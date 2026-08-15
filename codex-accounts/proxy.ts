#!/usr/bin/env node
// 다중 프로바이더 통합 라우팅 프록시 (SQLite 기반)
//
// 프로바이더(업체)별 계정풀:
//   providers 테이블: id, name, base_url, path_prefix, auth_header, model_pattern
//   accounts 테이블:  pool = provider id
//
// 라우팅:
//   /backend-api/codex/*  → chatgpt 프로바이더 (Codex CLI 네이티브)
//   /provider/v1/*        → commandcode 프로바이더 (OpenAI 호환)
//   /v1/*                 → 모델명으로 프로바이더의 model_pattern 매칭
//
// 사용량 기반 선택: score = remaining% / max(time_to_reset, 60s)
//   + weight 가중치, burn_priority 우선 태우기, 세션 고정, 401/429 재시도.
//
// 사용: node ~/.codex-accounts/proxy.ts  (포트: CC_PROXY_PORT ?? 9091)

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { initDb, listAccounts, latestUsage, usageScore, listProviders } from './db.ts';
import type { Provider } from './db.ts';

type PoolEntry = { acct: string; token: string; accountId?: string | null; installId?: string | null; enabled: number; weight: number; burn: number };
type Route = { providerId: string; path: string; unsupported?: boolean };
type ForwardOpts = { provider: Provider; path: string; query?: string };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9091);
// 응답 헤더 대기 상한 (기본 90s) — dead keep-alive 소켓에 걸린 요청을 확실히 종료
const UPSTREAM_TIMEOUT_MS = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS ?? 90_000);
// mid-stream silent hang 방어: 응답 헤더 후 N초간 업스트림 데이터가 0이면 스트림 종료.
// chatgpt.com은 SSE keepalive를 보내지 않음(실측 최대 무음 2.75s)이라 바이트 idle 기반으로
// 감지한다. 0이면 비활성화. 부분 전송된 스트림은 안전하게 이어서 재시도할 수 없어 재시도 없음.
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.PROXY_STREAM_IDLE_TIMEOUT_MS ?? 180_000);
// 요청당 최대 업스트림 시도 횟수 (초기 + 재시도). 401/429/타임아웃/일시적 커넥션 오류만 재시도.
const MAX_UPSTREAM_ATTEMPTS = Number(process.env.PROXY_MAX_UPSTREAM_ATTEMPTS ?? 3);
// 헤더 수신 전 재시도 대상 HTTP 상태 — 401/429(계정 로테이션) + 일시적 5xx
const RETRIABLE_STATUS = new Set([401, 408, 429, 500, 502, 503, 504]);
// 재시도 백오프 (시도 횟수 비례, 기본 300ms) — 업스트림 혼잡 시 즉시 재격화 방지
const RETRY_BACKOFF_MS = Number(process.env.PROXY_RETRY_BACKOFF_MS ?? 300);
// 요청 전체 상한 (모든 재시도 포함, 기본 240s) — 초과 시 재시도 중단하고 504
const TOTAL_TIMEOUT_MS = Number(process.env.PROXY_TOTAL_TIMEOUT_MS ?? 240_000);
// WebSocket 터널: 업스트림 커넥트+핸드셰이크 상한 (기본 15s)
const WS_CONNECT_TIMEOUT_MS = Number(process.env.PROXY_WS_CONNECT_TIMEOUT_MS ?? 15_000);
// WS 수립 후 바이트 idle 상한 (기본 10분, 0=비활성) — ping/pong 프레임도 트래픽으로 간주
const WS_IDLE_TIMEOUT_MS = Number(process.env.PROXY_WS_IDLE_TIMEOUT_MS ?? 600_000);
// 재시도 불가(영구) 오류 — TLS 인증서류는 재시도해도 같은 결과
const PERMANENT_ERR_RE = /certificate|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT|EPROTO/i;

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// 업스트림 TLS 연결 재사용 (요청마다 핸드셰이크 방지)
// Cloudflare가 idle keep-alive를 닫으면 Node가 CLOSE_WAIT 소켓을 free pool에서
// 제때 정리하지 못해 재사용 시 socket hang up/무한 대기가 반복됐다 (2회 이상 발생).
// 재사용을 끄고 요청마다 새 커넥션을 연다 — TLS 핸드셰이크 ~100ms는 수십 초짜리
// codex 요청에는 영향이 미미하고, 죽은 소켓 계열 실패는 구조적으로 사라진다.
const agent = new https.Agent({ keepAlive: false, maxSockets: 8 });

// model_pattern 정규식 캐시 (provider id → RegExp)
const regexCache = new Map<string, RegExp>();
function patternRe(p: Provider): RegExp {
  let re = regexCache.get(p.id);
  if (!re) {
    try { re = new RegExp(p.model_pattern); } catch { re = /.*/; }
    regexCache.set(p.id, re);
  }
  return re;
}

// ---------- DB 로딩 ----------
initDb();
let providers: Provider[] = [];
const pools: Record<string, PoolEntry[]> = {};
let usage = latestUsage();

function loadFromDb(): void {
  providers = listProviders().filter((p) => p.enabled === 1);
  // 프로바이더 id가 바뀌었으면 정규식 캐시 정리
  const ids = new Set(providers.map((p) => p.id));
  for (const k of regexCache.keys()) if (!ids.has(k)) regexCache.delete(k);
  for (const p of providers) {
    pools[p.id] = listAccounts(p.id as any).map((a) => ({
      acct: a.slot,
      token: a.access_token ?? '',
      accountId: a.account_id,
      installId: a.install_id,
      enabled: a.enabled,
      weight: a.weight,
      burn: a.burn_priority,
    })).filter((a) => a.token);
  }
  usage = latestUsage();
}
loadFromDb();

let rr = 0;

// 계정 선택: 세션 고정 + 사용량 스코어 + weight/burn
function pick(providerId: string, sessionId: string): PoolEntry | null {
  const entries = pools[providerId] ?? [];
  if (entries.length === 0) return null;
  const now = Date.now() / 1000;
  const scored = entries
    .filter((e) => e.enabled !== 0)
    .map((e) => ({ e, s: usageScore(usage, providerId as any, e.acct, now) * (e.weight || 1) + (e.burn || 0) * 1000 }));
  const usable = scored.filter((x) => x.s > 0);
  const source = usable.length > 0 ? usable : scored;

  if (sessionId) {
    const h = parseInt(createHash('sha1').update(sessionId).digest('hex').slice(0, 8), 16);
    return source[h % source.length]!.e;
  }
  const total = source.reduce((a, x) => a + x.s, 0);
  if (total <= 0) return entries[rr++ % entries.length]!;
  let r = Math.random() * total;
  for (const x of source) {
    r -= x.s;
    if (r <= 0) return x.e;
  }
  return source[source.length - 1]!.e;
}

// ChatGPT Responses 페이로드 정규화 (chatgpt 프로바이더 전용)
function normalizeChatgptBody(body: Buffer): Buffer {
  if (!body || !body.length) return body;
  const s = body.toString('utf8');
  // 대부분의 요청은 건드릴 게 없음 — 문자열 빠른 체크 후 스킵
  if (!s.includes('max_output_tokens') && s.includes('"store"')) return body;
  try {
    const payload = JSON.parse(s) as Record<string, unknown>;
    let changed = false;
    if ('max_output_tokens' in payload) {
      delete payload.max_output_tokens;
      changed = true;
    }
    if (!('store' in payload)) {
      payload.store = false;
      changed = true;
    }
    if (!changed) return body;
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return body;
  }
}

// ---------- auth.json 포워딩 ----------
// codex CLI는 ChatGPT 데스크톱 앱이 갱신해주는 ~/.codex/auth.json을 쓴다.
// env_key 없이도 그 토큰을 쓰도록 프록시가 최근 토큰을 자동 주입한다.
// auth.json 없으면 → chatgpt 풀 토큰 포워딩 (account-id 헤더 포함)

function authJsonToken(): string | null {
  try {
    const p = `${homedir()}/.codex/auth.json`;
    const a = JSON.parse(readFileSync(p, 'utf8')) as { tokens?: { access_token?: string; account_id?: string } };
    return a.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

function authJsonAccountId(): string | null {
  try {
    const p = `${homedir()}/.codex/auth.json`;
    const a = JSON.parse(readFileSync(p, 'utf8')) as { tokens?: { access_token?: string; account_id?: string } };
    return a.tokens?.account_id ?? null;
  } catch {
    return null;
  }
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  chosen: PoolEntry,
  opts: ForwardOpts,
  onFail: (() => void) | null,
): void {
  const { provider } = opts;
  // onFail은 요청당 최대 1회 — timeout/error/retriable status 경로의 중복 호출 방지
  let failed = false;
  const failOnce = (): boolean => {
    if (failed || !onFail || res.headersSent) return false;
    failed = true;
    onFail();
    return true;
  };
  if (process.env.DEBUG_PROXY) {
    console.log(
      `${new Date().toISOString()} [${provider.id}:${chosen.acct}] FWD ${req.method} ${opts.path} body=${body.toString('utf8').slice(0, 200)}`,
    );
  }
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers.authorization;
  delete headers['x-api-key'];
  delete headers['content-length'];
  if (provider.auth_mode === 'none') {
    // 인증 없음 (로컬 Ollama/LM Studio 등) — 토큰 불필요
  } else if (provider.auth_header.toLowerCase() === 'authorization') {
    // chatgpt: 데스크톱 앱이 갱신하는 auth.json 토큰을 우선 사용하되,
    // 선택된 계정과 동일 계정일 때만 (로테이션/사용량 귀속 유지)
    const ajTok = authJsonToken();
    const ajAcct = authJsonAccountId();
    const at =
      provider.id === 'chatgpt' && ajTok && ajAcct && chosen.accountId === ajAcct ? ajTok : chosen.token;
    headers.authorization = `Bearer ${at}`;
    if (provider.account_id_header && chosen.accountId) headers[provider.account_id_header] = chosen.accountId;
    if (provider.id === 'chatgpt' && chosen.installId) headers['x-codex-installation-id'] = chosen.installId;
  } else {
    headers[provider.auth_header] = chosen.token;
  }
  headers.host = provider.base_url.replace(/^https?:\/\//, '').split('/')[0];

  const upstreamPath =
    (opts.path.startsWith(provider.path_prefix) ? opts.path : `${provider.path_prefix}${opts.path}`) + (opts.query ?? '');

  const url = new URL(provider.base_url);
  // 클라이언트가 응답을 받기 전에 연결을 끊으면 업스트림 요청도 즉시 중단 (토큰 낭비 방지)
  res.on('close', () => {
    if (!res.writableFinished) r.destroy();
  });
  const r = https.request(
    {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      method: req.method,
      path: upstreamPath,
      headers,
      agent,
    },
    (up) => {
      r.setTimeout(0); // 응답 헤더 수신 후엔 연결 타임아웃 해제 — 이후는 idle watchdog이 감시
      const retriable = RETRIABLE_STATUS.has(up.statusCode ?? 0);
      if (retriable && failOnce()) {
        up.resume();
        return;
      }
      const ts = new Date().toISOString();
      const tag = retriable ? `[${provider.id}:${chosen.acct}!!${up.statusCode}]` : `[${provider.id}:${chosen.acct}]`;
      console.log(`${ts} ${tag} ${req.method} ${opts.path} -> ${up.statusCode}`);
      res.writeHead(up.statusCode!, up.headers);
      // mid-stream silent hang 방어: N초간 데이터가 안 오면 스트림 종료 (부분 전송 스트림은
      // 안전하게 재시도할 수 없으므로 error 이벤트를 주고 끝낸다)
      let idle: NodeJS.Timeout | null = null;
      const clearIdle = () => {
        if (idle) {
          clearTimeout(idle);
          idle = null;
        }
      };
      const armIdle = () => {
        if (STREAM_IDLE_TIMEOUT_MS <= 0) return;
        clearIdle();
        idle = setTimeout(() => {
          idle = null;
          console.log(
            `${new Date().toISOString()} [${provider.id}:${chosen.acct}] ERR stream idle > ${STREAM_IDLE_TIMEOUT_MS / 1000}s`,
          );
          r.destroy();
          if (!res.destroyed && !res.writableEnded) {
            res.write(
              `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'upstream_idle_timeout', message: 'upstream stream idle timeout' })}\n\n`,
            );
            res.end();
          }
        }, STREAM_IDLE_TIMEOUT_MS);
      };
      up.on('data', armIdle);
      up.on('end', clearIdle);
      up.on('close', clearIdle);
      armIdle();
      up.pipe(res);
    },
  );
  // 응답 헤더가 도착하기 전에 걸린 요청(dead keep-alive 소켓 등)은 상한 후
  // 소켓을 버리고 재시도(alt 계정, 새 커넥션)하거나 504를 돌려준다.
  r.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.log(
      `${new Date().toISOString()} [${provider.id}:${chosen.acct}] ERR timeout (no response in ${UPSTREAM_TIMEOUT_MS / 1000}s)`,
    );
    r.destroy();
    if (failOnce()) return;
    if (!res.headersSent) res.writeHead(504).end('upstream timeout');
  });
  r.on('error', (e) => {
    const msg = String(e?.message ?? e);
    console.log(`${new Date().toISOString()} [${provider.id}:${chosen.acct}] ERR ${msg}`);
    // TLS 인증서류(영구) 외 커넥션 오류는 일시적 — 응답 전이면 상한 내에서 재시도
    if (!PERMANENT_ERR_RE.test(msg) && failOnce()) return;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: `upstream error: ${msg}` }));
      return;
    }
    res.destroy(e);
  });
  r.write(body);
  r.end();
}

// ---------- WebSocket 터널링 (wire_api=responses_websocket 대응) ----------
// https.request는 101 upgrade를 중계할 수 없어 raw TLS 소켓 터널을 연다.
// 업스트림이 101을 돌려주면 양방향 파이프, 401/429/5xx면 계정을 바꿔 백오프 재시도.
// 주의: WS 프레임 페이로드는 중간 수정이 불가 — normalizeChatgptBody 미적용.
function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const fail = (status: number, detail: string) => {
    if (!socket.destroyed) {
      socket.end(
        `HTTP/1.1 ${status} Error\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ detail })}`,
      );
    }
  };
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = routeFor(u.pathname, Buffer.alloc(0));
  const provider = route ? providers.find((p) => p.id === route.providerId) : null;
  if (!route || !provider || route.unsupported) return fail(404, 'no route');
  const sessionId = (req.headers['x-session-id'] as string | undefined) ?? '';
  const first = pick(provider.id, sessionId);
  if (!first) return fail(503, `no ${provider.id} accounts in accounts.db`);
  const upstreamPath =
    (route.path.startsWith(provider.path_prefix) ? route.path : `${provider.path_prefix}${route.path}`) + u.search;
  const url = new URL(provider.base_url);
  const tried = new Set<string>();
  let n = 0;

  const attempt = (chosen: PoolEntry): void => {
    if (socket.destroyed) return;
    tried.add(chosen.acct);
    n++;
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.authorization;
    delete headers['x-api-key'];
    if (provider.auth_mode === 'none') {
      // 인증 없음 (로컬 Ollama/LM Studio 등) — 토큰 불필요
    } else if (provider.auth_header.toLowerCase() === 'authorization') {
      const ajTok = authJsonToken();
      const ajAcct = authJsonAccountId();
      const at =
        provider.id === 'chatgpt' && ajTok && ajAcct && chosen.accountId === ajAcct ? ajTok : chosen.token;
      headers.authorization = `Bearer ${at}`;
      if (provider.account_id_header && chosen.accountId) headers[provider.account_id_header] = chosen.accountId;
      if (provider.id === 'chatgpt' && chosen.installId) headers['x-codex-installation-id'] = chosen.installId;
    } else {
      headers[provider.auth_header] = chosen.token;
    }
    headers.host = provider.base_url.replace(/^https?:\/\//, '').split('/')[0];

    const up = tls.connect({
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      servername: url.hostname,
    });
    let established = false;
    let buf = Buffer.alloc(0);
    const onClientGone = () => up.destroy();
    socket.on('close', onClientGone);
    const retry = (why: string): void => {
      up.destroy();
      if (socket.destroyed) return;
      if (n < Math.max(1, MAX_UPSTREAM_ATTEMPTS)) {
        console.log(`${new Date().toISOString()} [${provider.id}:${chosen.acct}] WS retry (${why})`);
        const pool = pools[provider.id] ?? [];
        const alt = pool.find((k) => !tried.has(k.acct)) ?? chosen;
        setTimeout(() => attempt(alt), RETRY_BACKOFF_MS * n);
      } else {
        fail(504, `websocket upstream failed after retries (${why})`);
      }
    };

    up.setTimeout(WS_CONNECT_TIMEOUT_MS, () => {
      if (!established) retry(`no response in ${WS_CONNECT_TIMEOUT_MS / 1000}s`);
    });
    up.on('secureConnect', () => {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) for (const x of v) lines.push(`${k}: ${x}`);
        else lines.push(`${k}: ${v}`);
      }
      up.write(`${req.method} ${upstreamPath} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
    });
    up.on('data', (chunk: Buffer) => {
      if (established) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 64 * 1024) retry('upstream header overflow');
        return;
      }
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine);
      const status = m ? Number(m[1]) : 0;
      const ts = new Date().toISOString();
      if (status === 101) {
        established = true;
        up.setTimeout(0);
        socket.removeListener('close', onClientGone);
        up.removeAllListeners('data');
        console.log(`${ts} [${provider.id}:${chosen.acct}] WS ${req.method} ${upstreamPath} -> 101`);
        socket.write(buf); // 101 응답 + 딸려온 프레임까지 그대로 전달
        up.pipe(socket);
        socket.pipe(up);
        // 수립 후 가드레일: 바이트 idle 워치독 + 한쪽 종료 시 반대쪽도 정리
        let idle: NodeJS.Timeout | null = null;
        const arm = () => {
          if (WS_IDLE_TIMEOUT_MS <= 0) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            console.log(
              `${new Date().toISOString()} [${provider.id}:${chosen.acct}] WS ERR idle > ${WS_IDLE_TIMEOUT_MS / 1000}s`,
            );
            up.destroy();
            socket.destroy();
          }, WS_IDLE_TIMEOUT_MS);
        };
        up.on('data', arm);
        socket.on('data', arm);
        arm();
        up.on('close', () => {
          if (idle) clearTimeout(idle);
          socket.destroy();
        });
        socket.on('close', () => {
          if (idle) clearTimeout(idle);
          up.destroy();
        });
        return;
      }
      console.log(`${ts} [${provider.id}:${chosen.acct}] WS ${req.method} ${upstreamPath} -> ${status}`);
      if (RETRIABLE_STATUS.has(status)) return retry(`status ${status}`);
      fail(status || 502, 'upstream rejected websocket upgrade');
    });
    up.on('error', (e) => {
      if (established) {
        socket.destroy();
        return;
      }
      const msg = String(e?.message ?? e);
      console.log(`${new Date().toISOString()} [${provider.id}:${chosen.acct}] WS ERR ${msg}`);
      if (!PERMANENT_ERR_RE.test(msg)) return retry(msg);
      fail(502, `upstream error: ${msg}`);
    });
  };

  attempt(first);
}

function routeFor(path: string, body: Buffer): Route | null {
  // Codex CLI (wire_api=responses) → {base}/responses, {base}/models → chatgpt 풀
  if (path === '/responses' || path === '/models') {
    const gpt = providers.find((p) => p.id === 'chatgpt');
    if (gpt) return { providerId: 'chatgpt', path: `${gpt.path_prefix}${path}` };
  }
  // 명시 경로 → 프로바이더
  for (const p of providers) {
    if (path.startsWith(p.path_prefix)) return { providerId: p.id, path };
  }
  if (path.startsWith('/v1/')) {
    const rest = path.slice('/v1'.length);
    let model = '';
    try {
      const s = body.toString('utf8');
      const m = s.match(/"model"\s*:\s*"([^"]+)"/);
      model = m ? m[1]! : '';
    } catch {}
    for (const p of providers) {
      try {
        if (patternRe(p).test(model)) {
          // chatgpt는 Responses/모델 카탈로그만 (chat/completions 미지원)
          if (p.id === 'chatgpt' && rest !== '/responses' && rest !== '/models') {
            return { providerId: p.id, path, unsupported: true };
          }
          // /v1/* 요청을 provider의 path_prefix로 매핑: /v1/responses → {prefix}/responses
          return { providerId: p.id, path: `${p.path_prefix}${rest}` };
        }
      } catch {}
    }
  }
  return null;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routeFor(u.pathname, body);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'no route' }));
      return;
    }
    const provider = providers.find((p) => p.id === route.providerId);
    if (!provider) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'provider not found' }));
      return;
    }
    if (route.unsupported) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ detail: `${provider.id} only supports /v1/responses and /v1/models` }));
      return;
    }
    const sessionId = (req.headers['x-session-id'] as string | undefined) ?? '';
    const opts: ForwardOpts = { provider, path: route.path, query: u.search };
    const chosen = pick(provider.id, sessionId);
    if (!chosen) {
      res.writeHead(503).end(`no ${provider.id} accounts in accounts.db`);
      return;
    }
    if (provider.id === 'chatgpt') body = normalizeChatgptBody(body);
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const tried = new Set<string>([chosen.acct]);
    const retries = { left: Math.max(0, MAX_UPSTREAM_ATTEMPTS - 1), n: 1 };
    const next = () => {
      if (res.destroyed || res.writableEnded) return;
      if (retries.left <= 0 || Date.now() >= deadline) {
        if (!res.headersSent) res.writeHead(504).end('upstream failed after retries');
        return;
      }
      retries.left--;
      retries.n++;
      const pool = pools[provider.id] ?? [];
      // 아직 시도 안 한 계정 우선 — 모두 시도했으면 최초 계정 재사용
      const alt = pool.find((k) => !tried.has(k.acct)) ?? chosen;
      tried.add(alt.acct);
      setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) forward(req, res, body, alt, opts, next);
      }, RETRY_BACKOFF_MS * (retries.n - 1));
    };
    forward(req, res, body, chosen, opts, next);
  });
}

// requestTimeout: 0 — 장시간 SSE 스트림이 Node 기본 300s 제한으로 잘리는 것 방지
const server = http.createServer({ requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 75_000 }, handle);
// WebSocket upgrade 터널 — 리스너가 없으면 Node가 소켓을 즉시 destroy하여 클라이언트가 ECONNRESET을 본다
server.on('upgrade', handleUpgrade);
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `codex-proxy on http://127.0.0.1:${PORT} providers=${providers.map((p) => `${p.id}(${(pools[p.id] ?? []).length})`).join(', ')}`,
  );
  setInterval(loadFromDb, 5000);
});

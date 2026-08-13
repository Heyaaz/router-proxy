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

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// 업스트림 TLS 연결 재사용 (요청마다 핸드셰이크 방지)
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  // 재사용 풀을 작게 + free socket 수명을 15s로 줄여 stale 소켓 재사용 윈도우 최소화
  maxFreeSockets: 2,
  keepAliveMsecs: 15_000,
});

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
      r.setTimeout(0); // 응답 헤더 수신 후엔 타임아웃 해제 (긴 SSE 스트림 보호)
      const retriable = up.statusCode === 401 || up.statusCode === 429;
      if (retriable && onFail) {
        up.resume();
        return onFail();
      }
      const ts = new Date().toISOString();
      const tag = retriable ? `[${provider.id}:${chosen.acct}!!${up.statusCode}]` : `[${provider.id}:${chosen.acct}]`;
      console.log(`${ts} ${tag} ${req.method} ${opts.path} -> ${up.statusCode}`);
      res.writeHead(up.statusCode!, up.headers);
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
    if (onFail) return onFail();
    if (!res.headersSent) res.writeHead(504).end('upstream timeout');
  });
  r.on('error', (e) => {
    console.log(`${new Date().toISOString()} [${provider.id}:${chosen.acct}] ERR ${e.message}`);
    if (onFail && !res.headersSent) return onFail(); // 응답 전 커넥션 오류 → 새 커넥션으로 1회 재시도
    res.destroy(e);
  });
  r.write(body);
  r.end();
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
    const next = () => {
      const pool = pools[provider.id] ?? [];
      const alt = pool.find((k) => k.acct !== chosen.acct) ?? chosen;
      forward(req, res, body, alt, opts, null);
    };
    forward(req, res, body, chosen, opts, next);
  });
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(
    `codex-proxy on http://127.0.0.1:${PORT} providers=${providers.map((p) => `${p.id}(${(pools[p.id] ?? []).length})`).join(', ')}`,
  );
  setInterval(loadFromDb, 5000);
});

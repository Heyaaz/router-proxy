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
import { initDb, listAccounts, latestUsage, usageScore, listProviders } from './db.ts';
import type { Provider } from './db.ts';

type PoolEntry = { acct: string; token: string; accountId?: string | null; installId?: string | null; enabled: number; weight: number; burn: number };
type Route = { providerId: string; path: string; unsupported?: boolean };
type ForwardOpts = { provider: Provider; path: string };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9091);

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// 업스트림 TLS 연결 재사용 (요청마다 핸드셰이크 방지)
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });

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
  if (provider.auth_header.toLowerCase() === 'authorization') {
    headers.authorization = `Bearer ${chosen.token}`;
    if (provider.account_id_header && chosen.accountId) headers[provider.account_id_header] = chosen.accountId;
    if (provider.id === 'chatgpt' && chosen.installId) headers['x-codex-installation-id'] = chosen.installId;
  } else {
    headers[provider.auth_header] = chosen.token;
  }
  headers.host = provider.base_url.replace(/^https?:\/\//, '').split('/')[0];

  const upstreamPath = opts.path.startsWith(provider.path_prefix)
    ? opts.path
    : `${provider.path_prefix}${opts.path}`;

  const url = new URL(provider.base_url);
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
  r.on('error', (e) => {
    console.log(`${new Date().toISOString()} [${provider.id}:${chosen.acct}] ERR ${e.message}`);
    res.destroy(e);
  });
  r.write(body);
  r.end();
}

function routeFor(path: string, body: Buffer): Route | null {
  // 명시 경로 → 프로바이더
  for (const p of providers) {
    if (path.startsWith(p.path_prefix)) return { providerId: p.id, path };
  }
  if (path.startsWith('/v1/')) {
    const rest = path.slice('/v1'.length);
    let model = '';
    // 바디에서 model 필드만 추출 — 전체 JSON.parse는 최소화
    try {
      const s = body.toString('utf8');
      // "model":"..." 패턴만 빠르게 추출
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
    const route = routeFor(req.url ?? '', body);
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
    const opts: ForwardOpts = { provider, path: route.path };
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

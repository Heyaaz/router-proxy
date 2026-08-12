#!/usr/bin/env node
// Codex(ChatGPT 계정풀) + Command Code 통합 라우팅 프록시 (SQLite 기반)
//
// 풀 1 — ChatGPT 계정풀: accounts.db(chatgpt) — wham/usage 사용량 스코어링
// 풀 2 — Command Code:   accounts.db(commandcode) — billing/credits 사용량 스코어링
//
// 사용량 기반 선택 (codex-lb select_account 로직 단순화):
//   score(account) = remaining% / max(time_to_reset, 60s)
//   → 리셋이 가까우면서 사용량이 많이 남은 계정 우선 (쿼터 소진 최적화)
//   사용량 데이터 없으면 세션 해시/라운드로빈 폴백.
//   세션 고정: x-session-id → 해시로 고정, 단 쿼터 소진 계정은 제외.
//   401/429 → 같은 풀 다음 계정으로 1회 재시도.
//
// 사용: node ~/.codex-accounts/proxy.ts  (포트: CC_PROXY_PORT ?? 9091)

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { initDb, listAccounts, latestUsage } from './db.ts';

type PoolName = 'chatgpt' | 'commandcode';
type PoolEntry = { acct: string; token: string; accountId?: string | null; installId?: string | null; key?: string | null };
type Route = { pool: PoolName; path: string; unsupported?: boolean };
type RouteRule = { pool: PoolName; test: RegExp };
type ForwardOpts = { pool: PoolName; upstream: { hostname: string; port: number; base: string }; path: string };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9091);
const CHATGPT_UPSTREAM = { hostname: 'chatgpt.com', port: 443, base: '/backend-api/codex' };
const CC_UPSTREAM = { hostname: 'api.commandcode.ai', port: 443, base: '/provider/v1' };

// /v1/* 분기 테이블: 위에서부터 첫 매치. pool: 'chatgpt' | 'commandcode'
const MODEL_ROUTES: RouteRule[] = [
  { pool: 'chatgpt', test: /^(gpt-5\.|gpt-4\.|o[0-9]|codex-)/ },
  { pool: 'commandcode', test: /.*/ },
];

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// ---------- 계정/사용량 로딩 (DB) ----------
initDb();
let chatgpt: PoolEntry[] = [];
let commandcode: PoolEntry[] = [];
let usage = latestUsage();

function loadFromDb(): void {
  chatgpt = listAccounts('chatgpt').map((a) => ({
    acct: a.slot,
    token: a.access_token ?? '',
    accountId: a.account_id,
    installId: a.install_id,
  })).filter((a) => a.token);
  commandcode = listAccounts('commandcode').map((a) => ({
    acct: a.slot,
    key: a.access_token ?? '',
  })).filter((a) => a.key);
  usage = latestUsage();
}
loadFromDb();

let rr = 0;

// 사용량 스코어: remaining% / time_to_reset. 높을수록 우선 (리셋 가깝고 많이 남음)
function scoreOf(pool: PoolName, slot: string, now: number): number {
  const u = usage[`${pool}:${slot}`];
  if (!u) return 0;
  const win = pool === 'chatgpt' ? 'primary' : (u.weekly ? 'weekly' : 'fiveHour');
  const w = u[win];
  if (!w) return 0;
  const remaining = Math.max(0, 100 - w.used_percent);
  if (remaining <= 0) return 0;
  const ttr = w.reset_at ? Math.max(60, w.reset_at - now) : 7 * 86400;
  return remaining / ttr;
}

// 계정 선택: 세션 고정(쿼터 소진 계정 제외) + 사용량 스코어 + 라운드로빈 폴백
function pick(pool: PoolName, sessionId: string): PoolEntry | null {
  const entries = pool === 'chatgpt' ? chatgpt : commandcode;
  if (entries.length === 0) return null;
  const now = Date.now() / 1000;
  const scored = entries.map((e) => ({ e, s: scoreOf(pool, e.acct, now) }));
  const usable = scored.filter((x) => x.s > 0);
  const source = usable.length > 0 ? usable : scored;

  if (sessionId) {
    // 세션 고정: 해시 → 계정. 단, 쿼터 소진(score 0)이면 다른 계정으로.
    const h = parseInt(createHash('sha1').update(sessionId).digest('hex').slice(0, 8), 16);
    const pinned = source[h % source.length]!;
    return pinned.e;
  }
  // 무상태: 사용량 스코어 가중 랜덤 (없으면 라운드로빈)
  const total = source.reduce((a, x) => a + x.s, 0);
  if (total <= 0) return entries[rr++ % entries.length]!;
  let r = Math.random() * total;
  for (const x of source) {
    r -= x.s;
    if (r <= 0) return x.e;
  }
  return source[source.length - 1]!.e;
}

// ChatGPT Responses 페이로드 정규화
function normalizeChatgptBody(body: Buffer): Buffer {
  if (!body || !body.length) return body;
  try {
    const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
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
  if (process.env.DEBUG_PROXY) {
    console.log(
      `${new Date().toISOString()} [${opts.pool}:${chosen.acct}] FWD ${req.method} ${opts.path} body=${body.toString('utf8').slice(0, 200)}`,
    );
  }
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers.authorization;
  delete headers['x-api-key'];
  delete headers['content-length'];
  if (opts.pool === 'chatgpt') {
    headers.authorization = `Bearer ${chosen.token}`;
    if (chosen.accountId) headers['chatgpt-account-id'] = chosen.accountId;
    if (chosen.installId) headers['x-codex-installation-id'] = chosen.installId;
  } else {
    headers['x-api-key'] = chosen.key!;
  }
  headers.host = opts.upstream.hostname;

  const upstreamPath = opts.path.startsWith(opts.upstream.base)
    ? opts.path
    : `${opts.upstream.base}${opts.path}`;

  const r = https.request(
    { ...opts.upstream, method: req.method, path: upstreamPath, headers },
    (up) => {
      const retriable = up.statusCode === 401 || up.statusCode === 429;
      if (retriable && onFail) {
        up.resume();
        return onFail();
      }
      const ts = new Date().toISOString();
      const tag = retriable ? `[${opts.pool}:${chosen.acct}!!${up.statusCode}]` : `[${opts.pool}:${chosen.acct}]`;
      console.log(`${ts} ${tag} ${req.method} ${opts.path} -> ${up.statusCode}`);
      res.writeHead(up.statusCode!, up.headers);
      up.pipe(res);
    },
  );
  r.on('error', (e) => {
    console.log(`${new Date().toISOString()} [${opts.pool}:${chosen.acct}] ERR ${e.message}`);
    res.destroy(e);
  });
  r.write(body);
  r.end();
}

function routeFor(path: string, body: Buffer): Route | null {
  if (path.startsWith('/backend-api/codex')) return { pool: 'chatgpt', path };
  if (path.startsWith('/provider/v1')) return { pool: 'commandcode', path };
  if (path.startsWith('/v1/')) {
    const rest = path.slice('/v1'.length);
    let model = '';
    try {
      model = (JSON.parse(body.toString('utf8')) as { model?: string }).model ?? '';
    } catch {}
    for (const rule of MODEL_ROUTES) {
      if (rule.test.test(model)) {
        if (rule.pool === 'chatgpt') {
          if (rest === '/responses' || rest === '/models') {
            return { pool: 'chatgpt', path: `/backend-api/codex${rest}` };
          }
          return { pool: 'chatgpt', path, unsupported: true };
        }
        return { pool: 'commandcode', path: `/provider/v1${rest}` };
      }
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
    if (route.unsupported) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ detail: 'chatgpt pool only supports /v1/responses and /v1/models' }));
      return;
    }
    const sessionId = (req.headers['x-session-id'] as string | undefined) ?? '';

    const opts: ForwardOpts =
      route.pool === 'chatgpt'
        ? { pool: 'chatgpt', upstream: CHATGPT_UPSTREAM, path: route.path }
        : { pool: 'commandcode', upstream: CC_UPSTREAM, path: route.path };

    const chosen = pick(route.pool, sessionId);
    if (!chosen) {
      res.writeHead(503).end(`no ${route.pool} accounts in accounts.db`);
      return;
    }
    if (route.pool === 'chatgpt') body = normalizeChatgptBody(body);
    const next = () => {
      const pool = route.pool === 'chatgpt' ? chatgpt : commandcode;
      const alt = pool.find((k) => k.acct !== chosen.acct) ?? chosen;
      forward(req, res, body, alt, opts, null);
    };
    forward(req, res, body, chosen, opts, next);
  });
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(
    `codex-proxy on http://127.0.0.1:${PORT} chatgpt=${chatgpt.map((k) => `${k.acct}:${mask(k.token)}`).join(', ')} ` +
      `commandcode=${commandcode.map((k) => `${k.acct}:${mask(k.key ?? '')}`).join(', ')}`,
  );
  // 5초 핫리로드: DB에서 계정/토큰/사용량 재조회 (login/refresh/quota 반영)
  setInterval(loadFromDb, 5000);
});

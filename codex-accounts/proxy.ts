#!/usr/bin/env node
// Codex(ChatGPT 계정풀) + Command Code 통합 로테이션 프록시
//
// 풀 1 — ChatGPT 계정풀 (codex-lb store.db에서 export한 OAuth 토큰)
//   키:   {CODEX_ACCOUNTS_DIR}/{a,b,c}/token      (Bearer 액세스 토큰, 기본 ~/Documents/codex-accounts)
//         {CODEX_ACCOUNTS_DIR}/{a,b,c}/id         (chatgpt-account-id)
//         {CODEX_ACCOUNTS_DIR}/{a,b,c}/install-id (x-codex-installation-id)
//   갱신: node ~/.codex-accounts/export-tokens.ts --refresh  (codex-lb 불필요)
//   추가: node ~/.codex-accounts/login.ts
//   업스트림: https://chatgpt.com/backend-api/codex/*  (Authorization: Bearer + chatgpt-account-id)
//
// 풀 2 — Command Code GOAT 구독
//   키:   ~/.cc-accounts/{a,b}/key
//   업스트림: https://api.commandcode.ai/provider/v1/*  (x-api-key)
//
// 분기 규칙 (경로 기반):
//   /backend-api/codex/*  → ChatGPT 계정풀   (Codex CLI 네이티브 경로)
//   /provider/v1/*        → Command Code      (OpenAI 호환)
//   /v1/*                 → MODEL_ROUTES 테이블로 모델 기준 분기
//
// ChatGPT 풀 정규화: max_output_tokens 제거(업스트림 거부), store 누락 시 false 강제.
// 세션 고정: x-session-id 해시. 401/429 → 같은 풀 다음 계정으로 1회 재시도.
// 사용: node ~/.codex-accounts/proxy.ts  (포트: CC_PROXY_PORT ?? 9091, 데이터 디렉토리: CODEX_ACCOUNTS_DIR)

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

type PoolName = 'chatgpt' | 'commandcode';
type ChatgptEntry = { acct: string; token: string; id: string; 'install-id': string };
type CommandCodeEntry = { acct: string; key: string };
type PoolEntry = ChatgptEntry | CommandCodeEntry;
type Route = { pool: PoolName; path: string; unsupported?: boolean };
type RouteRule = { pool: PoolName; test: RegExp };
type ForwardOpts = { pool: PoolName; upstream: { hostname: string; port: number; base: string }; path: string };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9091);

const CHATGPT_DIR = process.env.CODEX_ACCOUNTS_DIR ?? `${homedir()}/Documents/codex-accounts`;
const CC_DIR = `${homedir()}/.cc-accounts`;

const CHATGPT_UPSTREAM = { hostname: 'chatgpt.com', port: 443, base: '/backend-api/codex' };
const CC_UPSTREAM = { hostname: 'api.commandcode.ai', port: 443, base: '/provider/v1' };

// /v1/* 분기 테이블: 위에서부터 첫 매치. pool: 'chatgpt' | 'commandcode'
const MODEL_ROUTES: RouteRule[] = [
  // ChatGPT 계열 모델 → 자체 ChatGPT 계정풀 (내 유료 시트 사용, Command Code 크레딧 아낌)
  { pool: 'chatgpt', test: /^(gpt-5\.|gpt-4\.|o[0-9]|codex-)/ },
  // 그 외(deepseek/*, meta/*, claude-*, grok-*, qwen/* 등) → Command Code 구독
  { pool: 'commandcode', test: /.*/ },
];

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

function loadPool<T extends { acct: string }>(dir: string, names: string[]): T[] {
  const out: T[] = [];
  for (const acct of ['a', 'b', 'c']) {
    const vals: Record<string, string> = {};
    let ok = true;
    for (const name of names) {
      const p = `${dir}/${acct}/${name}`;
      if (!existsSync(p)) { ok = false; break; }
      vals[name] = readFileSync(p, 'utf8').trim();
    }
    if (ok && vals[names[0]]) out.push({ acct, ...vals } as T);
  }
  return out;
}

function loadChatgpt(): ChatgptEntry[] {
  return loadPool<ChatgptEntry>(CHATGPT_DIR, ['token', 'id', 'install-id']);
}
function loadCommandCode(): CommandCodeEntry[] {
  return loadPool<CommandCodeEntry>(CC_DIR, ['key']);
}

let chatgpt = loadChatgpt();
let commandcode = loadCommandCode();
let rr = 0;

function pick<T extends { acct: string }>(pool: T[], sessionId: string): T | null {
  if (pool.length === 0) return null;
  if (sessionId) {
    const h = parseInt(createHash('sha1').update(sessionId).digest('hex').slice(0, 8), 16);
    return pool[h % pool.length]!;
  }
  return pool[rr++ % pool.length]!;
}

// ChatGPT Responses 페이로드 정규화: 업스트림이 거부하는 필드 제거/강제
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
    return body; // JSON이 아니면 그대로 (모델 목록 등)
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
  // body를 정규화한 경우 Content-Length가 원본 길이를 가리켜 업스트림이
  // 스트림 조기 종료(ECONNRESET)로 인식함 → 삭제하고 Node가 재계산하게 함
  delete headers['content-length'];
  if (opts.pool === 'chatgpt') {
    const e = chosen as ChatgptEntry;
    headers.authorization = `Bearer ${e.token}`;
    if (e.id) headers['chatgpt-account-id'] = e.id;
    if (e['install-id']) headers['x-codex-installation-id'] = e['install-id'];
  } else {
    const e = chosen as CommandCodeEntry;
    headers['x-api-key'] = e.key;
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
  if (path.startsWith('/backend-api/codex')) {
    return { pool: 'chatgpt', path };
  }
  if (path.startsWith('/provider/v1')) {
    return { pool: 'commandcode', path };
  }
  if (path.startsWith('/v1/')) {
    const rest = path.slice('/v1'.length); // '/responses', '/models', '/chat/completions'
    let model = '';
    try {
      model = (JSON.parse(body.toString('utf8')) as { model?: string }).model ?? '';
    } catch {}
    for (const rule of MODEL_ROUTES) {
      if (rule.test.test(model)) {
        if (rule.pool === 'chatgpt') {
          // ChatGPT 업스트림은 Responses/모델 카탈로그만 지원 (chat/completions 없음)
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

    if (route.pool === 'chatgpt') {
      body = normalizeChatgptBody(body);
      const pool = chatgpt;
      const chosen = pick(pool, sessionId);
      if (!chosen) {
        res.writeHead(503).end('no chatgpt tokens in ~/.codex-accounts/{a,b,c}/token');
        return;
      }
      const opts: ForwardOpts = { pool: 'chatgpt', upstream: CHATGPT_UPSTREAM, path: route.path };
      const next = () => {
        const alt = pool.find((k) => k.acct !== chosen.acct) ?? chosen;
        forward(req, res, body, alt, opts, null);
      };
      forward(req, res, body, chosen, opts, next);
    } else {
      const pool = commandcode;
      const chosen = pick(pool, sessionId);
      if (!chosen) {
        res.writeHead(503).end('no commandcode keys in ~/.cc-accounts/{a,b}/key');
        return;
      }
      const opts: ForwardOpts = { pool: 'commandcode', upstream: CC_UPSTREAM, path: route.path };
      const next = () => {
        const alt = pool.find((k) => k.acct !== chosen.acct) ?? chosen;
        forward(req, res, body, alt, opts, null);
      };
      forward(req, res, body, chosen, opts, next);
    }
  });
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(
    `codex-proxy on http://127.0.0.1:${PORT} chatgpt=${chatgpt.map((k) => `${k.acct}:${mask(k.token)}`).join(', ')} ` +
      `commandcode=${commandcode.map((k) => `${k.acct}:${mask(k.key)}`).join(', ')}`,
  );
  setInterval(() => {
    const freshCc = loadCommandCode();
    const freshCg = loadChatgpt();
    if (freshCc.length !== commandcode.length || freshCc.some((k, i) => k.key !== commandcode[i]?.key)) {
      commandcode = freshCc;
      console.log(`${new Date().toISOString()} commandcode reloaded: ${commandcode.map((k) => k.acct).join(', ')}`);
    }
    if (freshCg.length !== chatgpt.length || freshCg.some((k, i) => k.token !== chatgpt[i]?.token)) {
      chatgpt = freshCg;
      console.log(`${new Date().toISOString()} chatgpt reloaded: ${chatgpt.map((k) => k.acct).join(', ')}`);
    }
  }, 5000);
});

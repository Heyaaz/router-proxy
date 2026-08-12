#!/usr/bin/env node
// Command Code 계정 라우팅 프록시 (SQLite 기반, codex-lb 스타일)
// - 계정: accounts.db(commandcode) — billing/credits 사용량 스코어링
// - 세션 고정: x-session-id 해시 (쿼터 소진 계정 제외)
// - 무상태: 사용량 스코어 가중 랜덤 (데이터 없으면 라운드로빈)
// - 401/429 → 다음 계정 1회 재시도
// - 5초 핫리로드 (add-account/login 반영)
//
// 사용: COMMANDCODE_SANDBOX=true COMMANDCODE_API_URL=http://127.0.0.1:9090 cmd ...
// 실행: node ~/.cc-accounts/proxy.ts  (포트: CC_PROXY_PORT ?? 9090)

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { initDb, listAccounts, latestUsage } from './db.ts';

type KeyEntry = { acct: string; key: string };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9090);
const UPSTREAM = { hostname: 'api.commandcode.ai', port: 443 };

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

initDb();
let keys: KeyEntry[] = [];
let usage = latestUsage();

function loadFromDb(): void {
  keys = listAccounts('commandcode').map((a) => ({ acct: a.slot, key: a.access_token ?? '' })).filter((k) => k.key);
  usage = latestUsage();
}
loadFromDb();

let rr = 0;

function scoreOf(slot: string, now: number): number {
  const u = usage[`commandcode:${slot}`];
  if (!u) return 0;
  const win = u.weekly ? 'weekly' : 'fiveHour';
  const w = u[win];
  if (!w) return 0;
  const remaining = Math.max(0, 100 - w.used_percent);
  if (remaining <= 0) return 0;
  const ttr = w.reset_at ? Math.max(60, w.reset_at - now) : 7 * 86400;
  return remaining / ttr;
}

function pick(sessionId: string): KeyEntry | null {
  if (keys.length === 0) return null;
  const now = Date.now() / 1000;
  const scored = keys.map((k) => ({ e: k, s: scoreOf(k.acct, now) }));
  const usable = scored.filter((x) => x.s > 0);
  const source = usable.length > 0 ? usable : scored;
  if (sessionId) {
    const h = parseInt(createHash('sha1').update(sessionId).digest('hex').slice(0, 8), 16);
    return source[h % source.length]!.e;
  }
  const total = source.reduce((a, x) => a + x.s, 0);
  if (total <= 0) return keys[rr++ % keys.length]!;
  let r = Math.random() * total;
  for (const x of source) {
    r -= x.s;
    if (r <= 0) return x.e;
  }
  return source[source.length - 1]!.e;
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  chosen: KeyEntry,
  onFail: (() => void) | null,
): void {
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
    host: UPSTREAM.hostname,
    'x-api-key': chosen.key,
  };
  delete headers.authorization;
  const r = https.request(
    { ...UPSTREAM, method: req.method, path: req.url, headers },
    (up) => {
      const retriable = up.statusCode === 401 || up.statusCode === 429;
      if (retriable && onFail) {
        up.resume();
        return onFail();
      }
      const ts = new Date().toISOString();
      const tag = retriable ? `[${chosen.acct}!!${up.statusCode}]` : `[${chosen.acct}]`;
      console.log(`${ts} ${tag} ${req.method} ${req.url} -> ${up.statusCode}`);
      res.writeHead(up.statusCode!, up.headers);
      up.pipe(res);
    },
  );
  r.on('error', (e) => {
    console.log(`${new Date().toISOString()} [${chosen.acct}] ERR ${e.message}`);
    res.destroy(e);
  });
  r.write(body);
  r.end();
}

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sessionId = (req.headers['x-session-id'] as string | undefined) ?? '';
      const chosen = pick(sessionId);
      if (!chosen) {
        res.writeHead(503).end('no commandcode accounts in accounts.db');
        return;
      }
      const next = () => {
        const alt = keys[rr++ % keys.length]!;
        forward(req, res, body, alt, null);
      };
      forward(req, res, body, chosen, next);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(
      `cc-proxy on http://127.0.0.1:${PORT} accounts=${keys.map((k) => `${k.acct}:${mask(k.key)}`).join(', ')}`,
    );
    setInterval(loadFromDb, 5000);
  });

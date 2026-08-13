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
import { initDb, listAccounts, latestUsage, usageScore } from './db.ts';

type KeyEntry = { acct: string; key: string; enabled: number; weight: number; burn: number };

const PORT = Number(process.env.CC_PROXY_PORT ?? 9090);
// 응답 헤더 대기 상한 (기본 90s) — dead keep-alive 소켓에 걸린 요청을 확실히 종료
const UPSTREAM_TIMEOUT_MS = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS ?? 90_000);
const UPSTREAM = { hostname: 'api.commandcode.ai', port: 443 };

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// 업스트림 TLS 연결 재사용 (요청마다 핸드셰이크 방지)
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  // 재사용 풀을 작게 + free socket 수명을 15s로 줄여 stale 소켓 재사용 윈도우 최소화
  maxFreeSockets: 2,
  keepAliveMsecs: 15_000,
});

initDb();
let keys: KeyEntry[] = [];
let usage = latestUsage();

function loadFromDb(): void {
  keys = listAccounts('commandcode').map((a) => ({ acct: a.slot, key: a.access_token ?? '', enabled: a.enabled, weight: a.weight, burn: a.burn_priority })).filter((k) => k.key);
  usage = latestUsage();
}
loadFromDb();

let rr = 0;

function pick(sessionId: string): KeyEntry | null {
  if (keys.length === 0) return null;
  const now = Date.now() / 1000;
  const scored = keys
    .filter((k) => k.enabled !== 0)
    .map((k) => ({ e: k, s: usageScore(usage, 'commandcode', k.acct, now) * (k.weight || 1) + (k.burn || 0) * 1000 }));
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
  // 클라이언트가 응답을 받기 전에 연결을 끊으면 업스트림 요청도 즉시 중단 (크레딧 낭비 방지)
  res.on('close', () => {
    if (!res.writableFinished) r.destroy();
  });
  const r = https.request(
    { ...UPSTREAM, method: req.method, path: req.url, headers, agent },
    (up) => {
      r.setTimeout(0); // 응답 헤더 수신 후엔 타임아웃 해제 (긴 SSE 스트림 보호)
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
  // 응답 헤더가 도착하기 전에 걸린 요청(dead keep-alive 소켓 등)은 상한 후
  // 소켓을 버리고 재시도(alt 계정, 새 커넥션)하거나 504를 돌려준다.
  r.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.log(
      `${new Date().toISOString()} [${chosen.acct}] ERR timeout (no response in ${UPSTREAM_TIMEOUT_MS / 1000}s)`,
    );
    r.destroy();
    if (onFail) return onFail();
    if (!res.headersSent) res.writeHead(504).end('upstream timeout');
  });
  r.on('error', (e) => {
    console.log(`${new Date().toISOString()} [${chosen.acct}] ERR ${e.message}`);
    if (onFail && !res.headersSent) return onFail(); // 응답 전 커넥션 오류 → 새 커넥션으로 1회 재시도
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

#!/usr/bin/env node
// Command Code 계정 로테이션 프록시 (codex-lb 스타일)
// - 키 목록: ~/.cc-accounts/{a,b,c}/key  (5초마다 핫리로드)
// - 세션 고정: x-session-id 해시로 계정 선택 (한 대화는 한 계정 유지)
// - 무상태 요청: 라운드로빈
// - 401/429 발생 시 다음 계정으로 1회 재시도
// - 사용: COMMANDCODE_SANDBOX=true COMMANDCODE_API_URL=http://127.0.0.1:9090 cmd ...
// - 실행: node ~/.cc-accounts/proxy.ts  (Node 23+ 타입 스트리핑 — 빌드 불필요)

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

type KeyEntry = { acct: string; key: string };

const DIR = `${homedir()}/.cc-accounts`;
const PORT = Number(process.env.CC_PROXY_PORT ?? 9090);
const UPSTREAM = { hostname: 'api.commandcode.ai', port: 443 };

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

function loadKeys(): KeyEntry[] {
  const keys: KeyEntry[] = [];
  for (const acct of ['a', 'b', 'c']) {
    const p = `${DIR}/${acct}/key`;
    if (existsSync(p)) {
      const key = readFileSync(p, 'utf8').trim();
      if (key) keys.push({ acct, key });
    }
  }
  return keys;
}

let keys = loadKeys();
let rr = 0;

function pick(sessionId: string): KeyEntry | null {
  if (keys.length === 0) return null;
  if (sessionId) {
    const h = parseInt(createHash('sha1').update(sessionId).digest('hex').slice(0, 8), 16);
    return keys[h % keys.length]!;
  }
  return keys[rr++ % keys.length]!;
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
        res.writeHead(503).end('no account keys in ~/.cc-accounts/{a,b,c}/key');
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
    setInterval(() => {
      const fresh = loadKeys();
      if (fresh.length !== keys.length || fresh.some((k, i) => k.key !== keys[i]?.key)) {
        keys = fresh;
        console.log(`${new Date().toISOString()} accounts reloaded: ${keys.map((k) => k.acct).join(', ')}`);
      }
    }, 5000);
  });

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
// mid-stream silent hang 방어: 응답 헤더 후 N초간 업스트림 데이터가 0이면 스트림 종료.
// 0이면 비활성화. 부분 전송된 스트림은 안전하게 이어서 재시도할 수 없어 재시도 없음.
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.PROXY_STREAM_IDLE_TIMEOUT_MS ?? 180_000);
// 요청당 최대 업스트림 시도 횟수 (초기 + 재시도). 401/429/타임아웃/일시적 커넥션 오류만 재시도.
const MAX_UPSTREAM_ATTEMPTS = Number(process.env.PROXY_MAX_UPSTREAM_ATTEMPTS ?? 3);
// 헤더 수신 전 재시도 대상 HTTP 상태 — 401/429(계정 로테이션) + 일시적 5xx
const RETRIABLE_STATUS = new Set([401, 408, 429, 500, 502, 503, 504]);
// 재시도 백오프 (시도 횟수 비례, 기본 300ms) — 업스트림 혼잡 시 즉시 재격화 방지
const RETRY_BACKOFF_MS = Number(process.env.PROXY_RETRY_BACKOFF_MS ?? 300);
// 요청 전체 상한 (모든 재시도 포함, 기본 240s) — 초과 시 재시도 중단하고 504
const TOTAL_TIMEOUT_MS = Number(process.env.PROXY_TOTAL_TIMEOUT_MS ?? 240_000);
// 재시도 불가(영구) 오류 — TLS 인증서류는 재시도해도 같은 결과
const PERMANENT_ERR_RE = /certificate|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT|EPROTO/i;
const UPSTREAM = { hostname: 'api.commandcode.ai', port: 443 };

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

// 업스트림 TLS 연결 재사용 (요청마다 핸드셰이크 방지)
// Cloudflare가 idle keep-alive를 닫으면 Node가 CLOSE_WAIT 소켓을 free pool에서
// 제때 정리하지 못해 재사용 시 socket hang up/무한 대기가 반복됐다.
// 재사용을 끄고 요청마다 새 커넥션을 연다 — 죽은 소켓 계열 실패는 구조적으로 사라진다.
const agent = new https.Agent({ keepAlive: false, maxSockets: 8 });

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
  // onFail은 요청당 최대 1회 — timeout/error/retriable status 경로의 중복 호출 방지
  let failed = false;
  const failOnce = (): boolean => {
    if (failed || !onFail || res.headersSent) return false;
    failed = true;
    onFail();
    return true;
  };
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
      r.setTimeout(0); // 응답 헤더 수신 후엔 연결 타임아웃 해제 — 이후는 idle watchdog이 감시
      const retriable = RETRIABLE_STATUS.has(up.statusCode ?? 0);
      if (retriable && failOnce()) {
        up.resume();
        return;
      }
      const ts = new Date().toISOString();
      const tag = retriable ? `[${chosen.acct}!!${up.statusCode}]` : `[${chosen.acct}]`;
      console.log(`${ts} ${tag} ${req.method} ${req.url} -> ${up.statusCode}`);
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
            `${new Date().toISOString()} [${chosen.acct}] ERR stream idle > ${STREAM_IDLE_TIMEOUT_MS / 1000}s`,
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
      `${new Date().toISOString()} [${chosen.acct}] ERR timeout (no response in ${UPSTREAM_TIMEOUT_MS / 1000}s)`,
    );
    r.destroy();
    if (failOnce()) return;
    if (!res.headersSent) res.writeHead(504).end('upstream timeout');
  });
  r.on('error', (e) => {
    const msg = String(e?.message ?? e);
    console.log(`${new Date().toISOString()} [${chosen.acct}] ERR ${msg}`);
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

// requestTimeout: 0 — 장시간 SSE 스트림이 Node 기본 300s 제한으로 잘리는 것 방지
http
  .createServer({ requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 75_000 }, (req, res) => {
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
        // 아직 시도 안 한 활성 계정 우선 (라운드로빈 순서) — 모두 시도했으면 최초 계정 재사용
        const alt = keys.find((k) => k.enabled !== 0 && !tried.has(k.acct)) ?? chosen;
        tried.add(alt.acct);
        setTimeout(() => {
          if (!res.destroyed && !res.writableEnded) forward(req, res, body, alt, next);
        }, RETRY_BACKOFF_MS * (retries.n - 1));
      };
      forward(req, res, body, chosen, next);
    });
  })
  .on('upgrade', (req, socket) => {
    // WebSocket 미지원 프로바이더 — 리스너가 없으면 Node가 소켓을 조용히 destroy해
    // 클라이언트가 ECONNRESET만 보고 hang으로 인식한다. 명시적으로 거부.
    socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n{"detail":"websocket not supported by commandcode provider"}');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(
      `cc-proxy on http://127.0.0.1:${PORT} accounts=${keys.map((k) => `${k.acct}:${mask(k.key)}`).join(', ')}`,
    );
    setInterval(loadFromDb, 5000);
  });

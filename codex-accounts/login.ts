#!/usr/bin/env node
// ChatGPT 계정 디바이스 로그인 — codex-lb 없이 직접 OAuth (codex-lb oauth.py 계약 그대로).
//
// 사용:
//   node ~/.codex-accounts/login.ts          # 빈 슬롯(a/b/c)에 자동 등록
//   node ~/.codex-accounts/login.ts b        # 특정 슬롯에 등록 (덮어쓰기)
//
// 플로우:
//   deviceauth/usercode → 브라우저에서 https://auth.openai.com/codex/device 에
//   코드 입력 → 폴링(deviceauth/token) → authorization_code면 PKCE 교환,
//   아니면 토큰 직접 수신 → accounts.db에 암호화 저장 (Fernet + encryption.key).
//
// 설정: CODEX_ACCOUNTS_DIR (기본 ~/Documents/codex-accounts, accounts.db)
// 의존성: Node 18+ (내장 fetch/crypto/sqlite만 사용)

import { randomUUID } from 'node:crypto';
import { initDb, listAccounts, upsertAccount } from './db.ts';

const AUTH_BASE = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const VERIFY_URL = `${AUTH_BASE}/codex/device`;
const SLOTS = ['a', 'b', 'c'];
const DEFAULT_EXPIRES = 900;
// Cloudflare가 기본 UA 차단(530 cf_route_error) → 브라우저 UA 필수
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function post(
  url: string,
  payload: Record<string, string>,
  { form = false, timeout = 30000 }: { form?: boolean; timeout?: number } = {},
): Promise<{ status: number; data: Record<string, any> }> {
  const headers = { 'User-Agent': BROWSER_UA };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  return { status: res.status, data };
}

async function startDeviceFlow(): Promise<{ userCode: string; deviceAuthId: string; interval: number; expiresIn: number }> {
  const { status, data } = await post(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID });
  if (status >= 400) throw new Error(`deviceauth/usercode HTTP ${status}: ${JSON.stringify(data)}`);
  const userCode = data.user_code;
  const deviceAuthId = data.device_auth_id;
  if (!userCode || !deviceAuthId) throw new Error(`deviceauth 응답 필드 누락: ${JSON.stringify(data)}`);
  const interval = Math.max(Number(data.interval ?? 5) || 5, 1);
  let expiresIn = Number(data.expires_in ?? 0) || 0;
  if (expiresIn <= 0) {
    const at = Number(data.expires_at);
    expiresIn = Number.isFinite(at) && at > 0 ? Math.max(Math.floor(at / 1000 - Date.now() / 1000), 1) : DEFAULT_EXPIRES;
  }
  return { userCode, deviceAuthId, interval, expiresIn };
}

function isPending(data: Record<string, any>): boolean {
  const err = data.error ?? {};
  const code = typeof err === 'object' ? (err.code ?? '') : String(err);
  const status = String(data.status ?? '').toLowerCase();
  return String(code).toLowerCase() === 'authorization_pending' || String(code).toLowerCase() === 'slow_down' ||
    status === 'pending' || status === 'authorization_pending';
}

function errorCode(data: Record<string, any>): string {
  const err = data.error ?? {};
  return typeof err === 'object' ? String(err.code ?? err.message ?? '') : String(err);
}

async function exchangeCode(code: string, codeVerifier: string): Promise<Record<string, any>> {
  const { status, data } = await post(
    `${AUTH_BASE}/oauth/token`,
    { grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI },
    { form: true },
  );
  if (status >= 400) throw new Error(`oauth/token HTTP ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function pollDevice(
  deviceAuthId: string,
  userCode: string,
  interval: number,
  expiresIn: number,
): Promise<Record<string, any>> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    const { status, data } = await post(
      `${AUTH_BASE}/api/accounts/deviceauth/token`,
      { device_auth_id: deviceAuthId, user_code: userCode },
    );
    // 실측: pending 상태가 HTTP 403 + deviceauth_authorization_pending으로 온다.
    // codex-lb도 403/404는 None 반환 후 재시도 (만료/거부는 코드 필드로 구분).
    if (status === 403 || status === 404) {
      const code = errorCode(data).toLowerCase();
      if (code.includes('pending') || code.includes('slow_down')) { await sleep(interval); continue; }
      if (code.includes('expired') || code.includes('denied') || code.includes('invalid') || code.includes('cancel')) {
        throw new Error(`로그인 거부/만료 (${errorCode(data)}) — 다시 시도하세요`);
      }
      await sleep(interval); // 알 수 없는 403/404 → 데드라인까지 재시도
      continue;
    }
    if (status >= 400) {
      if (isPending(data)) { await sleep(interval); continue; }
      throw new Error(`deviceauth/token HTTP ${status}: ${JSON.stringify(data)}`);
    }
    if (data.authorization_code && data.code_verifier) return exchangeCode(data.authorization_code, data.code_verifier);
    if (data.access_token && data.refresh_token && data.id_token) return data;
    if (isPending(data)) { await sleep(interval); continue; }
    throw new Error(`deviceauth/token 응답 해석 불가: ${JSON.stringify(data)}`);
  }
  throw new Error('로그인 시간 초과 — 다시 시도하세요');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeIdToken(idToken: string): { email: string | null; accountId: string | null; plan: string | null } {
  try {
    let payload = idToken.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    const auth = claims['https://api.openai.com/auth'] ?? {};
    return {
      email: claims.email ?? null,
      accountId: auth.chatgpt_account_id ?? claims.chatgpt_account_id ?? null,
      plan: auth.chatgpt_plan_type ?? claims.chatgpt_plan_type ?? null,
    };
  } catch {
    return { email: null, accountId: null, plan: null };
  }
}

function main(): void {
  const slot = process.argv[2] ?? null;
  if (slot !== null && !SLOTS.includes(slot)) {
    console.error(`슬롯은 a/b/c 중 하나 (기본: 빈 슬롯 자동) — 받은 값: ${slot}`);
    process.exit(2);
  }
  initDb();
  const existing = new Set(listAccounts('chatgpt').map((a) => a.slot));
  let target = slot;
  if (target === null) {
    target = SLOTS.find((s) => !existing.has(s)) ?? null;
    if (target === null) {
      console.error('모든 슬롯(a/b/c)이 사용 중 — 덮어쓸 슬롯을 인자로 지정하세요');
      process.exit(2);
    }
  }

  startDeviceFlow()
    .then(async ({ userCode, deviceAuthId, interval, expiresIn }) => {
      console.log();
      console.log(`1) 브라우저에서 열기: ${VERIFY_URL}`);
      console.log(`2) 코드 입력: ${userCode}`);
      console.log(`   (유효 ${Math.floor(expiresIn / 60)}분, ${interval}초 간격으로 확인 중...)`);
      console.log();
      const tokens = await pollDevice(deviceAuthId, userCode, interval, expiresIn);
      const claims = decodeIdToken(tokens.id_token);
      const accountId = tokens.account_id ?? claims.accountId ?? '';
      const email = claims.email ?? `slot-${target}`;
      const installId = randomUUID();

      upsertAccount({
        pool: 'chatgpt',
        slot: target,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accountId,
        installId,
        email,
        planType: claims.plan,
      });
      console.log(`[${target}] ${email} (${claims.plan ?? 'unknown'}) 등록 완료 → accounts.db`);
      console.log("프록시는 5초 내 핫리로드됨 (proxy.log에서 로드 확인)");
    })
    .catch((err) => {
      console.error(`실패: ${err.message}`);
      process.exit(1);
    });
}

main();

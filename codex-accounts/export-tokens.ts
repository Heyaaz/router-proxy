#!/usr/bin/env node
// ChatGPT 토큰 갱신 — SQLite 기반
//
// 사용:
//   node ~/.codex-accounts/export-tokens.ts --refresh
//       accounts.db(chatgpt)의 refresh 토큰으로 auth.openai.com OAuth 갱신
//       → token/refresh 회전 저장 (refresh 토큰은 1회성)
//       계정 추가는 login.ts 사용.
//
// 설정: CODEX_ACCOUNTS_DIR (기본 ~/Documents/codex-accounts)

import { initDb, listAccounts, upsertAccount } from './db.ts';

const AUTH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function postJson(url: string, payload: Record<string, string>, timeout = 30000): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function decodeIdToken(idToken: string): { email: string | null; plan: string | null } {
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const auth = claims['https://api.openai.com/auth'] ?? {};
    return {
      email: claims.email ?? null,
      plan: auth.chatgpt_plan_type ?? claims.chatgpt_plan_type ?? null,
    };
  } catch {
    return { email: null, plan: null };
  }
}

async function refreshSlot(slot: string): Promise<{ email: string | null; plan: string | null }> {
  const acct = listAccounts('chatgpt').find((a) => a.slot === slot);
  if (!acct || !acct.refresh_token) {
    throw new Error(`chatgpt/${slot} refresh 토큰 없음 — login.ts로 계정 등록`);
  }
  const data = await postJson(AUTH_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: acct.refresh_token,
    scope: SCOPE,
  });
  if (!data.access_token || !data.refresh_token || !data.id_token) {
    throw new Error(`갱신 응답에 토큰 누락: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const claims = decodeIdToken(data.id_token);
  upsertAccount({
    pool: 'chatgpt',
    slot,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: claims.email ?? acct.email,
    planType: claims.plan ?? acct.plan_type,
  });
  return claims;
}

async function refreshAll(): Promise<void> {
  const active = listAccounts('chatgpt').filter((a) => a.refresh_token);
  if (active.length === 0) {
    console.error('accounts.db에 refresh 토큰을 가진 chatgpt 계정 없음 — login.ts로 계정 등록');
    process.exit(1);
  }
  for (const acct of active) {
    try {
      const claims = await refreshSlot(acct.slot);
      console.log(`[${acct.slot}] ${claims.email ?? acct.email ?? '?'} (${claims.plan ?? 'unknown'}) refreshed`);
    } catch (err) {
      console.error(`[${acct.slot}] 실패: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`refreshed ${active.length} accounts (accounts.db)`);
}

const args = process.argv.slice(2);
if (args.includes('--refresh')) {
  initDb();
  refreshAll().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  console.log('사용: node export-tokens.ts --refresh');
}

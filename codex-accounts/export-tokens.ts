#!/usr/bin/env node
// ChatGPT 토큰 갱신/이전 — Node 전용 (외부 패키지 없음).
//
// 사용:
//   node ~/.codex-accounts/export-tokens.ts --refresh
//       각 슬롯(CODEX_ACCOUNTS_DIR/{a,b,c}/refresh)의 refresh 토큰으로
//       auth.openai.com OAuth 갱신 → token/refresh 교체 (refresh 토큰은 1회성이라 회전 저장).
//       계정 추가는 login.ts 사용.
//
//   node ~/.codex-accounts/export-tokens.ts
//       (구형 이전용) codex-lb store.db에서 token/refresh/id/install-id/email을 이전.
//       store.db의 Fernet 암호화는 node:crypto로 직접 복호화 (AES-128-CBC + HMAC-SHA256).
//
// 설정:
//   CODEX_ACCOUNTS_DIR  슬롯 디렉토리 (기본 ~/Documents/codex-accounts)
//   CODEX_LB_DATA_DIR   (이전 모드) codex-lb 데이터 디렉토리 (기본 ~/.codex-lb)

import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OUT_DIR = process.env.CODEX_ACCOUNTS_DIR ?? `${homedir()}/Documents/codex-accounts`;
const DATA_DIR = process.env.CODEX_LB_DATA_DIR ?? `${homedir()}/.codex-lb`;
const SLOTS = ['a', 'b', 'c'];

const AUTH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email';
// Cloudflare가 기본 UA 차단(530 cf_route_error) → 브라우저 UA 필수
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

// Fernet 복호화 (codex-lb가 store.db에 쓰는 포맷): BLOB = base64 텍스트 → base64url(version|ts|IV|ciphertext|HMAC)
function fernetDecrypt(keyB64: string, tokenBuf: Uint8Array): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`Fernet 키 길이 이상: ${key.length} (기대 32)`);
  const signingKey = key.subarray(0, 16);
  const encKey = key.subarray(16, 32);
  const data = Buffer.from(Buffer.from(tokenBuf).toString('utf8'), 'base64');
  if (data.length < 57 || data[0] !== 0x80) throw new Error('Fernet 토큰 형식 이상');
  const iv = data.subarray(9, 25);
  const ciphertext = data.subarray(25, data.length - 32);
  const hmac = data.subarray(data.length - 32);
  const expected = createHmac('sha256', signingKey).update(data.subarray(0, data.length - 32)).digest();
  if (expected.length !== hmac.length || !timingSafeEqual(expected, hmac)) throw new Error('Fernet HMAC 불일치');
  const decipher = createDecipheriv('aes-128-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function refreshSlot(slotDir: string): Promise<{ email: string | null; plan: string | null }> {
  const refreshFile = join(slotDir, 'refresh');
  if (!existsSync(refreshFile)) throw new Error('refresh 토큰 없음 — login.ts로 계정 등록 또는 store.db 이전 실행');
  const rt = readFileSync(refreshFile, 'utf8').trim();
  const data = await postJson(AUTH_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: rt,
    scope: SCOPE,
  });
  if (!data.access_token || !data.refresh_token || !data.id_token) {
    throw new Error(`갱신 응답에 토큰 누락: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const claims = decodeIdToken(data.id_token);
  writeFileSync(join(slotDir, 'token'), data.access_token);
  writeFileSync(join(slotDir, 'refresh'), data.refresh_token);
  if (claims.email) writeFileSync(join(slotDir, 'email'), claims.email);
  for (const name of ['token', 'refresh', 'email']) {
    const p = join(slotDir, name);
    if (existsSync(p)) chmodSync(p, 0o600);
  }
  return claims;
}

async function refreshAll(): Promise<void> {
  const active = SLOTS.filter((s) => existsSync(join(OUT_DIR, s, 'refresh')));
  if (active.length === 0) {
    console.error(`${OUT_DIR} 에 refresh 토큰을 가진 슬롯 없음 — login.ts로 계정 등록`);
    process.exit(1);
  }
  for (const slot of active) {
    try {
      const claims = await refreshSlot(join(OUT_DIR, slot));
      console.log(`[${slot}] ${claims.email ?? '?'} (${claims.plan ?? 'unknown'}) refreshed`);
    } catch (err) {
      console.error(`[${slot}] 실패: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`refreshed ${active.length} slots -> ${OUT_DIR}`);
}

function importFromStoreDb(): void {
  const dbPath = join(DATA_DIR, 'store.db');
  const keyPath = join(DATA_DIR, 'encryption.key');
  if (!existsSync(dbPath) || !existsSync(keyPath)) {
    console.error(`store.db/encryption.key not found under ${DATA_DIR}`);
    console.error('CODEX_LB_DATA_DIR 환경변수로 codex-lb 데이터 디렉토리 지정');
    process.exit(1);
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    'select email, chatgpt_account_id, codex_installation_id, plan_type, ' +
      'access_token_encrypted, refresh_token_encrypted from accounts order by email',
  ).all() as Array<Record<string, any>>;
  db.close();
  if (rows.length === 0) {
    console.error('no accounts in store.db');
    process.exit(1);
  }
  if (rows.length > SLOTS.length) {
    console.error(`warning: ${rows.length} accounts > ${SLOTS.length} slots; extra accounts ignored`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  rows.slice(0, SLOTS.length).forEach((row, i) => {
    const slot = SLOTS[i];
    const slotDir = join(OUT_DIR, slot);
    mkdirSync(slotDir, { recursive: true });
    const files = {
      token: fernetDecrypt(key, row.access_token_encrypted),
      refresh: fernetDecrypt(key, row.refresh_token_encrypted),
      id: row.chatgpt_account_id ?? '',
      'install-id': row.codex_installation_id ?? '',
      email: row.email ?? '',
    };
    for (const [name, value] of Object.entries(files)) {
      const p = join(slotDir, name);
      writeFileSync(p, value);
      chmodSync(p, 0o600);
    }
    console.log(`[${slot}] ${row.email} (${row.plan_type})`);
  });
  console.log(`imported ${Math.min(rows.length, SLOTS.length)} accounts -> ${OUT_DIR}`);
}

const args = process.argv.slice(2);
if (args.includes('--refresh')) {
  refreshAll().catch((err) => { console.error(err.message); process.exit(1); });
} else if (args.length > 0) {
  console.error(`알 수 없는 인자: ${args.join(' ')} (지원: --refresh)`);
  process.exit(2);
} else {
  importFromStoreDb();
}

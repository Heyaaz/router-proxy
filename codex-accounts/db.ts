#!/usr/bin/env node
// SQLite 계정/사용량 저장소 (router-proxy)
//
// - accounts: ChatGPT 토큰 + Command Code 키 (Fernet 암호화, encryption.key 분리)
// - usage_snapshots: 사용량/리셋일 히스토리 (평문 — 시크릿 아님)
//
// 암호화: codex-lb와 동일한 Fernet (AES-128-CBC + HMAC-SHA256), 키는 DB와
// 분리된 encryption.key 파일 (chmod 600). 키가 없으면 자동 생성.

import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Pool = 'chatgpt' | 'commandcode';
export type AccountRow = {
  id: number;
  pool: Pool;
  slot: string;
  label: string | null;
  access_token: string | null;   // 복호화된 값 (메모리)
  refresh_token: string | null;
  account_id: string | null;
  email: string | null;
  install_id: string | null;
  plan_type: string | null;
  enabled: number;      // 1 = 활성, 0 = 비활성 (라우팅 제외)
  weight: number;       // 스코어 가중치 (기본 1.0)
  burn_priority: number; // 수동 우선 태우기 (기본 0, 높을수록 먼저)
  created_at: number;
  updated_at: number;
};
export type ModelRoute = {
  id: number;
  pool: Pool;
  pattern: string;      // 정규식 패턴
  priority: number;     // 낮을수록 먼저 매치
  enabled: number;
  created_at: number;
};
export type UsageRow = {
  pool: Pool;
  slot: string;
  window: string;
  used_percent: number;
  reset_at: number | null;
  window_seconds: number | null;
  fetched_at: number;
};

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***');

const DATA_DIR = process.env.CODEX_ACCOUNTS_DIR ?? `${homedir()}/Documents/codex-accounts`;
const DB_PATH = process.env.CODEX_ACCOUNTS_DB ?? join(DATA_DIR, 'accounts.db');
const KEY_PATH = process.env.CODEX_ACCOUNTS_KEY ?? join(DATA_DIR, 'encryption.key');

// ---------- Fernet ----------
// codex-lb가 쓰는 포맷과 동일: version(1) | timestamp(8) | IV(16) | ciphertext | HMAC(32)
// 키 32바이트 = 서명키 16 + 암호화키 16 (base64url)
function fernetKey(keyB64: string): { sig: Buffer; enc: Buffer } {
  const raw = Buffer.from(keyB64, 'base64');
  if (raw.length !== 32) throw new Error(`Fernet 키 길이 이상: ${raw.length}`);
  return { sig: raw.subarray(0, 16), enc: raw.subarray(16, 32) };
}

function fernetEncrypt(keyB64: string, plaintext: string): string {
  const { sig, enc } = fernetKey(keyB64);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', enc, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ts = BigInt(Math.floor(Date.now() / 1000));
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(ts);
  const hmac = createHmac('sha256', sig)
    .update(Buffer.concat([Buffer.from([0x80]), tsBuf, iv, ct]))
    .digest();
  return Buffer.concat([Buffer.from([0x80]), tsBuf, iv, ct, hmac]).toString('base64url');
}

function fernetDecrypt(keyB64: string, token: string): string {
  const { sig, enc } = fernetKey(keyB64);
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 57) throw new Error('Fernet 토큰 형식 이상');
  if (raw[0] !== 0x80) throw new Error('Fernet 버전 불일치');
  const tsBuf = raw.subarray(1, 9);
  const iv = raw.subarray(9, 25);
  const ct = raw.subarray(25, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const expected = createHmac('sha256', sig).update(raw.subarray(0, raw.length - 32)).digest();
  if (!timingSafeEqual(mac, expected)) throw new Error('Fernet HMAC 불일치');
  const decipher = createDecipheriv('aes-128-cbc', enc, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------- 키 관리 ----------
function getOrCreateKey(): string {
  if (existsSync(KEY_PATH)) {
    const k = readFileSync(KEY_PATH, 'utf8').trim();
    if (k.length >= 32) return k;
  }
  const key = randomBytes(32).toString('base64url');
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  return key;
}

// ---------- DB ----------
let _db: DatabaseSync | null = null;
let _key: string | null = null;

export function initDb(): DatabaseSync {
  if (_db) return _db;
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT NOT NULL CHECK (pool IN ('chatgpt','commandcode')),
      slot TEXT NOT NULL,
      label TEXT,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      account_id TEXT,
      email TEXT,
      install_id TEXT,
      plan_type TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(pool, slot)
    );
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT NOT NULL,
      slot TEXT NOT NULL,
      window TEXT NOT NULL,
      used_percent REAL NOT NULL,
      reset_at INTEGER,
      window_seconds INTEGER,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT NOT NULL CHECK (pool IN ('chatgpt','commandcode')),
      pattern TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_latest
      ON usage_snapshots(pool, slot, window, fetched_at DESC);
  `);
  // 기존 DB 마이그레이션: enabled/weight/burn_priority 컬럼 추가
  const cols = db.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'enabled')) db.exec(`ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  if (!cols.some((c) => c.name === 'weight')) db.exec(`ALTER TABLE accounts ADD COLUMN weight REAL NOT NULL DEFAULT 1.0`);
  if (!cols.some((c) => c.name === 'burn_priority')) db.exec(`ALTER TABLE accounts ADD COLUMN burn_priority INTEGER NOT NULL DEFAULT 0`);
  // 기본 모델 라우트 시드 (없을 때만)
  const routeCount = (db.prepare('SELECT COUNT(*) c FROM model_routes').get() as { c: number }).c;
  if (routeCount === 0) {
    const now = Math.floor(Date.now() / 1000);
    const seed = db.prepare('INSERT INTO model_routes (pool, pattern, priority, enabled, created_at) VALUES (?,?,?,?,?)');
    seed.run('chatgpt', '^(gpt-5\\.|gpt-4\\.|o[0-9]|codex-)', 10, 1, now);
    seed.run('commandcode', '.*', 999, 1, now);
  }
  _db = db;
  _key = getOrCreateKey();
  return db;
}

export function keyPath(): string { return KEY_PATH; }

// Fernet 헬퍼 (upsertAccount/listAccounts 내부에서만 사용)
function encrypt(plaintext: string): string {
  return fernetEncrypt(getKey(), plaintext);
}
function decrypt(token: string): string {
  return fernetDecrypt(getKey(), token);
}
function getKey(): string {
  if (!_key) initDb();
  return _key!;
}

// ---------- accounts ----------
export function upsertAccount(a: {
  pool: Pool;
  slot: string;
  label?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accountId?: string | null;
  email?: string | null;
  installId?: string | null;
  planType?: string | null;
  enabled?: number;
  weight?: number;
}): void {
  const db = initDb();
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT id FROM accounts WHERE pool=? AND slot=?').get(a.pool, a.slot) as { id: number } | undefined;
  const enc = (v?: string | null) => (v ? encrypt(v) : null);
  if (existing) {
    db.prepare(`
      UPDATE accounts SET
        label=COALESCE(?,label), access_token_enc=COALESCE(?,access_token_enc),
        refresh_token_enc=COALESCE(?,refresh_token_enc), account_id=COALESCE(?,account_id),
        email=COALESCE(?,email), install_id=COALESCE(?,install_id),
        plan_type=COALESCE(?,plan_type), enabled=COALESCE(?,enabled),
        weight=COALESCE(?,weight), updated_at=?
      WHERE id=?
    `).run(a.label ?? null, enc(a.accessToken), enc(a.refreshToken), a.accountId ?? null,
          a.email ?? null, a.installId ?? null, a.planType ?? null, a.enabled ?? null, a.weight ?? null, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO accounts (pool,slot,label,access_token_enc,refresh_token_enc,account_id,email,install_id,plan_type,enabled,weight,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(a.pool, a.slot, a.label ?? null, enc(a.accessToken), enc(a.refreshToken),
           a.accountId ?? null, a.email ?? null, a.installId ?? null, a.planType ?? null,
           a.enabled ?? 1, a.weight ?? 1.0, now, now);
  }
}

export function setAccountEnabled(pool: Pool, slot: string, enabled: boolean): void {
  const db = initDb();
  db.prepare('UPDATE accounts SET enabled=?, updated_at=? WHERE pool=? AND slot=?')
    .run(enabled ? 1 : 0, Math.floor(Date.now() / 1000), pool, slot);
}

export function setAccountWeight(pool: Pool, slot: string, weight: number): void {
  const db = initDb();
  db.prepare('UPDATE accounts SET weight=?, updated_at=? WHERE pool=? AND slot=?')
    .run(weight, Math.floor(Date.now() / 1000), pool, slot);
}

export function updateAccountLabel(pool: Pool, slot: string, label: string | null): void {
  const db = initDb();
  db.prepare('UPDATE accounts SET label=?, updated_at=? WHERE pool=? AND slot=?')
    .run(label, Math.floor(Date.now() / 1000), pool, slot);
}

export function listAccounts(pool?: Pool): AccountRow[] {
  const db = initDb();
  const rows = pool
    ? db.prepare('SELECT * FROM accounts WHERE pool=? ORDER BY slot').all(pool)
    : db.prepare('SELECT * FROM accounts ORDER BY pool, slot').all();
  return (rows as any[]).map((r) => ({
    id: r.id, pool: r.pool as Pool, slot: r.slot, label: r.label ?? null,
    access_token: r.access_token_enc ? decrypt(r.access_token_enc as string) : null,
    refresh_token: r.refresh_token_enc ? decrypt(r.refresh_token_enc as string) : null,
    account_id: r.account_id ?? null, email: r.email ?? null, install_id: r.install_id ?? null,
    plan_type: r.plan_type ?? null,
    enabled: (r.enabled as number) ?? 1, weight: (r.weight as number) ?? 1.0,
    burn_priority: (r.burn_priority as number) ?? 0,
    created_at: r.created_at as number, updated_at: r.updated_at as number,
  }));
}

export function setAccountBurn(pool: Pool, slot: string, burn: number): void {
  const db = initDb();
  db.prepare('UPDATE accounts SET burn_priority=?, updated_at=? WHERE pool=? AND slot=?')
    .run(burn, Math.floor(Date.now() / 1000), pool, slot);
}

// ---------- model_routes ----------
export function listModelRoutes(): ModelRoute[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM model_routes ORDER BY priority, id').all();
  return (rows as any[]).map((r) => ({
    id: r.id as number, pool: r.pool as Pool, pattern: r.pattern as string,
    priority: r.priority as number, enabled: r.enabled as number, created_at: r.created_at as number,
  }));
}

export function upsertModelRoute(r: {
  id?: number;
  pool: Pool;
  pattern: string;
  priority?: number;
  enabled?: number;
}): void {
  const db = initDb();
  const now = Math.floor(Date.now() / 1000);
  if (r.id) {
    db.prepare('UPDATE model_routes SET pool=?, pattern=?, priority=?, enabled=?, created_at=created_at WHERE id=?')
      .run(r.pool, r.pattern, r.priority ?? 100, r.enabled ?? 1, r.id);
  } else {
    db.prepare('INSERT INTO model_routes (pool, pattern, priority, enabled, created_at) VALUES (?,?,?,?,?)')
      .run(r.pool, r.pattern, r.priority ?? 100, r.enabled ?? 1, now);
  }
}

export function deleteModelRoute(id: number): void {
  const db = initDb();
  db.prepare('DELETE FROM model_routes WHERE id=?').run(id);
}

export function deleteAccount(pool: Pool, slot: string): void {
  const db = initDb();
  db.prepare('DELETE FROM accounts WHERE pool=? AND slot=?').run(pool, slot);
}

// ---------- usage ----------
export function recordUsage(rows: Omit<UsageRow, 'fetched_at'>[]): void {
  const db = initDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO usage_snapshots (pool,slot,window,used_percent,reset_at,window_seconds,fetched_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const r of rows) stmt.run(r.pool, r.slot, r.window, r.used_percent, r.reset_at, r.window_seconds, now);
}

export function latestUsage(pool?: Pool): Record<string, Record<string, UsageRow>> {
  const db = initDb();
  const rows = pool
    ? db.prepare('SELECT * FROM usage_snapshots WHERE pool=? ORDER BY fetched_at DESC').all(pool)
    : db.prepare('SELECT * FROM usage_snapshots ORDER BY fetched_at DESC').all();
  const out: Record<string, Record<string, UsageRow>> = {};
  for (const r of rows as any[]) {
    const key = `${r.pool}:${r.slot}`;
    if (!out[key]) out[key] = {};
    const w = r.window as string;
    if (!(w in out[key])) {
      out[key][w] = {
        pool: r.pool, slot: r.slot, window: w, used_percent: r.used_percent,
        reset_at: r.reset_at ?? null, window_seconds: r.window_seconds ?? null, fetched_at: r.fetched_at,
      };
    }
  }
  return out;
}

// 사용량 스코어: remaining% / max(time_to_reset, 60s)
// 높을수록 우선 — 리셋이 가깝고 사용량이 많이 남은 계정부터 태움 (쿼터 소진 방지)
// 사용량 데이터가 없으면 0 (호출자가 라운드로빈 등으로 폴백)
export function usageScore(
  usage: Record<string, Record<string, UsageRow>>,
  pool: Pool,
  slot: string,
  now: number,
): number {
  const u = usage[`${pool}:${slot}`];
  if (!u) return 0;
  const win = pool === 'chatgpt' ? 'primary' : u.weekly ? 'weekly' : 'fiveHour';
  const w = u[win];
  if (!w) return 0;
  const remaining = Math.max(0, 100 - w.used_percent);
  if (remaining <= 0) return 0;
  const ttr = w.reset_at ? Math.max(60, w.reset_at - now) : 7 * 86400;
  return remaining / ttr;
}

// CLI: node db.ts list|usage|key-path|add-commandcode <slot> <key>|del-commandcode <slot>
const args = process.argv.slice(2);
if (args.length > 0 && args[0] !== '--help') {
  if (args[0] === 'list') {
    for (const a of listAccounts()) {
      console.log(`${a.pool}/${a.slot} ${a.email ?? a.label ?? ''} plan=${a.plan_type ?? ''} token=${a.access_token ? 'yes' : 'no'} refresh=${a.refresh_token ? 'yes' : 'no'}`);
    }
  } else if (args[0] === 'usage') {
    console.log(JSON.stringify(latestUsage(), null, 2));
  } else if (args[0] === 'key-path') {
    console.log(keyPath());
  } else if (args[0] === 'add-commandcode' && args[1] && args[2]) {
    upsertAccount({ pool: 'commandcode', slot: args[1], accessToken: args[2], label: args[1] });
    console.log(`commandcode/${args[1]} 저장됨: ${mask(args[2])}`);
  } else if (args[0] === 'del-commandcode' && args[1]) {
    deleteAccount('commandcode', args[1]);
    console.log(`commandcode/${args[1]} 삭제됨`);
  } else if (args[0] === 'enable' && args[1] && args[2]) {
    setAccountEnabled(args[1] as Pool, args[2], true);
    console.log(`${args[1]}/${args[2]} 활성화됨`);
  } else if (args[0] === 'disable' && args[1] && args[2]) {
    setAccountEnabled(args[1] as Pool, args[2], false);
    console.log(`${args[1]}/${args[2]} 비활성화됨`);
  } else if (args[0] === 'weight' && args[1] && args[2] && args[3]) {
    setAccountWeight(args[1] as Pool, args[2], Number(args[3]));
    console.log(`${args[1]}/${args[2]} 가중치 ${args[3]}`);
  } else if (args[0] === 'label' && args[1] && args[2] && args[3]) {
    updateAccountLabel(args[1] as Pool, args[2], args[3]);
    console.log(`${args[1]}/${args[2]} 라벨: ${args[3]}`);
  } else if (args[0] === 'del' && args[1] && args[2]) {
    deleteAccount(args[1] as Pool, args[2]);
    console.log(`${args[1]}/${args[2]} 삭제됨`);
  } else if (args[0] === 'burn' && args[1] && args[2] && args[3]) {
    setAccountBurn(args[1] as Pool, args[2], Number(args[3]));
    console.log(`${args[1]}/${args[2]} 우선순위 ${args[3]}`);
  } else if (args[0] === 'routes') {
    for (const r of listModelRoutes()) {
      console.log(`#${r.id} [${r.pool}] ${r.pattern} (priority=${r.priority}, ${r.enabled ? 'on' : 'off'})`);
    }
  } else if (args[0] === 'route-add' && args[1] && args[2]) {
    upsertModelRoute({ pool: args[1] as Pool, pattern: args[2], priority: Number(args[3] ?? 100) });
    console.log(`라우트 추가: ${args[1]} ${args[2]}`);
  } else if (args[0] === 'route-del' && args[1]) {
    deleteModelRoute(Number(args[1]));
    console.log(`라우트 #${args[1]} 삭제`);
  }
}

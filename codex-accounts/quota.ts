#!/usr/bin/env node
// 사용량 수집기 — SQLite accounts에서 토큰/키를 읽어 두 풀의 사용량을
// usage_snapshots 테이블에 기록.
//
//   ChatGPT:      GET /backend-api/wham/usage (Bearer + chatgpt-account-id)
//   Command Code: GET /alpha/whoami + /alpha/billing/credits (x-api-key)
//
// 사용:
//   node ~/.codex-accounts/quota.ts            # 1회 수집
//   node ~/.codex-accounts/quota.ts --loop     # 5분 간격 무한 수집
//   node ~/.codex-accounts/quota.ts --watch    # proxy.ts가 import해서 사용 (수출)

import { initDb, listAccounts, recordUsage } from './db.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const INTERVAL_MS = 5 * 60 * 1000;

export type UsageSample = {
  pool: 'chatgpt' | 'commandcode';
  slot: string;
  window: string;
  used_percent: number;
  reset_at: number | null;
  window_seconds: number | null;
};

async function fetchChatgpt(account: { access_token: string; account_id: string | null }): Promise<UsageSample[]> {
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      Accept: 'application/json',
      ...(account.account_id ? { 'chatgpt-account-id': account.account_id } : {}),
      'User-Agent': UA,
    },
  });
  if (res.status !== 200) throw new Error(`wham/usage HTTP ${res.status}`);
  const j = (await res.json()) as any;
  const rl = j.rate_limit ?? {};
  const out: UsageSample[] = [];
  for (const [win, key] of [
    ['primary', 'primary_window'],
    ['secondary', 'secondary_window'],
  ] as const) {
    const w = rl[key];
    if (w?.used_percent != null) {
      out.push({
        pool: 'chatgpt', slot: '', window: win,
        used_percent: Number(w.used_percent),
        reset_at: w.reset_at ?? null,
        window_seconds: w.limit_window_seconds ?? null,
      });
    }
  }
  return out;
}

async function fetchCommandCode(key: string): Promise<UsageSample[]> {
  const who = await fetch('https://api.commandcode.ai/alpha/whoami', {
    headers: { 'x-api-key': key, 'User-Agent': UA },
  });
  const whoJson = (await who.json()) as any;
  const display = whoJson?.user?.userName ?? whoJson?.user?.name ?? null;
  const res = await fetch('https://api.commandcode.ai/alpha/billing/credits', {
    headers: { 'x-api-key': key, 'User-Agent': UA },
  });
  if (res.status !== 200) throw new Error(`billing/credits HTTP ${res.status}`);
  const j = (await res.json()) as any;
  const limits = j.windowLimits ?? {};
  const out: UsageSample[] = [];
  for (const win of ['weekly', 'fiveHour'] as const) {
    const w = limits[win];
    if (w?.used != null && w?.cap) {
      out.push({
        pool: 'commandcode', slot: '', window: win,
        used_percent: Number(((Number(w.used) / Number(w.cap)) * 100).toFixed(2)),
        reset_at: w.resetAt ? Math.floor(Number(w.resetAt) / 1000) : null, // ms → s
        window_seconds: win === 'weekly' ? 7 * 86400 : 5 * 3600,
      });
    }
  }
  return out;
}

export async function collectOnce(): Promise<UsageSample[]> {
  initDb();
  const all: UsageSample[] = [];
  const errors: string[] = [];
  for (const acct of listAccounts('chatgpt')) {
    if (!acct.access_token) continue;
    try {
      const samples = await fetchChatgpt(acct);
      for (const s of samples) all.push({ ...s, slot: acct.slot });
      console.log(`chatgpt/${acct.slot} 수집 완료 (${samples.map((s) => `${s.window}=${s.used_percent}%`).join(', ')})`);
    } catch (e: any) {
      errors.push(`chatgpt/${acct.slot}: ${e.message}`);
      console.error(`chatgpt/${acct.slot} 실패: ${e.message}`);
    }
  }
  for (const acct of listAccounts('commandcode')) {
    if (!acct.access_token) continue;
    try {
      const samples = await fetchCommandCode(acct.access_token);
      for (const s of samples) all.push({ ...s, slot: acct.slot });
      console.log(`commandcode/${acct.slot} 수집 완료 (${samples.map((s) => `${s.window}=${s.used_percent}%`).join(', ')})`);
    } catch (e: any) {
      errors.push(`commandcode/${acct.slot}: ${e.message}`);
      console.error(`commandcode/${acct.slot} 실패: ${e.message}`);
    }
  }
  if (all.length) recordUsage(all);
  return all;
}

const args = process.argv.slice(2);
if (args.includes('--loop')) {
  const run = async () => {
    try {
      await collectOnce();
    } catch (e: any) {
      console.error('수집 오류:', e.message);
    }
  };
  run();
  setInterval(run, INTERVAL_MS);
  console.log(`quota 수집기 시작: 5분 간격 (${new Date().toISOString()})`);
} else if (!args.includes('--watch')) {
  collectOnce().then((all) => {
    console.log(`총 ${all.length}개 샘플 저장`);
    process.exit(0);
  });
}

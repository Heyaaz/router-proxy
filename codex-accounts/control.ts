#!/usr/bin/env node
// 제어 API 서버 (router-proxy) — 가벼운 계정/라우팅 제어 + QuotaBar 호환
//
//   GET  /api/accounts                      → 계정 목록 (QuotaBar 호환 스키마)
//   GET  /api/usage                         → 최근 사용량 스냅샷
//   POST /api/accounts/:pool/:slot/enabled  → body {enabled:true|false} 비활성/재활성
//   POST /api/accounts/:pool/:slot/weight   → body {weight:0.5} 가중치
//   POST /api/accounts/:pool/:slot/label    → body {label:"..."} 라벨
//   DELETE /api/accounts/:pool/:slot        → 계정 삭제
//   GET  /api/health                        → 상태
//
// 사용: node ~/.codex-accounts/control.ts  (포트: CONTROL_PORT ?? 9092)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDb, listAccounts, latestUsage, setAccountEnabled, setAccountWeight, updateAccountLabel, deleteAccount, setAccountBurn, listProviders, upsertProvider, deleteProvider, upsertAccount } from './db.ts';
import type { Pool } from './db.ts';

const PORT = Number(process.env.CONTROL_PORT ?? 9092);

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// QuotaBar 호환: /api/accounts — status="active", usage.{primary,secondary}RemainingPercent, resetAtSecondary ISO8601
function accountsResponse(): unknown {
  const usage = latestUsage();
  const now = Date.now() / 1000;
  const providers = listProviders();
  return {
    providers: providers.map((p) => ({ id: p.id, name: p.name, modelPattern: p.model_pattern })),
    accounts: listAccounts().map((a) => {
      const u = usage[`${a.pool}:${a.slot}`];
      const win = a.pool === 'chatgpt' ? 'primary' : u?.weekly ? 'weekly' : 'fiveHour';
      const w = u?.[win as string];
      const remaining = w ? Math.max(0, 100 - w.used_percent) : null;
      const shortName = (a.label ?? a.email ?? a.slot).split('@')[0].slice(0, 14);
      const prov = providers.find((p) => p.id === a.pool);
      return {
        accountId: a.slot,
        pool: a.pool,
        providerName: prov?.name ?? a.pool,
        email: a.email,
        alias: a.label,
        displayName: shortName,
        status: a.enabled ? 'active' : 'disabled',
        usage: {
          primaryRemainingPercent: a.pool === 'chatgpt' ? remaining : null,
          secondaryRemainingPercent: a.pool === 'commandcode' ? remaining : null,
        },
        resetAtSecondary: w?.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
        windowMinutesSecondary: w?.window_seconds ? Math.round(w.window_seconds / 60) : null,
        planType: a.plan_type,
        weight: a.weight,
        burnPriority: a.burn_priority,
      };
    }),
  };
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    const m = path.match(/^\/api\/accounts\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/(enabled|weight|label)$/);
    const del = path.match(/^\/api\/accounts\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // 칸반 대시보드 (정적 HTML)
        const html = readFileSync(process.env.CODEX_DASHBOARD ?? join(homedir(), '.codex-accounts', 'dashboard.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      } else if (req.method === 'GET' && path === '/api/accounts') {
        json(res, 200, accountsResponse());
      } else if (req.method === 'GET' && path === '/api/usage') {
        json(res, 200, latestUsage());
      } else if (req.method === 'GET' && path === '/api/health') {
        const accs = listAccounts();
        json(res, 200, {
          ok: true,
          accounts: accs.length,
          chatgpt: accs.filter((a) => a.pool === 'chatgpt').length,
          commandcode: accs.filter((a) => a.pool === 'commandcode').length,
          usageSnapshots: Object.keys(latestUsage()).length,
          ts: Date.now(),
        });
      } else if (req.method === 'GET' && path === '/api/providers') {
        json(res, 200, { providers: listProviders() });
      } else if (req.method === 'POST' && path === '/api/providers') {
        const body = await readBody(req);
        if (!body.id || !body.name || !body.baseUrl) return json(res, 400, { error: 'id, name, baseUrl required' });
        try { new RegExp(body.modelPattern ?? '.*'); } catch { return json(res, 400, { error: 'invalid modelPattern regex' }); }
        upsertProvider({
          id: String(body.id),
          name: String(body.name),
          baseUrl: String(body.baseUrl),
          pathPrefix: String(body.pathPrefix ?? '/provider/v1'),
          authHeader: String(body.authHeader ?? 'x-api-key'),
          accountIdHeader: body.accountIdHeader ? String(body.accountIdHeader) : null,
          modelPattern: String(body.modelPattern ?? '.*'),
          enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
        });
        json(res, 200, { ok: true });
      } else if (req.method === 'DELETE' && path.match(/^\/api\/providers\/[a-z0-9_-]+$/)) {
        deleteProvider(String(path.split('/').pop()));
        json(res, 200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/accounts') {
        // 업체에 계정 추가: {providerId, slot, token, refresh?, accountId?, email?}
        const body = await readBody(req);
        if (!body.providerId || !body.slot || !body.token) return json(res, 400, { error: 'providerId, slot, token required' });
        upsertAccount({
          pool: body.providerId as Pool,
          slot: String(body.slot),
          accessToken: String(body.token),
          refreshToken: body.refresh ? String(body.refresh) : null,
          accountId: body.accountId ? String(body.accountId) : null,
          email: body.email ? String(body.email) : null,
        });
        json(res, 200, { ok: true });
      } else if (req.method === 'POST' && path.match(/^\/api\/accounts\/[a-z0-9_-]+\/[a-z0-9_-]+\/burn$/)) {
        const [, pool, slot] = path.match(/^\/api\/accounts\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/burn$/)!;
        const body = await readBody(req);
        const burn = Number(body.burn ?? 0);
        if (!Number.isFinite(burn) || burn < 0) return json(res, 400, { error: 'burn must be >= 0' });
        setAccountBurn(pool as Pool, slot, burn);
        json(res, 200, { ok: true, pool, slot, burn });
      } else if (req.method === 'POST' && m) {
        const [, pool, slot, action] = m;
        const body = await readBody(req);
        if (action === 'enabled') {
          setAccountEnabled(pool as Pool, slot, !!body.enabled);
          json(res, 200, { ok: true, pool, slot, enabled: !!body.enabled });
        } else if (action === 'weight') {
          const w = Number(body.weight);
          if (!Number.isFinite(w) || w <= 0) return json(res, 400, { error: 'weight must be > 0' });
          setAccountWeight(pool as Pool, slot, w);
          json(res, 200, { ok: true, pool, slot, weight: w });
        } else if (action === 'label') {
          updateAccountLabel(pool as Pool, slot, String(body.label ?? ''));
          json(res, 200, { ok: true, pool, slot, label: String(body.label ?? '') });
        }
      } else if (req.method === 'DELETE' && del) {
        const [, pool, slot] = del;
        deleteAccount(pool as Pool, slot);
        json(res, 200, { ok: true, pool, slot, deleted: true });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e: any) {
      json(res, 500, { error: e.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`control-api on http://127.0.0.1:${PORT}`);
  });

initDb();

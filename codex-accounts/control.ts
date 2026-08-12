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
import { initDb, listAccounts, latestUsage, setAccountEnabled, setAccountWeight, updateAccountLabel, deleteAccount, setAccountBurn, listModelRoutes, upsertModelRoute, deleteModelRoute } from './db.ts';
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
  return {
    accounts: listAccounts().map((a) => {
      const u = usage[`${a.pool}:${a.slot}`];
      const win = a.pool === 'chatgpt' ? 'primary' : u?.weekly ? 'weekly' : 'fiveHour';
      const w = u?.[win as string];
      const remaining = w ? Math.max(0, 100 - w.used_percent) : null;
      const shortName = (a.label ?? a.email ?? a.slot).split('@')[0].slice(0, 14);
      return {
        accountId: a.slot,
        pool: a.pool,
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
    const m = path.match(/^\/api\/accounts\/(chatgpt|commandcode)\/([a-z0-9_-]+)\/(enabled|weight|label)$/);
    const del = path.match(/^\/api\/accounts\/(chatgpt|commandcode)\/([a-z0-9_-]+)$/);

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
      } else if (req.method === 'GET' && path === '/api/models') {
        json(res, 200, { routes: listModelRoutes() });
      } else if (req.method === 'POST' && path === '/api/models') {
        const body = await readBody(req);
        if (!body.pool || !body.pattern) return json(res, 400, { error: 'pool and pattern required' });
        try { new RegExp(body.pattern); } catch { return json(res, 400, { error: 'invalid regex' }); }
        upsertModelRoute({
          id: body.id ? Number(body.id) : undefined,
          pool: body.pool as Pool,
          pattern: String(body.pattern),
          priority: body.priority !== undefined ? Number(body.priority) : 100,
          enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
        });
        json(res, 200, { ok: true });
      } else if (req.method === 'DELETE' && path.match(/^\/api\/models\/\d+$/)) {
        deleteModelRoute(Number(path.split('/').pop()));
        json(res, 200, { ok: true });
      } else if (req.method === 'POST' && path.match(/^\/api\/accounts\/(chatgpt|commandcode)\/[a-z0-9_-]+\/burn$/)) {
        const [, pool, slot] = path.match(/^\/api\/accounts\/(chatgpt|commandcode)\/([a-z0-9_-]+)\/burn$/)!;
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

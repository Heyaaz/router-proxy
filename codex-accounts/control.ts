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
import { createHash, randomUUID } from 'node:crypto';
import { initDb, listAccounts, latestUsage, setAccountEnabled, setAccountWeight, updateAccountLabel, deleteAccount, setAccountBurn, listProviders, upsertProvider, deleteProvider, upsertAccount } from './db.ts';
import type { Pool } from './db.ts';

const PORT = Number(process.env.CONTROL_PORT ?? 9092);

// ---------- OAuth 디바이스 플로우 (login.ts와 동일한 실제 ChatGPT PKCE) ----------
const AUTH_BASE = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const VERIFY_URL = `${AUTH_BASE}/codex/device`;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type OAuthSession = {
  providerId: string;
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresIn: number;
  deadline: number;
  slot: string;
  pending: boolean;
  done: boolean;
};
const oauthSessions = new Map<string, OAuthSession>();

async function oauthPost(url: string, payload: Record<string, string>, { form = false } = {}): Promise<{ status: number; data: Record<string, any> }> {
  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
  let body: string;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data: Record<string, any>;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  return { status: res.status, data };
}

function oauthPending(data: Record<string, any>): boolean {
  const err = data.error ?? {};
  const code = typeof err === 'object' ? String(err.code ?? '') : String(err);
  const status = String(data.status ?? '').toLowerCase();
  return code.toLowerCase() === 'authorization_pending' || code.toLowerCase() === 'slow_down' ||
    status === 'pending' || status === 'authorization_pending';
}

function oauthErrorCode(data: Record<string, any>): string {
  const err = data.error ?? {};
  return typeof err === 'object' ? String(err.code ?? err.message ?? '') : String(err);
}

function decodeIdToken(idToken: string): { email: string | null; accountId: string | null; plan: string | null } {
  try {
    const payload = idToken.split('.')[1]!;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json) as Record<string, any>;
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

// ---------- 업체 프리셋 (빠른 추가용) ----------
// authMode: api-key | bearer | oauth | none
const PRESETS: Record<string, {
  name: string; baseUrl: string; pathPrefix: string; authHeader: string; authMode: string;
  modelPattern?: string; accountIdHeader?: string | null;
}> = {
  'opencode-go': { name: 'OpenCode Go', baseUrl: 'https://api.opencode.ai', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'bearer', modelPattern: '^opencode' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'bearer', modelPattern: '^deepseek' },
  kimi: { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'bearer', modelPattern: '^kimi|^moonshot' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'bearer', modelPattern: '.*' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'bearer', modelPattern: '.*' },
  ollama: { name: 'Ollama (로컬)', baseUrl: 'http://127.0.0.1:11434', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'none', modelPattern: '.*' },
  'lm-studio': { name: 'LM Studio (로컬)', baseUrl: 'http://127.0.0.1:1234', pathPrefix: '/v1', authHeader: 'authorization', authMode: 'none', modelPattern: '.*' },
  'command-code': { name: 'Command Code', baseUrl: 'https://api.commandcode.ai', pathPrefix: '/provider/v1', authHeader: 'x-api-key', authMode: 'api-key', modelPattern: '.*' },
};

// ---------- OAuth 디바이스 코드 진행 상태 (인메모리, 108줄의 낡은 선언 제거) ----------

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
      } else if (req.method === 'GET' && path === '/api/presets') {
        json(res, 200, { presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })) });
      } else if (req.method === 'POST' && path === '/api/providers/preset') {
        const body = await readBody(req);
        const preset = PRESETS[String(body.id ?? '')];
        if (!preset) return json(res, 404, { error: 'unknown preset: ' + body.id });
        upsertProvider({ ...preset, id: String(body.id) });
        json(res, 200, { ok: true, id: String(body.id), ...preset });
      } else if (req.method === 'POST' && path === '/api/oauth/start') {
        // OAuth 디바이스 코드 시작: {providerId, slot} → {userCode, verificationUri, interval, expiresIn}
        const body = await readBody(req);
        const pid = String(body.providerId ?? '');
        const slot = String(body.slot ?? 'a');
        const provider = listProviders().find((p) => p.id === pid);
        if (!provider) return json(res, 404, { error: 'provider not found: ' + pid });
        if (provider.auth_mode !== 'oauth') return json(res, 400, { error: pid + ' is not oauth provider' });
        try {
          const { status, data } = await oauthPost(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID });
          if (status >= 400) throw new Error(`deviceauth/usercode HTTP ${status}: ${JSON.stringify(data)}`);
          const userCode = String(data.user_code ?? '');
          const deviceAuthId = String(data.device_auth_id ?? '');
          if (!userCode || !deviceAuthId) throw new Error('deviceauth 응답 필드 누락');
          const interval = Math.max(Number(data.interval ?? 5) || 5, 1);
          let expiresIn = Number(data.expires_in ?? 0) || 0;
          if (expiresIn <= 0) {
            const at = Number(data.expires_at);
            expiresIn = Number.isFinite(at) && at > 0 ? Math.max(Math.floor(at / 1000 - Date.now() / 1000), 1) : 900;
          }
          oauthSessions.set(pid, {
            providerId: pid, deviceAuthId, userCode, interval, expiresIn,
            deadline: Date.now() + expiresIn * 1000, slot, pending: true, done: false,
          });
          json(res, 200, { providerId: pid, userCode, verificationUri: VERIFY_URL, interval, expiresIn });
        } catch (e: any) {
          json(res, 502, { error: 'device code failed: ' + e.message });
        }
      } else if (req.method === 'POST' && path === '/api/oauth/poll') {
        // 폴링: {providerId} → 완료 시 {ok, slot} 아니면 pending
        const body = await readBody(req);
        const pid = String(body.providerId ?? '');
        const s = oauthSessions.get(pid);
        if (!s || s.done) return json(res, 404, { error: 'no active oauth session for ' + pid });
        if (Date.now() > s.deadline) {
          oauthSessions.delete(pid);
          return json(res, 400, { error: 'expired' });
        }
        try {
          const { status, data } = await oauthPost(
            `${AUTH_BASE}/api/accounts/deviceauth/token`,
            { device_auth_id: s.deviceAuthId, user_code: s.userCode },
          );
          if (status === 403 || status === 404) {
            const code = oauthErrorCode(data).toLowerCase();
            if (code.includes('expired') || code.includes('denied') || code.includes('invalid') || code.includes('cancel')) {
              oauthSessions.delete(pid);
              return json(res, 400, { error: 'denied or expired (' + code + ')' });
            }
            return json(res, 202, { pending: true, interval: s.interval });
          }
          if (status >= 400) {
            if (oauthPending(data)) return json(res, 202, { pending: true, interval: s.interval });
            oauthSessions.delete(pid);
            return json(res, 400, { error: 'deviceauth/token HTTP ' + status });
          }
          let tokens: Record<string, any> | null = null;
          if (data.authorization_code && data.code_verifier) {
            // PKCE 교환
            const r = await oauthPost(
              `${AUTH_BASE}/oauth/token`,
              { grant_type: 'authorization_code', client_id: CLIENT_ID, code: String(data.authorization_code), code_verifier: String(data.code_verifier), redirect_uri: REDIRECT_URI },
              { form: true },
            );
            if (r.status >= 400) {
              oauthSessions.delete(pid);
              return json(res, 400, { error: 'oauth/token HTTP ' + r.status });
            }
            tokens = r.data;
          } else if (data.access_token && data.refresh_token && data.id_token) {
            tokens = data;
          } else if (oauthPending(data)) {
            return json(res, 202, { pending: true, interval: s.interval });
          } else {
            oauthSessions.delete(pid);
            return json(res, 400, { error: 'deviceauth/token 응답 해석 불가' });
          }
          const claims = decodeIdToken(String(tokens.id_token ?? ''));
          upsertAccount({
            pool: pid as Pool,
            slot: s.slot,
            accessToken: String(tokens.access_token),
            refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : null,
            accountId: String(tokens.account_id ?? claims.accountId ?? ''),
            email: claims.email ?? `slot-${s.slot}`,
            installId: randomUUID(),
            planType: claims.plan,
          });
          s.done = true;
          oauthSessions.delete(pid);
          json(res, 200, { ok: true, providerId: pid, slot: s.slot });
        } catch (e: any) {
          json(res, 502, { error: 'poll failed: ' + e.message });
        }
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

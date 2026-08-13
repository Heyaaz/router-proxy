# router-proxy

Local LLM account-pool routing/rotation proxy with path- and model-based routing.
Runs entirely relative to `$HOME` (no hardcoded absolute paths), so it installs
identically on any macOS machine. No codex-lb dependency — account login, token
refresh, and usage collection are handled by the bundled Node scripts (the only
runtime requirement is Node 18+, Node 23+ recommended for type stripping).

## Layout

| Path | Purpose |
|---|---|
| `cc-accounts/` | Command Code GOAT subscription proxy (:9090) — `proxy.ts`, `add-account.sh`, `cc` |
| `codex-accounts/` | Unified routing proxy (:9091) — `proxy.ts`, `login.ts`, `export-tokens.ts`, `quota.ts`, `db.ts` |
| `launchd/` | LaunchAgent plist templates (`__HOME__` placeholder, rendered to `$HOME` at install time) |
| `install.sh` | Install / uninstall script |

## Storage (SQLite)

All credentials and usage data live in a single SQLite database:

```
~/Documents/codex-accounts/accounts.db    ← accounts (Fernet-encrypted) + usage snapshots
~/Documents/codex-accounts/encryption.key ← Fernet key (separate, chmod 600)
```

- **accounts** table: ChatGPT OAuth tokens (access/refresh) + Command Code keys,
  encrypted with Fernet (AES-128-CBC + HMAC-SHA256) using the separate key file.
- **usage_snapshots** table: per-account usage history (used %, reset time, window)
  collected every 5 minutes by the `quota` LaunchAgent.

No secrets in git — the repo contains code/templates only.

## Install

```bash
./install.sh               # install both proxies + quota collector + launchd agents
./install.sh --dry-run     # show what would happen, change nothing
./install.sh --uninstall   # remove launchd agents/plists (keep scripts and data)
```

Install targets (all under `$HOME`):

- Scripts: `~/.cc-accounts/`, `~/.codex-accounts/` — launchd executes them from here
  (macOS TCC blocks launchd from spawning scripts under `~/Documents`)
- Plists: `~/Library/LaunchAgents/`
- Data: `~/Documents/codex-accounts/` — `accounts.db` + `encryption.key`

## Add a ChatGPT account

> Requires Node 18+ (same runtime as the proxies)

```bash
node ~/.codex-accounts/login.ts          # auto-assign to first empty slot (a/b/c)
node ~/.codex-accounts/login.ts b        # overwrite a specific slot
```

The script prints a device code: open https://auth.openai.com/codex/device in a
browser, enter the code, done. On success the account is stored encrypted in
`accounts.db`. (This is the codex-lb OAuth flow, ported 1:1 — exchanges
`authorization_code` via PKCE when the endpoint returns one.)

## Refresh tokens

> Requires Node 18+ (same runtime as the proxies)

```bash
node ~/.codex-accounts/export-tokens.ts --refresh   # refresh every account (built-ins only)
```

Refresh tokens are single-use, so a refresh rotates and persists both
`token` and `refresh` in `accounts.db`. If a refresh fails (account expired),
re-register with `login.ts`.

## Add Command Code keys

```bash
~/.cc-accounts/add-account.sh a sk-...   # stores key encrypted in accounts.db
~/.cc-accounts/add-account.sh b          # browser login flow (cmd login)
```

## Usage collection & routing (quota-aware rotation)

The `quota` LaunchAgent (every 5 minutes) fetches usage from both pools:

- ChatGPT: `GET https://chatgpt.com/backend-api/wham/usage` (Bearer + account-id)
- Command Code: `GET https://api.commandcode.ai/alpha/whoami` +
  `GET https://api.commandcode.ai/alpha/billing/credits` (x-api-key)

Snapshots are stored in `usage_snapshots`. The proxies score each account as:

```
score = remaining% / max(time_to_reset, 60s)
```

Higher score = more remaining quota per second until reset → accounts whose
quota resets soon with plenty left are used first (no wasted quota). Session
requests stay pinned via `x-session-id` hash (skipping exhausted accounts);
stateless requests use score-weighted random selection; 401/429 retry once with
the next account in the same pool.

Manual collection: `node ~/.codex-accounts/quota.ts` (one-shot)
CLI helpers: `node ~/.codex-accounts/db.ts list|usage`

## Routing rules (:9091)

```
/backend-api/codex/*  → ChatGPT account pool  (Bearer token rotation)
/provider/v1/*        → Command Code          (x-api-key rotation)
/v1/*                 → model-based routing: gpt-5.x/o*/codex- → ChatGPT pool, everything else → Command Code
```

Routing is provider-driven: `/v1/*` requests match the model name against each
provider's `model_pattern` regex (in provider order); explicit paths
(`/backend-api/codex/*`, `/provider/v1/*`) map to the provider whose
`path_prefix` matches. Providers are managed via the dashboard or
`node ~/.codex-accounts/db.ts providers|provider-add|provider-del`.

## Control API + dashboard (:9092)

Lightweight HTTP API for account management and routing control, plus a
compact kanban-style web dashboard (no framework, single HTML file served at
`/`). Also serves a QuotaBar-compatible `/api/accounts` endpoint (point
QuotaBar at `CODEXBAR_ENDPOINT=http://127.0.0.1:9092`).

Open http://127.0.0.1:9092/ in a browser. Columns: one per **provider**
(serving vendor: GPT (ChatGPT), Command Code, or custom ones like OpenCode Go)
plus a paused column. Each card shows remaining %, reset countdown, plan,
weight, and inline controls (pause, burn, weight, label, delete).
Auto-refreshes every 30s.

A **서빙 업체 (providers)** panel adds new vendors (id, name, base URL, path
prefix, auth header, model regex) and adds accounts to a selected provider.
Providers are stored in the `providers` table; the proxy reloads every 5s.
**Burn** (🔥) bumps an account's burn priority ×1..×3 — burned accounts are
drained first regardless of usage score; clicking at ×3 resets to 0.

```
GET    /api/accounts                            → account list (QuotaBar schema)
GET    /api/usage                               → latest usage snapshots
GET    /api/health                              → status
POST   /api/accounts/:pool/:slot/enabled        → {"enabled":true|false} pause/resume
POST   /api/accounts/:pool/:slot/weight         → {"weight":1.5} routing weight
POST   /api/accounts/:pool/:slot/label          → {"label":"work"} rename
POST   /api/accounts/:pool/:slot/burn           → {"burn":1} burn priority (0-3)
DELETE /api/accounts/:pool/:slot                → delete account
GET    /api/providers                           → provider list
POST   /api/providers                           → add provider {id,name,baseUrl,pathPrefix,authHeader,modelPattern}
DELETE /api/providers/:id                       → delete provider
POST   /api/accounts                            → add account {providerId,slot,token,...}
```

`pool`/`providerId` is any provider id (`chatgpt`, `commandcode`, custom…);
`slot` is the account id (`a`, `b`, `c`, …). Disabled accounts are excluded
from routing; weight multiplies the usage score; burn priority (0–3) drains
the account first regardless of score.

`pool` is `chatgpt` or `commandcode`; `slot` is the account id (`a`, `b`, `c`, …).
Disabled accounts are excluded from routing; weight multiplies the usage score.
CLI equivalents: `node ~/.codex-accounts/db.ts enable|disable|weight|label|del`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CC_PROXY_PORT` | `9091` | Unified proxy port |
| `CODEX_ACCOUNTS_DIR` | `~/Documents/codex-accounts` | SQLite DB + encryption.key directory |
| `CODEX_ACCOUNTS_DB` | `$CODEX_ACCOUNTS_DIR/accounts.db` | Override DB path |
| `CODEX_ACCOUNTS_KEY` | `$CODEX_ACCOUNTS_DIR/encryption.key` | Override key path |
| `CONTROL_PORT` | `9092` | Control API port |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `90000` | Upstream 응답 헤더 대기 상한 (dead keep-alive 소켓 방어) |
| `CODEX_DASHBOARD` | `~/.codex-accounts/dashboard.html` | Dashboard HTML path |

## Notes

- Keys/tokens are stored **encrypted** in `accounts.db`; the Fernet key is in a
  separate `encryption.key` file (chmod 600). Never commit either to git.
- launchd requires absolute paths, so plists are rendered from `__HOME__`
  templates at install time.
- auth.openai.com's Cloudflare blocks default HTTP client user agents (HTTP 530
  `cf_route_error`); the scripts send a browser user agent.
- `node:sqlite` is experimental in Node — warnings are harmless.

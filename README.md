# router-proxy

Local LLM account-pool routing/rotation proxy with path- and model-based routing.
Runs entirely relative to `$HOME` (no hardcoded absolute paths), so it installs
identically on any macOS machine. No codex-lb dependency — account login and
token refresh are handled by the bundled Node scripts (the only runtime
requirement is Node).

## Layout

| Path | Purpose |
|---|---|
| `cc-accounts/` | Command Code GOAT subscription proxy (:9090) — `proxy.ts`, `add-account.sh`, `cc` |
| `codex-accounts/` | Unified routing proxy (:9091) — `proxy.ts`, `login.ts`, `export-tokens.ts` |
| `launchd/` | LaunchAgent plist templates (`__HOME__` placeholder, rendered to `$HOME` at install time) |
| `install.sh` | Install / uninstall script |

## Requirements

- macOS with launchd (or run the proxies manually with `node`)
- Node 18+ (Node 23+ recommended — proxies run as `.ts` via native type stripping, no build step)
  - `node:sqlite` (used only by the legacy codex-lb import mode) needs Node 22.5+

## Install

```bash
./install.sh               # install both proxies + register launchd agents
./install.sh --dry-run     # show what would happen, change nothing
./install.sh --uninstall   # remove launchd agents/plists (keep scripts and data)
```

Install targets (all under `$HOME`):

- Scripts: `~/.cc-accounts/`, `~/.codex-accounts/` — launchd executes them from here
  (macOS TCC blocks launchd from spawning scripts under `~/Documents`)
- Plists: `~/Library/LaunchAgents/`
- Data: `~/Documents/codex-accounts/{a,b,c}/` — tokens (unaffected by TCC)

## Add a ChatGPT account

> Requires Node 18+ (same runtime as the proxies)

```bash
node ~/.codex-accounts/login.ts          # auto-assign to first empty slot (a/b/c)
node ~/.codex-accounts/login.ts b        # overwrite a specific slot
```

The script prints a device code: open https://auth.openai.com/codex/device in a
browser, enter the code, done. On success the slot gets `token` / `refresh` /
`id` / `install-id` / `email` files. (This is the codex-lb OAuth flow, ported
1:1 — exchanges `authorization_code` via PKCE when the endpoint returns one.)

## Refresh tokens

> Requires Node 18+ (same runtime as the proxies)

```bash
node ~/.codex-accounts/export-tokens.ts --refresh   # refresh every slot (built-ins only)
```

Refresh tokens are single-use, so a refresh rotates and persists both
`token` and `refresh`. If a refresh fails (account expired), re-register with
`login.ts`.

### Migrate from a legacy codex-lb install (optional)

Run once on a machine that previously used codex-lb to import its accounts
(handled with Node built-ins `node:sqlite` / `node:crypto`):

```bash
node ~/.codex-accounts/export-tokens.ts
#   CODEX_LB_DATA_DIR   codex-lb data directory (default ~/.codex-lb)
```

## Add Command Code keys

```bash
~/.cc-accounts/add-account.sh a sk-...   # or drop a key file in a/b/ manually
```

## Routing rules (:9091)

```
/backend-api/codex/*  → ChatGPT account pool  (Bearer token rotation)
/provider/v1/*        → Command Code          (x-api-key rotation)
/v1/*                 → model-based routing: gpt-5.x/o*/codex- → ChatGPT pool, everything else → Command Code
```

Edit the `MODEL_ROUTES` table at the top of `codex-accounts/proxy.ts` to change
the model routing.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CC_PROXY_PORT` | `9091` | Unified proxy port |
| `CODEX_ACCOUNTS_DIR` | `~/Documents/codex-accounts` | ChatGPT token slot directory |
| `CODEX_LB_DATA_DIR` | `~/.codex-lb` | (import mode only) codex-lb data directory |

## Notes

- Keys/tokens are never stored in this repository — they are read from files at
  runtime and live outside the repo.
- launchd requires absolute paths, so plists are rendered from `__HOME__`
  templates at install time.
- auth.openai.com's Cloudflare blocks default HTTP client user agents (HTTP 530
  `cf_route_error`); the scripts send a browser user agent.

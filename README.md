# TradeBuddy - self-hosted MT4/MT5 account monitor

A Docker-native web application that collects balances, equity, open positions
and full trade history from your brokers' **MetaTrader 4 and MetaTrader 5**
accounts, and presents performance, P&L and deep statistics in one dashboard.
Credentials never leave your server.

Built for a single operator (or a small group) who wants their trading data
out of spreadsheet limbo: **unlimited accounts and owners**, every snapshot
kept, aggregate portfolio view across brokers and platforms.

> **Agent mode.** Connect your MT4/MT5 terminals with a one-time push agent -
> it sends snapshots and full trade history straight to this dashboard. No
> Wine or gateway containers required.

## Features

- **MT4 + MT5** accounts side by side, unlimited owners and accounts
- Collects on a schedule (default every 30 s per agent / 5 min pull mode):
  balance, equity, margin, floating P&L, open positions, **full closed-trade
  history** (idempotent, deduplicated by `positionId` - nothing is missed
  between pushes)
- Statistics: win rate, profit factor, expectancy, Sharpe (annualized daily),
  max drawdown, streaks, long/short split, per-symbol, per-month breakdowns
- Aggregate portfolio view: combined equity curve, allocation, monthly P&L
- Report ranges: 1M / 3M / 6M / 1Y / ALL
- Demo mode with a simulated portfolio - explore the UI without any broker
- Security model: investor (read-only) passwords only, AES-256-GCM encrypted
  at rest, shared-token ingest API, no trade paths anywhere in the code

## Two ways to get data in

| | **Agent mode** (default) | **Pull mode** (`--profile pull`) |
|---|---|---|
| How it works | A tiny EA / script runs **next to each terminal** (Windows VPS, desktop, Wine) and pushes snapshots to the dashboard | A Python collector polls accounts and asks **Wine gateway containers** to talk to MetaTrader terminals server-side |
| Setup | ~5 min per terminal (compile an EA, whitelist a URL) | Heavy Docker images (~10 min/build each), manual first-boot steps |
| Reliability | High - uses MetaQuotes' own APIs where they run natively | Experimental - MetaQuotes' installers are not reliably scriptable under Wine (the MT5 web installer can abort with `0x50000018`; MT4 first boot can sit in `health: starting` for 10+ minutes) |
| Services running | just `app` | `app` + `collector` + `mt4-gateway` + `mt5-gateway` |
| Best for | The trader who has the terminals running anyway | Headless servers where terminals must live on the host |

**Recommendation: agent mode.** It is the default in `docker-compose.yml`,
needs no Wine, and survives every MetaQuotes update that breaks scripted
installs.

```
Agent mode:
  MT4 terminal ── TradeBuddyAgent.mq4 ──┐
  MT5 terminal ── TradeBuddyAgent.mq5 ──┼──> POST /api/ingest ──> app (:3000) ──> SQLite
  MT5 + python ── mt5_agent.py ─────────┘         (X-Ingest-Token)

Pull mode (--profile pull):
  collector (:8000) ──> mt4-gateway (:8001, Wine+ZeroMQ EA) ──┐
                    └─> mt5-gateway (:8002, Wine+MetaTrader5) ─┴──> POST /api/ingest ──> app
```

## Requirements

- Docker 24+ with the compose plugin (agent mode runs on any architecture;
  pull mode needs **x86_64** because of Wine)
- Agent mode: a machine that runs your MT4/MT5 terminals (Windows VPS,
  desktop, or Wine) with outbound HTTPS to your dashboard
- ~512 MB RAM for the app alone; pull mode wants ~5 GB (two Wine terminals)
- Put the UI behind an authenticated reverse proxy or VPN before adding real
  accounts (see [Security](#security))

## Quick start (fully automatic)

```bash
git clone https://github.com/iain504/tradebuddy.git
cd tradebuddy
./deploy.sh
```

`deploy.sh` does the whole deployment:

1. checks host requirements (docker, compose plugin)
2. creates `.env` **once** with fresh random `ENCRYPTION_KEY` and
   `INGEST_TOKEN` (never regenerated, `chmod 600`)
3. builds and starts the stack (`--no-build` to skip rebuilds; `--pull` for
   the legacy collector + Wine gateway stack)
4. waits for the app to report healthy, then prints status + next steps

Open `http://SERVER:3000`. The **Agent setup** button in the header (and the
green banner's **Setup guide** button) shows your exact agent settings with
copy buttons. Load the demo portfolio to explore the UI, then connect real
accounts below.

## First-time MT4 setup (agent mode)

One-time, ~5 minutes, inside your MT4 terminal:

1. **Add the account in the dashboard first** - *Add account* → MT4 → same
   login + broker server as in the terminal + **investor (read-only)
   password**. (Server label optional; the agent's push fills it in.)
2. **Install the EA**: download
   [`agents/mt4-agent/TradeBuddyAgent.mq4`](agents/mt4-agent/TradeBuddyAgent.mq4),
   in MT4 open *File → Open Data Folder → MQL4/Experts*, copy it there, and
   compile in MetaEditor (F7).
3. **Whitelist the dashboard URL**: *Tools → Options → Expert Advisors* →
   tick *Allow WebRequest for listed URL* → add `https://your-tradebuddy-host`
   (scheme + host must match exactly).
4. **Attach the EA** to any chart. Inputs (the Setup guide shows your real
   values with copy buttons):
   - `IngestURL` = `https://your-tradebuddy-host/api/ingest`
   - `IngestToken` = the shared ingest token (dashboard banner or `.env`)
   - `PollSeconds` = 30
5. **Let MT4 see all history**: in the terminal's *Account History* tab
   (bottom), right-click → **All History**. MT4 only exposes loaded history to
   EAs - this one click makes the backfill complete.

Verify: green smiley on the chart, `state: pushed` in the chart comment,
`TradeBuddy: pushed snapshot, HTTP 200` in the *Experts* tab. The first push
backfills **all** closed trades in batches; after that, live snapshots every
`PollSeconds`. Progress is persisted per login - restarting the terminal
resumes, no duplicates (server-side dedup by `positionId`).

> The EA never trades and AutoTrading is **not** required. Only the investor
> password ever touches the terminal; the agent only knows the ingest token.

## First-time MT5 setup (agent mode)

Pick ONE of the two options:

**Option A - EA (same as MT4, one manual step less):**

1. Add the account in the dashboard (MT5, login, investor password).
2. Download
   [`agents/mt5-agent/TradeBuddyAgent.mq5`](agents/mt5-agent/TradeBuddyAgent.mq5)
   → *File → Open Data Folder → MQL5/Experts* → compile (F7).
3. Whitelist the dashboard URL (*Tools → Options → Expert Advisors*).
4. Attach to any chart with `IngestURL` + `IngestToken`.

No manual history step - MT5 exposes the full deal history; the EA groups
deals by `position_id` (partial closes, reversals, commissions handled).

**Option B - Python agent (Windows, no EA):**

```powershell
pip install MetaTrader5 requests
python mt5_agent.py --url https://your-tradebuddy-host/api/ingest --token TOKEN
```

- The script attaches to the terminal that is already logged in, or logs in
  itself: `--login 12345 --password INVESTOR_PW --server "ICMarketsSC-MT5"`
- Optional: `--path "C:/Program Files/MetaTrader 5/terminal64.exe"`,
  `--poll 30`, `--once` (for Task Scheduler)
- Full flag list: [`agents/README.md`](agents/README.md)

## Adding accounts (web UI)

**Always use the INVESTOR (read-only) password.** The system only reads, but
with a master password a compromised component *could* trade - investor
passwords make that impossible. The UI reminds you on every field.

1. **Add account** → pick platform (MT4/MT5), owner, login, investor password
2. **Server resolution** (any one works; optional in agent mode):
   - broker autocomplete (MetaQuotes public index, fetched server-side)
   - upload the broker's `.srv` file
   - upload the terminal's `config\servers.dat` (newer terminals only keep
     this one file) and pick your broker from the parsed list
   - manual `host:port`
3. The account starts `PENDING` and flips `ACTIVE` after the agent's first
   successful push.

## Pull mode (optional, experimental)

If you want server-side collection instead of agents:

```bash
./deploy.sh --pull          # or: docker compose --profile pull up -d --build
```

This adds the Python collector and the two Wine gateway containers (`deploy.sh
--pull` also writes `COLLECTOR_URL=http://collector:8000` into `.env` for the
dashboard's pipeline status; manual compose runs should add it too). Honest
caveats:

- **MT5 gateway**: the MetaQuotes web installer frequently aborts under Wine
  with `0x50000018` (no `terminal64.exe` installed). The image tries
  MetaQuotes' Wine-packaged `mt5ubuntu.exe` first, falls back to
  `mt5setup.exe /auto`, and retries at every container start - but success is
  not guaranteed on all Wine builds. When the build or boot fails, use agent
  mode for MT5.
- **MT4 gateway**: first boot downloads MT4, compiles the ZeroMQ bridge EA and
  stays in `health: starting` for up to ~12 minutes **once** (Wine prefix
  init) - this is normal; watch `docker compose logs -f mt4-gateway`.
  The stock bridge EA does not report closed-order history; see
  `gateways/mt4-gateway/README.md` for the patched-EA route.

Full gateway setup (logins, `.srv` files, scaling to multiple gateways):
[DEPLOY.md](DEPLOY.md) and the per-gateway READMEs.

## Configuration

All via `.env` (see `.env.example`; `deploy.sh` generates the secrets):

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | - (required) | 32-byte hex; AES-256-GCM key material for stored credentials. **Losing it = credentials unreadable.** |
| `INGEST_TOKEN` | - (required) | Shared secret agents/collector authenticate with against `/api/ingest`. |
| `EXPOSE_INGEST_TOKEN` | `0` | `1` = the dashboard's Setup guide shows the token (copy-paste ready). Keep `0` on shared instances. |
| `PUBLIC_APP_URL` | auto | Absolute base URL agents should use; auto-detected from proxy headers when unset. |
| `POLL_MINUTES` | `5` | Pull-mode collection cycle length. |
| `COLLECTOR_URL` | unset | App-side URL of the collector. **Agent mode: leave unset** (a value hides the agent setup guide). `deploy.sh --pull` sets it. |
| `COLLECTION_JITTER_SECONDS` | `20` | Random per-account delay (pull mode). |
| `MT4_LOGIN` / `MT4_PASSWORD` / `MT4_SERVER` | empty | Pull-mode MT4 start-flag login (one terminal = one account). |
| `MT4_BRIDGE_API_KEY` | generated | Pull-mode MT4 gateway ↔ bridge EA key. |
| `MT4_HISTORY_CMD` | empty | Optional patched-EA command for MT4 trade history. |
| `MT4_GATEWAY_URL` / `MT5_GATEWAY_URL` | internal | Comma-separated for scaled pull-mode gateways. |
| `MT5_PRESTART` | `true` | Warm up the pull-mode MT5 terminal at boot. |

## Operations

```bash
docker compose ps                    # running services + health
docker compose logs -f app           # ingest traffic (agents land here)
./deploy.sh                          # update: rebuild changed images, restart
docker compose --profile pull up -d  # add collector + gateways later
```

**Backup** - everything lives in one SQLite file on the `appdata` volume:

```bash
docker compose exec app sqlite3 /data/monitor.db ".backup '/data/backup.db'"
docker compose cp app:/data/backup.db ./backup-$(date +%F).db
```

## Security

- Investor (read-only) passwords only, enforced by the UI and assumed by the
  whole design; encrypted AES-256-GCM at rest, decrypted only in-memory when
  the pull collector fetches the account list
- `/api/collect/accounts` (pull mode) returns **decrypted** credentials to
  whoever holds `INGEST_TOKEN` - never expose it; keep the entire UI behind an
  authenticated proxy (basic auth, SSO) or a VPN (Tailscale/WireGuard is the
  simplest)
- Agents authenticate with the same `INGEST_TOKEN`; they never send passwords
  - those stay inside your terminal
- Only port 3000 is published; collector/gateways stay on the internal
  compose network
- Host firewall: allow inbound 80/443 (proxy) + SSH, nothing else

## Troubleshooting (quick)

| Symptom | Fix |
|---|---|
| Banner shows agent mode / accounts stay `PENDING` | Install the agent for that platform - click **Agent setup** in the header; check the EA chart comment / Experts tab |
| EA: `WebRequest failed (4014/4060)` | URL not whitelisted - *Tools → Options → Expert Advisors*, scheme+host must match exactly |
| EA: `HTTP 401` | Wrong `IngestToken` - copy from `.env` / Setup guide |
| EA: `HTTP 404 No account matches login` | Add the account in the dashboard first (same login + platform) |
| `HTTP 409 matches N accounts` | Same login on two brokers - set the broker server label on the account so `server` disambiguates |
| MT4 history incomplete | *Account History → right-click → All History*, then set `RestartHistory=true` once |
| Pull mode: MT5 build fails at installer | Known Wine limitation - retry the build (it tries `mt5ubuntu.exe`), or use agent mode for MT5 |
| Pull mode: MT4 `health: starting` long time | Normal on first boot (Wine init + MT4 download + EA compile, up to ~12 min) |
| Gateway image build fails | Pull mode builds need `download.mql5.com`, `python.org`, `dl.winehq.org`, `deb.nodesource.com`, `registry.npmjs.org`, `github.com` reachable |

Full runbook with the complete table: [DEPLOY.md](DEPLOY.md).

## Documentation

- [agents/README.md](agents/README.md) - push agent setup + troubleshooting
  (recommended path)
- [DEPLOY.md](DEPLOY.md) - full deployment runbook: architecture, data flow,
  security model, operations, troubleshooting
- [gateways/mt4-gateway/README.md](gateways/mt4-gateway/README.md) - MT4
  bridge details, login options, patched-EA history route
- [gateways/mt5-gateway/README.md](gateways/mt5-gateway/README.md) - MT5
  bridge details and sequential-connect design

## Repository layout

```
src/                     Next.js 16 app (App Router, TypeScript, Prisma/SQLite)
  app/api/               REST: accounts, ingest (agent+collector), agent/config,
                         brokers, srv/servers.dat decode
  components/dashboard/  Dashboard UI (accounts, reports, aggregate view)
  lib/                   stats engine, broker/.srv/servers.dat resolution,
                         crypto (AES-256-GCM), contracts
agents/                  Push agents (recommended data path)
  mt4-agent/             TradeBuddyAgent.mq4 - MT4 EA, WebRequest, zero deps
  mt5-agent/             TradeBuddyAgent.mq5 - MT5 EA + mt5_agent.py (official pkg)
collector/               Python polling service (:8000) - pull mode
gateways/mt4-gateway/    Node + ZeroMQ bridge EA over Wine (:8001) - pull mode
gateways/mt5-gateway/    FastAPI + MetaTrader5 lib over Wine (:8002) - pull mode
docker-compose.yml       app by default; --profile pull adds collector+gateways
deploy.sh                one-command bootstrap (env + build + up + health)
Dockerfile               multi-stage app image (bun build → node:20-slim)
```

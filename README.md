# TradeBuddy - self-hosted MT4/MT5 account monitor

A Docker-native web application that periodically collects balances, equity,
open positions and full trade history from your brokers' **MetaTrader 4 and
MetaTrader 5** accounts, and presents performance, P&L and deep statistics in
one dashboard. Credentials never leave your server.

Built for a single operator (or a small group) who wants their trading data
out of spreadsheet limbo: **unlimited accounts and owners**, every snapshot
kept, aggregate portfolio view across brokers and platforms.

## Features

- **MT4 + MT5** accounts side by side, unlimited owners and accounts
- Collects on a schedule (default every 5 min, per-account jitter + backoff):
  balance, equity, margin, floating P&L, open positions, **full closed-trade
  history** (idempotent, deduplicated by `positionId` - nothing is missed
  between polls)
- Statistics: win rate, profit factor, expectancy, Sharpe (annualized daily),
  max drawdown, streaks, long/short split, per-symbol, per-month breakdowns
- Aggregate portfolio view: combined equity curve, allocation, monthly P&L
- Report ranges: 1M / 3M / 6M / 1Y / ALL
- Demo mode with a simulated portfolio - explore the UI without any broker
- Security model: investor (read-only) passwords only, AES-256-GCM encrypted
  at rest, shared-token ingest API, no trade paths anywhere in the code

## How it works

```
browser ──> app (Next.js :3000) ──> SQLite (volume)
                 ▲  │
      ingest API │  │ account list (decrypted, X-Ingest-Token)
                 │  ▼
             collector (:8000) ── per-account threads + jitter
                  │                    │
        ┌──────────┘                    └──────────┐
        ▼                                          ▼
  mt4-gateway (:8001)                     mt5-gateway (:8002)
  Node + ZeroMQ bridge EA                 FastAPI + MetaTrader5 lib
  Wine → MT4 terminal (1 per account)     Wine → MT5 terminal (shared)
        └──────────────┬───────────────────────────┘
                       ▼
              broker trade servers (:443 typically)
```

One collector cycle: pull accounts from the app → dispatch each non-demo
account to the right gateway → normalize `{accountInfo, positions, trades}` →
`POST /api/ingest` (snapshot + position replace + trade upsert). Failures mark
the account `ERROR` with a human-readable reason and back off exponentially.

## Requirements

- **x86_64 Linux** host (the Wine gateway images do not build/run on arm64)
- Docker 24+ with the compose plugin
- ~5 GB RAM (two Wine containers run full MetaTrader terminals), ~10 GB disk
- Outbound TCP to your brokers (and to MetaQuotes/Python/Wine/NPM CDNs during
  the **first build/boot** of the gateway images)
- Put the UI behind an authenticated reverse proxy or VPN before adding real
  accounts (see [Security](#security))

## Quick start (fully automatic)

```bash
git clone https://github.com/iain504/tradebuddy.git
cd tradebuddy
./deploy.sh
```

`deploy.sh` does the whole deployment:

1. checks host requirements (x86_64, docker, compose plugin)
2. creates `.env` **once** with fresh random `ENCRYPTION_KEY`,
   `INGEST_TOKEN` and `MT4_BRIDGE_API_KEY` (never regenerated, `chmod 600`)
3. builds and starts all four services (`--no-build` to skip rebuilds)
4. waits for the app to report healthy, then prints status + next steps

First build takes a while (app ~3-5 min, each gateway image ~10 min: Wine +
official MetaTrader installers). Later `./deploy.sh` rebuilds only what
changed.

Open `http://SERVER:3000`, create an owner, and either load the demo
portfolio (one click, simulated data, never touches the gateways) or start
adding real accounts below.

## First-time MT4 setup

The `mt4-gateway` container runs **one MT4 terminal = one account**. All of
the following happens automatically on first start (`docker compose logs -f
mt4-gateway` to watch):

1. Wine prefix initialized in the `mt4data` volume (first boot only)
2. Official `mt4setup.exe` downloaded and silently installed
3. `mql-zmq` library + the ZeroMQ bridge EA installed into the terminal
4. The EA compiled with your `MT4_BRIDGE_API_KEY` patched in
5. Terminal started with a chart template that pre-attaches the EA; the
   gateway waits for the bridge socket before serving

**Log the terminal into your broker account (pick one):**

- *Automatic (preferred)* - set in `.env`, then `docker compose up -d`:

  ```dotenv
  MT4_LOGIN=51823041
  MT4_PASSWORD=your-investor-password
  MT4_SERVER=Pepperstone-Demo      # label; see .srv note below
  ```

  The broker's server definition (`.srv`) must exist in the volume: drop it
  into the drop-in directory before restarting:

  ```bash
  docker compose cp pepperstone-demo.srv mt4-gateway:/opt/mt4/srv/
  docker compose up -d   # or: docker compose restart mt4-gateway
  ```

  No `.srv`? Get it from MT4 (`File → Open Data Folder → config\`), the
  broker's website, or upload the terminal's `config\servers.dat` in the web
  UI's Add-account dialog to read out `host:port` and enter it manually.
- *Manual* - log in once through a GUI session (VNC/X11 into the container);
  the session persists in the `mt4data` volume, no env vars needed.

**Verify:** the Experts log should show
`[REP] Binding MT4 Server to Socket on Port 5555`. If you see error 4017/4109,
open the terminal UI once: Tools → Options → Expert Advisors → *Allow DLL
imports*, and enable AutoTrading (persists in the volume).

**More than one MT4 account:** add another gateway service (copy the compose
block, new name + new volume), set `MT4_GATEWAY_LOGIN` in each, and give the
collector a comma-separated list: `MT4_GATEWAY_URL=http://mt4-gateway:8001,http://mt4-gateway-2:8001`.
The collector routes each account to the gateway advertising its login
(`GATEWAY_LOGIN`).

> Honest limitation: the stock bridge EA reports balance/equity/positions but
> **not closed-order history**. For MT4 trade statistics, see
> `gateways/mt4-gateway/README.md` for the optional patched-EA route
> (`MT4_HISTORY_CMD`).

## First-time MT5 setup

The `mt5-gateway` container is the low-friction one - **no login
configuration**, no per-account setup:

1. Image build (once): Wine + official MT5 installer + Windows Python 3.11
   (~10 min, ~500 MB)
2. First start: wine prefix (if the volume is fresh), optional terminal
   warm-up (`MT5_PRESTART=true` default), bridge API on :8002
3. Done. Every account connect happens per-request through the official
   `MetaTrader5` python API: `initialize(login, password, server)` → collect →
   `shutdown`, serialized through one terminal under a lock

**Adding your broker's server definition (only if a server label fails to
resolve):**

```bash
docker compose cp mybroker.srv mt5-gateway:/opt/mt5/srv/
docker compose restart mt5-gateway
```

(The entrypoint copies `/opt/mt5/srv/*.srv` into the terminal's
`Config/servers` on every start.)

**Verify:** `docker compose exec mt5-gateway curl -s localhost:8002/health`,
then just add an account in the UI and hit *Fetch now*.

**Scaling:** one terminal serves accounts sequentially - comfortable up to
~20 accounts at `POLL_MINUTES >= 3`. Beyond that, run a second `mt5-gateway`
service and give the collector a comma-separated `MT5_GATEWAY_URL` list;
accounts are assigned deterministically (crc32 of account id).

## Adding accounts (web UI)

**Always use the INVESTOR (read-only) password.** The system only reads, but
with a master password a compromised component *could* trade - investor
passwords make that impossible. The UI reminds you on every field.

1. **Add account** → pick platform (MT4/MT5), owner, login, investor password
2. **Server resolution** (any one works):
   - broker autocomplete (MetaQuotes public index, fetched server-side)
   - upload the broker's `.srv` file
   - upload the terminal's `config\servers.dat` (newer terminals only keep
     this one file) and pick your broker from the parsed list - the server
     label, broker name and endpoints are filled in for you
   - manual `host:port` (from the MT4 Journal line `connected to IP:PORT`)
3. Optional *Test connection on save* verifies reachability before storing
4. The account starts `PENDING` and flips `ACTIVE` after its first successful
   snapshot; use *Fetch now* for an immediate first sync

## Configuration

All via `.env` (see `.env.example`; `deploy.sh` generates the secrets):

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | - (required) | 32-byte hex; AES-256-GCM key material for stored credentials. **Losing it = credentials unreadable.** |
| `INGEST_TOKEN` | - (required) | Shared secret between collector and app API. |
| `POLL_MINUTES` | `5` | Collection cycle length. Do not go below 1. |
| `COLLECTION_JITTER_SECONDS` | `20` | Random per-account delay to avoid thundering herd. |
| `MT4_LOGIN` / `MT4_PASSWORD` / `MT4_SERVER` | empty | MT4 start-flag login (one terminal = one account). |
| `MT4_GATEWAY_LOGIN` | empty | Advertised login for multi-gateway routing. |
| `MT4_BRIDGE_API_KEY` | generated | Shared key between gateway and bridge EA. |
| `MT4_HISTORY_CMD` | empty | Optional patched-EA command for trade history. |
| `MT4_GATEWAY_URL` / `MT5_GATEWAY_URL` | internal | Comma-separated for scaled gateways. |
| `MT5_PRESTART` | `true` | Warm up the MT5 terminal at boot. |

## Operations

```bash
docker compose ps                    # 4 services, gateway healthchecks included
docker compose logs -f collector     # per-cycle ingest summaries
docker compose logs -f mt4-gateway   # terminal + EA state
./deploy.sh                          # update: rebuild changed images, restart
```

**Backup** - everything lives in one SQLite file on the `appdata` volume:

```bash
docker compose exec app sqlite3 /data/monitor.db ".backup '/data/backup.db'"
docker compose cp app:/data/backup.db ./backup-$(date +%F).db
```

**Reset a terminal** (e.g. a broken MetaQuotes auto-update): remove the
`mt4data`/`mt5data` volume - accounts, snapshots and trades are safe in
`appdata` and reconnect automatically.

## Security

- Investor (read-only) passwords only, enforced by the UI and assumed by the
  whole design; encrypted AES-256-GCM at rest, decrypted only in-memory when
  the collector fetches the account list
- `/api/collect/accounts` returns **decrypted** credentials to whoever holds
  `INGEST_TOKEN` - never expose it; keep the entire UI behind an authenticated
  proxy (basic auth, SSO) or a VPN (Tailscale/WireGuard is the simplest)
- Only port 3000 is published; collector/gateways stay on the internal
  compose network; the MT4 bridge ports bind inside the container only
- Host firewall: allow inbound 80/443 (proxy) + SSH, nothing else

## Troubleshooting (quick)

| Symptom | Fix |
|---|---|
| Account stuck `PENDING` | `docker compose ps && docker compose logs collector`; check `/api/health` shows `collectorConfigured: true` |
| MT4 account `ERROR`, HTTP 503 | Bridge EA not attached / DLL imports off / AutoTrading off - see First-time MT4 setup |
| MT5 `initialize failed` | Wrong server label or wrong password; install the broker `.srv` (see above); investor vs master mix-up shows here |
| MT4 shows balance but no trades | Expected with the stock EA - patched-EA route in `gateways/mt4-gateway/README.md` |
| Gateway image build fails | First builds need `download.mql5.com`, `python.org`, `dl.winehq.org`, `deb.nodesource.com`, `registry.npmjs.org`, `github.com` reachable |

Full runbook with the complete table: [DEPLOY.md](DEPLOY.md).

## Documentation

- [DEPLOY.md](DEPLOY.md) - full deployment runbook: architecture, data flow,
  security model, operations, troubleshooting, honesty list (what is
  intentionally not automated)
- [gateways/mt4-gateway/README.md](gateways/mt4-gateway/README.md) - MT4
  bridge details, login options, patched-EA history route
- [gateways/mt5-gateway/README.md](gateways/mt5-gateway/README.md) - MT5
  bridge details and sequential-connect design

## Repository layout

```
src/                     Next.js 16 app (App Router, TypeScript, Prisma/SQLite)
  app/api/               REST: accounts, ingest, collect, brokers, srv decode
  components/dashboard/  Dashboard UI (accounts, reports, aggregate view)
  lib/                   stats engine, broker/.srv/servers.dat resolution,
                         crypto (AES-256-GCM), contracts
collector/               Python polling service (:8000)
gateways/mt4-gateway/    Node + ZeroMQ bridge EA over Wine (:8001)
gateways/mt5-gateway/    FastAPI + MetaTrader5 lib over Wine (:8002)
docker-compose.yml       4-service topology + volumes + healthchecks
deploy.sh                one-command bootstrap (env + build + up + health)
Dockerfile               multi-stage app image (bun build → node:20-slim)
```

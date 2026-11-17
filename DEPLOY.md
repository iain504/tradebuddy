# DEPLOY.md - self-hosted MT4/MT5 account monitor: deployment runbook

Honest, operational instructions for running the whole system on an
**x86_64 Linux host with Docker**. The web app is a Next.js 16 application;
data collection runs through one Python collector and two Wine-based gateway
microservices (one per platform).

---

## 1. Architecture

```
                          +-------------------------------------------+
                          |                Linux host                 |
                          |                                           |
   browser ----------->  |  +-----------+         +---------------+  |
   (reverse proxy +  --> |  |   app     |<------->|  SQLite (vol  |  |
   auth / VPN)           |  | Next.js   |  prisma |  appdata)     |  |
   :3000                 |  | :3000     |  db push|  /data        |  |
                          |  +-----^-----+         +---------------+  |
                          |        | ^                                 |
                          |  fetch | | POST /api/ingest                |
                          |  accts | | PATCH /api/accounts/:id         |
                          |        | |                                 |
                          |  +-----+-----+                               |
                          |  | collector | :8000 (/health /sync /test)   |
                          |  +--+-----+--+                               |
                          |     | |  per-account threads + jitter        |
                          |     | +--------------------+                |
                          |     v                      v                |
                          |  +-----------+      +--------------------+ |
                          |  | mt4-gw    |      | mt5-gateway        | |
                          |  | Node :8001|      | FastAPI :8002      | |
                          |  +-----+-----+      | (Windows Python    | |
                          |        | ZeroMQ     |  under Wine)       | |
                          |        | tcp 5555/  +---------+----------+ |
                          |        | 5556                 | mt5 lib     |
                          |  +-----v--------+   +---------v----------+ |
                          |  | MT4 terminal |   | MT5 terminal64.exe | |
                          |  | (Wine) + EA  |   | (Wine)             | |
                          |  +------+-------+   +---------+----------+ |
                          +---------|---------------------|-----------+
                                    v                     v
                             broker trade servers (usually :443)
```

Data flow per cycle:

1. `GET /api/collect/accounts` (X-Ingest-Token) -> accounts with **decrypted
   investor passwords**, `backfillFrom`, platform routing info.
2. Collector dispatches each non-demo account to `mt4-gateway` or
   `mt5-gateway` in its own thread with a random jitter delay.
3. Gateway returns `{ accountInfo, positions, trades }` normalized to the
   app's IngestPayload sub-shapes (BUY/SELL uppercase, ISO timestamps,
   positionId as string).
4. `POST /api/ingest` -> snapshot + position replace + trade upsert
   (dedup by `(accountId, positionId)`; retries/overlaps are safe).
5. On any failure the collector `PATCH`es the account to `ERROR` with a
   human-readable `lastError` and applies exponential backoff (1 -> 30 min).

## 2. Prerequisites

- x86_64 Linux host (the Wine containers do not build/run on arm64).
- Docker 24+ with the compose plugin (`docker compose version`).
- ~4 GB RAM for the two Wine containers (they run full MetaTrader terminals)
  plus ~1 GB for app + collector.
- Outbound network access to your brokers (MT4/MT5 servers usually use :443,
  sometimes custom ports; the host must allow arbitrary outbound TCP).
- ~10 GB disk for images + volumes.
- Internet access during the FIRST start of the gateway containers: they
  download the official MT4/MT5 installers and the bridge EA, then compile it
  (no internet needed again afterwards).

## 3. Quick start

One command (generates `.env` with random secrets, builds, starts, waits for
health):

```bash
./deploy.sh
# restart without rebuilding: ./deploy.sh --no-build
```

Manual equivalent:

```bash
cp .env.example .env
# EDIT .env: set strong ENCRYPTION_KEY and INGEST_TOKEN
openssl rand -hex 32    # one option for each secret

docker compose up -d --build
# first build: app ~3-5 min; gateways ~10 min each (Wine + terminal installs)
docker compose ps
docker compose logs -f collector
```

Open `http://SERVER:3000`, create an owner, add your trading accounts (or load
the demo portfolio first to explore the UI). Demo accounts are simulated
locally and never hit the gateways.

Then:

```bash
docker compose logs -f mt4-gateway    # watch the one-time MT4 setup + EA compile
docker compose logs -f mt5-gateway
```

The collector polls every `POLL_MINUTES`; accounts move `PENDING -> ACTIVE`
after their first successful snapshot. The "Fetch now" button on an account
calls the collector's `/sync` for that single account immediately.

## 4. Adding accounts

- **Use the INVESTOR (read-only) password.** The gateways only read, but they
  technically log in like any terminal - with a master password a compromised
  component could place trades. Investor passwords make that impossible.
- **MT5 accounts**: enter the server *label* exactly as the terminal names it
  (e.g. `ICMarketsSC-MT5`). The gateway terminal resolves labels; if a label
  is unknown, drop the broker's `.srv` file into the MT5 terminal config
  folder (see section 6).
- **MT4 accounts**: the gateway needs `serverHost:serverPort`. Get it from
  your broker's support page, by decoding the broker `.srv` file, or from the
  MT4 terminal Journal line: `... connected to 123.45.67.89:443`. The app's
  broker search pre-fills common brokers.

## 5. MT4 one-time bridge setup

The first `mt4-gateway` start with an empty `mt4data` volume runs
`gateways/mt4-gateway/setup/setup-mt4-terminal.sh` automatically:

1. Wine (winehq-stable) - preinstalled in the image.
2. Official `mt4setup.exe` (MetaQuotes CDN) - silent install (`/auto`).
3. `mql4-lib` + `mql-zmq` installed into the terminal's MQL4 folder.
4. `MetaTrader4Bridge.mq4` downloaded, your `MT4_BRIDGE_API_KEY` patched into
   the EA source, compiled with `metaeditor.exe /compile ... /log`.
5. A default chart template with the EA pre-attached + best-effort
   `terminal.ini` expert flags.

Verify once (persists in the volume):

```bash
docker compose logs mt4-gateway | grep -E "REP|PUSH|errors"
```

- Expect `[REP] Binding MT4 Server to Socket on Port 5555` in the Experts log.
- If you see error 4017 (`DLL calls not allowed`) or 4109 (`trade not
  allowed`): the terminal UI once: Tools -> Options -> Expert Advisors ->
  "Allow DLL imports", and enable the AutoTrading button. The settings
  persist in the volume.
- **Logging into the broker account**: set `MT4_LOGIN`, `MT4_PASSWORD`,
  `MT4_SERVER` in `.env` and restart the container (start-flag login; the
  broker `.srv` file must exist in the `mt4data` volume at `/opt/mt4/srv/`),
  or log in manually via a GUI session. This is the least automatable part of
  MT4 - MetaQuotes does not document headless login officially.
- One **MT4 terminal = one account**. For N MT4 accounts run N gateway
  containers (compose override adding `mt4-gateway-2`, etc.), set
  `GATEWAY_LOGIN` in each, and give the collector a comma-separated
  `MT4_GATEWAY_URL` list. The collector asks each gateway `/whoami` and routes
  the matching login to it.

## 6. MT5 gateway notes

- The image build is honest about being slow: Wine + official MT5 installer +
  Windows Python 3.11 = roughly 10 minutes on a typical VPS.
- Accounts connect **sequentially** through the single terminal
  (`initialize -> work -> shutdown` under a lock). With up to ~20 accounts
  keep `POLL_MINUTES >= 3`; for more, run replicas and split accounts by
  giving the collector a comma-separated `MT5_GATEWAY_URL` list - assignment
  is deterministic (crc32 of accountId), so accounts stick to their gateway.
- Broker `.srv` installation for label resolution - easiest is the drop-in
  directory (picked up on every gateway start):

  ```bash
  docker compose cp mybroker.srv mt5-gateway:/opt/mt5/srv/
  docker compose restart mt5-gateway
  ```

  Manual alternative:

  ```bash
  docker compose cp mybroker.srv mt5-gateway:/tmp/
  docker compose exec mt5-gateway bash -c \
    'cp /tmp/mybroker.srv "/opt/mt5/prefix/drive_c/Program Files/MetaTrader 5/Config/servers/"'
  docker compose restart mt5-gateway
  ```

  (Or bake it into a small derived image: `COPY mybroker.srv /opt/.../servers/`.)
- MetaQuotes force-updates terminals; if a terminal auto-update breaks under
  Wine, recreate the `mt5data` volume (you only lose the terminal install and
  login cache - all data lives in `appdata`).

## 7. Operations

```bash
docker compose ps                          # all four services Up/healthy
docker compose logs -f collector           # per-cycle ingest summaries
curl -s http://SERVER:3000/api/health      # app + pipeline health (see below)
curl -s http://SERVER:8000 -H '' 2>/dev/null || true   # (collector is internal)
docker compose exec collector curl -s localhost:8000/health
```

- **Pipeline status in the UI**: `GET /api/health` now includes a live
  snapshot from the collector - `collector.ok`, `collector.lastCycle`, and
  per-platform gateway probes (`collector.gateways.mt4` with the terminal
  bridge state, `collector.gateways.mt5`). The dashboard footer renders these
  as status chips ("Collector live / MT4 terminal attached / MT5 gateway
  online"), and the amber demo banner only appears when the collector is not
  configured or unreachable. The collector's `/health` probes each gateway
  every ~30s in a background thread, so the endpoint stays fast.
- **Poll tuning**: 1-5 minutes is comfortable. Brokers throttle or lock
  accounts for hammering; the collector already jitters each account and
  backs off exponentially on failures. Do not set `POLL_MINUTES < 1`.
- **Backups**: all trading data lives in the `appdata` volume as one SQLite
  file.

  ```bash
  docker compose exec app sqlite3 /data/monitor.db ".backup '/data/backup.db'"
  docker compose cp app:/data/backup.db ./backup-$(date +%F).db
  ```

  Restore: stop the stack, `docker compose cp backup.db app:/data/monitor.db`,
  start again. (The `sqlite3` CLI may need `apt-get install sqlite3` inside
  the container, or copy the file out while the app is stopped.)
- **Updates**: `docker compose build && docker compose up -d` - volumes keep
  the database and terminal state.
- **Scaling MT4**: one container per account (section 5). The compose file
  ships a single instance; add more by copying the service block with a
  different name/volume and extending `MT4_GATEWAY_URL`.

## 8. Security

- **Never expose `/api/collect/accounts` publicly** - it returns decrypted
  investor passwords to anyone holding `INGEST_TOKEN`. Keep the entire UI
  behind a reverse proxy with authentication or a VPN (Tailscale/WireGuard
  are the simplest). Publish only port 3000, and only through the proxy.
- **Investor passwords are mandatory** (read-only). The system stores them
  AES-256-GCM encrypted (`ENCRYPTION_KEY` -> sha256 -> AES key); the app
  decrypts them only in-memory when the collector fetches the account list.
  If `ENCRYPTION_KEY` is lost, stored credentials cannot be decrypted.
- The collector and gateways have no browser-facing authentication by design
  (private compose network). If you must expose them, front them with the
  same proxy auth and set strong `INGEST_TOKEN` / `BRIDGE_API_KEY` values.
- The MT4 bridge ports (5555/5556) are bound **inside** the gateway container
  only - they are never published by compose.
- Host firewall recommendation: allow inbound only your proxy ports
  (e.g. 80/443) and SSH.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Account stuck `PENDING` | Collector not running or `APP_URL` wrong. `docker compose ps`, `docker compose logs collector`. Also check the app's `/api/health` shows `collectorConfigured: true`. |
| Account `ERROR`, tooltip shows `gateway ... HTTP 503` | Gateway terminal not up yet (first boot runs installs) or bridge EA not attached / AutoTrading off / DLL imports off. Read section 5 (MT4) or the gateway README. |
| Account `ERROR`: `mt5.initialize failed` | Wrong server label or wrong password. MT5 labels must resolve inside the terminal (`.srv` install, section 6). Investor vs master password mix-up shows here too. |
| Account `ERROR`: `login must be numeric` | Login field contains letters/spaces - edit the account. |
| MT4 account shows balance/equity but no trades | **Expected with the stock bridge EA** - it cannot read closed-order history. See `gateways/mt4-gateway/README.md` for the patched-EA option (`MT4_HISTORY_CMD`). |
| MT4 "Fetch now" says terminal designated for another login | `GATEWAY_LOGIN` on that container does not match the account - one gateway per MT4 account. |
| Wine container crashes / terminal froze | `docker compose restart mt5-gateway` (or mt4-gateway). Terminal state persists in the volume. |
| Snapshot times look shifted by 1-3h | MT4 timestamps are broker-server time treated as UTC (known approximation, see gateway README). MT5 timestamps are true UTC. |
| Collector logs `Could not fetch account list` | App container down or `INGEST_TOKEN` mismatch between app and collector. |
| Gateway image build fails downloading installers | Outbound network blocked - the builds need `download.mql5.com`, `python.org`, `dl.winehq.org`, `deb.nodesource.com`, `registry.npmjs.org`, `github.com`. |

Health endpoints for probes: app `GET /api/health`, collector `GET :8000/health`,
mt4-gateway `GET :8001/health`, mt5-gateway `GET :8002/health`.

## 10. What is intentionally NOT automated (honesty list)

- MT4/MT5 terminal first-run EULAs and broker logins (start flags are
  supported for MT4; MT5 login happens per-request through the python API).
- Broker `.srv` distribution - brokers require you to obtain these files.
- Terminal auto-updates by MetaQuotes - they can change behavior under Wine
  at any time; pin nothing, expect occasional gateway rebuilds.
- The stock MT4 bridge EA cannot read closed-trade history - MT4 trade
  statistics require the optional patched-EA route described in the gateway
  README.

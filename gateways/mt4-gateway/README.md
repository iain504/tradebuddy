# MT4 Gateway

Express service that reads live data from a MetaTrader 4 terminal running
inside the same container (Wine) through the ZeroMQ bridge EA of the
[`metatrader4`](https://github.com/peterszombati/metatrader4) npm package.

```
collector --HTTP--> mt4-gateway (Node, :8001) --ZeroMQ tcp/5555+5556--> MT4 terminal (Wine) --trade server--> broker
```

## What it serves

| Route | Purpose |
|---|---|
| `POST /test` `{ serverHost, serverPort, login, password }` | Bridge/terminal health check. Returns `{ ok, message }`. |
| `POST /snapshot` `{ serverHost, serverPort, login, password, historyFrom }` | Returns `{ ok, accountInfo, positions, trades }` in the app's IngestPayload sub-shapes. |
| `GET /whoami` | `{ ok, login }` - advertises `GATEWAY_LOGIN` so the collector can route accounts. |
| `GET /health` | `{ ok, bridge, historyCmd, uptimeS }`. |

Failures of the terminal/bridge return HTTP 503 `{ ok:false, error }` - the
process never crashes on them.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_API_KEY` | `change-me` | Must equal the APIKEY compiled into the bridge EA. |
| `REQ_PORT` / `PULL_PORT` | `5555` / `5556` | ZeroMQ ports bound by the EA inside the container. |
| `PORT` | `8001` | Express listen port. |
| `GATEWAY_LOGIN` | unset | Login of the account the terminal is logged into. Enables `/whoami` routing and snapshot/test mismatch rejection. One terminal = one account. |
| `MT4_LOGIN` / `MT4_PASSWORD` / `MT4_SERVER` | unset | Optional start-flag auto-login for the terminal (community-verified flags `/login: /password: /server:`; not officially documented by MetaQuotes). The broker `.srv` file must be present in `/opt/mt4/srv/` so the server label resolves. |
| `MT4_HISTORY_CMD` | unset (disabled) | Command id of a PATCHED bridge EA that exposes closed orders. The stock EA has no history support (see below). |

## One-time terminal + EA setup (automated on first boot)

On the first start with an empty `/opt/mt4` volume, `entrypoint.sh` runs
`setup/setup-mt4-terminal.sh`, which:

1. Uses the preinstalled Wine (winehq-stable).
2. Downloads `mt4setup.exe` from the official MetaQuotes CDN and installs it
   silently (`/auto` switch).
3. Installs `mql4-lib` and `mql-zmq` into the terminal's `MQL4` folder
   (portable mode: the data folder is the install folder on the volume).
4. Downloads `MetaTrader4Bridge.mq4`, patches `APIKEY`, `REP_PORT`,
   `PUSH_PORT`, and compiles it with `metaeditor.exe /compile ... /log`.
5. Drops a default chart template with the EA pre-attached and best-effort
   `terminal.ini` flags (`[Experts] Enabled=1, AllowDLLImports=1`).

Manual verification (one time, persists in the volume):

- Check the terminal's Experts tab for
  `[REP] Binding MT4 Server to Socket on Port 5555`.
- If you see errors 4017 (`DLL calls are not allowed`) or 4109
  (`trade is not allowed`), open Tools -> Options -> Expert Advisors, tick
  "Allow DLL imports", and make sure the AutoTrading toolbar button is green.
- Log the terminal into the broker account (start flags or manual login; a
  GUI session can be attached with `docker compose exec` + a VNC server if
  you prefer doing it interactively).

## Known limitations (read before relying on MT4 numbers)

1. **No closed-trade history with the stock EA.** The bridge protocol
   implements PING/RATES/ACCOUNT/ORDERS/trade commands only; `ORDERS`
   iterates `OrdersTotal()` (open + pending orders). Closed orders live in
   MT4's history pool, which the stock `MetaTrader4Bridge.mq4` never reads.
   Consequence: MT4 accounts get balance/equity/positions correctly but
   `trades: []` - no closed-trade backfill, no trade statistics.
   If you patch the EA (add a command that walks `OrdersHistoryTotal()` and
   streams the closed orders as JSON), set `MT4_HISTORY_CMD=<id>` and the
   gateway will call it with the ISO `historyFrom` date and map the result.
   The expected JSON shape is documented in `index.js` (CONFIG).
2. **One account per gateway.** MT4 terminals are single-account. Run one
   container per MT4 account and give the collector a comma-separated
   `MT4_GATEWAY_URL` list; it matches logins via `/whoami` (set
   `GATEWAY_LOGIN` in each container).
3. **Timestamps are broker-server time treated as UTC.** The EA formats order
   times as `yyyy.mm.dd hh:mi` with no timezone. Expect a possible 0..3h
   offset versus true UTC depending on the broker.
4. **`currentPrice` for open positions comes from the RATES command**
   (bid for BUY, ask for SELL). If a quote is unavailable the open price is
   used as fallback.
5. **Credentials cannot be applied through the bridge.** `/test` verifies
   bridge + terminal health, not broker credentials.
6. Wine is a CPU/emulation layer: expect ~0.5-1 GB RAM per terminal and a
   slow first boot (prefix init + installer).

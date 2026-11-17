# MT5 Gateway

Wine + official MetaTrader 5 terminal + **Windows Python 3.11** running a
FastAPI bridge. The official `MetaTrader5` pip package only works with
Windows Python, so the bridge itself runs under Wine's Windows interpreter.

```
collector --HTTP--> mt5-gateway (:8002, FastAPI on Wine's Windows Python)
                        |  mt5.initialize(login, password, server)
                        v
                    MT5 terminal64.exe (Wine) --trade server--> broker
```

## What it serves

| Route | Purpose |
|---|---|
| `GET /health` | `{ ok, service, terminalPath }` (used by the container HEALTHCHECK). |
| `POST /test` `{ login, password, server? }` | Real `mt5.initialize()` with the credentials, then shutdown. `{ ok, message }`. |
| `POST /snapshot` `{ login, password, server?, historyFrom? }` | `{ ok, accountInfo, positions, trades }` in the app's IngestPayload sub-shapes. |

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MT5_TERMINAL_PATH` | `C:\Program Files\MetaTrader 5\terminal64.exe` | Passed to `mt5.initialize(path=...)`. |
| `MT5_PRESTART` | `true` | Warm up terminal64.exe at container start (disable with `false`). |
| (bridge port) | 8002 | Hardcoded in the entrypoint (`--port 8002`). |

## Honest operational notes

1. **First image build is long (~10 min).** Wine + the MT5 installer
   (~500 MB) + Windows Python are downloaded during `docker compose build`.
   Subsequent rebuilds are cached unless the Dockerfile changes.
2. **Wine costs CPU.** The terminal is a full Windows app under emulation:
   budget ~0.5-1 GB RAM per gateway and expect noticeable idle CPU (~2-5%).
3. **Accounts connect SEQUENTIALLY through one terminal.** Every snapshot
   does `initialize(account) -> work -> shutdown` under a global lock. With
   20+ accounts keep `POLL_MINUTES >= 3`, or run more gateway replicas and
   give the collector a comma-separated `MT5_GATEWAY_URL` list - accounts are
   assigned deterministically (crc32 of accountId), so each account sticks to
   its gateway.
4. **Server labels must resolve inside the terminal.** MT5 connects by label
   (e.g. `ICMarketsSC-MT5`), not host:port. If the label is unknown to the
   terminal, download the broker's `.srv` file and drop it into the volume:
   `/opt/mt5/prefix/drive_c/Program Files/MetaTrader 5/Config/servers/`.
   The app's broker search usually provides the label; the `.srv` install is
   the fallback for exotic brokers.
5. **History window approximations.** Deals are grouped by position id. A
   position opened before `historyFrom` but closed after it has its opening
   deal outside the window - the side is then approximated from the closing
   deal and the app's 1-day overlap dedupe makes this harmless. Position
   reversals (`DEAL_ENTRY_INOUT`) emit only the closed part; the newly opened
   side shows up as a normal open position on the next poll.
6. **Known Wine fragility.** Some MT5 terminal builds ship Wine-incompatible
   updates. If the terminal fails to start after an auto-update, wipe the
   terminal binaries but keep `login` state: easiest is to recreate the
   `mt5data` volume and rebuild. Pinning terminal versions is not possible
   because MetaQuotes force-updates terminals.

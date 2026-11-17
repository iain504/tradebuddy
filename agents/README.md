# TradeBuddy push agents (recommended data path)

Agents run **where your MT4/MT5 terminals already run** (Windows VPS, desktop,
or a Wine box) and push account snapshots, open positions and closed-trade
history straight into the TradeBuddy dashboard's `/api/ingest` endpoint.

Why agents instead of server-side Wine gateways?

| | Push agents (this folder) | Pull gateways (`gateways/`) |
|---|---|---|
| Needs Wine/Docker hacks | No | Yes (fragile MetaQuotes installers) |
| Runs on your existing terminals | Yes | Not applicable |
| Credential exposure | None (agent reads your terminal session; only the ingest token is configured) | Investor password stored on server (encrypted) |
| Setup time | ~5 minutes per terminal | First boot image builds + manual GUI steps |

Both paths can coexist. Agents are the default recommendation since they have
no server-side moving parts.

---

## 0. Prerequisites (dashboard side)

1. Deploy the dashboard (see the root `README.md`) and open it.
2. Click **Setup guide** in the agent-mode banner (or use *Add account*) -
   it shows your exact `IngestURL` and `IngestToken` values with copy buttons.
3. Add each trading account in the dashboard first (**Add account**, same
   login + broker server as in the terminal, investor/read-only password).
   Agents are matched to accounts **by login** (+ server label when the same
   login exists on two brokers).

> Tip: on private instances set `EXPOSE_INGEST_TOKEN=1` so the dashboard can
> display copy-paste ready agent inputs.

---

## 1. MT4 - `TradeBuddyAgent.mq4` (EA, no external dependencies)

1. Download `agents/mt4-agent/TradeBuddyAgent.mq4` from this repo.
2. In MT4: **File -> Open Data Folder -> MQL4/Experts** - copy the file there,
   open MetaEditor (F4) and compile it (F7).
3. In MT4: **Tools -> Options -> Expert Advisors**:
   - tick **Allow WebRequest for listed URL**
   - add your dashboard base URL (e.g. `https://tradebuddy.example.com`)
4. Add the account in the dashboard (step 0) if you have not yet.
5. Drag **TradeBuddyAgent** onto any chart and fill the inputs:
   - `IngestURL` - e.g. `https://tradebuddy.example.com/api/ingest`
   - `IngestToken` - the shared token from the dashboard/.env
   - `PollSeconds` - push interval (default 30)
6. **Account History tab** (bottom of the terminal): right-click ->
   **All History**. MT4 only exposes loaded history to the EA, and this makes
   the first backfill cover everything.

Verification: a green smiley on the chart, `state: pushed` in the chart
comment and `TradeBuddy: pushed snapshot, HTTP 200` in the **Experts** tab.
The first push sends the full closed-trade history in batches (200 per
request), then live snapshots every `PollSeconds`.

Notes:
- Read-only: the EA never trades; AutoTrading is not required.
- Progress is persisted per login (terminal Global Variables), so restarting
  the terminal/EA resumes where it stopped. Set `RestartHistory=true` once to
  force a full re-send.
- MT4 timestamps are terminal (server) time.

---

## 2. MT5 - `TradeBuddyAgent.mq5` (EA)

Same flow as MT4, except:

1. Copy `agents/mt5-agent/TradeBuddyAgent.mq5` into **MQL5/Experts**, compile (F7).
2. Whitelist the dashboard URL in **Tools -> Options -> Expert Advisors**.
3. Attach to any chart, fill `IngestURL` + `IngestToken`.

No manual history step needed - MT5 exposes the full deal history to the EA.
Closed trades are rebuilt from deals grouped by `position_id` (partial closes,
reversals and commissions/swap are handled).

---

## 3. MT5 alternative - `mt5_agent.py` (Windows Python, no EA)

Uses the **official MetaTrader5 package** (Windows-only, talks to the local
terminal). Handy when you prefer a scheduled script over an EA, or you want
to run it as a Windows service / Task Scheduler job.

```powershell
pip install MetaTrader5 requests

# terminal already logged in - attach to it:
python mt5_agent.py --url https://tradebuddy.example.com/api/ingest --token TOKEN

# or let the agent log in itself (investor password works):
python mt5_agent.py --url ... --token ... --login 12345 --password INVESTOR_PW --server "ICMarketsSC-MT5"

# single run for Task Scheduler:
python mt5_agent.py --url ... --token ... --once
```

Useful flags: `--poll 30`, `--history-batch 200`, `--path "C:/Program Files/MetaTrader 5/terminal64.exe"`,
`--state-file ~/.tradebuddy-mt5-agent.json` (history cursor persists there).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Experts tab: `WebRequest failed (error 4014/4060)` | URL not whitelisted - redo step "Allow WebRequest". The URL must match scheme+host exactly. |
| Chart comment shows `push FAILED (HTTP 401)` | Wrong `IngestToken` - copy it again from the dashboard/.env. |
| `HTTP 404 No account matches login ...` | Add the account in the dashboard first (same login + platform). |
| `HTTP 409 matches N accounts` | Same login on two brokers - add the account with the exact broker server label so the agent's `server` field disambiguates. |
| MT4 history incomplete | Account History tab -> right-click -> **All History**, then set `RestartHistory=true` once. |
| Nothing appears in dashboard | Check the agent pushed 200s AND that the account is not `demo` (demo accounts are simulated, agents are ignored). |

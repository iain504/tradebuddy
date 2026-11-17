#!/usr/bin/env python3
"""
TradeBuddy MT5 push agent (Windows).

Runs next to your MetaTrader 5 terminal, reads the account the terminal is
logged into (or logs in itself with --login/--password/--server) and pushes:

  - account balance/equity/margin snapshots
  - currently open positions
  - closed trade history (deals grouped by position id, incremental cursor)

to a TradeBuddy dashboard's /api/ingest endpoint. Data is deduplicated
server-side by (login, positionId), so overlapping history windows are safe.

Usage:
  # terminal already logged in, attach to it:
  python mt5_agent.py --url https://tradebuddy.example.com/api/ingest --token TOKEN

  # explicit account (works without keeping the terminal UI open):
  python mt5_agent.py --url ... --token ... --login 12345 --password INVESTOR_PW --server "ICMarketsSC-MT5"

  # portable/terminal in a custom location:
  python mt5_agent.py --url ... --token ... --path "C:/Program Files/MetaTrader 5/terminal64.exe"

  # run a single cycle and exit (e.g. for Task Scheduler / cron):
  python mt5_agent.py --url ... --token ... --once

Requirements (Windows only - the official package needs the terminal):
  pip install MetaTrader5 requests
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package missing. Install with:  pip install MetaTrader5 requests",
          file=sys.stderr)
    sys.exit(1)

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s [mt5-agent] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mt5-agent")

STATE_VERSION = 1
EPS = 1e-6


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def clamp(v, digits=2):
    return round(float(v or 0.0), digits)


def price_digits(symbol: str) -> int:
    info = mt5.symbol_info(symbol)
    if info and getattr(info, "digits", 0):
        return int(info.digits)
    return 5


def rnd(v: float, digits: int) -> float:
    return round(float(v or 0.0), digits)


# --------------------------------------------------------------------------- #
# State (history pagination cursor), survives restarts
# --------------------------------------------------------------------------- #

def load_state(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
            if data.get("version") == STATE_VERSION:
                return data
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001 - corrupt state must not kill the agent
        log.warning("state file unreadable (%s) - starting a fresh history scan", exc)
    return {"version": STATE_VERSION, "cursorTime": 0, "cursorPos": 0}


def save_state(path: Path, state: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(state, fh)
        tmp.replace(path)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not persist state: %s", exc)


# --------------------------------------------------------------------------- #
# Terminal connection
# --------------------------------------------------------------------------- #

def connect(args) -> None:
    kwargs = {}
    if args.path:
        kwargs["path"] = args.path
    if args.login:
        if not (args.password and args.server):
            log.error("--login requires --password and --server")
            sys.exit(2)
        kwargs.update(login=int(args.login), password=args.password, server=args.server)

    if not mt5.initialize(**kwargs):
        code, msg = mt5.last_error()
        log.error("mt5.initialize() failed: %s %s", code, msg)
        log.error("Hints: the MT5 terminal must be installed on this machine; "
                  "start it once and log in manually, or pass --login/--password/--server.")
        sys.exit(3)
    acc = mt5.account_info()
    if acc is None:
        log.error("terminal reachable but no account is logged in - log in once "
                  "in the terminal or pass --login/--password/--server")
        mt5.shutdown()
        sys.exit(3)
    log.info("connected: login=%s server=%s balance=%.2f %s",
             acc.login, acc.server, acc.balance, acc.currency)


# --------------------------------------------------------------------------- #
# Snapshot builders
# --------------------------------------------------------------------------- #

def positions_payload() -> list:
    out = []
    for p in mt5.positions_get() or []:
        out.append({
            "positionId": str(p.identifier),
            "symbol": p.symbol,
            "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
            "volume": clamp(p.volume),
            "openPrice": rnd(p.price_open, price_digits(p.symbol)),
            "currentPrice": rnd(p.price_current, price_digits(p.symbol)),
            "openTime": iso(datetime.fromtimestamp(p.time, tz=timezone.utc)),
            "profit": clamp(p.profit),
            "swap": clamp(p.swap),
            "comment": (p.comment or None),
        })
    return out


def account_payload() -> dict:
    acc = mt5.account_info()
    margin = float(acc.margin or 0.0)
    return {
        "balance": clamp(acc.balance),
        "equity": clamp(acc.equity),
        "margin": clamp(margin),
        "freeMargin": clamp(acc.margin_free),
        "marginLevel": clamp(acc.margin_level) if margin > 0 else None,
        "leverage": int(acc.leverage or 0),
        "currency": acc.currency,
    }


def collect_closed_since(cursor_time: int, cursor_pos: int, grace_days: int,
                         limit: int) -> tuple[list, bool]:
    """Return (closed_trades_sorted_oldest_first, exhausted).

    exhausted=True means no more closed trades after the cursor (until new
    deals appear), so the caller can idle until the next rescan.
    """
    now = datetime.now(timezone.utc)
    frm = datetime.fromtimestamp(max(0, cursor_time), tz=timezone.utc) - timedelta(days=grace_days)
    deals = mt5.history_deals_get(frm, now + timedelta(days=1))
    if deals is None:
        return [], True

    # distinct position ids that have an OUT deal, in deal (time) order
    seen: set[int] = set()
    ids: list[int] = []
    for d in deals:
        if d.entry not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            continue
        pid = int(d.position_id or 0)
        if pid > 0 and pid not in seen:
            seen.add(pid)
            ids.append(pid)

    trades: list[dict] = []
    for pid in ids:
        group = mt5.history_deals_get(position=pid)
        if not group:
            continue
        vin = vout = pin = pout = profit = swap = comm = 0.0
        t_in = t_out = 0
        symbol = comment = ""
        side = None
        for d in group:
            if d.type in (mt5.DEAL_TYPE_BALANCE, mt5.DEAL_TYPE_CREDIT):
                continue
            profit += float(d.profit or 0.0)
            swap += float(d.swap or 0.0)
            comm += float(d.commission or 0.0)
            if not symbol:
                symbol = d.symbol
            if not comment:
                comment = d.comment
            if d.entry in (mt5.DEAL_ENTRY_IN, mt5.DEAL_ENTRY_INOUT):
                vin += float(d.volume or 0.0)
                pin += float(d.price or 0.0) * float(d.volume or 0.0)
                if t_in == 0:
                    t_in = int(d.time)
                if side is None:
                    side = "SELL" if d.type == mt5.DEAL_TYPE_SELL else "BUY"
            if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
                vout += float(d.volume or 0.0)
                pout += float(d.price or 0.0) * float(d.volume or 0.0)
                t_out = max(t_out, int(d.time))

        # only fully closed positions become trades (open ones go via /positions)
        if vin <= 0 or vout <= 0 or abs(vin - vout) > EPS:
            continue
        # strictly after cursor (tiebreak by position id)
        if t_out < cursor_time or (t_out == cursor_time and pid <= cursor_pos):
            continue

        trades.append({
            "positionId": str(pid),
            "symbol": symbol,
            "side": side or "BUY",
            "volume": clamp(vin),
            "openPrice": rnd(pin / vin, price_digits(symbol)),
            "closePrice": rnd(pout / vout, price_digits(symbol)),
            "openTime": iso(datetime.fromtimestamp(t_in, tz=timezone.utc)),
            "closeTime": iso(datetime.fromtimestamp(t_out, tz=timezone.utc)),
            "profit": clamp(profit),
            "commission": clamp(comm),
            "swap": clamp(swap),
            "comment": (comment or None),
            "_closeTime": t_out,
            "_posId": pid,
        })
        if len(trades) >= limit:
            break

    trades.sort(key=lambda t: (t["_closeTime"], t["_posId"]))
    exhausted = len(trades) < limit
    return trades, exhausted


# --------------------------------------------------------------------------- #
# Push cycle
# --------------------------------------------------------------------------- #

def push_once(args, state: dict) -> bool:
    acc = mt5.account_info()
    if acc is None:
        log.warning("lost terminal/account connection - reconnecting")
        mt5.shutdown()
        connect(args)
        acc = mt5.account_info()
        if acc is None:
            return False

    cursor_time = int(state.get("cursorTime") or 0)
    cursor_pos = int(state.get("cursorPos") or 0)

    trades, exhausted = collect_closed_since(
        cursor_time, cursor_pos, args.grace_days, args.history_batch
    )

    payload = {
        "login": str(acc.login),
        "platform": "MT5",
        "server": acc.server,
        "accountInfo": account_payload(),
        "positions": positions_payload(),
        "trades": [{k: v for k, v in t.items() if not k.startswith("_")} for t in trades],
        "ts": iso(datetime.now(timezone.utc)),
    }

    headers = {"Content-Type": "application/json"}
    if args.token:
        headers["X-Ingest-Token"] = args.token
    resp = requests.post(args.url, headers=headers, data=json.dumps(payload),
                         timeout=args.timeout)
    if resp.status_code != 200:
        log.error("push failed: HTTP %s %s", resp.status_code, resp.text[:200])
        return False

    if trades:
        state["cursorTime"] = trades[-1]["_closeTime"]
        state["cursorPos"] = trades[-1]["_posId"]
        save_state(args.state_file, state)
        log.info("pushed snapshot: %d closed trade(s), %d open position(s)%s",
                 len(trades), len(payload["positions"]),
                 "" if exhausted else " (more history pending)")
    else:
        log.info("pushed snapshot: %d open position(s), history up to date",
                 len(payload["positions"]))
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="TradeBuddy MT5 push agent")
    ap.add_argument("--url", default=os.environ.get("INGEST_URL", ""),
                    help="TradeBuddy ingest endpoint, e.g. https://host/api/ingest")
    ap.add_argument("--token", default=os.environ.get("INGEST_TOKEN", ""),
                    help="X-Ingest-Token value from the dashboard/.env")
    ap.add_argument("--login", default=os.environ.get("MT5_LOGIN", ""),
                    help="MT5 login (optional - otherwise attaches to the logged-in terminal)")
    ap.add_argument("--password", default=os.environ.get("MT5_PASSWORD", ""))
    ap.add_argument("--server", default=os.environ.get("MT5_SERVER", ""),
                    help='broker server label, e.g. "ICMarketsSC-MT5"')
    ap.add_argument("--path", default=os.environ.get("MT5_PATH", ""),
                    help="optional path to terminal64.exe (portable installs)")
    ap.add_argument("--poll", type=float, default=float(os.environ.get("POLL_SECONDS", "30")),
                    help="seconds between pushes (default 30)")
    ap.add_argument("--history-batch", type=int, default=200,
                    help="closed trades per request (default 200)")
    ap.add_argument("--grace-days", type=int, default=30,
                    help="history overlap window in days (default 30)")
    ap.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout seconds")
    ap.add_argument("--once", action="store_true", help="run one push cycle and exit")
    ap.add_argument("--state-file",
                    default=os.environ.get("MT5_AGENT_STATE",
                                           str(Path.home() / ".tradebuddy-mt5-agent.json")))
    args = ap.parse_args()

    if not args.url:
        ap.error("--url is required (e.g. https://your-tradebuddy/api/ingest)")

    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)

    connect(args)
    poll = max(5.0, args.poll)
    backoff = 5.0

    while True:
        try:
            if push_once(args, state):
                backoff = 5.0
            else:
                backoff = min(backoff * 2, 300.0)
        except KeyboardInterrupt:
            break
        except Exception as exc:  # noqa: BLE001 - never die on one bad cycle
            backoff = min(max(backoff, 5.0) * 2, 300.0)
            log.exception("cycle failed: %s", exc)

        if args.once:
            break
        time.sleep(poll if backoff <= 5.0 else backoff)

    mt5.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
MT5 bridge (FastAPI) - runs UNDER WINE with WINDOWS Python 3.11.

The official `MetaTrader5` pip package only works with Windows Python and an
MT5 terminal, which is why this file is executed by Wine's Windows Python
(see ../Dockerfile + ../entrypoint.sh), not by a Linux interpreter.

Endpoints (all JSON):
  GET  /health   -> { ok, service, terminalPath }
  POST /test     { login, password, server? }
                 -> { ok, message }           (connectivity check, no ingest)
  POST /snapshot { login, password, server?, historyFrom? }
                 -> { ok, accountInfo, positions, trades }
                    in the app's IngestPayload sub-shapes.

Design notes:
  * ONE terminal process serves ALL accounts: every request wraps
    mt5.initialize(login=..., password=..., server=...) -> work ->
    mt5.shutdown() while holding a global threading.Lock. Accounts are
    therefore connected SEQUENTIALLY - fine for pollMinutes >= 3, but do not
    point hundreds of accounts at a single gateway (run replicas and give the
    collector a comma-separated MT5_GATEWAY_URL list).
  * MT5 connects by SERVER LABEL (e.g. "ICMarketsSC-MT5"), not host:port.
    Labels resolve inside the terminal - install the broker .srv file if the
    label is unknown (see README.md).
  * History: deals are grouped by position_id. DEAL_ENTRY_IN (0) provides
    open side/price/time; DEAL_ENTRY_OUT (1) provides close price/time/profit;
    DEAL_ENTRY_INOUT (2, position reversal) and DEAL_ENTRY_OUT_BY (3, close by)
    are treated as closes of the current position - the reversal's newly opened
    side is NOT reconstructed (approximation, commented inline below).
  * Only positions with at least one OUT/INOUT/OUT_BY deal are emitted as
    closed trades; still-open positions come exclusively from positions_get().
  * All timestamps are converted to ISO-8601 UTC ("Z"). history_deals_get is
    called with naive UTC datetimes (the package's documented usage; the
    collector's ~1 day overlap window makes small boundary shifts harmless).
"""

import os
import threading
from datetime import datetime, timedelta, timezone

try:
    import MetaTrader5 as mt5
except ImportError as exc:  # clearer failure than a bare traceback at import
    raise SystemExit(
        "MetaTrader5 package not available - this service must run under "
        "Wine's WINDOWS Python (see Dockerfile/entrypoint.sh). "
        f"Original error: {exc}"
    )

from fastapi import FastAPI
from pydantic import BaseModel

TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH",
                               "C:\\Program Files\\MetaTrader 5\\terminal64.exe")

app = FastAPI(title="mt5-gateway", docs_url=None, redoc_url=None, openapi_url=None)

# One terminal -> strictly sequential account logins.
LOCK = threading.Lock()

DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1
DEAL_ENTRY_INOUT = 2      # reversal: closes the position AND opens the opposite
DEAL_ENTRY_OUT_BY = 3     # closed by an opposite position (close-by)
SIDE_BY_DEAL_TYPE = {DEAL_TYPE_BUY: "BUY", DEAL_TYPE_SELL: "SELL"}


class Credentials(BaseModel):
    login: str
    password: str
    server: str = ""


class SnapshotRequest(Credentials):
    historyFrom: str = ""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def iso_from_unix(seconds) -> str:
    """Unix seconds -> ISO-8601 UTC string ending in Z."""
    try:
        ts = float(seconds)
    except (TypeError, ValueError):
        return "1970-01-01T00:00:00Z"
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def parse_history_from(value: str) -> datetime:
    """ISO string -> naive UTC datetime for history_deals_get."""
    if value:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except ValueError:
            pass
    return datetime(1970, 1, 1)


def fnum(value, default=0.0) -> float:
    try:
        f = float(value)
        return f
    except (TypeError, ValueError):
        return default


def mt5_error() -> str:
    """Human-readable last error from the terminal."""
    try:
        code, desc = mt5.last_error()
        return f"{desc} (code {code})"
    except Exception:
        return "unknown terminal error"


def initialize_account(login: str, password: str, server: str) -> None:
    """Attach to the terminal and log into the given account.

    Raises RuntimeError on failure. mt5.shutdown() is the caller's duty
    (always paired in the endpoints below).
    """
    kwargs = {
        "login": int(login),
        "password": password,
        "path": TERMINAL_PATH,
    }
    if server:
        kwargs["server"] = server
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"mt5.initialize failed for login {login}: {mt5_error()}")


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #

@app.get("/health")
def health():
    return {"ok": True, "service": "mt5-gateway", "terminalPath": TERMINAL_PATH}


@app.post("/test")
def test(creds: Credentials):
    """Verify the terminal accepts the credentials. Never ingests anything."""
    try:
        int(creds.login)
    except ValueError:
        return {"ok": False, "message": f"login must be numeric, got {creds.login!r}"}

    with LOCK:
        try:
            initialize_account(creds.login, creds.password, creds.server)
            info = mt5.account_info()
            if info is None:
                message = f"terminal reachable but account_info() failed: {mt5_error()}"
                ok = False
            else:
                ok = True
                message = (f"Connected to server '{getattr(info, 'server', creds.server)}' "
                           f"as {info.login} ({info.currency}), balance {info.balance}")
        except Exception as exc:
            ok, message = False, str(exc)
        finally:
            mt5.shutdown()
    return {"ok": ok, "message": message}


@app.post("/snapshot")
def snapshot(req: SnapshotRequest):
    try:
        int(req.login)
    except ValueError:
        return {"ok": False, "error": f"login must be numeric, got {req.login!r}"}

    with LOCK:
        try:
            initialize_account(req.login, req.password, req.server)
            account_info = mt5.account_info()
            if account_info is None:
                raise RuntimeError(f"account_info() failed: {mt5_error()}")

            account = {
                "balance": fnum(account_info.balance),
                "equity": fnum(account_info.equity),
                "margin": fnum(account_info.margin),
                "freeMargin": fnum(account_info.margin_free),
                # margin_level is 0 when nothing is margined -> report null
                "marginLevel": (fnum(account_info.margin_level)
                                if fnum(account_info.margin) > 0 else None),
                "leverage": int(account_info.leverage or 0),
                "currency": str(account_info.currency or ""),
            }

            positions = normalize_positions(mt5.positions_get() or [])

            now = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(
                parse_history_from(req.historyFrom),
                # +1 day margin protects against clock skew between host and broker
                now + timedelta(days=1),
            )
            if deals is None:
                deals = []
            trades = normalize_trades(deals)

        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        finally:
            mt5.shutdown()

    return {"ok": True, "accountInfo": account, "positions": positions, "trades": trades}


# --------------------------------------------------------------------------- #
# normalization
# --------------------------------------------------------------------------- #

def normalize_positions(raw) -> list:
    """positions_get() rows -> IngestPosition shapes."""
    out = []
    for p in raw:
        side = SIDE_BY_DEAL_TYPE.get(int(getattr(p, "type", -1)))
        if side is None:
            continue
        out.append({
            "positionId": str(getattr(p, "ticket")),
            "symbol": str(getattr(p, "symbol", "")),
            "side": side,
            "volume": fnum(getattr(p, "volume")),
            "openPrice": fnum(getattr(p, "price_open")),
            "currentPrice": fnum(getattr(p, "price_current"),
                                 fnum(getattr(p, "price_open"))),
            "openTime": iso_from_unix(getattr(p, "time", 0)),
            "profit": fnum(getattr(p, "profit")),
            "swap": fnum(getattr(p, "swap")),
            "comment": (str(p.comment) if getattr(p, "comment", None) else None),
        })
    return out


def normalize_trades(deals) -> list:
    """
    Group deals by position_id and emit closed trades.

      DEAL_ENTRY_IN   (0): opening deal  -> side, volume, openPrice, openTime
      DEAL_ENTRY_OUT  (1): closing deal  -> closePrice, closeTime, profit
      DEAL_ENTRY_INOUT(2): reversal - closes the current position and opens the
                           opposite one. We emit the CLOSED part only and use
                           the reversal deal's price/time/profit for the close.
                           The newly opened position is not reconstructed (it
                           will appear in positions_get() on the next poll).
      DEAL_ENTRY_OUT_BY(3): close-by - treated exactly like OUT.

    Commission/swap/fee are summed across ALL deals of the position (MT5 may
    charge on entry and exit). Groups without any close-deal are skipped:
    those positions are still open and come from positions_get().
    """
    groups = {}
    for d in deals:
        if int(getattr(d, "type", -1)) not in (DEAL_TYPE_BUY, DEAL_TYPE_SELL):
            continue  # skip balance operations, credits, bonuses
        pos_id = getattr(d, "position_id", 0)
        if not pos_id:
            continue
        entry = int(getattr(d, "entry", -1))
        g = groups.setdefault(pos_id, {"in": [], "out": []})
        if entry == DEAL_ENTRY_IN:
            g["in"].append(d)
        elif entry in (DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY):
            g["out"].append(d)
        # unknown entry codes are ignored

    trades = []
    for pos_id, g in groups.items():
        ins, outs = g["in"], g["out"]
        if not outs:
            continue  # position not (fully) closed yet

        # side: from the opening deal when present; otherwise approximate as
        # the OPPOSITE of the first closing deal's type (an OUT deal trades in
        # the direction that neutralizes the position).
        if ins:
            side = SIDE_BY_DEAL_TYPE.get(int(ins[0].type))
            open_price = fnum(ins[0].price)
            open_time = iso_from_unix(ins[0].time)
            volume = sum(fnum(i.volume) for i in ins)
        else:
            # Opening deal is outside the history window (position opened
            # before historyFrom and closed after) - approximate.
            first_out = min(outs, key=lambda d: getattr(d, "time", 0))
            side = ("SELL" if int(first_out.type) == DEAL_TYPE_BUY else "BUY")
            open_price = fnum(first_out.price)
            open_time = iso_from_unix(first_out.time)
            volume = sum(fnum(o.volume) for o in outs)

        close_deal = max(outs, key=lambda d: getattr(d, "time", 0))
        all_deals = ins + outs

        trades.append({
            "positionId": str(pos_id),
            "symbol": str(getattr(close_deal, "symbol", "")
                          or (getattr(ins[0], "symbol", "") if ins else "")),
            "side": side or "BUY",
            "volume": round(volume, 8),
            "openPrice": open_price,
            "closePrice": fnum(close_deal.price),
            "openTime": open_time,
            "closeTime": iso_from_unix(close_deal.time),
            "profit": round(sum(fnum(d.profit) for d in outs), 8),
            "commission": round(sum(fnum(d.commission) + fnum(getattr(d, "fee", 0.0))
                                    for d in all_deals), 8),
            "swap": round(sum(fnum(d.swap) for d in all_deals), 8),
            "comment": (str(getattr(close_deal, "comment"))
                        if getattr(close_deal, "comment", None) else None),
        })

    trades.sort(key=lambda t: t["closeTime"])
    return trades

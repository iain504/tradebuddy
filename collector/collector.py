#!/usr/bin/env python3
"""
mt-monitor collector.

A single-file, asyncio-free polling worker that:
  1. Pulls the account list from the web app   (GET  {APP_URL}/api/collect/accounts)
  2. Asks the right platform gateway for a snapshot (MT4: ZeroMQ/terminal bridge,
     MT5: MetaTrader5 python bridge running under Wine)
  3. Pushes normalized results into the app    (POST {APP_URL}/api/ingest)
  4. Reports failures on the account record    (PATCH {APP_URL}/api/accounts/:id)

It also exposes a tiny stdlib HTTP server (COLLECTOR_PORT, default 8000):
  GET  /health -> { ok, accounts, lastCycle }
  POST /sync   { accountId } -> polls that account immediately (used by the
                                app's "Fetch now" button), returns { ok, trades }
  POST /test   { accountId } -> gateway connectivity test WITHOUT ingesting,
                                returns { ok, message }

/sync and /test require the shared token in the X-Ingest-Token header (same
secret as between collector and app). GET /health is unauthenticated on
purpose: it only exposes counters, never credentials.

Design notes:
  * One thread per account per cycle (ThreadPoolExecutor, max 4 workers) with a
    random per-account jitter so a big account list never becomes a burst.
  * Per-account exponential backoff on failures (1, 2, 4, ... max 30 minutes).
    A failing account can never kill the main loop.
  * History backfill: on first contact (and on every process start, because the
    bookkeeping is in-memory) we ask the gateway for closed trades since
    (backfillFrom - 1 day). After each success we roll the window to
    (lastSync - 1 day). The app dedupes trades by (accountId, positionId), so
    the ~1 day overlap is safe.
  * MT5_GATEWAY_URL / MT4_GATEWAY_URL accept comma-separated lists; accounts
    are split across gateways deterministically (crc32 of accountId). For MT4
    the collector additionally prefers a gateway whose /whoami reports the
    matching GATEWAY_LOGIN, because one MT4 terminal serves exactly one account.
"""

import json
import logging
import os
import random
import signal
import sys
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# --------------------------------------------------------------------------- #
# Configuration (env)
# --------------------------------------------------------------------------- #

APP_URL = os.environ.get("APP_URL", "http://app:3000").rstrip("/")
INGEST_TOKEN = os.environ.get("INGEST_TOKEN", "")
POLL_MINUTES = float(os.environ.get("POLL_MINUTES", "5"))
MT4_GATEWAY_URLS = [
    u.strip().rstrip("/")
    for u in os.environ.get("MT4_GATEWAY_URL", "http://mt4-gateway:8001").split(",")
    if u.strip()
]
MT5_GATEWAY_URLS = [
    u.strip().rstrip("/")
    for u in os.environ.get("MT5_GATEWAY_URL", "http://mt5-gateway:8002").split(",")
    if u.strip()
]
COLLECTION_JITTER_SECONDS = max(0.0, float(os.environ.get("COLLECTION_JITTER_SECONDS", "20")))
COLLECTOR_PORT = int(os.environ.get("COLLECTOR_PORT", "8000"))
APP_TIMEOUT_SECONDS = float(os.environ.get("APP_TIMEOUT_SECONDS", "30"))
GATEWAY_TIMEOUT_SECONDS = float(os.environ.get("GATEWAY_TIMEOUT_SECONDS", "90"))
MAX_BACKOFF_SECONDS = float(os.environ.get("MAX_BACKOFF_MINUTES", "30")) * 60.0
WORKERS = max(1, int(os.environ.get("MAX_WORKERS", "4")))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s [collector] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("collector")

if not INGEST_TOKEN:
    log.warning("INGEST_TOKEN is not set - requests to /sync and /test are accepted "
                "from anyone with network access. Set a strong token in production.")
if not MT4_GATEWAY_URLS or not MT5_GATEWAY_URLS:
    log.error("MT4_GATEWAY_URL or MT5_GATEWAY_URL is empty - fix the environment.")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(value: str) -> datetime:
    """Parse an ISO timestamp; fall back to 1970 on garbage."""
    if not value:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        log.warning("Could not parse ISO timestamp %r - using 1970-01-01", value)
        return datetime(1970, 1, 1, tzinfo=timezone.utc)


def app_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        h["X-Ingest-Token"] = INGEST_TOKEN
    return h


def stable_index(seed: str, modulo: int) -> int:
    """Deterministic gateway assignment (crc32 - stable across restarts)."""
    if modulo <= 1:
        return 0
    return zlib.crc32(seed.encode("utf-8")) % modulo


# --------------------------------------------------------------------------- #
# Collector state + core logic
# --------------------------------------------------------------------------- #

class Collector:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._inflight: set = set()
        self._failures: dict = {}         # accountId -> consecutive failures
        self._next_attempt: dict = {}     # accountId -> epoch seconds when due again
        self._history_from: dict = {}     # accountId -> rolling history window start (ISO)
        self._whoami_cache: dict = {}     # gateway url -> (expires_epoch, login_or_None)
        self.accounts_count = 0
        self.last_cycle = None

    # ---------------- gateway routing ---------------- #

    def _whoami(self, gateway_url: str):
        """GET /whoami on an MT4 gateway; cached 5 minutes. None = unknown."""
        now = time.time()
        with self._lock:
            cached = self._whoami_cache.get(gateway_url)
            if cached and cached[0] > now:
                return cached[1]
        login = None
        try:
            r = requests.get(f"{gateway_url}/whoami", timeout=APP_TIMEOUT_SECONDS)
            if r.ok:
                login = r.json().get("login")
        except Exception:
            login = None
        with self._lock:
            self._whoami_cache[gateway_url] = (now + 300, login)
        return login

    def pick_gateway(self, account: dict) -> str:
        urls = MT4_GATEWAY_URLS if account.get("platform") == "MT4" else MT5_GATEWAY_URLS
        if not urls:
            raise RuntimeError(f"No gateway URL configured for platform "
                               f"{account.get('platform')}")
        if len(urls) == 1:
            return urls[0]
        # Multi-gateway setup.
        if account.get("platform") == "MT4":
            # One MT4 terminal = one account: prefer the gateway that declares
            # this login via GATEWAY_LOGIN (/whoami). Fall back to a stable hash.
            for url in urls:
                if self._whoami(url) == str(account.get("login")):
                    return url
        return urls[stable_index(str(account.get("id")), len(urls))]

    # ---------------- app I/O ---------------- #

    def fetch_accounts(self) -> list:
        r = requests.get(f"{APP_URL}/api/collect/accounts",
                         headers=app_headers(), timeout=APP_TIMEOUT_SECONDS)
        r.raise_for_status()
        return r.json().get("accounts", [])

    def ingest(self, account: dict, result: dict) -> int:
        payload = {
            "accountId": account["id"],
            "ts": now_iso(),
            "status": "ACTIVE",
            "error": None,
            "accountInfo": result["accountInfo"],
            "positions": result.get("positions", []),
            "trades": result.get("trades", []),
        }
        r = requests.post(f"{APP_URL}/api/ingest", headers=app_headers(),
                          data=json.dumps(payload), timeout=APP_TIMEOUT_SECONDS)
        r.raise_for_status()
        return len(payload["trades"])

    def report_error(self, account_id: str, message: str) -> None:
        try:
            requests.patch(f"{APP_URL}/api/accounts/{account_id}",
                           headers=app_headers(),
                           data=json.dumps({"status": "ERROR",
                                            "lastError": message[:480]}),
                           timeout=APP_TIMEOUT_SECONDS)
        except Exception as exc:
            log.warning("Failed to report ERROR state for %s: %s", account_id, exc)

    # ---------------- gateway I/O ---------------- #

    def gateway_snapshot(self, account: dict, history_from: str) -> dict:
        url = self.pick_gateway(account)
        if account.get("platform") == "MT4":
            body = {
                "serverHost": account.get("serverHost") or "",
                "serverPort": account.get("serverPort") or 0,
                "login": account.get("login"),
                "password": account.get("password"),
                "historyFrom": history_from,
            }
        else:  # MT5 connects by server *label* inside the terminal
            body = {
                "login": account.get("login"),
                "password": account.get("password"),
                "server": account.get("serverName") or account.get("serverHost") or "",
                "historyFrom": history_from,
            }
        r = requests.post(f"{url}/snapshot", headers={"Content-Type": "application/json"},
                          data=json.dumps(body), timeout=GATEWAY_TIMEOUT_SECONDS)
        if not r.ok:
            raise RuntimeError(f"gateway {url} HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"gateway {url}: {data.get('error') or 'snapshot failed'}")
        return data

    def gateway_test(self, account: dict):
        url = self.pick_gateway(account)
        if account.get("platform") == "MT4":
            body = {
                "serverHost": account.get("serverHost") or "",
                "serverPort": account.get("serverPort") or 0,
                "login": account.get("login"),
                "password": account.get("password"),
            }
        else:
            body = {
                "login": account.get("login"),
                "password": account.get("password"),
                "server": account.get("serverName") or account.get("serverHost") or "",
            }
        r = requests.post(f"{url}/test", headers={"Content-Type": "application/json"},
                          data=json.dumps(body), timeout=GATEWAY_TIMEOUT_SECONDS)
        data = r.json() if (r.content or b"") else {}
        return bool(data.get("ok")), str(data.get("message") or data.get("error") or "")

    # ---------------- history window ---------------- #

    def history_window(self, account: dict) -> str:
        """Closed-trades window start. First contact / process start:
        backfillFrom - 1 day. After a success: last sync - 1 day (the overlap
        is deduplicated app-side by (accountId, positionId))."""
        with self._lock:
            cached = self._history_from.get(account["id"])
        if cached:
            return cached
        start = parse_iso(account.get("backfillFrom")) - timedelta(days=1)
        return start.isoformat()

    # ---------------- collection ---------------- #

    def collect_account(self, account: dict, jitter: bool = True) -> dict:
        """Full collect -> ingest for one account. Returns a summary dict and
        NEVER raises (all failures become ERROR state + backoff)."""
        acc_id = account["id"]
        summary = {"accountId": acc_id, "ok": False, "trades": 0, "error": None}

        with self._lock:
            if acc_id in self._inflight:
                summary["error"] = "already in flight"
                return summary
            self._inflight.add(acc_id)
        try:
            if jitter and COLLECTION_JITTER_SECONDS > 0:
                time.sleep(random.uniform(0, COLLECTION_JITTER_SECONDS))

            history_from = self.history_window(account)
            result = self.gateway_snapshot(account, history_from)
            trades = self.ingest(account, result)

            with self._lock:
                self._failures[acc_id] = 0
                self._next_attempt[acc_id] = 0.0
                self._history_from[acc_id] = (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat()
            summary.update(ok=True, trades=trades)
            log.info("account %s (%s %s): ingested balance=%.2f equity=%.2f "
                     "positions=%d trades=%d",
                     acc_id, account.get("platform"), account.get("login"),
                     float(result["accountInfo"].get("balance") or 0.0),
                     float(result["accountInfo"].get("equity") or 0.0),
                     len(result.get("positions", [])), trades)
        except Exception as exc:
            with self._lock:
                fails = self._failures.get(acc_id, 0) + 1
                self._failures[acc_id] = fails
                backoff = min(MAX_BACKOFF_SECONDS, 60.0 * (2 ** min(fails - 1, 5)))
                self._next_attempt[acc_id] = time.time() + backoff
            summary["error"] = str(exc)
            log.error("account %s (%s %s) failed (%d in a row, backing off %.0fs): %s",
                      acc_id, account.get("platform"), account.get("login"),
                      fails, backoff, exc)
            self.report_error(acc_id, str(exc))
        finally:
            with self._lock:
                self._inflight.discard(acc_id)
        return summary

    def run_cycle(self) -> None:
        try:
            accounts = self.fetch_accounts()
        except Exception as exc:
            log.error("Could not fetch account list from %s: %s", APP_URL, exc)
            return

        now = time.time()
        with self._lock:
            self.accounts_count = len(accounts)
            due = [a for a in accounts
                   if a["id"] not in self._inflight
                   and now >= self._next_attempt.get(a["id"], 0.0)]
        if not due:
            return

        log.info("cycle start: %d account(s) due of %d known (jitter<=%.0fs)",
                 len(due), self.accounts_count, COLLECTION_JITTER_SECONDS)
        with ThreadPoolExecutor(max_workers=WORKERS,
                                thread_name_prefix="collect") as pool:
            futures = [pool.submit(self.collect_account, acc) for acc in due]
            for fut in futures:
                fut.result()  # collect_account never raises; keeps semantics simple

        self.last_cycle = now_iso()
        log.info("cycle done: %s", self.last_cycle)

    # ---------------- immediate ops (HTTP /sync, /test) ---------------- #

    def sync_now(self, account: dict) -> dict:
        """One immediate poll for one account: no jitter, ignores backoff,
        resets it on success (handled inside collect_account)."""
        with self._lock:
            self._next_attempt[account["id"]] = 0.0
        return self.collect_account(account, jitter=False)

    def test_account(self, account: dict):
        try:
            return self.gateway_test(account)
        except Exception as exc:
            return False, str(exc)


# --------------------------------------------------------------------------- #
# Gateway health probing (surfaced via GET /health)
# --------------------------------------------------------------------------- #

_probe_lock = threading.Lock()
_probe_state: dict = {"mt4": None, "mt5": None, "updatedAt": None}


def _probe_urls(urls: list) -> dict:
    """Probe every configured gateway URL for a platform. ok = any reachable."""
    if not urls:
        return {"ok": False, "error": "no gateway URL configured", "urls": []}
    results = []
    for u in urls:
        try:
            r = requests.get(f"{u}/health", timeout=2.5)
            data = r.json() if (r.content or b"") else {}
            entry = {"url": u, "ok": bool(r.ok)}
            if "bridge" in data:            # mt4-gateway reports terminal state
                entry["bridge"] = data.get("bridge")
            results.append(entry)
        except Exception as exc:
            results.append({"url": u, "ok": False, "error": str(exc)[:120]})
    return {"ok": any(x.get("ok") for x in results), "urls": results}


def _probe_cycle() -> None:
    state = {
        "mt4": _probe_urls(MT4_GATEWAY_URLS),
        "mt5": _probe_urls(MT5_GATEWAY_URLS),
        "updatedAt": now_iso(),
    }
    with _probe_lock:
        _probe_state.clear()
        _probe_state.update(state)


def _gateway_probe_loop() -> None:
    """Refresh gateway health every ~30s in the background so /health itself
    always answers instantly (serving slightly stale state is fine)."""
    while True:
        try:
            _probe_cycle()
        except Exception as exc:  # never die
            log.warning("gateway probe failed: %s", exc)
        time.sleep(30)


# --------------------------------------------------------------------------- #
# Tiny HTTP server (/health, /sync, /test)
# --------------------------------------------------------------------------- #

collector = Collector()


class Handler(BaseHTTPRequestHandler):
    server_version = "mt-monitor-collector/1.0"

    # -- helpers ---------------------------------------------------------- #

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not INGEST_TOKEN:
            return True  # mirrors the app: token optional when unset (dev only)
        if self.headers.get("X-Ingest-Token") != INGEST_TOKEN:
            self._send(401, {"ok": False, "error": "Unauthorized"})
            return False
        return True

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _find_account(self, account_id: str):
        try:
            accounts = collector.fetch_accounts()
        except Exception as exc:
            log.error("/sync,/test: account list fetch failed: %s", exc)
            return None
        for acc in accounts:
            if acc.get("id") == account_id:
                return acc
        return None

    def log_message(self, fmt: str, *args) -> None:  # stdlib access logs -> logging
        log.info("http %s", fmt % args)

    # -- routes ------------------------------------------------------------ #

    def do_GET(self) -> None:
        if self.path.split("?")[0] == "/health":
            with _probe_lock:
                gateways = dict(_probe_state)
            self._send(200, {
                "ok": True,
                "accounts": collector.accounts_count,
                "lastCycle": collector.last_cycle,
                "gateways": gateways,
            })
        else:
            self._send(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        if path not in ("/sync", "/test"):
            self._send(404, {"ok": False, "error": "Not found"})
            return
        if not self._authorized():
            return
        body = self._read_json()
        account_id = str(body.get("accountId") or "")
        if not account_id:
            self._send(400, {"ok": False, "error": "accountId is required"})
            return

        account = self._find_account(account_id)
        if account is None:
            self._send(404, {"ok": False,
                             "error": "Account not found or app unreachable"})
            return

        if path == "/sync":
            summary = collector.sync_now(account)
            self._send(200 if summary.get("ok") else 502, {
                "ok": bool(summary.get("ok")),
                "trades": summary.get("trades", 0),
                "error": summary.get("error"),
            })
        else:  # /test - gateway connectivity check, never ingests
            ok, message = collector.test_account(account)
            self._send(200, {"ok": ok, "message": message})


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #

_stop_event = threading.Event()


def _handle_signal(signum, _frame) -> None:
    log.info("received signal %s - shutting down gracefully", signum)
    _stop_event.set()


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    httpd = ThreadingHTTPServer(("0.0.0.0", COLLECTOR_PORT), Handler)
    server_thread = threading.Thread(target=httpd.serve_forever,
                                     name="http", daemon=True)
    server_thread.start()
    threading.Thread(target=_gateway_probe_loop,
                     name="gateway-probe", daemon=True).start()
    log.info("collector up: app=%s poll=%.1fmin mt4=%s mt5=%s http=:%d",
             APP_URL, POLL_MINUTES, MT4_GATEWAY_URLS, MT5_GATEWAY_URLS,
             COLLECTOR_PORT)

    poll_seconds = max(30.0, POLL_MINUTES * 60.0)
    # Run one pass right away (freshly added accounts get data fast), then
    # every POLL_MINUTES. Sleep in short slices so SIGTERM is honored quickly.
    while not _stop_event.is_set():
        collector.run_cycle()
        deadline = time.monotonic() + poll_seconds
        while not _stop_event.is_set() and time.monotonic() < deadline:
            _stop_event.wait(timeout=1.0)

    log.info("stopping HTTP server")
    httpd.shutdown()
    httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

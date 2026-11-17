#!/usr/bin/env bash
#
# mt5-gateway entrypoint.
# Boot order: Xvfb -> wine prefix check -> (optional) pre-start terminal64.exe
# -> Windows Python + uvicorn on :8002.
#
# Note: the MetaTrader5 python package spawns/attaches to the terminal itself
# on mt5.initialize(). Pre-starting it here warms the terminal (symbol base
# download) but is optional; account switching is always done by the bridge.

set -euo pipefail

export WINEPREFIX="${WINEPREFIX:-/opt/mt5/prefix}"
export WINEDEBUG="${WINEDEBUG:--all}"
export DISPLAY="${DISPLAY:-:99}"

TERMINAL="$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe"
WINPYTHON='C:\Python311\python.exe'
PRESTART="${MT5_PRESTART:-true}"

log() { echo "[mt5-entrypoint] $*"; }

# --------------------------------------------------------------------------- #
# 1. Virtual display
# --------------------------------------------------------------------------- #
XSOCK="/tmp/.X11-unix/X${DISPLAY#:}"
if [ ! -S "$XSOCK" ]; then
  log "starting Xvfb on ${DISPLAY}"
  Xvfb "${DISPLAY}" -screen 0 1024x768x16 -nolisten tcp &
  for _ in $(seq 1 20); do [ -S "$XSOCK" ] && break; sleep 0.5; done
fi

# --------------------------------------------------------------------------- #
# 2. Wine prefix (created during build; created here when the volume is fresh)
# --------------------------------------------------------------------------- #
if [ ! -f "$WINEPREFIX/system.reg" ]; then
  log "wine prefix missing - initializing at $WINEPREFIX (first boot takes minutes)"
  wineboot --init >/dev/null 2>&1 || true
  wineserver -w || true
fi

# --------------------------------------------------------------------------- #
# 3. Optional terminal pre-start (warm-up: quotes, symbol base)
# --------------------------------------------------------------------------- #
if [ "$PRESTART" = "true" ] && [ -x "$TERMINAL" ]; then
  log "pre-starting MT5 terminal (MT5_PRESTART=true; disable with MT5_PRESTART=false)"
  wine "$TERMINAL" >/dev/null 2>&1 &
  sleep 5
fi

# --------------------------------------------------------------------------- #
# 4. Bridge API (Windows Python under Wine)
# --------------------------------------------------------------------------- #
cd /opt/bridge
log "starting uvicorn (Windows Python under Wine) on 0.0.0.0:8002"
exec wine "$WINPYTHON" -m uvicorn app:app --host 0.0.0.0 --port 8002 --log-level info

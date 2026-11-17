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
# 2b. Install the terminal when missing (build-time install can be skipped on
#     fresh volumes / flaky CDNs). Tries MetaQuotes' Wine-packaged installer
#     (mt5ubuntu.exe) first, then the generic web installer.
# --------------------------------------------------------------------------- #
MT5_INSTALL="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
TERMINAL="$MT5_INSTALL/terminal64.exe"
if [ ! -f "$TERMINAL" ]; then
  for inst in /opt/downloads/mt5ubuntu.exe /opt/downloads/mt5setup.exe; do
    [ -f "$inst" ] || continue
    log "terminal64.exe missing - trying silent install: $(basename "$inst") /auto"
    wine "$inst" /auto >/tmp/mt5-install.log 2>&1 || true
    for _ in $(seq 1 180); do
      [ -f "$TERMINAL" ] && break
      sleep 5
    done
    [ -f "$TERMINAL" ] && { log "MT5 installed via $(basename "$inst")"; break; }
    log "$(basename "$inst") did not produce terminal64.exe (see /tmp/mt5-install.log)"
  done
  if [ ! -f "$TERMINAL" ]; then
    log "WARNING: MT5 terminal is not installed - the bridge will answer /health but snapshots will fail."
    log "MetaQuotes installers are unreliable under Wine. Agent mode (agents/README.md) is the recommended data path."
  fi
fi

# --------------------------------------------------------------------------- #
# 3. Broker server files (*.srv) drop-in
#    Operator puts broker .srv files into /opt/mt5/srv (bind or docker cp into
#    the mt5data volume). They are copied into the terminal's Config/servers
#    so mt5.initialize(server:"<label>") resolves the broker by label.
# --------------------------------------------------------------------------- #
mkdir -p /opt/mt5/srv "$MT5_INSTALL/Config/servers"
for srv in /opt/mt5/srv/*.srv; do
  [ -f "$srv" ] || continue
  cp -f "$srv" "$MT5_INSTALL/Config/servers/" 2>/dev/null || true
  # Best-effort: also install into any per-user terminal data folders that
  # exist already (created by the terminal itself on first run).
  for datadir in "$WINEPREFIX"/drive_c/users/*/AppData/Roaming/MetaQuotes/Terminal/*/; do
    [ -d "$datadir/config/servers" ] && cp -f "$srv" "$datadir/config/servers/" 2>/dev/null || true
  done
  log "installed broker server file $(basename "$srv")"
done

# --------------------------------------------------------------------------- #
# 4. Optional terminal pre-start (warm-up: quotes, symbol base)
# --------------------------------------------------------------------------- #
if [ "$PRESTART" = "true" ] && [ -x "$TERMINAL" ]; then
  log "pre-starting MT5 terminal (MT5_PRESTART=true; disable with MT5_PRESTART=false)"
  wine "$TERMINAL" >/dev/null 2>&1 &
  sleep 5
fi

# --------------------------------------------------------------------------- #
# 5. Bridge API (Windows Python under Wine)
# --------------------------------------------------------------------------- #
cd /opt/bridge
log "starting uvicorn (Windows Python under Wine) on 0.0.0.0:8002"
exec wine "$WINPYTHON" -m uvicorn app:app --host 0.0.0.0 --port 8002 --log-level info

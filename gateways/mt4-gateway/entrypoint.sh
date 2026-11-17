#!/usr/bin/env bash
#
# mt4-gateway entrypoint.
# Boot order: Xvfb -> wine prefix init -> MT4 terminal (setup on first boot) ->
# wait for the ZeroMQ bridge port -> Node gateway.
#
# Terminal login: set MT4_LOGIN / MT4_PASSWORD / MT4_SERVER (and drop the
# broker .srv file into /opt/mt4/srv/) for start-flag based auto login, or log
# in manually once via GUI - the session persists in the /opt/mt4 volume.

set -euo pipefail

export WINEPREFIX="${WINEPREFIX:-/opt/mt4/prefix}"
export WINEDEBUG="${WINEDEBUG:--all}"
export DISPLAY="${DISPLAY:-:99}"
export MT4_DATA="${MT4_DATA:-/opt/mt4}"

MT4_INSTALL="$WINEPREFIX/drive_c/Program Files/MetaTrader 4"
TERMINAL="$MT4_INSTALL/terminal.exe"

log() { echo "[mt4-entrypoint] $*"; }

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
# 2. Wine prefix
# --------------------------------------------------------------------------- #
if [ ! -f "$WINEPREFIX/system.reg" ]; then
  log "initializing wine prefix at $WINEPREFIX (first boot takes a few minutes)"
  wineboot --init >/dev/null 2>&1 || true
  wineserver -w || true
fi

# --------------------------------------------------------------------------- #
# 3. MT4 terminal + bridge EA (one-time setup, persisted in the volume)
# --------------------------------------------------------------------------- #
if [ ! -x "$TERMINAL" ]; then
  log "MT4 terminal not found - running one-time setup (downloads MT4, compiles bridge EA)"
  bash /opt/gateway/setup/setup-mt4-terminal.sh
else
  log "MT4 terminal found at $TERMINAL"
fi

# Broker server definitions (*.srv) placed by the operator into /opt/mt4/srv
# are copied into the terminal's config/servers so /server:<label> resolves.
mkdir -p "$MT4_DATA/srv" "$MT4_INSTALL/config/servers"
for srv in "$MT4_DATA"/srv/*.srv; do
  [ -f "$srv" ] || continue
  cp -f "$srv" "$MT4_INSTALL/config/servers/"
  log "installed broker server file $(basename "$srv")"
done

# --------------------------------------------------------------------------- #
# 4. Start the terminal (background wine process)
# --------------------------------------------------------------------------- #
LOGFLAGS=()
if [ -n "${MT4_LOGIN:-}" ] && [ -n "${MT4_PASSWORD:-}" ] && [ -n "${MT4_SERVER:-}" ]; then
  log "starting terminal with login flags for account $MT4_LOGIN (server: $MT4_SERVER)"
  LOGFLAGS=( "/login:${MT4_LOGIN}" "/password:${MT4_PASSWORD}" "/server:${MT4_SERVER}" )
else
  log "starting terminal without login flags (no MT4_LOGIN/MT4_PASSWORD/MT4_SERVER set)"
fi
# shellcheck disable=SC2086
wine "$TERMINAL" /portable ${LOGFLAGS[@]+"${LOGFLAGS[@]}"} >/dev/null 2>&1 &

# --------------------------------------------------------------------------- #
# 5. Wait for the bridge EA to bind its REP port before starting Node
# --------------------------------------------------------------------------- #
REQ_PORT_NUM="${REQ_PORT:-5555}"
log "waiting for the bridge EA on 127.0.0.1:${REQ_PORT_NUM} (up to ~4 min; first terminal start is slow)"
BRIDGE_UP=0
for _ in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${REQ_PORT_NUM}") 2>/dev/null; then
    exec 3>&- 3<&- || true
    BRIDGE_UP=1
    break
  fi
  sleep 2
done
if [ "$BRIDGE_UP" = "1" ]; then
  log "bridge port is up"
else
  log "WARNING: bridge port did not open - the Node gateway will answer 503 until the EA binds. Check 'docker compose logs mt4-gateway' and the terminal Experts tab."
fi

# --------------------------------------------------------------------------- #
# 6. Node gateway (exec = PID 1 receives SIGTERM directly)
# --------------------------------------------------------------------------- #
exec node /opt/gateway/index.js

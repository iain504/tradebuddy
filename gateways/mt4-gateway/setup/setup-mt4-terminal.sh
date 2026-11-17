#!/usr/bin/env bash
#
# setup-mt4-terminal.sh - one-time MetaTrader 4 + bridge EA installation.
#
# Designed to run INSIDE the mt4-gateway container on first boot (the
# entrypoint calls it when no terminal is found in the persistent volume), but
# it also works on any Ubuntu 22.04 host with Wine if you export the env vars.
#
# What it automates:
#   1. Wine install (skipped when Wine is already present, e.g. in the image).
#   2. Official MT4 installer download from the MetaQuotes CDN + silent setup.
#   3. mql4-lib + mql-zmq libraries into the terminal's MQL4 folder.
#   4. MetaTrader4Bridge.mq4 download, BRIDGE_API_KEY/ports patched in,
#      compiled with metaeditor.exe.
#   5. A default chart template with the EA pre-attached + terminal.ini flags.
#
# What it CANNOT automate honestly (see printed MANUAL STEPS at the end):
#   - Logging the terminal into a broker account (start flags are used by the
#     entrypoint when MT4_LOGIN/MT4_PASSWORD/MT4_SERVER are provided, but they
#     are community-verified, not officially documented; manual login via UI
#     always works and persists in the volume).
#   - Verifying that AutoTrading/DLL-imports flags took effect (MetaQuotes
#     changes terminal.ini keys between builds; check the Experts tab once).
#
# Env vars:
#   WINEPREFIX      wine prefix (default /opt/mt4/prefix)
#   BRIDGE_API_KEY  EA apiKey (default change-me; MUST match the gateway env)
#   REQ_PORT        EA REP port (default 5555)
#   PULL_PORT       EA PUSH port (default 5556)
#   MT4_DATA        persistent volume root (default /opt/mt4)

set -euo pipefail

WINEPREFIX="${WINEPREFIX:-/opt/mt4/prefix}"
BRIDGE_API_KEY="${BRIDGE_API_KEY:-change-me}"
REQ_PORT="${REQ_PORT:-5555}"
PULL_PORT="${PULL_PORT:-5556}"
MT4_DATA="${MT4_DATA:-/opt/mt4}"

export WINEPREFIX
export WINEDEBUG="${WINEDEBUG:--all}"
export DISPLAY="${DISPLAY:-:99}"

MT4_INSTALL="$WINEPREFIX/drive_c/Program Files/MetaTrader 4"   # /auto default target
WORK_DIR="$MT4_DATA/setup-work"
NODE_DLL_DIR="/opt/gateway/node_modules/metatrader4/dll"        # fallback dlls shipped by the npm package

log() { echo "[mt4-setup] $*"; }
fail() { echo "[mt4-setup] ERROR: $*" >&2; exit 1; }

mkdir -p "$MT4_DATA" "$WORK_DIR"

# --------------------------------------------------------------------------- #
# 1. Wine (skipped inside the container - image already contains winehq-stable)
# --------------------------------------------------------------------------- #
if ! command -v wine >/dev/null 2>&1; then
  log "Wine not found - installing winehq-stable for Ubuntu 22.04 (official WineHQ wiki steps)"
  export DEBIAN_FRONTEND=noninteractive
  sudo dpkg --add-architecture i386
  sudo mkdir -pm755 /etc/apt/keyrings
  wget -qO- https://dl.winehq.org/wine-builds/winehq.key | sudo gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
  wget -qO /etc/apt/sources.list.d/winehq.sources https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources
  sudo apt-get update -y
  sudo apt-get install -y --install-recommends winehq-stable winbind xvfb cabextract
else
  log "Wine already present: $(wine --version 2>/dev/null | head -1 || echo 'version check failed')"
fi

# --------------------------------------------------------------------------- #
# 2. Wine prefix + MT4 silent install
# --------------------------------------------------------------------------- #
if [ ! -d "$WINEPREFIX" ]; then
  log "Initializing wine prefix (takes a minute or two)..."
  wineboot --init >/dev/null 2>&1 || true
  wineserver -w || true
fi

if [ ! -x "$MT4_INSTALL/terminal.exe" ]; then
  log "Downloading official MT4 installer from MetaQuotes CDN..."
  wget -q -O "$WORK_DIR/mt4setup.exe" \
    "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt4/mt4setup.exe" \
    || fail "mt4setup.exe download failed (network egress required on first boot)"
  log "Silent-installing MT4 (/auto is the MetaQuotes installer silent switch)..."
  wine "$WORK_DIR/mt4setup.exe" /auto >/dev/null 2>&1 || true
  # Wait for the installer to finish (it spawns installers asynchronously).
  for _ in $(seq 1 120); do
    [ -x "$MT4_INSTALL/terminal.exe" ] && break
    sleep 5
  done
  [ -x "$MT4_INSTALL/terminal.exe" ] || fail "terminal.exe not found after silent install - install MT4 manually (see README.md) and re-run"
  log "MT4 installed at $MT4_INSTALL"
else
  log "MT4 already installed at $MT4_INSTALL"
fi

# Portable mode: with /portable the terminal keeps its data (MQL4, config,
# profiles) INSIDE the install folder -> deterministic paths, volume-persistent.
MQL4_DIR="$MT4_INSTALL/MQL4"
CONFIG_DIR="$MT4_INSTALL/config"
mkdir -p "$MQL4_DIR/Include" "$MQL4_DIR/Libraries" "$MQL4_DIR/Experts" "$CONFIG_DIR/servers"

# --------------------------------------------------------------------------- #
# 3. mql-zmq + mql4-lib (bridge EA dependencies)
#    Verified structures (master branches):
#      mql-zmq-master/Include/Zmq/*.mqh  (+ Include/Mql/Lang partial subset)
#      mql-zmq-master/Library/MT4/{libzmq.dll,libsodium.dll}
#      mql4-lib-master/{Collection,Format,Lang,Trade,UI,...}   <- NO Include dir
#    The EA includes <Zmq/Zmq.mqh>, which includes <Mql/Lang/Native.mqh>.
# --------------------------------------------------------------------------- #
log "Installing mql-zmq (Include/Zmq + Libraries) ..."
if [ ! -f "$MQL4_DIR/Include/Zmq/Zmq.mqh" ]; then
  wget -q -O "$WORK_DIR/mql-zmq.zip" "https://github.com/dingmaotu/mql-zmq/archive/refs/heads/master.zip"
  unzip -qo "$WORK_DIR/mql-zmq.zip" -d "$WORK_DIR/mql-zmq"
  ZMQ_ROOT="$(dirname "$(find "$WORK_DIR/mql-zmq" -name Zmq.mqh | head -1)")/../.."   # zip root
  cp -r "$ZMQ_ROOT/Include/Zmq" "$MQL4_DIR/Include/"
  # Fallback for <Mql/Lang/Native.mqh> if mql4-lib is unavailable below.
  if [ ! -f "$MQL4_DIR/Include/Mql/Lang/Native.mqh" ]; then
    cp -r "$ZMQ_ROOT/Include/Mql" "$MQL4_DIR/Include/"
  fi
  # mql-zmq ships Library/MT4/<dlls>; MT4 requires them in MQL4/Libraries.
  if [ -d "$ZMQ_ROOT/Library/MT4" ]; then
    cp -r "$ZMQ_ROOT"/Library/MT4/* "$MQL4_DIR/Libraries/"
  fi
  rm -rf "$MQL4_DIR/Library"
else
  log "mql-zmq headers already present"
fi

log "Installing mql4-lib into MQL4/Include/Mql ..."
if [ ! -f "$MQL4_DIR/Include/Mql/Lang/Native.mqh" ]; then
  wget -q -O "$WORK_DIR/mql4-lib.zip" "https://github.com/dingmaotu/mql4-lib/archive/refs/heads/master.zip"
  unzip -qo "$WORK_DIR/mql4-lib.zip" -d "$WORK_DIR/mql4-lib"
  LIB_ROOT="$(find "$WORK_DIR/mql4-lib" -maxdepth 1 -type d -name 'mql4-lib-*' | head -1)"
  mkdir -p "$MQL4_DIR/Include/Mql"
  cp -r "$LIB_ROOT"/* "$MQL4_DIR/Include/Mql/"
else
  log "mql4-lib already present"
fi

# DLLs must exist in MQL4/Libraries - fall back to the ones shipped inside the
# metatrader4 npm package (identical libzmq/libsodium builds).
for dll in libzmq.dll libsodium.dll; do
  if [ ! -f "$MQL4_DIR/Libraries/$dll" ] && [ -f "$NODE_DLL_DIR/$dll" ]; then
    log "Restoring $dll from the npm package fallback"
    cp "$NODE_DLL_DIR/$dll" "$MQL4_DIR/Libraries/"
  fi
done
[ -f "$MQL4_DIR/Libraries/libzmq.dll" ] || log "WARNING: libzmq.dll missing - EA will fail to load (DLL imports step)"

# --------------------------------------------------------------------------- #
# 4. Bridge EA: download, patch credentials/ports, compile
# --------------------------------------------------------------------------- #
EA="$MQL4_DIR/Experts/MetaTrader4Bridge.mq4"
log "Fetching MetaTrader4Bridge.mq4 ..."
wget -q -O "$EA" "https://raw.githubusercontent.com/peterszombati/metatrader4/master/src/MetaTrader4Bridge.mq4" \
  || fail "bridge EA download failed - fetch it manually from https://github.com/peterszombati/metatrader4 (src/MetaTrader4Bridge.mq4)"

log "Patching EA: APIKEY='${BRIDGE_API_KEY:0:4}***' REP_PORT=$REQ_PORT PUSH_PORT=$PULL_PORT"
sed -i "s/extern string APIKEY = \"[^\"]*\";/extern string APIKEY = \"${BRIDGE_API_KEY//\"/\\\"}\";/" "$EA"
sed -i "s/extern int REP_PORT = [0-9]*;/extern int REP_PORT = ${REQ_PORT};/" "$EA"
sed -i "s/extern int PUSH_PORT = [0-9]*;/extern int PUSH_PORT = ${PULL_PORT};/" "$EA"

log "Compiling EA with metaeditor.exe (headless)..."
rm -f "$MQL4_DIR/Experts/MetaTrader4Bridge.log"
wine "$MT4_INSTALL/metaeditor.exe" \
  /compile:"C:\\Program Files\\MetaTrader 4\\MQL4\\Experts\\MetaTrader4Bridge.mq4" /log >/dev/null 2>&1 || true
sleep 2
if [ -f "$MQL4_DIR/Experts/MetaTrader4Bridge.log" ]; then
  tail -n 5 "$MQL4_DIR/Experts/MetaTrader4Bridge.log" || true
  if grep -q " 0 errors" "$MQL4_DIR/Experts/MetaTrader4Bridge.log"; then
    log "EA compiled successfully"
  else
    fail "EA compilation reported errors - inspect $MQL4_DIR/Experts/MetaTrader4Bridge.log"
  fi
else
  fail "metaeditor produced no compile log - EA not compiled"
fi
[ -f "$MQL4_DIR/Experts/MetaTrader4Bridge.ex4" ] || fail "MetaTrader4Bridge.ex4 not found after compile"

# --------------------------------------------------------------------------- #
# 5. Auto-attach the EA via the default chart template + terminal.ini flags
# --------------------------------------------------------------------------- #
log "Writing default chart template with the bridge EA pre-attached"
mkdir -p "$MT4_INSTALL/templates"
cat > "$MT4_INSTALL/templates/default.tpl" <<'TPL'
<chart>
symbol=EURUSD
period_type=0
period=60
digits=5
scale_fix=0
scale=0
mode=0
fore=0
grid=0
volume=0
resize=0
candle=0
date=1
price=1
toolbar=1
status=1
oneclick=0
window_left=0
window_top=0
window_right=640
window_bottom=480
window maximize=1
<window>
type=1
flags=0
items=0
<expert>MetaTrader4Bridge</expert>
expert_flags=339
</window>
</chart>
TPL

log "Writing terminal.ini expert flags (best effort - verify in UI if EA errors 4017/4109)"
touch "$CONFIG_DIR/terminal.ini"
grep -q "^\[Experts\]" "$CONFIG_DIR/terminal.ini" || printf "\n[Experts]\nEnabled=1\nAllowDLLImports=1\n" >> "$CONFIG_DIR/terminal.ini"

# --------------------------------------------------------------------------- #
# 6. Broker .srv files (server label resolution for /login starts)
# --------------------------------------------------------------------------- #
if [ -d "$MT4_DATA/srv" ]; then
  for srv in "$MT4_DATA"/srv/*.srv; do
    [ -f "$srv" ] || continue
    cp -f "$srv" "$CONFIG_DIR/servers/"
    log "Installed broker server file: $(basename "$srv")"
  done
fi

# --------------------------------------------------------------------------- #
# Done - print the honest checklist
# --------------------------------------------------------------------------- #
cat <<EOF

[mt4-setup] ============================================================
[mt4-setup] Setup finished. MANUAL VERIFICATION (one time, persists in the volume):
[mt4-setup]   1. Start the container; the entrypoint launches terminal.exe /portable.
[mt4-setup]   2. If MT4_LOGIN/MT4_PASSWORD/MT4_SERVER env vars are set, the terminal
[mt4-setup]      is started with those flags (place the broker .srv into the
[mt4-setup]      mt4data volume folder /opt/mt4/srv first so the server label resolves).
[mt4-setup]      Otherwise log in once manually (needs GUI access - see README.md).
[mt4-setup]   3. Check the Experts tab: expect "[REP] Binding MT4 Server to Socket on
[mt4-setup]      Port $REQ_PORT" and "[PUSH] Binding ... $PULL_PORT".
[mt4-setup]   4. If the log shows ERR_DLL_CALLS_NOT_ALLOWED (4017) or "trade is not
[mt4-setup]      allowed" (4109): Tools -> Options -> Expert Advisors -> tick
[mt4-setup]      "Allow DLL imports", and enable the AutoTrading button.
[mt4-setup] ============================================================
EOF

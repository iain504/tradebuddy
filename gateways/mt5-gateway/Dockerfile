# mt5-gateway container: Wine + official MetaTrader 5 terminal + Windows Python
# bridge (FastAPI). Target: x86_64 Linux. Best-effort but detailed; the build
# downloads ~500 MB (wine, MT5 installer, Windows Python) and takes ~10 min.
#
# Proxy-friendly build args (all optional):
#   docker build --build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=... .
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

ARG WINPYTHON_VERSION=3.11.9

# --------------------------------------------------------------------------- #
# Base tools + WineHQ stable (official wiki steps for Ubuntu 22.04, x86_64)
# --------------------------------------------------------------------------- #
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg unzip xz-utils winbind xvfb cabextract \
 && mkdir -pm755 /etc/apt/keyrings \
 && wget -qO /tmp/winehq.key https://dl.winehq.org/wine-builds/winehq.key \
 && gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key /tmp/winehq.key \
 && wget -qO /etc/apt/sources.list.d/winehq.sources \
      https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources \
 && apt-get update \
 && apt-get install -y --install-recommends winehq-stable \
 && rm -rf /var/lib/apt/lists/* /tmp/winehq.key

# --------------------------------------------------------------------------- #
# Downloaders: official MT5 installer + Windows Python 3.11 (amd64)
# --------------------------------------------------------------------------- #
RUN mkdir -p /opt/downloads /opt/bridge \
 && wget -q -O /opt/downloads/mt5setup.exe \
      "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" \
 && wget -q -O /opt/downloads/python-installer.exe \
      "https://www.python.org/ftp/python/${WINPYTHON_VERSION}/python-${WINPYTHON_VERSION}-amd64.exe"

# --------------------------------------------------------------------------- #
# Wine prefix + silent installs
#   - MT5 via the official installer's /auto switch
#   - Windows Python with a deterministic TargetDir=C:\Python311
#   Each RUN ends in an assertion so a failed silent install breaks the build.
# --------------------------------------------------------------------------- #
ENV WINEPREFIX=/opt/mt5/prefix \
    WINEDEBUG=-all \
    DISPLAY=:99 \
    WINPYTHON='C:\Python311\python.exe'

# 1. Initialize the wine prefix (quiet, best effort - failures are retried by wineboot itself)
RUN wineboot --init >/dev/null 2>&1 || true; \
    wineserver -w || true

# 2. Install MetaTrader 5
RUN wine /opt/downloads/mt5setup.exe /auto >/dev/null 2>&1 || true; \
    for i in $(seq 1 120); do \
      [ -f "$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe" ] && break; \
      sleep 5; \
    done; \
    test -f "$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe" \
      || { echo "MT5 silent install failed (terminal64.exe missing)"; exit 1; }

# 3. Install Windows Python 3.11
RUN wine /opt/downloads/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 \
      TargetDir='C:\Python311' Include_doc=0 Include_test=0 Include_tcltk=0 \
      Include_launcher=0 AssociateFiles=0 Shortcuts=0 >/dev/null 2>&1 || true; \
    for i in $(seq 1 120); do \
      [ -f "$WINEPREFIX/drive_c/Python311/python.exe" ] && break; \
      sleep 5; \
    done; \
    test -f "$WINEPREFIX/drive_c/Python311/python.exe" \
      || { echo "Windows Python silent install failed (python.exe missing)"; exit 1; } \
 && rm -f /opt/downloads/mt5setup.exe /opt/downloads/python-installer.exe

# --------------------------------------------------------------------------- #
# Bridge app + Python dependencies (Windows wheels work under Wine)
# --------------------------------------------------------------------------- #
COPY requirements-win.txt /opt/bridge/requirements-win.txt
RUN wine "$WINPYTHON" -m pip install --no-warn-script-location \
      -r 'Z:\opt\bridge\requirements-win.txt'

COPY bridge/app.py /opt/bridge/app.py
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

VOLUME ["/opt/mt5"]
EXPOSE 8002

HEALTHCHECK --interval=60s --timeout=10s --start-period=15m --retries=3 \
  CMD curl -fsS http://127.0.0.1:8002/health || exit 1

ENTRYPOINT ["/opt/entrypoint.sh"]

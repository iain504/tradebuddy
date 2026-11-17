# mt4-gateway container: Wine + MetaTrader 4 terminal + ZeroMQ bridge EA + Node 20 app.
# Target: x86_64 Linux. Build context = this directory.
#
# NOTE ON THE BUILD: `npm install` may compile the pinned zeromq version from
# source on Node 20 (python3/make/g++ are installed for that reason).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------------------------------- #
# Base tools + WineHQ stable (official wiki steps for Ubuntu 22.04, x86_64)
# --------------------------------------------------------------------------- #
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg unzip xz-utils winbind xvfb \
      python3 make g++ \
 && mkdir -pm755 /etc/apt/keyrings \
 && wget -qO /tmp/winehq.key https://dl.winehq.org/wine-builds/winehq.key \
 && gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key /tmp/winehq.key \
 && wget -qO /etc/apt/sources.list.d/winehq.sources \
      https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources \
 && apt-get update \
 && apt-get install -y --install-recommends winehq-stable \
 && rm -rf /var/lib/apt/lists/* /tmp/winehq.key

# --------------------------------------------------------------------------- #
# Node.js 20 (NodeSource)
# --------------------------------------------------------------------------- #
RUN curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh \
 && bash /tmp/nodesource.sh >/dev/null \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* /tmp/nodesource.sh

# --------------------------------------------------------------------------- #
# Gateway app
# --------------------------------------------------------------------------- #
WORKDIR /opt/gateway

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js entrypoint.sh ./
COPY setup/ ./setup/
RUN chmod +x entrypoint.sh setup/*.sh

# Wine + terminal live on the persistent volume so the terminal, its login and
# the compiled EA survive restarts.
ENV WINEPREFIX=/opt/mt4/prefix \
    WINEDEBUG=-all \
    DISPLAY=:99 \
    MT4_DATA=/opt/mt4 \
    BRIDGE_API_KEY=change-me \
    REQ_PORT=5555 \
    PULL_PORT=5556 \
    PORT=8001

VOLUME ["/opt/mt4"]
EXPOSE 8001

HEALTHCHECK --interval=60s --timeout=10s --start-period=15m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/gateway/entrypoint.sh"]

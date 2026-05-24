#!/bin/bash
# ============================================================================
# Usenet Ultimate - Localhost One-Click Install (macOS / Linux)
# ============================================================================
#
# Sets up Usenet Ultimate + NzbDAV on a single machine, bound to localhost
# only. This is the "Scenario 1" setup from INSTALLATION.md, automated.
#
# For LAN or VPS deployments you need HTTPS (Stremio rejects plain-HTTP addon
# URLs for any non-localhost host) - follow INSTALLATION.md instead.
#
# Usage:
#   ./auto-installers/auto-install-localhost-Mac-Linux.sh            # installs into ./usenet-ultimate
#   ./auto-installers/auto-install-localhost-Mac-Linux.sh /path/dir  # installs into a chosen directory
#
# The project directory is created relative to the directory you RUN the
# script from (your current working directory), not where this script lives.
# Running it from the repo root drops ./usenet-ultimate inside the repo. cd
# elsewhere first, or pass an absolute path, if you don't want that.
# ============================================================================

set -euo pipefail

PROJECT_DIR="${1:-usenet-ultimate}"
UU_IMAGE="ghcr.io/dsmart33/usenet-ultimate:latest"
NZBDAV_IMAGE="ghcr.io/nzbdav-dev/nzbdav:latest"
WATCHTOWER_IMAGE="nickfedor/watchtower:latest"

info()  { printf '\033[0;36m==>\033[0m %s\n' "$1"; }
ok()    { printf '\033[0;32m  ok\033[0m %s\n' "$1"; }
warn()  { printf '\033[0;33m  ! \033[0m %s\n' "$1"; }
die()   { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. Docker checks --------------------------------------------------------
info "Checking Docker"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop: https://docs.docker.com/desktop/"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Docker Compose not found. Install the Compose plugin: https://docs.docker.com/compose/install/"
fi

if ! docker_err=$(docker info 2>&1); then
  case "$docker_err" in
    *"permission denied"*|*"Permission denied"*)
      die "Permission denied connecting to the Docker socket.
Your user isn't in the 'docker' group. Fix it with:
  sudo usermod -aG docker \$USER
then log out and back in (or run: newgrp docker) and re-run this script.
Alternatively, run this script with sudo." ;;
    *)
      die "Can't connect to the Docker daemon. Start Docker and re-run this script:
  - macOS: launch Docker Desktop
  - Linux: sudo systemctl start docker" ;;
  esac
fi
ok "Docker and Compose available"

# --- 2. Check host ports are free --------------------------------------------
UI_PORT=1337
NZBDAV_PORT=3000
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

info "Checking ports $UI_PORT and $NZBDAV_PORT"
port_free "$UI_PORT"     || die "Port $UI_PORT is already in use. Free it (find the process with 'lsof -nP -iTCP:$UI_PORT -sTCP:LISTEN') and re-run, or edit the compose file to use a different host port."
port_free "$NZBDAV_PORT" || die "Port $NZBDAV_PORT is already in use. Free it (find the process with 'lsof -nP -iTCP:$NZBDAV_PORT -sTCP:LISTEN') and re-run, or edit the compose file to use a different host port."
ok "Ports $UI_PORT and $NZBDAV_PORT are free"

# --- 2b. Detect host timezone so Watchtower's nightly schedule runs in local time
HOST_TZ=""
if [ -L /etc/localtime ]; then
  HOST_TZ="$(readlink /etc/localtime | sed -e 's|^.*zoneinfo/||')"
elif [ -f /etc/timezone ]; then
  HOST_TZ="$(cat /etc/timezone)"
fi
HOST_TZ="${HOST_TZ:-UTC}"
ok "Host timezone: $HOST_TZ"

# --- 3. Project directory + compose file -------------------------------------
info "Creating project directory: $PROJECT_DIR"
mkdir -p "$PROJECT_DIR/config" "$PROJECT_DIR/nzbdav-config"
cd "$PROJECT_DIR"

COMPOSE_FILE="docker-compose.yml"
if [ -f "$COMPOSE_FILE" ]; then
  warn "$COMPOSE_FILE already exists, backing it up to ${COMPOSE_FILE}.bak"
  cp "$COMPOSE_FILE" "${COMPOSE_FILE}.bak"
fi

cat > "$COMPOSE_FILE" <<EOF
services:
  usenet-ultimate:
    image: $UU_IMAGE
    container_name: usenet-ultimate
    ports:
      - "127.0.0.1:${UI_PORT}:1337"
    volumes:
      - ./config:/app/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped
    depends_on:
      - nzbdav

  nzbdav:
    image: $NZBDAV_IMAGE
    container_name: nzbdav
    ports:
      - "127.0.0.1:${NZBDAV_PORT}:3000"
    environment:
      - NZB_GRAB_USER_AGENT=SABnzbd/4.5.5
    volumes:
      - ./nzbdav-config:/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped

  watchtower:
    image: $WATCHTOWER_IMAGE
    container_name: watchtower
    environment:
      - TZ=${HOST_TZ}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --schedule "0 0 4 * * *" --cleanup --label-enable
    restart: unless-stopped
EOF
ok "Wrote $PROJECT_DIR/$COMPOSE_FILE"

# --- 4. Start ----------------------------------------------------------------
info "Pulling images and starting containers"
$DC pull
$DC up -d

# --- 5. Done -----------------------------------------------------------------
echo
ok "Usenet Ultimate is starting."
echo
echo "  Open:           http://localhost:${UI_PORT}"
echo "  NzbDAV UI:      http://localhost:${NZBDAV_PORT}  (for its API key + WebDAV creds)"
echo "  Logs:           cd $PROJECT_DIR && $DC logs -f usenet-ultimate"
echo "  Stop:           cd $PROJECT_DIR && $DC down"
echo
echo "Next: create your admin account in the browser, then follow the"
echo "First-Run Checklist in INSTALLATION.md to wire up indexers and NzbDAV."

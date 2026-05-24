#!/bin/bash
# ============================================================================
# Usenet Ultimate - LAN One-Click Install (macOS / Linux)
# ============================================================================
#
# Sets up Usenet Ultimate + NzbDAV + Caddy so the addon is reachable over
# HTTPS from other devices on your home network (phone, TV, laptop). This is
# the "Scenario 2" setup from INSTALLATION.md, automated.
#
# Stremio refuses a plain-HTTP addon URL for any non-localhost host. This uses
# DuckDNS + a Caddy image built with the DuckDNS DNS module to obtain and
# AUTO-RENEW a real Let's Encrypt wildcard certificate over the DNS-01
# challenge. No open inbound ports, no per-device CA install, no manual cert
# refresh. The wildcard keeps the app names out of public CT logs. Only the
# duckdns subdomain is logged.
#
# Requires a free DuckDNS account: create a subdomain at https://www.duckdns.org
# and copy your token from the top of the dashboard.
#
# Usage:
#   ./auto-installers/auto-install-LAN-Mac-Linux.sh                          # prompts for subdomain + token
#   ./auto-installers/auto-install-LAN-Mac-Linux.sh <duckdns-subdomain> <duckdns-token>
#   ./auto-installers/auto-install-LAN-Mac-Linux.sh <sub> <token> /path/dir
#   ./auto-installers/auto-install-LAN-Mac-Linux.sh <sub> <token> /path/dir 192.168.1.50
#
#   <duckdns-subdomain>  the part before .duckdns.org (e.g. "myhomeuu")
#   <duckdns-token>      your DuckDNS token (kept in a private .env file)
#   [project dir]        default: ./usenet-ultimate
#   [lan ip]             default: auto-detected
#
# The project directory is created relative to the directory you RUN the
# script from (your current working directory), not where this script lives.
# Running it from the repo root drops ./usenet-ultimate inside the repo. cd
# elsewhere first, or pass an absolute path, if you don't want that.
# ============================================================================

# Exit on error, unset variable, or failed pipe.
set -euo pipefail

# Arguments and image constants
DUCKDNS_SUBDOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"
PROJECT_DIR="${3:-usenet-ultimate}"
LAN_IP="${4:-}"
UU_IMAGE="ghcr.io/dsmart33/usenet-ultimate:latest"
NZBDAV_IMAGE="ghcr.io/nzbdav-dev/nzbdav:latest"
WATCHTOWER_IMAGE="nickfedor/watchtower:latest"

# Colored status output helpers.
info()  { printf '\033[0;36m==>\033[0m %s\n' "$1"; }
ok()    { printf '\033[0;32m  ok\033[0m %s\n' "$1"; }
warn()  { printf '\033[0;33m  ! \033[0m %s\n' "$1"; }
die()   { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 0. DuckDNS credentials (prompt if not passed as arguments) --------------
# Mirrors the Windows script, which prompts for these when run with no args.
# The [ -t 0 ] guard skips prompting when stdin isn't a terminal (e.g. piped
# via curl | bash), so non-interactive runs fail cleanly instead of hanging.
if [ -z "$DUCKDNS_SUBDOMAIN" ] && [ -t 0 ]; then
    printf 'DuckDNS subdomain (the part before .duckdns.org): '
    read -r DUCKDNS_SUBDOMAIN
fi
if [ -z "$DUCKDNS_TOKEN" ] && [ -t 0 ]; then
    printf 'DuckDNS token: '
    read -r DUCKDNS_TOKEN
fi
[ -n "$DUCKDNS_SUBDOMAIN" ] && [ -n "$DUCKDNS_TOKEN" ] || die "DuckDNS subdomain and token are required.
Usage: $0 <duckdns-subdomain> <duckdns-token> [project-dir] [lan-ip]
Create a free subdomain + token at https://www.duckdns.org first."

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

# --- 2. Determine the LAN IP -------------------------------------------------
if [ -z "$LAN_IP" ]; then
  info "Detecting LAN IP"
  if [ "$(uname)" = "Darwin" ]; then
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
fi
[ -n "$LAN_IP" ] || die "Could not detect a LAN IP. Re-run with it explicitly as the 4th argument."
echo "$LAN_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || die "Detected value '$LAN_IP' is not an IPv4 address. Pass the correct one as the 4th argument."
ok "LAN IP: $LAN_IP"

# --- 3. Point DuckDNS at the LAN IP ------------------------------------------
info "Pointing $DUCKDNS_SUBDOMAIN.duckdns.org at $LAN_IP"
DUCK_RESP="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=${LAN_IP}" 2>/dev/null || true)"
[ "$DUCK_RESP" = "OK" ] || die "DuckDNS update failed (response: '${DUCK_RESP:-no response}'). Check the subdomain and token."
ok "DuckDNS record set"

# --- 4. Check host port is free ----------------------------------------------
HTTPS_PORT=443
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

info "Checking port $HTTPS_PORT"
port_free "$HTTPS_PORT" || die "Port $HTTPS_PORT is already in use. Free it (find the process with 'lsof -nP -iTCP:$HTTPS_PORT -sTCP:LISTEN') and re-run, or edit the compose file to use a different host port."
ok "Port $HTTPS_PORT is free"

# --- 4b. Detect host timezone so Watchtower's nightly schedule runs in local time
HOST_TZ=""
if [ -L /etc/localtime ]; then
  HOST_TZ="$(readlink /etc/localtime | sed -e 's|^.*zoneinfo/||')"
elif [ -f /etc/timezone ]; then
  HOST_TZ="$(cat /etc/timezone)"
fi
HOST_TZ="${HOST_TZ:-UTC}"
ok "Host timezone: $HOST_TZ"

# --- 5. Project directory ----------------------------------------------------
info "Creating project directory: $PROJECT_DIR"
mkdir -p "$PROJECT_DIR/config" "$PROJECT_DIR/nzbdav-config" \
         "$PROJECT_DIR/caddy-data" "$PROJECT_DIR/caddy-config"
cd "$PROJECT_DIR"

backup() { if [ -f "$1" ]; then warn "$1 exists, backing up to ${1}.bak"; cp "$1" "${1}.bak"; fi; }

# --- 6. caddy.Dockerfile (stock Caddy has no DNS modules) --------------------
backup caddy.Dockerfile
cat > caddy.Dockerfile <<'EOF'
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
EOF
ok "Wrote caddy.Dockerfile"

# --- 7. Caddyfile (generic; values come from .env) --------------------------
backup Caddyfile
cat > Caddyfile <<'EOF'
*.{$DUCKDNS_SUBDOMAIN}.duckdns.org {
	tls {
		dns duckdns {env.DUCKDNS_TOKEN}
		resolvers 1.1.1.1
	}

	@uu host uu.{$DUCKDNS_SUBDOMAIN}.duckdns.org
	handle @uu {
		reverse_proxy usenet-ultimate:1337
	}

	@nzbdav host nzbdav.{$DUCKDNS_SUBDOMAIN}.duckdns.org
	handle @nzbdav {
		reverse_proxy nzbdav:3000
	}
}
EOF
ok "Wrote Caddyfile"

# --- 8. .env (DuckDNS secrets; keep private) ---------------------------------
backup .env
cat > .env <<EOF
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EOF
chmod 600 .env
ok "Wrote .env (chmod 600)"

# --- 9. docker-compose.yml ---------------------------------------------------
backup docker-compose.yml
cat > docker-compose.yml <<EOF
services:
  caddy:
    build:
      context: .
      dockerfile: caddy.Dockerfile
    image: usenet-ultimate-caddy-duckdns:latest
    container_name: caddy
    ports:
      - "${HTTPS_PORT}:443"
    env_file: .env
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    restart: unless-stopped
    depends_on:
      - usenet-ultimate

  usenet-ultimate:
    image: $UU_IMAGE
    container_name: usenet-ultimate
    expose:
      - "1337"
    environment:
      - BASE_URL=https://uu.\${DUCKDNS_SUBDOMAIN}.duckdns.org
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
    expose:
      - "3000"
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
ok "Wrote docker-compose.yml"

# --- 10. Build + start -------------------------------------------------------
info "Building the Caddy+DuckDNS image and starting containers (first build compiles Caddy, can take a few minutes)"
$DC up -d --build

# --- 11. Done ----------------------------------------------------------------
ADDON_HOST="uu.${DUCKDNS_SUBDOMAIN}.duckdns.org"
NZBDAV_HOST="nzbdav.${DUCKDNS_SUBDOMAIN}.duckdns.org"
echo
ok "Usenet Ultimate is starting on your LAN."
echo
echo "  Open (Stremio + UI):  https://$ADDON_HOST"
echo "  NzbDAV UI:            https://$NZBDAV_HOST"
echo "  Logs:                 cd $PROJECT_DIR && $DC logs -f caddy"
echo "  Stop:                 cd $PROJECT_DIR && $DC down"
echo
echo "The first certificate is issued over DNS-01 and can take 1 to 3 minutes."
echo "Watch the caddy logs for 'certificate obtained successfully'. After that,"
echo "renewals are automatic."
echo
echo "If https://$ADDON_HOST doesn't resolve from a LAN device, your router's"
echo "DNS-rebind protection is likely dropping the private-IP answer. Whitelist"
echo "duckdns.org in the router, or run a local DNS override (Pi-hole)."
echo
echo "Next: open the NzbDAV UI for its API key + WebDAV creds, create your"
echo "admin account, then follow the First-Run Checklist in INSTALLATION.md."

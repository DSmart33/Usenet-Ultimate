# Installation Guide

The following installation guide will walk you through the process for both a localhost and LAN installation. For public internet access, I've linked the recommended documentation to get you up and running.

---

## Before You Start

This guide works on **Windows, macOS, and Linux**.

You'll need:

- **Docker** and **Docker Compose**. Pick the install that matches your OS:

  | Platform | Recommended | Install link |
  |---|---|---|
  | **Windows 10/11** | Docker Desktop | [Install Docker Desktop on Windows](https://docs.docker.com/desktop/install/windows-install/) (enable WSL 2 backend when prompted) |
  | **macOS** (Intel or Apple Silicon) | Docker Desktop | [Install Docker Desktop on Mac](https://docs.docker.com/desktop/install/mac-install/) |
  | **Linux desktop** | Docker Desktop *or* Docker Engine | [Docker Desktop on Linux](https://docs.docker.com/desktop/install/linux/) (GUI) · [Docker Engine](https://docs.docker.com/engine/install/) (CLI only, lighter, common on servers) |
  | **Linux server / VPS** | Docker Engine (CLI) | [Install Docker Engine](https://docs.docker.com/engine/install/). Pick your distro from the left sidebar |

  Docker Desktop ships with Compose v2 built in. For Docker Engine on Linux, also install the [Compose plugin](https://docs.docker.com/compose/install/linux/). Verify both with:

  ```bash
  docker --version
  docker compose version
  ```

- A **Usenet provider** (NNTP) (Torbox will not work).
- At least **one indexer source**: a Newznab-compatible indexer with an API key, or a configured [Prowlarr](https://prowlarr.com/) / [NZBHydra2](https://github.com/theotherp/nzbhydra2) instance, or an Easynews account.
- A **Stremio** install on whatever devices you want to stream from. [Download Stremio](https://www.stremio.com/downloads).

Usenet Ultimate streams through [NzbDAV](https://github.com/nzbdav-dev/nzbdav), which runs as a separate container. The compose examples below include an NzbDAV service.

### Pick your setup

| Scenario | Choose this if… |
|---|---|
| [Localhost only](#scenario-1-localhost-only) | You'll only use Usenet Ultimate and Stremio on the same machine. |
| [LAN](#scenario-2-lan-accessible) | You want to use the Usenet Ultimate and Stremio from other devices on your home network (Phone, TV, etc.). |
| [Server](#scenario-3-vps-with-https) | You want to use Usenet Ultimate over the public internet. |

---

## Scenario 1: Localhost Only

**Single Machine:** Usenet Ultimate and Stremio are running on the same machine.

### 1. Create the project directory

Navigate to where you'd like the project to exist and execute the following:

Unix
```bash
mkdir usenet-ultimate && cd usenet-ultimate
mkdir config nzbdav-config
```

Windows Powershell
```powershell
New-Item -ItemType Directory -Force usenet-ultimate; cd usenet-ultimate
New-Item -ItemType Directory -Force config, nzbdav-config
```

### 2. Create `docker-compose.yml` in current directory (usenet-ultiamte)

```bash
touch docker-compose.yml
```
Contents:

```yaml
services:
  usenet-ultimate:
    image: ghcr.io/dsmart33/usenet-ultimate:latest
    container_name: usenet-ultimate
    ports:
      - "127.0.0.1:1337:1337"
    volumes:
      - ./config:/app/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped
    depends_on:
      - nzbdav

  nzbdav:
    # See https://github.com/nzbdav-dev/nzbdav for the current image and required env vars.
    image: ghcr.io/nzbdav-dev/nzbdav:latest
    container_name: nzbdav
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - NZB_GRAB_USER_AGENT=SABnzbd/4.5.5
    volumes:
      - ./nzbdav-config:/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped

  watchtower:
    # Auto-pulls newer :latest images for the two services above every night at
    # 4 AM (local time, set by TZ below) and restarts them. Skips anything
    # without the enable=true label (so Caddy and Watchtower itself are left alone).
    # Change TZ to your IANA zone, e.g. America/New_York, Europe/London, Asia/Tokyo.
    # Disable entirely with: docker compose stop watchtower
    image: nickfedor/watchtower:latest
    container_name: watchtower
    environment:
      - TZ=UTC
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --schedule "0 0 4 * * *" --cleanup --label-enable
    restart: unless-stopped
```

### 3. Start it
From the project directory:
```bash
docker compose up -d
```
To check the logs
```bash
docker compose logs -f usenet-ultimate
```

### 4. First-run setup

Usenet Ultimate is now at `http://localhost:1337` and NzbDAV at `http://localhost:3000`. Follow **[SETUP.md](SETUP.md)** to create your account, connect your indexers and NzbDAV, and install the addon in Stremio.


---

## Scenario 2: LAN-Accessible

**LAN:** A machine on your home network runs Usenet Ultimate. You want to use it, and install it as a Stremio addon, from a phone, TV, or other computer on the same LAN.

Stremio refuses a plain-HTTP addon URLs for any host other than `localhost`, so LAN use needs HTTPS. 

This installation uses **[DuckDNS](https://www.duckdns.org) + Caddy with a Let's Encrypt wildcard certificate** obtained over DNS-01. 

Caddy issues and **auto-renews the certificate indefinitely** with no manual steps, no open inbound ports, and no per-device certificate install. 

The wildcard certificate (`*.<yourSubDomain>.duckdns.org`) keeps your specific app name out of public Certificate Transparency logs.

What ends up public: The name `<yourSubDomain>.duckdns.org` exists and resolves to your **private** LAN IP (e.g. `192.168.1.50`). A private IP is not routable from the internet and grants no access, so the service stays reachable only from your LAN. Your public IP, the service itself, and the individual app labels are not exposed.

### Prerequisites

1. A free account at [duckdns.org](https://www.duckdns.org).
2. Create a subdomain there, e.g. `myhomeuu` (gives you `myhomeuu.duckdns.org`).
3. Copy your **token** from the top of the DuckDNS dashboard. Treat it like a password.

### 1. Find your LAN IP

| OS | Command |
|---|---|
| macOS | `ipconfig getifaddr en0` or `en1` |
| Linux | `hostname -I \| awk '{print $1}'` |
| Windows (PowerShell) | `(Get-NetRoute -DestinationPrefix "0.0.0.0/0" \| Get-NetIPInterface \| Get-NetIPAddress).IPAddress` |

You'll get something like `192.168.1.50`. Set a DHCP reservation on your router so it doesn't change.

### 2. Point DuckDNS at your LAN IP

Tell DuckDNS to resolve your subdomain (and every name under it) to your LAN IP. Replace `<sub>`, `<token>`, `<lan-ip>`:

```bash
curl "https://www.duckdns.org/update?domains=<sub>&token=<token>&ip=<lan-ip>"
```

It should print `OK`. (Web alternative: set the IP field on the DuckDNS dashboard.)

### 3. Create the project

```bash
mkdir usenet-ultimate && cd usenet-ultimate
mkdir config nzbdav-config caddy-data caddy-config
```

Create **`caddy.Dockerfile`** (stock Caddy has no DNS-provider plugins. This bakes in the DuckDNS one):

Contents:

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Create **`Caddyfile`**:

Contents:

```
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
```

Create **`.env`** (your DuckDNS values):

Contents:
```
DUCKDNS_SUBDOMAIN=yourSubDomain
DUCKDNS_TOKEN=your-duckdns-token
```

Create **`docker-compose.yml`**:

Contents:

```yaml
services:
  caddy:
    build:
      context: .
      dockerfile: caddy.Dockerfile
    image: usenet-ultimate-caddy-duckdns:latest
    container_name: caddy
    ports:
      - "443:443"
    env_file: .env
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    restart: unless-stopped
    depends_on:
      - usenet-ultimate

  usenet-ultimate:
    image: ghcr.io/dsmart33/usenet-ultimate:latest
    container_name: usenet-ultimate
    expose:
      - "1337"
    environment:
      - BASE_URL=https://uu.${DUCKDNS_SUBDOMAIN}.duckdns.org
    volumes:
      - ./config:/app/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped
    depends_on:
      - nzbdav

  nzbdav:
    # See https://github.com/nzbdav-dev/nzbdav for the current image and required env vars.
    image: ghcr.io/nzbdav-dev/nzbdav:latest
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
    # Auto-pulls newer :latest images for the two services above every night at
    # 4 AM (local time, set by TZ below) and restarts them. Skips anything
    # without the enable=true label (so Caddy and Watchtower itself are left alone).
    # Change TZ to your IANA zone, e.g. America/New_York, Europe/London, Asia/Tokyo.
    # Disable entirely with: docker compose stop watchtower
    image: nickfedor/watchtower:latest
    container_name: watchtower
    environment:
      - TZ=UTC
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --schedule "0 0 4 * * *" --cleanup --label-enable
    restart: unless-stopped
```

### 4. Start it

```bash
docker compose up -d --build
docker compose logs -f caddy
```

### 5. First-run setup

Once Caddy has its certificate (watch the logs from step 4), your apps are reachable at `https://uu.<sub>.duckdns.org` (Usenet Ultimate) and `https://nzbdav.<sub>.duckdns.org` (NzbDAV admin). Follow **[SETUP.md](SETUP.md)** to create your account, connect NzbDAV, and install the addon in Stremio.

Two LAN-specific notes:
- In Streaming, set NzbDAV to the **container-DNS** values (not the LAN IP): `http://nzbdav:3000` for both the NzbDAV URL and WebDAV URL. `https://nzbdav.<sub>.duckdns.org` is only for reaching the NzbDAV admin page; the app talks to it internally over `http://nzbdav:3000`.
- The manifest URL from the dashboard already contains `https://uu.<sub>.duckdns.org`. Paste it into Stremio on each device.

### Troubleshooting (LAN)

- **Cert never issued / Caddy log shows DNS-01 errors**: confirm the token in `.env` is correct and the step-2 `curl` returned `OK`. The DuckDNS TXT update can be slow; if it times out, raise `propagation_delay` / `propagation_timeout` in the Caddyfile and re-run `docker compose up -d --build`.
- **Hostname doesn't resolve from a LAN device / "server not found"**: many routers have **DNS-rebind protection** that drops public DNS answers pointing at a private IP, which is exactly what DuckDNS returns here. Whitelist `duckdns.org` in the router, or run a local DNS override (Pi-hole, router local DNS) that answers `*.<sub>.duckdns.org` with the LAN IP.
- **Works on LAN, not on cellular**: expected. The name resolves to a private IP, so it is LAN-only by design.
- **`.env` token leaked**: regenerate it on the DuckDNS dashboard, update `.env`, then `docker compose up -d`.

---

## Scenario 3: Public Internet

For hosting publicly on the internet, I highly recommend following these guides to ensure a safe and reliable instance.

**Free Oracle VPS Guide:**
https://guides.viren070.me/selfhosting/oracle

**Docker Template Guide:**
https://guides.viren070.me/selfhosting/template

**Docker Template:**
https://github.com/Viren070/docker-compose-template

---

## First-Run Setup

After your container is up and reachable, **[SETUP.md](SETUP.md)** walks you through the full first-run configuration: creating your account, adding indexers, connecting NzbDAV, recommended settings, and installing the addon in Stremio.

---
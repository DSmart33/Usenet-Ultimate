# ============================================================================
# Usenet Ultimate - LAN One-Click Install (Windows / PowerShell)
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
# Usage (in PowerShell):
#   ./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token>
#   ./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token> -ProjectDir D:\apps\uu
#   ./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token> -LanIp 192.168.1.50
#
# The project directory is created relative to the directory you RUN the
# script from (your current working directory), not where this script lives.
# Running it from the repo root drops ./usenet-ultimate inside the repo - cd
# elsewhere first, or pass an absolute path, if you don't want that.
#
# If you get an execution-policy error, run once:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# ============================================================================

# Arguments and image constants
param(
    [Parameter(Mandatory=$true)][string]$DuckdnsSubdomain,
    [Parameter(Mandatory=$true)][string]$DuckdnsToken,
    [string]$ProjectDir = "usenet-ultimate",
    [string]$LanIp = ""
)

# Exit on any error.
$ErrorActionPreference = "Stop"

$UuImage         = "ghcr.io/dsmart33/usenet-ultimate:latest"
$NzbdavImage     = "ghcr.io/nzbdav-dev/nzbdav:latest"
$WatchtowerImage = "nickfedor/watchtower:latest"

# Colored status output helpers.
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  ok $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# --- 1. Docker checks --------------------------------------------------------
Info "Checking Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "Docker is not installed. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
}

$DC = $null
docker compose version *> $null
if ($LASTEXITCODE -eq 0) {
    $DC = "compose"
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $DC = "legacy"
} else {
    Die "Docker Compose not found. Docker Desktop includes it - make sure it's up to date."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Die "The Docker daemon isn't running. Start Docker Desktop and re-run this script."
}
Ok "Docker and Compose available"

function Invoke-DC {
    if ($DC -eq "compose") { docker compose @args } else { docker-compose @args }
}

# --- 2. Determine the LAN IP -------------------------------------------------
if ([string]::IsNullOrWhiteSpace($LanIp)) {
    Info "Detecting LAN IP"
    $LanIp = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" |
              Get-NetIPInterface |
              Get-NetIPAddress).IPAddress | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($LanIp)) {
    Die "Could not detect a LAN IP. Re-run with it explicitly: -LanIp 192.168.x.x"
}
if ($LanIp -notmatch '^(\d{1,3}\.){3}\d{1,3}$') {
    Die "Value '$LanIp' is not an IPv4 address. Pass the correct one: -LanIp 192.168.x.x"
}
Ok "LAN IP: $LanIp"

# --- 3. Point DuckDNS at the LAN IP ------------------------------------------
Info "Pointing $DuckdnsSubdomain.duckdns.org at $LanIp"
try {
    $resp = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$DuckdnsSubdomain&token=$DuckdnsToken&ip=$LanIp"
} catch {
    Die "DuckDNS update request failed: $_"
}
if ("$resp".Trim() -ne "OK") {
    Die "DuckDNS update failed (response: '$resp'). Check the subdomain and token."
}
Ok "DuckDNS record set"

# --- 4. Check host port is free ----------------------------------------------
$HttpsPort = 443
function Test-PortFree([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $Port)
        $client.Close()
        return $false   # connection succeeded => port in use
    } catch {
        return $true    # connection refused => port free
    }
}

Info "Checking port $HttpsPort"
if (-not (Test-PortFree $HttpsPort)) {
    Die "Port $HttpsPort is already in use. Free it (find the process with 'Get-NetTCPConnection -LocalPort $HttpsPort') and re-run, or edit the compose file to use a different host port."
}
Ok "Port $HttpsPort is free"

# --- 4b. Detect host timezone (IANA) for Watchtower's nightly schedule -------
# Windows reports a Windows zone id (e.g. "Eastern Standard Time"); Watchtower
# wants an IANA name (e.g. America/New_York). The table below (CLDR default
# mapping) does the conversion on Windows PowerShell 5.1, which has no built-in
# converter. .NET 6+ (PowerShell 7) does, so it's used as a fallback for any
# zone not in the table.
$WinToIana = @{
    "Dateline Standard Time"          = "Etc/GMT+12"
    "UTC-11"                          = "Etc/GMT+11"
    "Aleutian Standard Time"          = "America/Adak"
    "Hawaiian Standard Time"          = "Pacific/Honolulu"
    "Marquesas Standard Time"         = "Pacific/Marquesas"
    "Alaskan Standard Time"           = "America/Anchorage"
    "UTC-09"                          = "Etc/GMT+9"
    "Pacific Standard Time (Mexico)"  = "America/Tijuana"
    "UTC-08"                          = "Etc/GMT+8"
    "Pacific Standard Time"           = "America/Los_Angeles"
    "US Mountain Standard Time"       = "America/Phoenix"
    "Mountain Standard Time (Mexico)" = "America/Chihuahua"
    "Mountain Standard Time"          = "America/Denver"
    "Central America Standard Time"   = "America/Guatemala"
    "Central Standard Time"           = "America/Chicago"
    "Easter Island Standard Time"     = "Pacific/Easter"
    "Central Standard Time (Mexico)"  = "America/Mexico_City"
    "Canada Central Standard Time"    = "America/Regina"
    "SA Pacific Standard Time"        = "America/Bogota"
    "Eastern Standard Time (Mexico)"  = "America/Cancun"
    "Eastern Standard Time"           = "America/New_York"
    "Haiti Standard Time"             = "America/Port-au-Prince"
    "Cuba Standard Time"              = "America/Havana"
    "US Eastern Standard Time"        = "America/Indiana/Indianapolis"
    "Turks And Caicos Standard Time"  = "America/Grand_Turk"
    "Paraguay Standard Time"          = "America/Asuncion"
    "Atlantic Standard Time"          = "America/Halifax"
    "Venezuela Standard Time"         = "America/Caracas"
    "Central Brazilian Standard Time" = "America/Cuiaba"
    "SA Western Standard Time"        = "America/La_Paz"
    "Pacific SA Standard Time"        = "America/Santiago"
    "Newfoundland Standard Time"      = "America/St_Johns"
    "Tocantins Standard Time"         = "America/Araguaina"
    "E. South America Standard Time"  = "America/Sao_Paulo"
    "SA Eastern Standard Time"        = "America/Cayenne"
    "Argentina Standard Time"         = "America/Buenos_Aires"
    "Greenland Standard Time"         = "America/Godthab"
    "Montevideo Standard Time"        = "America/Montevideo"
    "Magallanes Standard Time"        = "America/Punta_Arenas"
    "Saint Pierre Standard Time"      = "America/Miquelon"
    "Bahia Standard Time"             = "America/Bahia"
    "UTC-02"                          = "Etc/GMT+2"
    "Azores Standard Time"            = "Atlantic/Azores"
    "Cape Verde Standard Time"        = "Atlantic/Cape_Verde"
    "UTC"                             = "Etc/UTC"
    "GMT Standard Time"               = "Europe/London"
    "Greenwich Standard Time"         = "Atlantic/Reykjavik"
    "Sao Tome Standard Time"          = "Africa/Sao_Tome"
    "Morocco Standard Time"           = "Africa/Casablanca"
    "W. Europe Standard Time"         = "Europe/Berlin"
    "Central Europe Standard Time"    = "Europe/Budapest"
    "Romance Standard Time"           = "Europe/Paris"
    "Central European Standard Time"  = "Europe/Warsaw"
    "W. Central Africa Standard Time" = "Africa/Lagos"
    "Jordan Standard Time"            = "Asia/Amman"
    "GTB Standard Time"               = "Europe/Bucharest"
    "Middle East Standard Time"       = "Asia/Beirut"
    "Egypt Standard Time"             = "Africa/Cairo"
    "E. Europe Standard Time"         = "Europe/Chisinau"
    "Syria Standard Time"             = "Asia/Damascus"
    "West Bank Standard Time"         = "Asia/Hebron"
    "South Africa Standard Time"      = "Africa/Johannesburg"
    "FLE Standard Time"               = "Europe/Kiev"
    "Israel Standard Time"            = "Asia/Jerusalem"
    "Kaliningrad Standard Time"       = "Europe/Kaliningrad"
    "Sudan Standard Time"             = "Africa/Khartoum"
    "Libya Standard Time"             = "Africa/Tripoli"
    "Namibia Standard Time"           = "Africa/Windhoek"
    "Arabic Standard Time"            = "Asia/Baghdad"
    "Turkey Standard Time"            = "Europe/Istanbul"
    "Arab Standard Time"              = "Asia/Riyadh"
    "Belarus Standard Time"           = "Europe/Minsk"
    "Russian Standard Time"           = "Europe/Moscow"
    "E. Africa Standard Time"         = "Africa/Nairobi"
    "Iran Standard Time"              = "Asia/Tehran"
    "Arabian Standard Time"           = "Asia/Dubai"
    "Astrakhan Standard Time"         = "Europe/Astrakhan"
    "Azerbaijan Standard Time"        = "Asia/Baku"
    "Russia Time Zone 3"              = "Europe/Samara"
    "Mauritius Standard Time"         = "Indian/Mauritius"
    "Saratov Standard Time"           = "Europe/Saratov"
    "Georgian Standard Time"          = "Asia/Tbilisi"
    "Volgograd Standard Time"         = "Europe/Volgograd"
    "Caucasus Standard Time"          = "Asia/Yerevan"
    "Afghanistan Standard Time"       = "Asia/Kabul"
    "West Asia Standard Time"         = "Asia/Tashkent"
    "Ekaterinburg Standard Time"      = "Asia/Yekaterinburg"
    "Pakistan Standard Time"          = "Asia/Karachi"
    "India Standard Time"             = "Asia/Kolkata"
    "Sri Lanka Standard Time"         = "Asia/Colombo"
    "Nepal Standard Time"             = "Asia/Kathmandu"
    "Central Asia Standard Time"      = "Asia/Almaty"
    "Bangladesh Standard Time"        = "Asia/Dhaka"
    "Omsk Standard Time"              = "Asia/Omsk"
    "Myanmar Standard Time"           = "Asia/Yangon"
    "SE Asia Standard Time"           = "Asia/Bangkok"
    "Altai Standard Time"             = "Asia/Barnaul"
    "W. Mongolia Standard Time"       = "Asia/Hovd"
    "North Asia Standard Time"        = "Asia/Krasnoyarsk"
    "N. Central Asia Standard Time"   = "Asia/Novosibirsk"
    "Tomsk Standard Time"             = "Asia/Tomsk"
    "China Standard Time"             = "Asia/Shanghai"
    "North Asia East Standard Time"   = "Asia/Irkutsk"
    "Singapore Standard Time"         = "Asia/Singapore"
    "W. Australia Standard Time"      = "Australia/Perth"
    "Taipei Standard Time"            = "Asia/Taipei"
    "Ulaanbaatar Standard Time"       = "Asia/Ulaanbaatar"
    "Aus Central W. Standard Time"    = "Australia/Eucla"
    "Transbaikal Standard Time"       = "Asia/Chita"
    "Tokyo Standard Time"             = "Asia/Tokyo"
    "North Korea Standard Time"       = "Asia/Pyongyang"
    "Korea Standard Time"             = "Asia/Seoul"
    "Yakutsk Standard Time"           = "Asia/Yakutsk"
    "Cen. Australia Standard Time"    = "Australia/Adelaide"
    "AUS Central Standard Time"       = "Australia/Darwin"
    "E. Australia Standard Time"      = "Australia/Brisbane"
    "AUS Eastern Standard Time"       = "Australia/Sydney"
    "West Pacific Standard Time"      = "Pacific/Port_Moresby"
    "Tasmania Standard Time"          = "Australia/Hobart"
    "Vladivostok Standard Time"       = "Asia/Vladivostok"
    "Lord Howe Standard Time"         = "Australia/Lord_Howe"
    "Bougainville Standard Time"      = "Pacific/Bougainville"
    "Russia Time Zone 10"             = "Asia/Srednekolymsk"
    "Magadan Standard Time"           = "Asia/Magadan"
    "Norfolk Standard Time"           = "Pacific/Norfolk"
    "Sakhalin Standard Time"          = "Asia/Sakhalin"
    "Central Pacific Standard Time"   = "Pacific/Guadalcanal"
    "Russia Time Zone 11"             = "Asia/Kamchatka"
    "New Zealand Standard Time"       = "Pacific/Auckland"
    "UTC+12"                          = "Etc/GMT-12"
    "Fiji Standard Time"              = "Pacific/Fiji"
    "Chatham Islands Standard Time"   = "Pacific/Chatham"
    "UTC+13"                          = "Etc/GMT-13"
    "Tonga Standard Time"             = "Pacific/Tongatapu"
    "Samoa Standard Time"             = "Pacific/Apia"
    "Line Islands Standard Time"      = "Pacific/Kiritimati"
}

$HostTz = "UTC"
try {
    $winTz = (Get-TimeZone).Id
    if ($WinToIana.ContainsKey($winTz)) {
        $HostTz = $WinToIana[$winTz]
    } else {
        # Not in the table: try the .NET 6+ converter (PowerShell 7), guarded
        # so the call is never attempted on 5.1 (where it doesn't exist).
        $iana = $null
        $hasConvert = [bool]([TimeZoneInfo].GetMethods() | Where-Object { $_.Name -eq 'TryConvertWindowsIdToIanaId' })
        if ($hasConvert -and [TimeZoneInfo]::TryConvertWindowsIdToIanaId($winTz, [ref]$iana)) {
            $HostTz = $iana
        } else {
            Warn "Could not map Windows TZ '$winTz' to IANA. Watchtower will run on UTC."
            Warn "To fix: edit docker-compose.yml and set TZ to your IANA zone (e.g. America/New_York)."
        }
    }
} catch {
    Warn "TZ detection failed. Watchtower will run on UTC."
    Warn "To fix: edit docker-compose.yml and set TZ to your IANA zone (e.g. America/New_York)."
}
Ok "Host timezone: $HostTz"

# --- 5. Project directory ----------------------------------------------------
Info "Creating project directory: $ProjectDir"
New-Item -ItemType Directory -Force -Path `
    "$ProjectDir/config", "$ProjectDir/nzbdav-config", `
    "$ProjectDir/caddy-data", "$ProjectDir/caddy-config" | Out-Null
Set-Location $ProjectDir

function Backup-File($p) {
    if (Test-Path $p) { Warn "$p exists, backing up to $p.bak"; Copy-Item $p "$p.bak" -Force }
}

# --- 6. caddy.Dockerfile (stock Caddy has no DNS modules) --------------------
Backup-File "caddy.Dockerfile"
@"
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
"@ | Set-Content -Path "caddy.Dockerfile" -Encoding utf8
Ok "Wrote caddy.Dockerfile"

# --- 7. Caddyfile (generic; values come from .env) --------------------------
Backup-File "Caddyfile"
@"
*.{`$DUCKDNS_SUBDOMAIN}.duckdns.org {
	tls {
		dns duckdns {env.DUCKDNS_TOKEN}
		resolvers 1.1.1.1
	}

	@uu host uu.{`$DUCKDNS_SUBDOMAIN}.duckdns.org
	handle @uu {
		reverse_proxy usenet-ultimate:1337
	}

	@nzbdav host nzbdav.{`$DUCKDNS_SUBDOMAIN}.duckdns.org
	handle @nzbdav {
		reverse_proxy nzbdav:3000
	}
}
"@ | Set-Content -Path "Caddyfile" -Encoding utf8
Ok "Wrote Caddyfile"

# --- 8. .env (DuckDNS secrets; keep private) ---------------------------------
Backup-File ".env"
@"
DUCKDNS_SUBDOMAIN=$DuckdnsSubdomain
DUCKDNS_TOKEN=$DuckdnsToken
"@ | Set-Content -Path ".env" -Encoding utf8
Ok "Wrote .env"

# --- 9. docker-compose.yml ---------------------------------------------------
Backup-File "docker-compose.yml"
@"
services:
  caddy:
    build:
      context: .
      dockerfile: caddy.Dockerfile
    image: usenet-ultimate-caddy-duckdns:latest
    container_name: caddy
    ports:
      - "${HttpsPort}:443"
    env_file: .env
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    restart: unless-stopped
    depends_on:
      - usenet-ultimate

  usenet-ultimate:
    image: $UuImage
    container_name: usenet-ultimate
    expose:
      - "1337"
    environment:
      - BASE_URL=https://uu.`${DUCKDNS_SUBDOMAIN}.duckdns.org
    volumes:
      - ./config:/app/config
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    restart: unless-stopped
    depends_on:
      - nzbdav

  nzbdav:
    image: $NzbdavImage
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
    image: $WatchtowerImage
    container_name: watchtower
    environment:
      - TZ=$HostTz
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --schedule "0 0 4 * * *" --cleanup --label-enable
    restart: unless-stopped
"@ | Set-Content -Path "docker-compose.yml" -Encoding utf8
Ok "Wrote docker-compose.yml"

# --- 10. Build + start -------------------------------------------------------
Info "Building the Caddy+DuckDNS image and starting containers (first build compiles Caddy, can take a few minutes)"
Invoke-DC up -d --build

# --- 11. Done ----------------------------------------------------------------
$AddonHost  = "uu.$DuckdnsSubdomain.duckdns.org"
$NzbdavHost = "nzbdav.$DuckdnsSubdomain.duckdns.org"
Write-Host ""
Ok "Usenet Ultimate is starting on your LAN."
Write-Host ""
Write-Host "  Open (Stremio + UI):  https://$AddonHost"
Write-Host "  NzbDAV UI:            https://$NzbdavHost"
Write-Host "  Logs:                 cd $ProjectDir; docker compose logs -f caddy"
Write-Host "  Stop:                 cd $ProjectDir; docker compose down"
Write-Host ""
Write-Host "The first certificate is issued over DNS-01 and can take 1 to 3 minutes."
Write-Host "Watch the caddy logs for 'certificate obtained successfully'. After that,"
Write-Host "renewals are automatic."
Write-Host ""
Write-Host "If https://$AddonHost doesn't resolve from a LAN device, your router's"
Write-Host "DNS-rebind protection is likely dropping the private-IP answer. Whitelist"
Write-Host "duckdns.org in the router, or run a local DNS override (Pi-hole)."
Write-Host ""
Write-Host "Next: open the NzbDAV UI for its API key + WebDAV creds, create your"
Write-Host "admin account, then follow the First-Run Checklist in INSTALLATION.md."

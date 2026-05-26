# ============================================================================
# Usenet Ultimate - Localhost One-Click Install (Windows / PowerShell)
# ============================================================================
#
# Sets up Usenet Ultimate + NzbDAV on a single machine, bound to localhost
# only. This is the "Scenario 1" setup from INSTALLATION.md, automated.
#
# For LAN or VPS deployments you need HTTPS (Stremio rejects plain-HTTP addon
# URLs for any non-localhost host) - follow INSTALLATION.md instead.
#
# Usage (in PowerShell):
#   ./auto-installers/auto-install-localhost-Windows.ps1                 # installs into ./usenet-ultimate
#   ./auto-installers/auto-install-localhost-Windows.ps1 -ProjectDir D:\apps\uu
#
# The project directory is created relative to the directory you RUN the
# script from (your current working directory), not where this script lives.
# Running it from the repo root drops ./usenet-ultimate inside the repo - cd
# elsewhere first, or pass an absolute path, if you don't want that.
#
# If you get an execution-policy error, run once:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# ============================================================================

param(
    [string]$ProjectDir = "usenet-ultimate"
)

$ErrorActionPreference = "Stop"

$UuImage         = "ghcr.io/dsmart33/usenet-ultimate:latest"
$NzbdavImage     = "ghcr.io/nzbdav-dev/nzbdav:latest"
$WatchtowerImage = "nickfedor/watchtower:latest"

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

# --- 2. Check host ports are free --------------------------------------------
$UiPort     = 1337
$NzbdavPort = 3000
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

Info "Checking ports $UiPort and $NzbdavPort"
if (-not (Test-PortFree $UiPort)) {
    Die "Port $UiPort is already in use. Free it (find the process with 'Get-NetTCPConnection -LocalPort $UiPort') and re-run, or edit the compose file to use a different host port."
}
if (-not (Test-PortFree $NzbdavPort)) {
    Die "Port $NzbdavPort is already in use. Free it (find the process with 'Get-NetTCPConnection -LocalPort $NzbdavPort') and re-run, or edit the compose file to use a different host port."
}
Ok "Ports $UiPort and $NzbdavPort are free"

# --- 2b. Detect host timezone (IANA) for Watchtower's nightly schedule -------
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

# --- 3. Project directory + compose file -------------------------------------
Info "Creating project directory: $ProjectDir"
New-Item -ItemType Directory -Force -Path "$ProjectDir/config", "$ProjectDir/nzbdav-config" | Out-Null
Set-Location $ProjectDir

$ComposeFile = "docker-compose.yml"
if (Test-Path $ComposeFile) {
    Warn "$ComposeFile already exists, backing it up to $ComposeFile.bak"
    Copy-Item $ComposeFile "$ComposeFile.bak" -Force
}

@"
services:
  usenet-ultimate:
    image: $UuImage
    container_name: usenet-ultimate
    ports:
      - "127.0.0.1:${UiPort}:1337"
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
    ports:
      - "127.0.0.1:${NzbdavPort}:3000"
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
"@ | Set-Content -Path $ComposeFile -Encoding utf8
Ok "Wrote $ProjectDir/$ComposeFile"

# --- 4. Start ----------------------------------------------------------------
Info "Pulling images and starting containers"
Invoke-DC pull
Invoke-DC up -d

# --- 5. Done -----------------------------------------------------------------
Write-Host ""
Ok "Usenet Ultimate is starting."
Write-Host ""
Write-Host "  Open:        http://localhost:$UiPort"
Write-Host "  NzbDAV UI:   http://localhost:$NzbdavPort  (for its API key + WebDAV creds)"
Write-Host "  Logs:        cd $ProjectDir; docker compose logs -f usenet-ultimate"
Write-Host "  Stop:        cd $ProjectDir; docker compose down"
Write-Host ""
Write-Host "Next: create your admin account in the browser, then follow the"
Write-Host "First-Run Checklist in INSTALLATION.md to wire up indexers and NzbDAV."

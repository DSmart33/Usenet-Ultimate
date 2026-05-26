# Auto-Installers

One-command installers that automate the Docker Compose setups from
[../INSTALLATION.md](../INSTALLATION.md). 

| Script | Platform | Equivalent manual guide |
|---|---|---|
| `auto-install-localhost-Mac-Linux.sh` | macOS / Linux | [Scenario 1: Localhost Only](../INSTALLATION.md#scenario-1-localhost-only) |
| `auto-install-localhost-Windows.ps1` | Windows | [Scenario 1: Localhost Only](../INSTALLATION.md#scenario-1-localhost-only) |
| `auto-install-LAN-Mac-Linux.sh` | macOS / Linux | [Scenario 2: LAN-Accessible](../INSTALLATION.md#scenario-2-lan-accessible) |
| `auto-install-LAN-Windows.ps1` | Windows | [Scenario 2: LAN-Accessible](../INSTALLATION.md#scenario-2-lan-accessible) |

Every script can be run with **no arguments**. The localhost scripts default
the project directory to `./usenet-ultimate`. 

The LAN scripts prompt for your
DuckDNS subdomain and token if you don't pass them.

## Before you run

- **Docker** must be installed and running. On Linux you also need the
  **Compose plugin** (`docker-compose-plugin`) and your user must be in the
  **docker** group (`sudo usermod -aG docker $USER`, then log out/in) so the
  installer can reach the Docker socket without `sudo`.
- The project directory is created **relative to your current directory**, not
  where the script lives. Run the script from the location where you want the
  `usenet-ultimate/` folder created, or pass an explicit project-dir argument.

- **LAN scripts only:** a free [DuckDNS](https://www.duckdns.org) account.
  Create a subdomain and copy your token from the top of the dashboard.

- **Windows only:** if you hit an execution-policy error, run this once in the
  same PowerShell session, then re-run the installer:
  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  ```

The commands below assume you are in the repository root.

## Localhost (single machine)

Binds Usenet Ultimate + NzbDAV to localhost on one machine.

**macOS / Linux**
```bash
# no args: installs into ./usenet-ultimate
bash auto-installers/auto-install-localhost-Mac-Linux.sh             

# custom directory
bash auto-installers/auto-install-localhost-Mac-Linux.sh /path/dir
```

**Windows (PowerShell)**
```powershell
# no args: installs into ./usenet-ultimate
./auto-installers/auto-install-localhost-Windows.ps1

# custom directory
./auto-installers/auto-install-localhost-Windows.ps1 -ProjectDir D:\apps\uu
```

## LAN (HTTPS, reachable from other devices)

Adds Caddy + DuckDNS so the addon is reachable over HTTPS from phones, TVs, and
other computers on your network. Run with no arguments to be prompted for your
DuckDNS subdomain and token, or pass them on the command line.

**macOS / Linux**
```bash
# no args: prompts for subdomain + token
bash auto-installers/auto-install-LAN-Mac-Linux.sh


# pass DuckDNS credentials directly
bash auto-installers/auto-install-LAN-Mac-Linux.sh <duckdns-sub> <duckdns-token>


# custom install directory
bash auto-installers/auto-install-LAN-Mac-Linux.sh <duckdns-sub> <duckdns-token> /path/dir


# set the LAN IP manually (skip auto-detection)
bash auto-installers/auto-install-LAN-Mac-Linux.sh <duckdns-sub> <duckdns-token> /path/dir 192.168.1.50
```

**Windows (PowerShell)**
```powershell
# no args: prompts for subdomain + token
./auto-installers/auto-install-LAN-Windows.ps1


# pass DuckDNS credentials directly
./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token>


# custom install directory
./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token> -ProjectDir D:\apps\uu


# set the LAN IP manually (skip auto-detection)
./auto-installers/auto-install-LAN-Windows.ps1 -DuckdnsSubdomain myhomeuu -DuckdnsToken <token> -LanIp 192.168.1.50
```

Arguments:
- `<duckdns-sub>`: the part before `.duckdns.org` (e.g. `myhomeuu`)
- `<duckdns-token>`: your DuckDNS token (stored in a private `.env`)
- project dir (optional): default `./usenet-ultimate`
- lan ip (optional): default auto-detected

## After it finishes

The stack is running but not yet configured. Follow **[../SETUP.md](../SETUP.md)**
to create your account, connect an indexer and NzbDAV, and install the addon in
Stremio.

For the manual setup steps, troubleshooting, and the public-internet scenario,
see **[../INSTALLATION.md](../INSTALLATION.md)**.

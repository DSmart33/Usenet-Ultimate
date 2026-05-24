<h1 align="center">Usenet Ultimate: First-Time Setup</h1>

<p align="center">
  A step-by-step walkthrough that takes you from a freshly installed instance to streaming in Stremio.
</p>

---

This guide picks up **after** you have Usenet Ultimate running and the web UI reachable in a browser. If you are not there yet, follow **[INSTALLATION.md](INSTALLATION.md)** first (localhost, LAN, or VPS), then come back here.

By the end you will have created your account, connected an indexer, setup NzbDAV, installed the addon in Stremio, and confirmed a working stream.

---

## Before you begin

| For | You need |
|---|---|
| Searching (pick one) | A Newznab-compatible indexer URL + API key, **or** a configured Prowlarr / NZBHydra2 instance **or** an Easynews account|
| Title resolution (recommended) | A free [TMDB API key](https://www.themoviedb.org/settings/api) and [TVDB API key](https://thetvdb.com/api-information) |
| Streaming | Your [NzbDAV](https://github.com/nzbdav-dev/nzbdav) API key and WebDAV username/password (see [Step 3](#step-3-setup-and-connect-nzbdav)) |
| Health checks (optional) | Your Usenet provider's NNTP host, port, username, and password |

---

## Step 1: Create your account

1. Open the web UI in a browser:
   - **localhost**: `http://localhost:1337`
   - **LAN / VPS**: the HTTPS hostname from your install, e.g. `https://uu.<yourSubDomain>.duckdns.org`
2. On first launch you will see a **Create your account to get started** screen. Enter a **Username**, a **Password**, and confirm the password, then click **Create Account**.
3. You'll then be asked to **Configure Index Manager** (see [Step 2](#step-2-set-up-your-indexers)). Configure an indexer using Newznab, Prowlarr, NZBHydra2, or configure your Easynews account.
3. You'll then land on the **Dashboard**. It is a grid of cards, clicking a card opens that section in an overlay menu. The two top tabs are **Dashboard** and **Install**.

---

## Step 2: Set up your indexers

Open the **Index Manager** card. At the top, pick your **Manager Type**:

### Option A: Newznab (manage indexers directly)

1. Add an indexer and fill in:
   - **Indexer Name** (any label you like)
   - **Newznab URL**
   - **API Key**
2. Click **Caps Discovery** so the addon auto-detects what the indexer supports.
3. Set the **Movie Search Method** and **TV Search Method** (IMDB / TMDB / TVDB / TVmaze, or Ultimate Text Search). Ultimate Text Search is the default.
4. Perform a **Test Search** and confirm results load without errors.
5. Repeat for any additional indexers.

In the shared **Search Settings** above, add your **TMDB API Key** and **TVDB API Key**, use the **Test** buttons to validate the keys. These noticeably improve search results.

### Option B: Prowlarr or NZBHydra2 (sync from an existing setup)

1. Choose **Prowlarr** or **NZBHydra2** as the Manager Type.
2. Enter the instance **URL** and **API Key** (NZBHydra also has optional username/password if its auth is enabled).
3. Click **Sync** to pull in your indexer list, then enable the ones you want.

### EasyNews (optional)

EasyNews can be enabled from the Index Manager as an additional source: toggle **Enable EasyNews**, enter your username and password, choose **DDL** or **NZB** mode, and click **Test EasyNews**.

> The Dashboard shows an empty state until at least one indexer, manager, or Easynews is configured. The **Install** tab also stays gated.

---

## Step 3: Setup and Connect NzbDAV

First, open the NzbDAV UI in a browser:
- **localhost**: `http://localhost:3000`
- **LAN / VPS**: the HTTPS hostname from your install, e.g. `https://nzbdav.<yourSubDomain>.duckdns.org`

Add your Usenet provider in NzbDAV, **Settings → Usenet**:
- **Host** and **Port** (usually 563 for SSL)
- **Username** and **Password**
- **Connections** (the maximum your provider plan allows, or the maximum minus the number of connections set in Usenet Ultimate's Health Check settings, if enabled. Feel free to use less here as well.)

Then grab the credentials Usenet Ultimate needs:
- **API Key**: Settings → SABnzbd → API Key
- **WebDAV user/pass**: Settings → WebDAV (set them and save at the bottom)

Back in Usenet Ultimate, open the **Streaming Mode** tile, keep the mode on **NzbDAV**, and fill in the Streaming overlay:

| Field | Value |
|---|---|
| **NzbDAV URL** | NzbDAV's API URL |
| **NzbDAV API Key** | from NzbDAV → Settings → SABnzbd |
| **WebDAV URL** | NzbDAV's WebDAV URL |
| **WebDAV Username / Password** | from NzbDAV → Settings → WebDAV |

**Which URL to use:** the Compose setups in INSTALLATION.md (localhost, LAN, and VPS) all run NzbDAV as a container named `nzbdav` on the same Docker network, so use the **container-DNS** name `http://nzbdav:3000` for both the NzbDAV URL and the WebDAV URL, not `http://localhost:3000` or the LAN IP. (Inside the Usenet Ultimate container, `localhost` points to itself, not NzbDAV.)

The default mount folders (`Usenet-Ultimate-Movies` and `Usenet-Ultimate-TV`) are fine to leave as-is.

Finally, click **Test Connection**, then **Send Test NZB** to confirm end-to-end submission works.

---

## Step 4: Install in Stremio

1. Open the **Install** tab.
2. Each install card shows an **Addon Manifest URL** with these controls:
   - **Copy** the URL, or click **Open in Stremio** to hand it straight to the app.
   - **Add Install** creates an additional manifest (handy for multiple people or devices); 
   - **Regenerate Key** rotates the URL.
   - **Edit** allows you to changes the name of the manifest.
   - **Delete** discards the selected manifest
3. In Stremio, go to the addon catalog, paste the URL if you copied it, and click **Install**.
4. Repeat on each device. Each install card has its own unique URL, so different users can share one instance.

> **HTTPS note:** Stremio refuses a plain-HTTP addon URL on any host other than `localhost`. On a phone, TV, or any device that is not the host machine, the manifest URL must be **HTTPS**, which is exactly what the LAN/VPS install in INSTALLATION.md sets up.

---

## Step 5: Test it

1. In Stremio, open a movie or TV episode and view its stream list.
2. Confirm Usenet Ultimate streams appear, then start one and confirm it plays.

If streams appear and play, your core setup is done. The rest below is optional polish.

---

## Recommended optional settings

These are not required to stream, but they meaningfully improve performance, reliability, and result quality. Each heading below is a Dashboard tile.

### Index Manager

Beyond the indexer(s) you added in [Step 2](#step-2-set-up-your-indexers):

- **Search methods**: use only **Ultimate Text Search**.
- **Ultimate Library (UL)**: enable it, then **disable Apply to Movies**.
  - Enable **Run on cache hit**.
  - Enable **both delete tiles**.
  - Under **Delete All results**, set **Pack scope** to **Pack**.
- Enable the **Complete** chip for series packs.
- If you use EasyNews, set its **Timeout** to **7 seconds**.

### Ultimate Fallback (strongly recommended)

1. **Enable** it and apply a preset: 
   - **Lite** or **Enhanced**. Enhanced is recommended over Lite.
2. Set up your **health check provider** at the bottom of this card (your Usenet provider's **Host**, **Port**, **Username**, **Password**). This is where health checking is configured.
3. If you are not going to set up a provider here, disable the health checks within Ultimate Fallback.

### Health Checks

  - Leave this card **disabled**. An optimized implimentation of Health checking is handled inside Ultimate Fallback (above).

### NZB Database

  - **Disable Include Timed-out NZBs** so a one-off timeout doesn't permanently blacklist an otherwise good release.

### Auto Play

  - Leave it **enabled** on **First File**.

### Search Cache

  - Set **Cache 0-result searches** to **disabled**.

### Filters, Rules & Sorting

This card has separate profiles. Configure **TV Shows** first, then **Global** (which now applies to movies).

**TV Shows** (click the **TV Shows** tab):

1. Enable the **series / season pack min**.
2. Under **Ranked rules**, click **Import**, select the preset URL, then **Fetch**, then **Fetch and Parse**.
3. In **Sort order priority**, enable **Edition** and move it to the top. 
4. Enable **Ranked SEL Score** directly after **Quality**.
5. Expand **Edition filters / priorities** and enable **Prefer Non-Standard Editions**.
6. Expand **Encodes** and disable any that your streaming devices cannot play.

**Global** (now just movies):

1. Import the preset again.
2. Enable **SEL Score** after **Quality**.
3. Apply the same **Encodes** filtering as above.

---

## Where to go next

- **[README.md](README.md)** for the full feature reference and all environment variables.
- **[INSTALLATION.md](INSTALLATION.md)** for advanced deployment (VPS, public internet, invisible proxy).
- **[Discord](https://discord.gg/6RPVSeg56v)** if you get stuck.

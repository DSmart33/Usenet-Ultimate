<p align="center">
  <img src="ui/public/pwa-icon.svg" alt="Usenet Ultimate" width="120" height="120" />
</p>

<h1 align="center">Usenet Ultimate</h1>

<p align="center">
  A Stremio addon that searches Usenet indexers for media content and streams it directly through NZBDav.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="https://discord.gg/6RPVSeg56v"><img src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  &nbsp;&nbsp;
  <a href="https://ko-fi.com/dsmart33"><img src="https://img.shields.io/badge/Ko--fi-Support%20Development-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/e63a6bf4-08a6-4a2f-aa08-88d231508c26" width="200" alt="Dashboard">
  &nbsp;&nbsp;
  <img src="https://github.com/user-attachments/assets/7f7077b4-d34b-4f3d-9353-916147fad836" width="200" alt="Login Screen">
  &nbsp;&nbsp;
  <img src="https://github.com/user-attachments/assets/eba4c2a9-25ea-41f5-9d63-622ef5687540" width="200" alt="PWA Install">
</p>

---

## Community & Support

Have questions, need help, or want to follow development?

- **Discord** — [Join the community](https://discord.gg/6RPVSeg56v) for help, feature discussion, and updates
- **Ko-fi** — [Support development](https://ko-fi.com/dsmart33) if you find this project useful
- **Issues** — [Open an issue](../../issues) to report bugs or request features

---

## What Is It

Usenet Ultimate is a self-hosted Stremio addon that turns Usenet into a streaming service. Point it at your Newznab indexers (or Prowlarr/NZBHydra), connect a Usenet provider and [NZBDav](https://github.com/nzbdav-dev/nzbdav), and you've got a fully searchable streaming layer on top of Usenet — no download client required.

> **What is NZBDav?** — [NZBDav](https://github.com/nzbdav-dev/nzbdav) is the streaming engine that powers playback. It downloads NZBs from your Usenet provider, assembles the files, and serves them over WebDAV so Usenet Ultimate can stream video directly into Stremio. Think of it as the backend that turns Usenet downloads into a streamable library. Head to the [NZBDav repo](https://github.com/nzbdav-dev/nzbdav) to set it up — it runs alongside Usenet Ultimate as a separate container.

## How It Works

When you click play on a movie or TV show in Stremio, Usenet Ultimate:

1. **Resolves the title** via IMDB/TMDB/TVDB/TVMaze, including alternate and international titles
2. **Searches your configured Usenet indexers** in parallel across all configured sources
3. **Parses release metadata** — resolution, codec, HDR, audio, release group, edition, language, and more
4. **Health-checks NZBs** against your Usenet provider at the NNTP level before presenting them
5. **Inspects archives** for encryption, passwords, nested containers, and disc structures
6. **Streams the content** through NZBDav or EasyNews directly into Stremio with automatic fallback

---

## Features

### Search & Indexers

**Newznab-Compatible Indexers**

Connect any Newznab-compatible indexer with an API key. Each indexer can be configured with its own preferred search method (IMDB ID, TMDB ID, TVDB ID, or text search), so you get the best results from each source. Capabilities are auto-discovered via the `?t=caps` endpoint — the addon knows exactly what each indexer supports.

**Prowlarr & NZBHydra Integration**

Already running Prowlarr or NZBHydra? Sync your indexers directly from your existing setup instead of re-entering them. The addon pulls your full indexer list, respects per-indexer search method overrides, and searches them all in parallel.

**EasyNews Direct Search**

EasyNews accounts get first-class support with a Solr-based API search. Results can stream via direct download (DDL) or NZB mode. Videos are validated against a whitelist of extensions and minimum duration to filter out trailers and samples.

**Paginated Search with Configurable Depth**

When a single page of indexer results isn't enough, the addon can paginate through multiple pages to find more candidates. Search depth is configurable per your preferences.

**Season Pack Detection & Per-Episode Size Estimation**

For TV shows, the addon runs a separate search for season packs (matching `S01` but not `S01E01`). When a season pack is found, the total size is divided by the TMDB episode count to estimate per-episode size, so you can make informed quality decisions. Season packs are included by default and visually distinguished in the stream list.

**Cross-Indexer Deduplication**

When the same release appears on multiple indexers, the addon deduplicates results based on configurable indexer priority ordering. You see each unique release once, sourced from your preferred indexer.

**Anime-Aware Search**

Anime titles are detected automatically. When found, the addon can optionally fall back to text-based search with alternate title resolution to handle the naming conventions common in anime releases.

**Title Resolution & Alternate Titles**

IMDB IDs are resolved to TMDB, TVDB, and TVMaze IDs with a 24-hour cache. Alternate and international titles are fetched and used as additional search queries to maximize coverage across indexers that may catalog content under different names.

---

### Streaming

**NZBDav Streaming**

NZBs are submitted to your NZBDav instance, which downloads and assembles the content. The addon discovers the video file via WebDAV, then issues a 302 redirect directly to the WebDAV URL. Stremio streams from NZBDav without proxying through the addon, keeping the server lightweight while supporting full range requests and seeking.

**Automatic Fallback on Failure**

When a stream fails (dead NZB, incomplete download, corrupted content), the addon automatically tries the next healthy candidate from a pre-computed fallback group. Fallback is enabled by default with unlimited candidates and a configurable TTL that matches your search cache. Two fallback ordering modes are available: start from the NZB you clicked ("selected", default) or always start from the top-ranked result ("top"). A self-redirect mechanism resets Stremio's 60-second timeout between fallback attempts, allowing up to 5 minutes of total retry time across multiple candidates.

**Separate Movie & TV Wait Times**

Movies and TV episodes have independent timeout budgets controlling how long the addon waits for a stream to become ready before moving to the next fallback. Defaults are 30 seconds for movies and 15 seconds for TV. Each step in the pipeline (NZB submission, job polling, video discovery) shares a single time budget so the total wait is predictable.

**3-Hour Failure Video (Anti-Skip Protection)**

When every fallback candidate is exhausted and no stream is available, the addon serves a 3-hour static MP4 file instead of returning an error. This is deliberate: Stremio interprets short errors as "episode complete" and auto-advances to the next episode in binge mode, which would cascade failures across your entire watch session. The 3-hour duration ensures Stremio never considers the episode finished, so it won't mark it as watched or auto-skip. You see "Stream Unavailable" and can manually go back to try a different result.

**EasyNews Direct Download**

EasyNews accounts can stream content directly from EasyNews CDN servers, proxied through the addon for seamless Stremio integration.

**BDMV/Disc Structure Handling**

Blu-ray disc rips (`.m2ts` files from `BDMV` folder structures) are currently excluded from video discovery. Most players cannot reliably stream `.m2ts` files over WebDAV, so BDMV releases are automatically skipped in favor of non-BDMV alternatives (e.g., MKV remuxes) via the fallback system. The BDMV parsing infrastructure (MPLS binary parser, multi-disc episode mapping) is preserved in the codebase for future re-enablement.

---

### Health Checking

**NNTP-Level Article Verification**

Before presenting a stream, the addon can verify that the underlying Usenet articles actually exist. It downloads the NZB, extracts segment message IDs, and issues NNTP `STAT` commands against your provider to check article availability. You can sample 3 or 7 segments per file — more samples means higher confidence but slower checks.

**Pipelined NNTP Checks**

Multiple `STAT` commands are sent in a single batch over a persistent NNTP connection, minimizing round-trip overhead. Connections are authenticated once and reused across multiple NZBs within the same health check run.

**Multi-Provider Support (Pool + Backup)**

Configure multiple NNTP providers with pool and backup roles. Pool providers are checked first in parallel. If all pool providers report missing articles, backup providers are tried as a fallback. This mirrors how real Usenet setups work — your primary provider handles most content, with a backup filling gaps.

**Archive Inspection**

Before streaming, the addon can inspect archive headers to detect problems without downloading the full content:

- **RAR4/RAR5**: Reads archive headers, detects encryption and password protection, lists contained files
- **7-Zip**: Detects headers and end-of-archive metadata
- **ZIP**: Parses central directory entries
- **Nested containers**: Detects archives containing other archives or ISOs (which can't be streamed)

This is non-invasive — only headers are read, not full file content. Encrypted archives are fully supported when a password is present in the NZB metadata — the addon extracts the password from the NZB `<head>` and allows the release through to segment checking and streaming.

The only content types that are rejected are: **ISOs**, **nested archives** (archives inside archives), and **encrypted archives without a provided password**. These are the same limitations as NZBDav itself — Usenet Ultimate's file type support matches NZBDav's identically. Everything else streams without issue.

**Smart Batching**

Two health check modes are available:

- **Fixed mode**: Check the top N NZBs in parallel. Simple and predictable.
- **Smart mode**: Check small batches of 1–3 NZBs. If a healthy result is found, stop immediately. If not, run additional batches. This minimizes NNTP connections while still finding good content quickly.

**Zyclops Integration**

Per-indexer Zyclops proxy support for backbone-level pre-verification. When enabled, search requests are routed through the Zyclops API, which pre-checks article availability across major Usenet backbones (usenetexpress, eweka, etc.). Results come back pre-marked as verified, reducing the need for your own NNTP health checks.

**NZB Database Pre-Check**

Before running NNTP checks, health checks consult the NZB Database (the same caches used by the streaming pipeline). NZBs previously streamed successfully are instantly marked as verified, and NZBs that previously failed are instantly blocked — skipping expensive NNTP connections entirely. Blocked results from health checks are also written back to the dead NZB database so future searches skip them instantly.

**NZBDav Library Pre-Check**

If content is already in your NZBDav library (previously downloaded), the addon skips health checking entirely and streams it directly. No redundant verification for content you already have.

---

### Quality & Filtering

**Full Metadata Parsing**

Every search result is parsed for rich metadata:

| Category | Detected Values |
|----------|----------------|
| Resolution | 2160p, 1440p, 1080p, 720p, 576p, 480p, 360p, 240p, 144p |
| Video Source | BluRay REMUX, BluRay, WEB-DL, WEBRip, HDRip, DVDRip, HDTV |
| Codec | AV1, HEVC, AVC |
| Visual Tags | Dolby Vision, HDR10+, HDR10, HDR, IMAX, 10-bit, AI Upscale, SDR |
| Audio | Atmos, DTS:X, DTS-HD MA, TrueHD, DTS-HD, DD+, Dolby Digital |
| Other | Language, Edition (Extended, Director's Cut), Release Group, Clean Title |

**Per-Media-Type Filter Profiles**

Movies and TV shows have separate filter configurations. You might want 4K REMUX for movies but 1080p WEB-DL for TV — set each independently.

**Configurable Sort Priority Chains**

Define exactly how results are ranked with ordered priority chains. For example: resolution > codec > audio > size. Each attribute has its own priority ordering (e.g., for resolution: 2160p first, then 1080p, then 720p). The addon applies these chains to produce a deterministic, preference-aware sort order.

**Size & Stream Limits**

Set maximum file size, maximum number of streams returned to Stremio, and maximum results per quality level. These limits keep the stream list focused on your best options.

**Strict Title Matching**

An optional strict mode filters out false positives by requiring the parsed title to closely match the searched title, accounting for diacritics, alternate titles, and common naming variations.

---

### Auto-Play & Binge Mode

**Stremio Binge Group Support**

Stremio's native binge watching is fully supported. When an episode ends, Stremio auto-plays the next one using a matching stream. Three matching methods are available:

- **firstFile** (default): Always auto-plays the first available stream for every episode
- **matchingFile**: Auto-plays the next episode's stream that matches specific attributes (resolution, quality, edition by default, but configurable to include codec, audio, release group, indexer, or visual tags)
- **matchingIndex**: Auto-plays the stream at the same position in the next episode's results (e.g., always the #1 result)

**Auto-Queue to NZBDav**

For seamless binge watching, the addon can pre-download content to NZBDav before you need it:

- **Auto-queue**: After health checks complete, queues the verified result(s) so they're ready before the current episode ends
- Two modes: queue only the top result, or queue all verified results in order

---

### Stream Display Customization

**Configurable Stream Titles**

The information shown for each stream in Stremio's stream picker is fully customizable:

- Choose which elements appear: resolution, quality, health badge, title, size, codec, visual tags, audio tags, release group, indexer, health providers, edition, language
- Reorder elements via drag-and-drop in the web UI
- Set custom emoji prefixes for each element (e.g., "💾" for size, "🎨" for visual tags, "🔊" for audio)
- Group elements into lines for clean formatting
- Separate display rules for season packs vs regular episodes
- Live Stremio preview in the configuration UI so you see exactly how streams will appear

---

### Configuration UI

**Web-Based Dashboard**

All settings are managed through a web-based dashboard — no config file editing required. The UI is built with React and Tailwind CSS for a responsive, modern experience.

**Indexer Management**

Add, edit, and remove indexers with full capability discovery. The addon probes each indexer's `?t=caps` endpoint and shows you exactly what search types, categories, and features it supports.

**Real-Time Log Viewer**

A live log viewer streams server output via Server-Sent Events (SSE). Console output is intercepted and buffered in memory (up to 1000 entries), then broadcast to all connected clients. Logs are color-coded by level (info, warn, error) with filtering and search.

**Per-Indexer Statistics**

Track query counts, response times, and grab statistics for each indexer. See which indexers are performing well and which are slow or returning poor results.

**PWA Support**

The web UI is a Progressive Web App — installable as a standalone app on iOS, Android, and desktop. Service workers handle auto-updates with immediate activation, while API routes and Stremio addon routes are excluded from caching to ensure fresh data.

---

### Infrastructure & Security

**JWT Authentication with Bcrypt**

User accounts are protected with bcrypt password hashing and JWT tokens. The JWT secret is randomly generated on first run. A `RESET_PASSWORD` environment variable provides emergency password reset without database access.

**Per-User Manifest Keys**

Each user gets a unique manifest key embedded in their Stremio addon URL. This means multiple users can share a single Usenet Ultimate instance, each with their own addon URL. Manifest keys are validated on every streaming request independently of JWT authentication.

**HTTP Proxy Support**

Route indexer API requests through an HTTP proxy to prevent IP-based rate limiting or bans. Proxy usage is toggleable per-indexer — proxy some indexers while accessing others directly. Exit IP is resolved via the ipify API and logged for verification.

**Docker-First Deployment**

A multi-stage Dockerfile produces a minimal production image:

1. **Stage 1** — Build the React UI with Vite
2. **Stage 2** — Compile TypeScript backend to JavaScript
3. **Stage 3** — Copy built artifacts into a clean Node 20 Alpine image

The result is a small, production-ready container with health checks (`/health` endpoint), JSON log rotation, and automatic restarts.

**Graceful Shutdown**

On SIGTERM/SIGINT, the addon persists the segment cache to disk before exiting. No cached health check data is lost during container restarts or deployments.

**Version-Aware User Agents**

The addon periodically fetches the latest versions of Prowlarr, SABnzbd, Chrome, and Alpine Linux from their official sources (GitHub API, Google Version History API, Alpine CDN). These versions are used to construct realistic user-agent strings for indexer requests, reducing the chance of being blocked by indexers that filter outdated clients. Versions are cached for 24 hours with hardcoded fallbacks if fetches fail.

---

## Why These Technologies

| Technology | Why I Chose It |
|---|---|
| **TypeScript** | Full-stack type safety across 14,000+ lines of backend code. Catches entire categories of bugs at compile time — especially important for complex data pipelines where NZB metadata flows through parsing, filtering, health checking, and stream building. |
| **Node.js 20** | Native TLS/TCP socket support for NNTP connections without external dependencies. The event loop handles hundreds of concurrent indexer searches and NNTP health checks efficiently. |
| **Express** | The Stremio addon SDK is built on Express. Using Express as the base server means the addon SDK, REST API, and static file serving all share a single HTTP server with unified middleware. |
| **React + Tailwind CSS** | Component-based UI for a settings dashboard with many interactive overlays (drag-and-drop, emoji pickers, live previews). Tailwind keeps styling co-located with components and eliminates CSS bloat. |
| **Vite** | Sub-second HMR during UI development. PWA plugin support out of the box. Tree-shaking produces a small production bundle. |
| **stremio-addon-sdk** | Official SDK ensures compatibility with the Stremio protocol. Handles manifest generation, stream/catalog routing, and transport negotiation. |
| **xml2js** | Newznab APIs return XML RSS feeds with custom `newznab:attr` extensions. xml2js provides reliable XML→JSON parsing with namespace support. |
| **axios** | HTTP client with built-in proxy agent support and request/response interceptors. Used for indexer API calls and NZB downloads. |
| **node-cache** | Lightweight in-memory cache with TTL support for search results and ID resolution. No external cache server needed — everything runs in a single process. |
| **bcryptjs + jsonwebtoken** | Industry-standard password hashing and stateless authentication. Pure JavaScript implementations with no native compilation required — critical for Alpine Docker builds. |
| **webdav** | First-class WebDAV client for NZBDav file operations including directory listing, file streaming, and range request support. |
| **Docker + Alpine** | Multi-stage build produces a minimal image. Alpine base keeps the image small. Health checks, log rotation, and volume mounts are configured out of the box. |
| **JSON file storage** | No database server to configure or maintain. Config, users, stats, and segment cache are stored as JSON files in a single mounted volume. For a single-instance addon, this is simpler and more portable than SQLite or Postgres. |

---

## Requirements

- **Node.js 20+** (for native development)
- **Docker** (recommended for deployment)
- At least one of:
  - A Newznab-compatible Usenet indexer with an API key
  - Prowlarr or NZBHydra instance with Usenet indexers configured
  - An EasyNews account
- For streaming (rather than external NZB links):
  - A [NZBDav](https://github.com/nzbdav-dev/nzbdav) instance, or
  - EasyNews direct streaming

## Quick Start with Docker

```bash
docker run -d \
  --name usenet-ultimate \
  -p 1337:1337 \
  -v ./config:/app/config \
  --restart unless-stopped \
  ghcr.io/dsmart33/usenet-ultimate:latest
```

Or with Docker Compose:

```yaml
services:
  usenet-ultimate:
    image: ghcr.io/dsmart33/usenet-ultimate:latest
    container_name: usenet-ultimate
    ports:
      - "1337:1337"
    volumes:
      - ./config:/app/config
    restart: unless-stopped
```

Then open `http://localhost:1337` in your browser. On first run you'll be prompted to create an account, after which you can configure everything from the web UI.

## Building from Source

```bash
# Clone and install
git clone https://github.com/DSmart33/Usenet-Ultimate.git
cd usenet-ultimate
npm install

# Build backend
npm run build

# Build UI
cd ui && npm install && npm run build && cd ..

# Run
npm start
```

The server starts on port 1337 by default. Override with the `PORT` environment variable.

For development with hot reload:

```bash
# Terminal 1 — backend
npm run dev

# Terminal 2 — frontend (proxies API calls to the backend)
cd ui && npm run dev
```

## Configuration

All configuration is managed through the web UI at `http://localhost:1337`. On first launch, you'll set up an admin account, then configure:

1. **Index Manager** — Choose between Newznab (direct), Prowlarr, or NZBHydra
2. **Indexers** — Add your Usenet indexers with API keys. Capabilities are auto-discovered
3. **Streaming** — Connect NZBDav for direct streaming, or use EasyNews, or use external NZB links
4. **Health Checks** — Add your Usenet providers (NNTP credentials) to verify NZBs before streaming
5. **Filters** — Set quality preferences, size limits, and sort priorities
6. **Auto-Play** — Configure binge watching behavior

The configuration is stored in `config/config.json` (created automatically). Mount this directory as a Docker volume to persist settings across container restarts.

### Environment Variables

See [`.env.example`](.env.example) for a fully commented template. All runtime overrides follow the priority: **env var > config.json > default**. Active overrides are logged at startup.

#### Essential

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | Auto-detected | Override for stream URLs. Auto-detected from the incoming request when not set. Set this if you need a fixed URL (custom domain, Docker networking, etc.) |
| `PORT` | `1337` | HTTP server port |

#### Indexer Configuration (one-time migration)

These are migrated into `config/config.json` on first startup. After that, manage indexers through the web UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_URL` | — | Newznab-compatible indexer URL. Comma-separated for multiple indexers |
| `INDEXER_API_KEY` | — | API key(s) matching each indexer URL. Comma-separated for multiple |
| `CACHE_TTL` | `0` (disabled) | Search result cache TTL in seconds. `0` disables caching |

#### Index Manager

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEX_MANAGER` | `newznab` | Indexer manager type: `newznab`, `prowlarr`, or `nzbhydra` |
| `PROWLARR_URL` | — | Prowlarr instance URL |
| `PROWLARR_API_KEY` | — | Prowlarr API key |
| `NZBHYDRA_URL` | — | NZBHydra instance URL |
| `NZBHYDRA_API_KEY` | — | NZBHydra API key |
| `NZBHYDRA_USERNAME` | — | NZBHydra username (required only if auth is enabled) |
| `NZBHYDRA_PASSWORD` | — | NZBHydra password (required only if auth is enabled) |

#### NZBDav Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `NZBDAV_URL` | — | NZBDav API URL |
| `NZBDAV_API_KEY` | — | NZBDav API key |
| `NZBDAV_WEBDAV_URL` | — | NZBDav WebDAV URL |
| `NZBDAV_WEBDAV_USER` | — | WebDAV username |
| `NZBDAV_WEBDAV_PASS` | — | WebDAV password |

#### Easynews

| Variable | Default | Description |
|----------|---------|-------------|
| `EASYNEWS_ENABLED` | `false` | Enable Easynews integration |
| `EASYNEWS_USERNAME` | — | Easynews account username |
| `EASYNEWS_PASSWORD` | — | Easynews account password |

#### Streaming

| Variable | Default | Description |
|----------|---------|-------------|
| `STREAMING_MODE` | `nzbdav` | Streaming mode: `nzbdav` or `stremio` |

#### NZB Fallback

| Variable | Default | Description |
|----------|---------|-------------|
| `NZBDAV_FALLBACK_ENABLED` | `false` | Enable automatic fallback to alternative NZBs on failure |
| `NZBDAV_FALLBACK_ORDER` | `top` | Candidate ordering: `top` (start from highest-ranked) or `selected` (start from clicked NZB) |
| `NZBDAV_MAX_FALLBACKS` | `0` | Max fallback attempts. `0` = unlimited (try all search results), `1-20` = limit |
| `NZBDAV_LIBRARY_CHECK` | `true` | Check WebDAV library for existing files before grabbing a new NZB |
| `NZBDAV_MOVIES_TIMEOUT` | `30` | Seconds to wait for a movie stream before trying the next fallback (1-90) |
| `NZBDAV_TV_TIMEOUT` | `15` | Seconds to wait for a TV episode stream before trying the next fallback (1-90) |
| `NZBDAV_SEASON_PACK_TIMEOUT` | `30` | Seconds to wait for a season pack stream before trying the next fallback (1-90) |
| `NZBDAV_JOB_TIMEOUT` | `120` | Legacy: sets both movie and TV timeouts if the specific ones aren't configured (clamped to 1-90) |
| `NZBDAV_MAX_SELF_REDIRECTS` | `500` | Max Stremio self-redirects during fallback chains before giving up |
| `AUTO_RESOLVE_ON_SEARCH` | `true` | Pre-resolve NZBs when search results appear (requires "from top" fallback order) |

#### Stream Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `NZBDAV_PROXY_ENABLED` | `true` | Stream through a local proxy with buffering and reconnection. When disabled, players are redirected directly to the WebDAV URL |
| `NZBDAV_STREAM_BUFFER_MB` | `128` | Internal proxy buffer size in MB. Larger buffers absorb network jitter but use more memory (min: 8) |
| `NZBDAV_STREAM_MAX_RECONNECTS` | `30` | Max upstream reconnect attempts before giving up on a proxied stream |

#### NZB Database

| Variable | Default | Description |
|----------|---------|-------------|
| `FILTER_DEAD_NZBS` | `true` | Filter dead (previously failed) NZBs from search results |
| `INCLUDE_TIMEOUTS_AS_DEAD_NZBS` | `true` | Store timed-out NZBs in the dead cache. When `false`, only permanently failed NZBs are cached |

#### Search Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_REMAKE_DETECTION` | `true` | Filter out results from the wrong version of remade/rebooted shows |
| `ALLOW_MULTI_EPISODE_FILES` | `true` | Allow streaming from combined multi-episode files (e.g. S01E01E02) |
| `URL_DEDUP` | `true` | Remove duplicate results with identical download URLs |

#### HTTP Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_MODE` | `disabled` | Proxy mode: `disabled` or `http` |
| `PROXY_URL` | — | HTTP proxy URL |

#### Health Checking

| Variable | Default | Description |
|----------|---------|-------------|
| `ZYCLOPS_ENDPOINT` | `https://zyclops.elfhosted.com` | Zyclops verification endpoint. Override for self-hosted |
| `HEALTH_CHECK_ENABLED` | `false` | Enable NNTP health checks |
| `HEALTH_CHECK_NNTP_HOST` | — | NNTP server hostname (auto-enables health checks when set) |
| `HEALTH_CHECK_NNTP_PORT` | `563` | NNTP server port |
| `HEALTH_CHECK_NNTP_TLS` | `true` | Use TLS for NNTP connection |
| `HEALTH_CHECK_NNTP_USER` | — | NNTP account username |
| `HEALTH_CHECK_NNTP_PASS` | — | NNTP account password |

#### Admin / Maintenance

| Variable | Default | Description |
|----------|---------|-------------|
| `RESET_PASSWORD` | — | One-time password reset. Format: `username:newpassword` or just `newpassword` (single-user only). Remove after restart |
| `NODE_ENV` | — | Set to `production` for production deployments (set automatically in Docker) |

Most UI-specific settings (filters, sort order, display preferences) are configured through the web UI only.

## Installing in Stremio

Once the server is running and configured:

1. Open the web UI and copy your personal addon URL from the dashboard (it contains your unique manifest key)
2. In Stremio, go to the addon catalog and paste the URL
3. The addon will appear in your stream results when you browse movies and TV shows

Each user gets a unique manifest key, so multiple users can share a single Usenet Ultimate instance with their own addon URLs.

## Advanced: Invisible Proxy with Tailscale + Squid

If you want indexer requests to originate from a different IP (e.g., a home server) without exposing a proxy to the public internet, you can combine Tailscale and Squid. Tailscale creates an encrypted mesh network between your machines, and Squid runs a proxy that's only accessible over that private network — no port forwarding, no firewall rules, no authentication needed. The "invisible" part: Squid strips all proxy-identifying headers so indexers see a normal direct connection from your tailscale device's IP (e.g., a home server).

### 1. Install Tailscale on Both Machines

On your **Usenet Ultimate host** and your **home server** (any non Usenet Ultimate host machine):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

After connecting, each machine gets a stable Tailscale IP (e.g., `100.x.y.z`). All Tailscale nodes use the `100.64.0.0/10` CGNAT range — this is universal across all Tailscale networks. Confirm connectivity:

```bash
# From your Usenet Ultimate host, ping the home server
ping <vps-tailscale-ip>
```

### 2. Install and Configure Squid on the home server

```bash
# Debian/Ubuntu
apt update && apt install squid -y
```

Replace `/etc/squid/squid.conf` with the following (adjust the `http_port` IP to your home server Tailscale IP):

```squid
# ==========================================================
# NETWORK & DNS
# ==========================================================
# Force IPv4 for outgoing connections to avoid "No Route" errors
tcp_outgoing_address 0.0.0.0

# Privacy-focused DNS (Cloudflare)
dns_nameservers 1.1.1.1 1.0.0.1

# Bind to your VPS Tailscale IP only — not reachable from the public internet
# Replace with your VPS's actual Tailscale IP and desired port
http_port 100.x.y.z:3128

# ==========================================================
# ACCESS CONTROL
# ==========================================================
# 100.64.0.0/10 is the universal Tailscale CGNAT range
acl tailscale_net src 100.64.0.0/10
acl SSL_ports port 443
acl Safe_ports port 80
acl Safe_ports port 443
acl CONNECT method CONNECT

# ==========================================================
# SECURITY RULES
# ==========================================================
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow localhost
http_access allow tailscale_net
http_access deny all

# ==========================================================
# INVISIBILITY
# ==========================================================
# Strip all headers that reveal this is a proxy
forwarded_for off
request_header_access Via deny all
request_header_access X-Forwarded-For deny all
request_header_access Proxy-Connection deny all

# ==========================================================
# HOUSEKEEPING
# ==========================================================
# Adjust coredump_dir to match your system's Squid cache path
# Debian/Ubuntu: /var/spool/squid
# macOS (Homebrew): /opt/homebrew/var/cache/squid
coredump_dir /var/spool/squid
refresh_pattern . 0 20% 4320
```

**Note:** The `coredump_dir` path varies by OS and install method. Common paths:

| Platform | Path |
|----------|------|
| Debian/Ubuntu | `/var/spool/squid` |
| macOS (Homebrew) | `/opt/homebrew/var/cache/squid` |
| Alpine | `/var/cache/squid` |

Check your system's default with `squid -v | grep DEFAULT_SWAP_DIR` or look at the stock config that shipped with the package.

Restart Squid:

```bash
systemctl restart squid
systemctl enable squid
```

Since Squid binds to the Tailscale IP and only accepts connections from the `100.64.0.0/10` range, it's completely inaccessible from the public internet.

### 3. Configure Usenet Ultimate

In the web UI, go to **Settings** and set:

- **Proxy Mode**: `http`
- **Proxy URL**: `http://<vps-tailscale-ip>:3128`

Or via environment variables:

```yaml
environment:
  PROXY_MODE: http
  PROXY_URL: http://100.x.y.z:3128
```

Indexer requests will now route through the home server. The addon logs the exit IP at startup via ipify — verify it matches your home server public IP.

### 4. Per-Indexer Proxy Control

Not every indexer needs to go through the proxy. In the web UI, each indexer has a proxy toggle — enable it only for indexers that are rate-limiting or blocking your home IP.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Stremio Player                             │
│                    (stream/manifest requests & playback)                 │
└───────────────────┬──────────────────────────────────▲──────────────────┘
                    │ manifest/stream req              │ video stream
                    ▼                                  │ (HTTP response)
┌═════════════════════════════════════════════════════════════════════════┐
║                           Express Server                                ║
║          (all routes, middleware, and handlers run inside Express)       ║
║                                                                         ║
║  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐  ║
║  │ Auth     │  │ Stremio SDK  │  │ REST API      │  │ Static Files  │  ║
║  │ (JWT)    │  │ (addon)      │  │ (config/mgmt) │  │ (React UI)    │  ║
║  └──────────┘  └──────┬───────┘  └───────────────┘  └───────────────┘  ║
║                        │                                                ║
║                        ▼                                                ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │                     Search Orchestrator                           │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ Title      │  │ ID Resolver│  │ Search     │                  │  ║
║  │  │ Resolver   │  │ (IMDB→TMDB/│  │ Cache      │                  │  ║
║  │  │ (alt       │  │  TVDB/     │  │ (node-     │                  │  ║
║  │  │  titles)   │  │  TVMaze)   │  │  cache)    │                  │  ║
║  │  └────────────┘  └────────────┘  └────────────┘                  │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ Newznab    │  │ Prowlarr   │  │ EasyNews   │                  │  ║
║  │  │ Client     │  │ Searcher   │  │ Searcher   │                  │  ║
║  │  │ (XML/RSS)  │  │ (API sync) │  │ (Solr API) │                  │  ║
║  │  └────────────┘  └────────────┘  └────────────┘                  │  ║
║  └──────────────────────┬────────────────────────────────────────────┘  ║
║                         │                                               ║
║                         ▼                                               ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │                     Result Processor                              │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ Metadata   │  │ Title      │  │ Dedup &    │                  │  ║
║  │  │ Parser     │  │ Matcher    │  │ Sort/Filter│                  │  ║
║  │  │ (quality,  │  │ (fuzzy,    │  │ (per-media │                  │  ║
║  │  │  codec,    │  │  diacrit-  │  │  profiles, │                  │  ║
║  │  │  HDR,      │  │  ics,      │  │  priority  │                  │  ║
║  │  │  audio)    │  │  strict)   │  │  chains)   │                  │  ║
║  │  └────────────┘  └────────────┘  └────────────┘                  │  ║
║  └──────────────────────┬────────────────────────────────────────────┘  ║
║                         │                                               ║
║                         ▼                                               ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │                  Health Check Coordinator                         │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ NZB Parser │  │ Archive    │  │ Segment    │                  │  ║
║  │  │ (XML→files │  │ Inspector  │  │ Cache      │                  │  ║
║  │  │  & segs)   │  │ (RAR4/5,   │  │ (persist,  │                  │  ║
║  │  └────────────┘  │  7z, ZIP)  │  │  disk)     │                  │  ║
║  │                  └────────────┘  └────────────┘                  │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ NNTP Pool  │  │ Article    │  │ Batch      │                  │  ║
║  │  │ (TLS,      │  │ Checker    │  │ Processor  │                  │  ║
║  │  │  conn      │  │ (STAT,     │  │ (smart/    │                  │  ║
║  │  │  reuse)    │  │  pipelined)│  │  fixed)    │                  │  ║
║  │  └────────────┘  └────────────┘  └────────────┘                  │  ║
║  └──────────────────────┬────────────────────────────────────────────┘  ║
║                         │                                               ║
║                         ▼                                               ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │                     Stream Builder                                │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ Stream     │  │ Binge Group│  │ Fallback   │                  │  ║
║  │  │ Display    │  │ Builder    │  │ Manager    │                  │  ║
║  │  │ (custom    │  │ (auto-play │  │ (unlimited │                  │  ║
║  │  │  format)   │  │  matching) │  │  cands)    │                  │  ║
║  │  └────────────┘  └────────────┘  └────────────┘                  │  ║
║  └──────────────────────┬────────────────────────────────────────────┘  ║
║                         │                                               ║
║                         ▼                                               ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │              Stream Handler (NZBDav 302 redirect)                  │  ║
║  │                                                                   │  ║
║  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  ║
║  │  │ NZBDav API │  │ WebDAV     │  │ Fallback   │                  │  ║
║  │  │ (submit    │  │ Discovery  │  │ Handler    │                  │  ║
║  │  │  NZB, poll │  │ (find      │  │ (auto-     │                  │  ║
║  │  │  status)   │  │  video)    │  │  retry,    │                  │  ║
║  │  └────────────┘  └────────────┘  │  self-redir)│                 │  ║
║  │                                  └────────────┘                  │  ║
║  │  ┌────────────┐  ┌────────────┐                                  │  ║
║  │  │ Stream     │  │ Failure    │                                  │  ║
║  │  │ Cache      │  │ Video      │                                  │  ║
║  │  │ (pending,  │  │ (3hr MP4,  │                                  │  ║
║  │  │  ready,    │  │  anti-skip)│                                  │  ║
║  │  │  failed)   │  └────────────┘                                  │  ║
║  │  └────────────┘                                                  │  ║
║  └──────────────────────┬───────────▲────────────────────────────────┘  ║
║                submit NZB│          │302 redirect (WebDAV URL)          ║
╚═════════════════════════╪══════════╪════════════════════════════════════╝
                          ▼           │
┌─────────────────────────────────────────────────────────────────────────┐
│                          NZBDav Instance                                │
│              (download, assemble, serve via WebDAV)                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Stremio** sends a stream request with an IMDB ID to the addon
2. **Search Orchestrator** resolves the title, fetches alternate names, and searches all indexers in parallel
3. **Result Processor** parses metadata, applies title matching, deduplicates across indexers, and sorts by user-defined priority chains
4. **Health Check Coordinator** downloads NZBs, inspects archive headers, checks segment availability via NNTP, and caches results
5. **Stream Builder** formats verified results for Stremio display, assigns binge groups, and registers fallback candidates
6. **Stream Handler** submits the chosen NZB to NZBDav, discovers the video file via WebDAV, and redirects Stremio directly to the WebDAV URL. If the stream fails, the fallback handler automatically tries the next candidate with self-redirect to reset Stremio's timeout

### File Storage

All persistent data lives in the `config/` directory (single Docker volume):

| File | Purpose |
|------|---------|
| `config.json` | All settings, indexers, filters, display preferences |
| `users.json` | User accounts with bcrypt password hashes and manifest keys |
| `healthy-nzbs.json` | NZB Database: successfully streamed NZBs (ready cache) |
| `dead-nzbs.json` | NZB Database: failed NZBs from streaming and health checks |
| `stats.json` | Per-indexer query counts, response times, grab statistics |
| `version-cache.json` | Cached latest versions of Prowlarr, SABnzbd, Chrome, Alpine |

## Releasing

The included release script handles version bumping, Docker builds, git tags, and GitHub releases:

```bash
./release.sh patch                  # 1.0.0 -> 1.0.1
./release.sh minor --push           # Build + push to GitHub
./release.sh major --clean --push   # Full major release
./release.sh patch --dry-run        # Preview without executing
```

## Project Structure

```
src/
  addon/        Stremio addon (search orchestration, stream building, health coordination)
  archive/      RAR4, RAR5, 7-Zip, ZIP header parsers for archive inspection
  auth/         JWT authentication and bcrypt password hashing
  config/       Schema, migrations, CRUD operations
  health/       NNTP health check pipeline (article sampling, segment cache)
  nzbdav/       NZBDav API, WebDAV client, stream handler, fallback manager
  parsers/      Newznab client, metadata extraction, title matching
  routes/       Express route handlers
  searchers/    EasyNews, Prowlarr, NZBHydra search implementations
ui/             React + Tailwind configuration dashboard (Vite, PWA)
```

---

## License

[MIT](LICENSE)

---

**Disclaimer:** This software is provided strictly as a technical tool. It is your responsibility to ensure all content accessed through Usenet Ultimate complies with applicable laws. This project does not endorse or encourage copyright infringement in any form.

/**
 * NZBDav routes — /api/nzbdav/*
 *
 * POST   /api/nzbdav/test   — Test NZBDav + WebDAV connection
 * GET    /api/nzbdav/cache  — Stream cache stats
 * DELETE /api/nzbdav/cache  — Clear stream cache
 *
 * Also mounts the key-protected stream and video proxy:
 *   GET /:manifestKey/nzbdav/stream — NZBDav stream handler (mounted separately in server.ts)
 *   GET /:manifestKey/nzbdav/v      — WebDAV video proxy (adds auth server-side for ExoPlayer compat)
 */

import { Router } from 'express';
import http from 'http';
import https from 'https';
import { PassThrough } from 'stream';
import type { Config } from '../types.js';
import type { NZBDavConfig } from '../nzbdav/index.js';
import { encodeWebdavPath, WebDav404Error, buildNzbdavConfig } from '../nzbdav/utils.js';
import { evictReadyByVideoPath } from '../nzbdav/streamCache.js';

interface NzbdavDeps {
  config: Config;
  handleStream: (req: any, res: any, nzbdavConfig: NZBDavConfig, trackGrab: (indexer: string, title: string) => void, proxyFn?: (req: any, res: any, videoPath: string, usePipe: boolean) => Promise<void>) => Promise<void>;
  getCacheStats: () => any;
  clearStreamCache: () => void;
  clearReadyCache: () => number;
  clearFailedCache: () => number;
  deleteCacheEntry: (cacheKey: string) => boolean;
  getCacheEntries: () => any;
  isStreamCached: (nzbUrl: string, title: string) => boolean;
  trackGrab: (indexerName: string, title: string) => void;
  getLatestVersions: () => { chrome: string };
}

export function createNzbdavRoutes(deps: NzbdavDeps): Router {
  const router = Router();
  const { config, getCacheStats, clearStreamCache, clearReadyCache, clearFailedCache, deleteCacheEntry, getCacheEntries, getLatestVersions } = deps;

  const TEST_CONNECTION_TIMEOUT_MS = 15_000;

  // NZBDav test connection endpoint
  router.post('/test', async (req, res) => {
    try {
      const { url, apiKey, webdavUrl, webdavUser, webdavPassword, moviesCategory } = req.body;

      if (!url) {
        return res.status(400).json({ message: 'NZBDav URL is required' });
      }

      // Test NZBDav server connection
      const testUrl = new URL(url);
      const userAgent3 = config.userAgents?.nzbdavOperations || getLatestVersions().chrome;
      const nzbdavHeaders: Record<string, string> = apiKey ? { 'X-Api-Key': apiKey, 'User-Agent': userAgent3 } : { 'User-Agent': userAgent3 };
      console.log('\u{1F4E4} Request to test NZBDav connection:', { url: testUrl.toString(), headers: apiKey ? { 'X-Api-Key': '[REDACTED]', 'User-Agent': userAgent3 } : { 'User-Agent': userAgent3 } });
      const nzbdavResponse = await fetch(testUrl.toString(), {
        headers: nzbdavHeaders,
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });

      if (!nzbdavResponse.ok && nzbdavResponse.status !== 401) {
        return res.status(502).json({
          message: `NZBDav server returned status ${nzbdavResponse.status}`
        });
      }

      // Test WebDAV connection if provided
      if (webdavUrl) {
        const webdavTestUrl = new URL(webdavUrl);
        const userAgent4 = config.userAgents?.webdavOperations || getLatestVersions().chrome;
        const webdavHeaders: Record<string, string> = webdavUser && webdavPassword ? {
          'Authorization': 'Basic ' + Buffer.from(`${webdavUser}:${webdavPassword}`).toString('base64'),
          'User-Agent': userAgent4
        } : { 'User-Agent': userAgent4 };
        console.log('\u{1F4E4} Request to test WebDAV connection:', { url: webdavTestUrl.toString(), method: 'PROPFIND', headers: webdavUser && webdavPassword ? { 'Authorization': 'Basic [REDACTED]', 'User-Agent': userAgent4 } : { 'User-Agent': userAgent4 } });
        const webdavResponse = await fetch(webdavTestUrl.toString(), {
          method: 'PROPFIND',
          headers: { ...webdavHeaders, 'Depth': '0' },
          signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
        });

        if (webdavResponse.status === 401 || webdavResponse.status === 403) {
          return res.status(502).json({ message: 'WebDAV authentication failed - check credentials' });
        }

        // PROPFIND returns 207 Multi-Status on success
        if (!webdavResponse.ok && webdavResponse.status !== 207) {
          return res.status(502).json({
            message: `WebDAV server returned status ${webdavResponse.status}`
          });
        }
      }

      // Only send a test NZB if explicitly requested (avoids flooding NZBDav on page refreshes)
      if (req.body.sendTestNzb) {
        const testNzb = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head>
    <meta type="title">Usenet Ultimate Test File</meta>
  </head>
  <file poster="test@usenet-ultimate" date="1738368000" subject="Usenet Ultimate Test [1/1] - test.txt (1 KB)">
    <groups>
      <group>alt.binaries.test</group>
    </groups>
    <segments>
      <segment bytes="1024" number="1">test@usenet-ultimate</segment>
    </segments>
  </file>
</nzb>`;

        const category = moviesCategory || 'Usenet-Ultimate-Movies';

        const nzbApiUrl = `${url.endsWith('/') ? url.slice(0, -1) : url}/api?mode=addfile&cat=${encodeURIComponent(category)}&nzbname=UsenetUltimate-Test${apiKey ? `&apikey=${apiKey}` : ''}`;

        const formData = new FormData();
        formData.append('nzbFile', new Blob([testNzb], { type: 'application/x-nzb' }), 'test.nzb');

        const userAgent2 = config.userAgents?.nzbdavOperations || getLatestVersions().chrome;
        const redactedNzbApiUrl = apiKey ? nzbApiUrl.replace(apiKey, '[REDACTED]') : nzbApiUrl;
        console.log('\u{1F4E4} Request to test NZB submission:', { url: redactedNzbApiUrl, method: 'POST', headers: { 'Content-Type': 'multipart/form-data', 'User-Agent': userAgent2 } });
        const testNzbResponse = await fetch(nzbApiUrl, {
          method: 'POST',
          body: formData,
          headers: { 'User-Agent': userAgent2 },
          signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
        });

        if (!testNzbResponse.ok) {
          const errorText = await testNzbResponse.text();
          return res.status(502).json({
            message: `NZB submission test failed: ${testNzbResponse.status} - ${errorText}`
          });
        }

        const testResult = await testNzbResponse.json();

        return res.json({
          message: 'Connection successful! Test NZB accepted.',
          testPath: (testResult as any).path
        });
      }

      res.json({
        message: 'Connection successful!'
      });
    } catch (error) {
      res.status(500).json({ message: `Connection failed: ${(error as Error).message}` });
    }
  });

  // Stream cache stats endpoint
  router.get('/cache', (req, res) => {
    res.json(getCacheStats());
  });

  // Clear stream cache endpoint
  router.delete('/cache', (req, res) => {
    clearStreamCache();
    res.json({ success: true });
  });

  // Detailed cache entries endpoint
  router.get('/cache/entries', (req, res) => {
    res.json(getCacheEntries());
  });

  // Clear only ready (successful) cache entries
  router.delete('/cache/ready', (req, res) => {
    const cleared = clearReadyCache();
    res.json({ success: true, cleared });
  });

  // Clear only failed cache entries
  router.delete('/cache/failed', (req, res) => {
    const cleared = clearFailedCache();
    res.json({ success: true, cleared });
  });

  // Delete a single cache entry by key
  router.delete('/cache/entry', (req, res) => {
    const key = req.query.key as string;
    if (!key) return res.status(400).json({ message: 'Missing key parameter' });
    const deleted = deleteCacheEntry(key);
    res.json({ success: deleted });
  });

  return router;
}

/**
 * Creates the key-protected NZBDav stream proxy router.
 * Mounted at /:manifestKey/nzbdav in server.ts.
 */
export function createNzbdavStreamRoutes(deps: NzbdavDeps): Router {
  const router = Router({ mergeParams: true });
  const { config, handleStream, isStreamCached, trackGrab, getLatestVersions } = deps;

  // Dedup set for grab tracking — prevents concurrent requests from tracking the same grab
  // before the stream cache is populated. Entries are cleaned up after 60s.
  const trackedGrabKeys = new Set<string>();
  const GRAB_DEDUP_TTL_MS = 60_000;

  // Throttle the /stream entry log to first-hit-per-(kind,filename) per 60 s —
  // Range probes and seek bursts otherwise spam the log during active playback.
  const loggedStreamHits = new Set<string>();
  const STREAM_HIT_LOG_TTL_MS = 15_000;

  // NZBDav stream endpoint (key-protected)
  // Uses history API polling to detect job completion/failure
  // :filename? is cosmetic — external video players display the URL path as the stream name
  router.get('/stream/:filename?', async (req, res) => {
    // One-liner for external-player regression diagnosis. Throttled so Range
    // probes from an active player don't flood the log.
    const kind = (req.query.user_pick === '1' || req.query.t) ? 'user_pick'
      : req.params.filename === 'ultimate-fallback' ? 'UF'
      : 'other';
    const hitKey = `${kind}::${req.params.filename ?? '-'}`;
    if (!loggedStreamHits.has(hitKey)) {
      loggedStreamHits.add(hitKey);
      setTimeout(() => loggedStreamHits.delete(hitKey), STREAM_HIT_LOG_TTL_MS);
      const qKeys = Object.keys(req.query).sort().join(',') || '(none)';
      console.log(`\u{1F39F}\uFE0F /stream hit: kind=${kind} filename=${req.params.filename ?? '-'} q=[${qKeys}] ua=${(req.headers['user-agent'] ?? '').slice(0, 80)}`);
    }

    const nzbUrl = req.query.nzb as string;
    const title = req.query.title as string || 'Unknown';
    const indexerName = req.query.indexer as string;
    const isAuto = req.query.auto === 'true';

    // Track grab only for genuinely new streams (not cache hits, range requests, retries)
    // Key format: indexer::title (tracks unique grabs per indexer, matching fallback dedup)
    const grabKey = `${indexerName}::${title}`;
    if (indexerName && nzbUrl && title !== 'Unknown' && !isStreamCached(nzbUrl, title) && !trackedGrabKeys.has(grabKey)) {
      trackedGrabKeys.add(grabKey);
      setTimeout(() => trackedGrabKeys.delete(grabKey), GRAB_DEDUP_TTL_MS);
      trackGrab(indexerName, title);
      console.log(`\u{1F4CA} Tracked grab from ${indexerName}: ${title}${isAuto ? ' (auto)' : ''}`);
    }

    const nzbdavConfig = buildNzbdavConfig();

    // Wrap trackGrab with the same dedup set so fallback grabs after
    // self-redirects don't double-count candidates already tracked.
    const dedupedTrackGrab = (indexer: string, grabTitle: string) => {
      const key = `${indexer}::${grabTitle}`;
      if (trackedGrabKeys.has(key)) return;
      trackedGrabKeys.add(key);
      setTimeout(() => trackedGrabKeys.delete(key), GRAB_DEDUP_TTL_MS);
      trackGrab(indexer, grabTitle);
      console.log(`\u{1F4CA} Tracked grab from ${indexer}: ${grabTitle}`);
    };

    // Delegate to nzbdav module (handles caching, history polling, streaming, fallback)
    try {
      await handleStream(req, res, nzbdavConfig, dedupedTrackGrab, proxyVideoStream);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream handler failed' });
      }
    }
  });

  // WebDAV video proxy — pipes video with server-side auth + transparent reconnect.
  // Android ExoPlayer doesn't support credentials in redirect URLs (user:pass@host),
  // so the stream handler redirects here and we add the Authorization header ourselves.
  // Uses native http/https.request() for zero-overhead Node-to-Node streaming.
  // On mid-stream upstream drops, transparently reconnects from the last byte sent
  // using Range requests — the player never sees the interruption.
  const MAX_PROXY_RETRIES = 3;
  const UPSTREAM_MAX_RECONNECTS = Number(process.env.NZBDAV_STREAM_MAX_RECONNECTS || process.env.STREAM_MAX_RECONNECTS) || 30;
  const RECONNECT_BASE_DELAY_MS = 50;
  const RECONNECT_MAX_DELAY_MS = 8000;
  const MAX_CONCURRENT_PER_FILE = 6;
  const TCP_KEEPALIVE_DELAY_MS = 10_000; // Initial delay before first TCP keepalive probe on idle WebDAV sockets — detects dead connections (NAT timeout, TLS half-open) so they get culled from the pool.

  // MIME types for the /v video proxy. Mirrors VIDEO_EXTENSIONS in
  // src/health/fileClassifier.ts — the canonical set of recognized video
  // containers across the project. Used to override generic upstream
  // Content-Types so strict demuxers (Infuse, tvOS) get a codec hint.
  const VIDEO_MIME_BY_EXT: Record<string, string> = {
    '.mkv':  'video/x-matroska',
    '.mp4':  'video/mp4',
    '.m4v':  'video/x-m4v',
    '.mov':  'video/quicktime',
    '.ts':   'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.avi':  'video/x-msvideo',
    '.webm': 'video/webm',
    '.wmv':  'video/x-ms-wmv',
    '.mpg':  'video/mpeg',
    '.mpeg': 'video/mpeg',
  };
  const DEFAULT_VIDEO_MIME = 'video/mp4';
  const GENERIC_UPSTREAM_MIME = new Set(['application/octet-stream', 'application/x-download', 'binary/octet-stream']);

  // Throttle the MIME-override log to first-hit-per-videoPath per 60 s —
  // a single stream triggers dozens of Range probes/seeks that would each
  // emit an identical override line.
  const loggedMimeOverride = new Set<string>();
  const MIME_OVERRIDE_LOG_TTL_MS = 15_000;

  // Per-file request tracker — aborts superseded/excess connections.
  interface TrackedReq { id: number; rangeStart: number; isFullRequest: boolean; abort: () => void; }
  const activeRequests = new Map<string, TrackedReq[]>();
  let reqIdCounter = 0;

  function trackRequest(filePath: string, rangeStart: number, isFullRequest: boolean, usePipe: boolean, abort: () => void): number {
    const id = ++reqIdCounter;
    if (!activeRequests.has(filePath)) activeRequests.set(filePath, []);
    const tracked = activeRequests.get(filePath)!;

    // Kill full (non-Range) requests when a Range request arrives — the player
    // has switched to range-based streaming and the old full download wastes
    // bandwidth AND its pre-fetched buffer sits idle until TCP teardown.
    // Only relevant in dual-stage proxy mode: its 128 MB buffer adds real memory
    // pressure per ghost stream. Pipe mode's 8 MB buffer makes this negligible;
    // MAX_CONCURRENT_PER_FILE eviction handles those cases.
    // Don't kill range-vs-range — players legitimately maintain parallel streams
    // at different offsets (moov reads + read-ahead probes).
    const toAbort: TrackedReq[] = [];
    if (!isFullRequest && !usePipe) {
      for (const t of tracked) {
        if (t.isFullRequest) toAbort.push(t);
      }
    }
    for (const t of toAbort) {
      t.abort();
    }

    // Evict oldest if over the concurrency cap (after supersession cleanup)
    const remaining = tracked.filter(t => !toAbort.includes(t));
    while (remaining.length >= MAX_CONCURRENT_PER_FILE) {
      const oldest = remaining.shift()!;
      oldest.abort();
    }

    remaining.push({ id, rangeStart, isFullRequest, abort });
    activeRequests.set(filePath, remaining);
    return id;
  }

  function untrackRequest(filePath: string, id: number): void {
    const tracked = activeRequests.get(filePath);
    if (!tracked) return;
    const filtered = tracked.filter(t => t.id !== id);
    if (filtered.length === 0) activeRequests.delete(filePath);
    else activeRequests.set(filePath, filtered);
  }

  const agentOpts = {
    keepAlive: true,
    maxSockets: 32,
    keepAliveMsecs: 15_000,
    scheduling: 'fifo' as const, // Rotate sockets across long-running sessions so a degraded socket doesn't stay pinned at the top of the pool.
  };
  const webdavHttpAgent = new http.Agent(agentOpts);
  const webdavHttpsAgent = new https.Agent(agentOpts);

  // TCP-level SO_KEEPALIVE on every new socket — pairs with scheduling: 'fifo'
  // above. FIFO rotates sockets across requests; keepalive culls the dead ones.
  // Together they keep multi-hour streaming pools healthy without restart.
  for (const agent of [webdavHttpAgent, webdavHttpsAgent]) {
    const base = agent.createConnection.bind(agent);
    (agent as any).createConnection = (options: any, callback: any) => {
      const socket = base(options, callback) as { setKeepAlive?: (enable: boolean, delay: number) => void } | undefined;
      if (socket && typeof socket.setKeepAlive === 'function') {
        socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
      }
      return socket;
    };
  }

  /** Resolve dual-stage proxy buffer size (accessor handles env var → config → 128 MB default). */
  function getStreamBufferBytes(): number {
    return (config.nzbdavStreamBufferMB ?? 128) * 1024 * 1024;
  }

  /** Resolve pipe mode buffer size (accessor clamps 1–16 MB; default 8). */
  function getPipeBufferBytes(): number {
    return (config.nzbdavPipeBufferMB ?? 8) * 1024 * 1024;
  }

  /** Parse a Content-Range header (e.g. "bytes 0-999/1000"). */
  function parseContentRange(header: string | undefined): { start: number; end: number; total: number | null } | null {
    if (!header) return null;
    const m = header.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
    if (!m) return null;
    return { start: parseInt(m[1], 10), end: parseInt(m[2], 10), total: m[3] === '*' ? null : parseInt(m[3], 10) };
  }

  /** Parse a client Range header (e.g. "bytes=0-999" or "bytes=0-"). */
  function parseClientRange(header: string | undefined): { start: number; end: number | null } | null {
    if (!header) return null;
    const m = header.match(/^bytes=(\d+)-(\d*)/);
    if (!m) return null;
    return { start: parseInt(m[1], 10), end: m[2] ? parseInt(m[2], 10) : null };
  }

  /** Make an upstream WebDAV GET request. Resolves with the response stream. */
  function fetchUpstream(
    url: URL,
    headers: Record<string, string>,
    useHttps: boolean,
  ): Promise<http.IncomingMessage> {
    const transport = useHttps ? https : http;
    const agent = useHttps ? webdavHttpsAgent : webdavHttpAgent;
    return new Promise((resolve, reject) => {
      const r = transport.request(url, { method: 'GET', headers, timeout: 30_000, agent }, (upstream) => {
        upstream.socket?.setNoDelay(true);
        resolve(upstream);
      });
      r.on('timeout', () => r.destroy());
      r.on('error', reject);
      r.end();
    });
  }

  /**
   * Buffered proxy: upstream → PassThrough (pre-fetch) → res (delivery).
   *
   * The PassThrough pre-fetches data ahead of playback so that when upstream
   * momentarily stalls (e.g. WebDAV hiccups at specific byte offsets), there's
   * already data waiting.
   *
   * Two modes for stage 1, controlled by usePipe:
   *  - Proxy (usePipe=false): manual data/end/drain listeners with split buffer,
   *    giving finer control over upstream pause/resume.
   *  - Pipe  (usePipe=true):  Node .pipe() handles upstream → buffer flow,
   *    simpler code, Node-managed backpressure.
   *
   * Stage 2 (buffer → res) is always manual: soft backpressure pauses the
   * buffer when res has a large pending backlog.
   */
  function consumeUpstream(
    upstream: http.IncomingMessage,
    res: http.ServerResponse,
    req: http.IncomingMessage,
    onChunk: (byteLength: number) => void,
    skipBytes = 0,
    usePipe = false,
  ): Promise<void> {
    const stageBytes = usePipe ? getPipeBufferBytes() : Math.max(1, Math.floor(getStreamBufferBytes() / 2));
    const buffer = new PassThrough({ highWaterMark: stageBytes });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let skipped = 0;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (usePipe) upstream.unpipe(buffer);
        upstream.removeListener('data', onUpstreamData);
        upstream.removeListener('end', onUpstreamEnd);
        upstream.removeListener('error', onUpstreamError);
        buffer.removeAllListeners();
        res.removeListener('drain', onResDrain);
        req.removeListener('close', onClientGone);
        if (err) reject(err); else resolve();
      };

      // --- Stage 1: upstream → buffer (pre-fetch) ---
      const onUpstreamData = (chunk: Buffer) => {
        if (!buffer.write(chunk)) upstream.pause();
      };
      const onBufferDrain = () => { if (!settled) upstream.resume(); };
      const onUpstreamEnd = () => { buffer.end(); };
      const onUpstreamError = (err: Error) => {
        // Disconnect pipe before draining so it stops writing to a buffer we end below
        if (usePipe) upstream.unpipe(buffer);
        // Force-resume so queued data drains instantly to res (in-process memory
        // copy) even if the buffer was paused due to res backpressure. Without
        // this, we'd wait for res to drain below 16KB before buffer un-pauses,
        // delaying the reconnect by up to ~34s while pre-fetched data sits idle.
        buffer.resume();
        buffer.end();
        // Override the normal 'end' handler to reject (triggers reconnect loop)
        // instead of resolving (which would signal "stream complete").
        buffer.removeListener('end', onBufferEnd);
        buffer.on('end', () => finish(err));
      };

      // --- Stage 2: buffer → res (delivery) ---
      const onBufferData = (chunk: Buffer) => {
        // Skip leading bytes on reconnect (overlap from upstream)
        if (skipBytes > 0 && skipped < skipBytes) {
          const remaining = skipBytes - skipped;
          if (chunk.length <= remaining) { skipped += chunk.length; return; }
          chunk = chunk.subarray(remaining);
          skipped = skipBytes;
        }
        onChunk(chunk.length);
        res.write(chunk);
        // Soft backpressure: pause buffer when res has a large pending backlog
        if (res.writableLength > stageBytes) buffer.pause();
      };
      const onResDrain = () => { if (!settled) buffer.resume(); };
      const onBufferEnd = () => finish();
      const onBufferError = (err: Error) => { upstream.destroy(); finish(err); };

      const onClientGone = () => {
        if (res.writableFinished) return;
        upstream.destroy();
        buffer.destroy();
        const err = new Error('Client disconnected') as NodeJS.ErrnoException;
        err.code = 'ERR_STREAM_PREMATURE_CLOSE';
        finish(err);
      };

      // Wire up stage 1 — pipe mode lets Node handle upstream → buffer flow;
      // manual mode uses explicit data/end/drain listeners. Error listener is
      // always needed — Node's pipe() does NOT propagate errors.
      if (usePipe) {
        upstream.pipe(buffer);
        upstream.on('error', onUpstreamError);
      } else {
        upstream.on('data', onUpstreamData);
        upstream.on('end', onUpstreamEnd);
        upstream.on('error', onUpstreamError);
        buffer.on('drain', onBufferDrain);
      }

      // Wire up stage 2
      buffer.on('data', onBufferData);
      buffer.on('end', onBufferEnd);
      buffer.on('error', onBufferError);
      res.on('drain', onResDrain);
      req.on('close', onClientGone);
    });
  }

  /** Proxy video bytes from WebDAV with auth, buffering, and transparent reconnect. */
  async function proxyVideoStream(req: any, res: any, videoPath: string, usePipeOverride?: boolean): Promise<void> {
    const webdavBase = (config.nzbdavWebdavUrl || config.nzbdavUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const safePath = encodeWebdavPath(videoPath);

    const targetUrl = new URL(`${webdavBase}${safePath}`);
    const useHttps = targetUrl.protocol === 'https:';

    const baseHeaders: Record<string, string> = {
      'User-Agent': config.userAgents?.webdavOperations || getLatestVersions().chrome,
    };
    if (config.nzbdavWebdavUser && config.nzbdavWebdavPassword) {
      baseHeaders['Authorization'] = 'Basic ' + Buffer.from(
        `${config.nzbdavWebdavUser}:${config.nzbdavWebdavPassword}`
      ).toString('base64');
    }

    const clientRange = parseClientRange(req.headers.range as string);
    const isFullRequest = !req.headers.range;
    const rangeStart = clientRange?.start ?? 0;
    // Resolve usePipe once — used by the request tracker (to gate supersession
    // cleanup) and by consumeUpstream (pipe vs manual branch).
    const usePipe = usePipeOverride ?? ((config.nzbdavStreamingMethod ?? 'proxy') !== 'proxy');

    // Track this request and get an abort handle
    let currentUpstream: http.IncomingMessage | undefined;
    let aborted = false;
    const reqId = trackRequest(safePath, rangeStart, isFullRequest, usePipe, () => {
      aborted = true;
      currentUpstream?.destroy();
      if (!res.writableFinished) res.destroy();
    });

    try {
      // Phase 1: Establish upstream connection (pre-header retries)
      let upstream: http.IncomingMessage | undefined;
      for (let attempt = 1; attempt <= MAX_PROXY_RETRIES; attempt++) {
        if (aborted) return;
        const headers = { ...baseHeaders };
        if (req.headers.range) headers['Range'] = req.headers.range as string;
        try {
          upstream = await fetchUpstream(targetUrl, headers, useHttps);
          currentUpstream = upstream;
          break;
        } catch (err: any) {
          if (aborted) return;
          if (attempt >= MAX_PROXY_RETRIES) {
            console.error(`\u274C WebDAV proxy error: ${err.message}`);
            if (!res.headersSent) res.status(502).send('WebDAV proxy error');
            return;
          }
          console.warn(`\u26A0\uFE0F WebDAV proxy retry ${attempt}/${MAX_PROXY_RETRIES}: ${err.message}`);
          await new Promise(r => setTimeout(r, 100));
        }
      }
      if (!upstream || aborted) { upstream?.destroy(); return; }

      // Follow one upstream redirect server-side (keeps credentials out of Location header)
      const upstreamStatus = upstream.statusCode ?? 200;
      if ((upstreamStatus === 301 || upstreamStatus === 302 || upstreamStatus === 307 || upstreamStatus === 308) && upstream.headers.location) {
        upstream.destroy();
        const redirectTarget = new URL(upstream.headers.location, targetUrl);
        const redirectHeaders = { ...baseHeaders };
        // Strip credentials if redirecting to a different origin (prevents leaking to CDNs etc.)
        if (redirectTarget.origin !== targetUrl.origin) {
          delete redirectHeaders['Authorization'];
        }
        if (req.headers.range) redirectHeaders['Range'] = req.headers.range as string;
        try {
          upstream = await fetchUpstream(redirectTarget, redirectHeaders, redirectTarget.protocol === 'https:');
          currentUpstream = upstream;
          if (aborted) { upstream.destroy(); return; }
        } catch (err: any) {
          console.error(`\u274C WebDAV proxy redirect failed: ${err.message}`);
          if (!res.headersSent) res.status(502).send('WebDAV proxy error');
          return;
        }
      }

      // Forward safe response headers
      const fwdHeaders: Record<string, string | string[]> = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition']) {
        const val = upstream.headers[name];
        if (val) fwdHeaders[name] = val;
      }

      let status = upstream.statusCode ?? 200;
      if (status === 404 || status === 410) {
        upstream.destroy();
        throw new WebDav404Error(videoPath, status);
      }
      // 416 means the client's Range exceeds the upstream's reported file size.
      // Common when the player carried a byte position from a different file
      // across a fallback redirect — recoverable by re-fetching with no Range.
      // Player will re-buffer from byte 0 instead of burning a candidate.
      if (status === 416 && req.headers.range) {
        upstream.destroy();
        console.warn(`\u26A0\uFE0F WebDAV 416 for ${safePath} — retrying without Range`);
        let retryUpstream: http.IncomingMessage | undefined;
        for (let attempt = 1; attempt <= MAX_PROXY_RETRIES; attempt++) {
          if (aborted) return;
          try {
            retryUpstream = await fetchUpstream(targetUrl, baseHeaders, useHttps);
            currentUpstream = retryUpstream;
            break;
          } catch {
            if (attempt >= MAX_PROXY_RETRIES) {
              if (!res.headersSent) res.status(502).send('WebDAV proxy error');
              return;
            }
            await new Promise(r => setTimeout(r, 100));
          }
        }
        if (!retryUpstream || aborted) { retryUpstream?.destroy(); return; }
        upstream = retryUpstream;
        // Refresh forwarded headers + status from the retry response
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition']) {
          delete fwdHeaders[name];
          const val = upstream.headers[name];
          if (val) fwdHeaders[name] = val;
        }
        status = upstream.statusCode ?? 200;
        // Empty success body means upstream is lying about a real file — treat
        // as upstream error so the fallback path advances to the next candidate.
        const cl = parseInt((upstream.headers['content-length'] as string) ?? '', 10);
        if (status === 200 && Number.isFinite(cl) && cl === 0) {
          upstream.destroy();
          throw new Error(`WebDAV returned empty body on no-Range retry for ${safePath}`);
        }
      }
      if (status !== 200 && status !== 206) {
        upstream.destroy();
        console.warn(`\u26A0\uFE0F WebDAV upstream returned ${status} for ${safePath} — triggering fallback`);
        throw new Error(`WebDAV upstream returned ${status}`);
      }
      // Parse range info for reconnect
      const cr = parseContentRange(upstream.headers['content-range'] as string);
      const streamRangeStart = cr?.start ?? (status === 206 ? (clientRange?.start ?? 0) : 0);
      const rangeEnd = cr?.end ?? (fwdHeaders['content-length']
        ? streamRangeStart + parseInt(fwdHeaders['content-length'] as string, 10) - 1
        : null);
      const totalSize = cr?.total ?? null;

      // iOS external-player compatibility (Infuse demuxer probe).
      // Override generic/missing Content-Type with an extension-derived MIME
      // so the demuxer has a codec hint. Without this, Infuse fails with
      // "Failed to open input stream in the demuxing stream".
      const currentType = (fwdHeaders['content-type'] as string | undefined)?.toLowerCase().split(';')[0].trim();
      if (!currentType || GENERIC_UPSTREAM_MIME.has(currentType)) {
        const basename = videoPath.split('/').pop() || '';
        const dotIdx = basename.lastIndexOf('.');
        const ext = dotIdx >= 0 ? basename.slice(dotIdx).toLowerCase() : '';
        const inferred = VIDEO_MIME_BY_EXT[ext] ?? DEFAULT_VIDEO_MIME;
        fwdHeaders['content-type'] = inferred;
        if (!loggedMimeOverride.has(safePath)) {
          loggedMimeOverride.add(safePath);
          setTimeout(() => loggedMimeOverride.delete(safePath), MIME_OVERRIDE_LOG_TTL_MS);
          console.log(`\u{1F3AC} /v MIME override: ${safePath} → ${inferred}${currentType ? ` (was ${currentType})` : ''}`);
        }
      }

      // Accept-Ranges: always advertise — the reconnect loop below resumes via
      // byte-range requests against nzbdav, so the /v contract is range-capable.
      fwdHeaders['accept-ranges'] = 'bytes';

      // Upgrade 200→206 only when the client actually asked for a range AND
      // Content-Range parsed. Without a client Range, a 200 + Content-Range
      // from upstream usually means "whole file, here's a cosmetic range
      // header" — forcing 206 would make us advertise a partial offset while
      // the body is actually the full file, and strict demuxers (Infuse's
      // FFmpeg) fail on the mismatch.
      if (status === 200 && cr && clientRange) status = 206;

      // Send headers to client
      res.socket?.setNoDelay(true);
      res.writeHead(status, fwdHeaders);

      // Phase 2: Stream with transparent mid-stream reconnect
      let bytesSent = 0;
      // usePipe resolved at function entry — in-flight streams keep their
      // original mode even if config changes mid-stream.

      // Initial consume attempt
      try {
        await consumeUpstream(upstream, res, req, (n) => { bytesSent += n; }, 0, usePipe);
        if (!res.writableFinished) res.end();
        return;
      } catch {
        if (aborted || req.destroyed || res.writableFinished || res.destroyed) return;
      }

      // Upstream failed while client is still alive — reconnect loop
      for (let rc = 1; rc <= UPSTREAM_MAX_RECONNECTS; rc++) {
        const resumeByte = streamRangeStart + bytesSent;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.min(rc - 1, 3), RECONNECT_MAX_DELAY_MS);

        await new Promise(r => setTimeout(r, delay));
        if (aborted || req.destroyed || res.writableFinished || res.destroyed) return;

        // Reconnect with updated Range
        const rangeStr = rangeEnd != null ? `bytes=${resumeByte}-${rangeEnd}` : `bytes=${resumeByte}-`;
        let newUpstream: http.IncomingMessage;
        try {
          newUpstream = await fetchUpstream(targetUrl, { ...baseHeaders, Range: rangeStr }, useHttps);
          currentUpstream = newUpstream;
          if (aborted) { newUpstream.destroy(); return; }
        } catch {
          continue;
        }

        // Non-2xx on reconnect — stop trying
        if (newUpstream.statusCode && newUpstream.statusCode >= 400) {
          // 404/410: video gone — evict stale cache so player's next retry uses fallback
          if (newUpstream.statusCode === 404 || newUpstream.statusCode === 410) {
            const evicted = evictReadyByVideoPath(videoPath);
            if (evicted) console.warn(`  🗑️ Evicted stale stream (reconnect ${newUpstream.statusCode}): ${evicted}`);
            if (evicted) console.log(`  🔄 Player retry will use fallback candidate`);
          }
          console.warn(`  \u26A0\uFE0F Reconnect returned ${newUpstream.statusCode}. Ending stream.`);
          newUpstream.destroy();
          if (!res.writableFinished) res.end();
          return;
        }

        // Validate Content-Range — detect file replacement
        const newCR = parseContentRange(newUpstream.headers['content-range'] as string);
        if (newCR && totalSize != null && newCR.total != null && newCR.total !== totalSize) {
          console.warn(`  \u26A0\uFE0F File size changed on reconnect: ${totalSize} \u2192 ${newCR.total}. Ending stream.`);
          newUpstream.destroy();
          if (!res.writableFinished) res.end();
          return;
        }

        // Handle byte overlap or gap
        let skipBytes = 0;
        if (newCR) {
          if (newCR.start < resumeByte) {
            skipBytes = resumeByte - newCR.start;
          } else if (newCR.start > resumeByte) {
            console.warn(`  \u26A0\uFE0F Gap in stream: expected byte ${resumeByte}, got ${newCR.start}. Ending stream.`);
            newUpstream.destroy();
            if (!res.writableFinished) res.end();
            return;
          }
        }

        try {
          await consumeUpstream(newUpstream, res, req, (n) => { bytesSent += n; }, skipBytes, usePipe);
          if (!res.writableFinished) res.end();
          return;
        } catch {
          if (aborted || req.destroyed || res.writableFinished || res.destroyed) return;
        }
      }

      console.error(`  \u26D4 Exhausted ${UPSTREAM_MAX_RECONNECTS} reconnect attempts for ${safePath}`);
      if (!res.writableFinished) res.end();
    } catch (err: any) {
      if (err instanceof WebDav404Error) throw err;
      if (aborted) return;
      if (!res.headersSent) throw err;
      console.error(`\u274C WebDAV proxy error: ${(err as Error).message}`);
    } finally {
      untrackRequest(safePath, reqId);
    }
  }

  router.get('/v', async (req, res) => {
    const videoPath = req.query.path as string;
    if (!videoPath) {
      res.status(400).send('Missing path parameter');
      return;
    }
    // _norange=1: the previous /v hop just switched candidate files; the
    // player's Range was for the broken file and is invalid here. Drop it so
    // the new backup serves from byte 0. Set in the eviction-redirect builder
    // when _ci advances; same-file _rc++ retries (lobby self-redirects,
    // transient blips) preserve Range so manual seek positions survive.
    if (req.query._norange === '1') {
      delete (req.headers as Record<string, unknown>).range;
    }
    try {
      await proxyVideoStream(req, res, videoPath);
    } catch (err) {
      if (!res.headersSent) {
        // Evict ready cache so fallback advances to the next candidate. The
        // library check at /stream is now the single source of truth — it'll
        // see the file is missing on the next request, no marker needed.
        if (err instanceof WebDav404Error) {
          const evicted = evictReadyByVideoPath(videoPath);
          if (evicted) console.warn(`🗑️ Evicted stale stream (upstream ${err.statusCode}): ${evicted}`);
        } else {
          const evicted = evictReadyByVideoPath(videoPath, false);
          if (evicted) console.warn(`🗑️ Evicted stream for retry (upstream error): ${evicted}`);
        }

        // Redirect to fallback for ANY upstream error when _fb available.
        // _fb contains the relative path — reconstruct as same-origin URL.
        const fb = req.query._fb;
        if (typeof fb === 'string' && fb.startsWith('/') && !fb.startsWith('//')) {
          const fallbackUrl = new URL(`${req.protocol}://${req.get('host')}${fb}`);
          const rc = Math.max(0, parseInt(fallbackUrl.searchParams.get('_rc') ?? '0', 10) || 0);
          fallbackUrl.searchParams.set('_rc', String(rc + 1));
          // Any error here means the candidate file is being abandoned — the
          // next /v hop will serve a different file, so the player's Range is
          // invalid. Signal _norange=1 unconditionally; the next /v drops it.
          fallbackUrl.searchParams.set('_norange', '1');
          // For non-404 errors (file exists on disk but server can't serve it),
          // advance _ci so /stream doesn't re-resolve to the same broken video
          // via library check. 404 doesn't need _ci++ because the file is
          // genuinely gone — library check on the next request returns null.
          if (!(err instanceof WebDav404Error)) {
            const ci = Math.max(0, parseInt(fallbackUrl.searchParams.get('_ci') ?? '0', 10) || 0);
            fallbackUrl.searchParams.set('_ci', String(ci + 1));
          }
          const label = err instanceof WebDav404Error ? `${err.statusCode}` : 'error';
          console.log(`🔄 Upstream ${label} → fallback redirect to /stream (rc=${rc + 1})`);
          res.redirect(302, fallbackUrl.href);
        } else if (err instanceof WebDav404Error) {
          res.status(404).send('Video file not found');
        } else {
          console.error(`❌ WebDAV proxy error: ${(err as Error).message}`);
          res.status(502).send('WebDAV proxy error');
        }
      }
    }
  });

  return router;
}

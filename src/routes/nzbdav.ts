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
import { cleanupHistoryForPath } from '../nzbdav/historyApi.js';
import { posix as pathPosix } from 'path';
import { evictReadyByVideoPath, evictReadyByVideoPathPrefix, clearVideoPathState, markVideoPathBroken, markLibraryBypass } from '../nzbdav/streamCache.js';
import { sendLibraryBypassArmedVideo, sendDeleteAllSuccessVideo, sendDeleteFileSuccessVideo, sendDeletePackSuccessVideo, sendDeleteFailedVideo } from '../nzbdav/streamHandler.js';
import { incrementRedirectCounterOnUrl } from '../nzbdav/redirectHelpers.js';
import { getDeleteAllTargets } from '../nzbdav/deleteAllTargetsStore.js';
import { getWebdavClient } from '../nzbdav/webdavClient.js';
import { resolveBaseUrl } from '../utils/urlHelpers.js';
import { buildSearchCacheKey, deleteSearchCacheEntry } from '../addon/index.js';

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
  const { config, handleStream, trackGrab, getLatestVersions } = deps;

  // Dedup set for grab tracking — prevents concurrent requests from tracking the same grab
  // before the stream cache is populated. Entries are cleaned up after 60s.
  const trackedGrabKeys = new Set<string>();
  const GRAB_DEDUP_TTL_MS = 60_000;

  // Throttle the /stream entry log to first-hit-per-(kind,filename) per 60 s —
  // Range probes and seek bursts otherwise spam the log during active playback.
  const loggedStreamHits = new Set<string>();
  const STREAM_HIT_LOG_TTL_MS = 15_000;

  // Per-bypassKey log dedup. The bypass tile click triggers the player to fetch
  // the URL with multiple range requests; without this, the "bypass armed" log
  // fires once per range request. 30s TTL covers the burst of probe + open
  // requests on a single user click.
  const recentLoggedBypassKeys = new Set<string>();

  // Ultimate Library bypass endpoint — fired by the "Query indexers on next
  // search" action-tile. Sets a one-shot, manifest-scoped marker so the next
  // search of this content skips Ultimate Library. Cache handling depends on
  // libraryRunOnCacheHit (see the inline comment below). Returns 204 (no body)
  // — Stremio shows a brief toast and the user backs out; marker is set as a
  // background side-effect.
  router.get('/library-bypass', async (req, res) => {
    // Source of truth for manifestKey is req.params (already validated by the
    // validateManifestKey middleware mounted upstream). The sk query param is
    // user-controlled and must NOT be trusted as the manifest scope.
    const manifestKey = (req.params as { manifestKey?: string }).manifestKey;
    const sk = req.query.sk as string | undefined;
    if (!manifestKey || !sk) return sendLibraryBypassArmedVideo(req, res);
    // sk encodes ${manifestKey}:${type}:${imdbId}:${season}:${episode}. Skip
    // index 0 (the embedded manifestKey) and use the validated path manifest.
    const [, type, imdbId, season, episode] = sk.split(':');
    if (!type || !imdbId) return sendLibraryBypassArmedVideo(req, res);
    const id = (season || episode) ? `${imdbId}:${season || ''}:${episode || ''}` : imdbId;
    const bypassKey = `${manifestKey}:${type}:${imdbId}:${season || ''}:${episode || ''}`;
    markLibraryBypass(bypassKey);
    // When libraryRunOnCacheHit is OFF (legacy semantics), the Skip tile means
    // "skip UL AND force a fresh indexer query" so we drop the cache entry to
    // guarantee re-evaluation. When the toggle is ON, the user has opted into
    // "use cache when possible" semantics; the Skip tile only suppresses UL for
    // the next search and leaves the cached indexer results in place so the
    // next request is served from cache (the orchestrator's cache-hit branch
    // honors the bypass marker and skips UL even when the toggle is on).
    if (!config.searchConfig?.libraryRunOnCacheHit) {
      const targetCacheKey = buildSearchCacheKey(manifestKey, type, id, config);
      deleteSearchCacheEntry(targetCacheKey);
    }
    if (!recentLoggedBypassKeys.has(bypassKey)) {
      console.log(`📚 Ultimate Library bypass armed for ${bypassKey} (5 min TTL)`);
      recentLoggedBypassKeys.add(bypassKey);
      setTimeout(() => recentLoggedBypassKeys.delete(bypassKey), 30_000).unref?.();
    }
    return sendLibraryBypassArmedVideo(req, res);
  });

  // ── Library delete tiles ─────────────────────────────────────────────
  // Stremio tiles fire on a single click (the URL is fetched and the
  // response video played), so the delete runs immediately on click and
  // the response placeholder tells the user what happened. There is no
  // two-step arm/confirm because tiles cannot reliably distinguish first
  // click from second click in Stremio's UX.
  //
  // Stremio sends multiple Range requests against the placeholder MP4 as
  // it plays it. Each request hits this route. Dedup by key for 30s so
  // the WebDAV delete (and its log line) runs once per click rather than
  // once per Range request. Cleanup is lazy on each insertion.
  const recentDeletes = new Map<string, number>();
  function alreadyHandled(key: string): boolean {
    const now = Date.now();
    const expiresAt = recentDeletes.get(key);
    if (expiresAt && expiresAt > now) return true;
    for (const [k, exp] of recentDeletes) {
      if (exp <= now) recentDeletes.delete(k);
    }
    recentDeletes.set(key, now + 30_000);
    return false;
  }

  // Validate that a query path is a legal absolute WebDAV path under /content/.
  // Rejects path-traversal attempts (.., null bytes, paths that change under
  // normalization) and enforces 4-segment depth for pack scope.
  function validateDeletePath(rawPath: string, scope: 'file' | 'pack'): { ok: true; path: string } | { ok: false; reason: string } {
    const normalized = pathPosix.normalize(rawPath);
    if (!normalized.startsWith('/content/')) return { ok: false, reason: 'not under /content/' };
    if (normalized.includes('..')) return { ok: false, reason: 'contains ..' };
    if (normalized.includes('\0')) return { ok: false, reason: 'contains null byte' };
    if (normalized !== rawPath) return { ok: false, reason: 'path normalizes differently than provided' };
    if (scope === 'pack' && normalized.split('/').length !== 4) {
      return { ok: false, reason: `pack scope requires 4 segments, got ${normalized.split('/').length}` };
    }
    return { ok: true, path: normalized };
  }

  // Issue a raw WebDAV DELETE so we can read the response status (the webdav
  // package's deleteFile() throws on non-2xx but hides the status code on
  // success). For pack scope we set Depth: infinity per RFC 4918 since
  // compliant servers reject DELETE on a non-empty collection without it.
  // 404/410 is treated as success (file already gone, goal achieved).
  async function runWebdavDelete(targetPath: string, scope: 'file' | 'pack'): Promise<{ ok: true; status: number } | { ok: false; error: string; status?: number }> {
    const nzbdavConfig = buildNzbdavConfig();
    const webdavBase = (nzbdavConfig.webdavUrl || nzbdavConfig.url).replace(/\/+$/, '');
    const url = `${webdavBase}${encodeWebdavPath(targetPath)}`;
    const headers: Record<string, string> = {};
    if (scope === 'pack') headers['Depth'] = 'infinity';
    if (nzbdavConfig.webdavUser && nzbdavConfig.webdavPassword) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${nzbdavConfig.webdavUser}:${nzbdavConfig.webdavPassword}`).toString('base64');
    }
    try {
      const resp = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) });
      const status = resp.status;
      // Drain the body so the connection releases cleanly.
      await resp.body?.cancel().catch(() => {});
      console.log(`\u{1F5D1}\uFE0F WebDAV DELETE ${scope}: ${url} \u2192 HTTP ${status}`);
      if (status === 404 || status === 410) return { ok: true, status };
      if (status >= 200 && status < 300) return { ok: true, status };
      return { ok: false, status, error: `HTTP ${status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // PROPFIND helper: is the given folder empty (no immediate children)?
  // Returns false on error so we never prune a folder we couldn't list
  // safely. Uses the webdav client (same auth/base URL as the rest of the
  // pipeline) since DELETE was already proven to work via raw fetch.
  async function isFolderEmpty(folderPath: string): Promise<boolean> {
    const client = getWebdavClient(buildNzbdavConfig());
    try {
      const items = await (client as any).getDirectoryContents(folderPath, { deep: false });
      const arr: Array<{ filename?: string; basename?: string }> = Array.isArray(items)
        ? items
        : (items && Array.isArray(items.data) ? items.data : []);
      // Some WebDAV impls echo the folder itself in the response; filter it out
      // by matching the requested path. Anything else is a real child.
      const normalizedTarget = folderPath.replace(/\/+$/, '');
      const children = arr.filter(x => {
        const fn = (x.filename || '').replace(/\/+$/, '');
        return fn !== normalizedTarget && fn !== '';
      });
      return children.length === 0;
    } catch (err) {
      console.warn(`\u{1F5D1}\uFE0F PROPFIND failed for ${folderPath}: ${(err as Error).message}`);
      return false;
    }
  }

  // After a successful file-scope delete, walk up the path and remove any
  // parent folders that are now empty. Stops before `/content/<root>/` so
  // category roots (Usenet-Ultimate-TV, Usenet-Ultimate-Movies, uncategorized)
  // are never deleted. Stops as soon as a non-empty ancestor is found.
  // Path layout: `/content/<root>/<release>/<...>/<file>` — segments[0]
  // is 'content', segments[1] is the root; we never delete depth <= 2.
  async function pruneEmptyAncestors(filePath: string): Promise<void> {
    const segments = filePath.split('/').filter(s => s.length > 0);
    for (let depth = segments.length - 1; depth >= 3; depth--) {
      const parent = '/' + segments.slice(0, depth).join('/');
      const empty = await isFolderEmpty(parent);
      if (!empty) return;
      const result = await runWebdavDelete(parent, 'pack');
      if (!result.ok) {
        console.warn(`\u{1F5D1}\uFE0F Could not prune empty folder ${parent}: ${result.error}`);
        return;
      }
      console.log(`\u{1F5D1}\uFE0F Pruned empty folder: ${parent}`);
    }
  }

  // Drop cache state that referenced the deleted path. File scope: ready cache
  // entry by exact videoPath, plus broken-video marker and dead-NZB entry
  // pointing at library:<path>. Pack scope: prefix sweep across ready cache,
  // dead-NZB cache, and broken-video markers. Ready-cache evictions are
  // unconditional (a deleted file can't be streamed). The search cache drop is
  // gated on libraryRunOnCacheHit: when OFF (legacy) we drop the entry so the
  // next search re-evaluates from scratch; when ON, the user has opted into
  // "use cache when possible" semantics and we leave the cached indexer entry
  // in place so the next stream-fetch is a cache hit. The orchestrator's
  // cache-hit path re-validates the inLibrary flag, so deleted entries lose
  // their 📚 marker on the next request without needing a full cache wipe.
  function invalidateAfterDelete(targetPath: string, scope: 'file' | 'pack', manifestKey: string, type?: string, id?: string): void {
    if (scope === 'file') {
      evictReadyByVideoPath(targetPath, false);
      clearVideoPathState(targetPath);
    } else {
      evictReadyByVideoPathPrefix(targetPath, false);
    }
    if (type && id && !config.searchConfig?.libraryRunOnCacheHit) {
      const searchCacheKey = buildSearchCacheKey(manifestKey, type, id, config);
      deleteSearchCacheEntry(searchCacheKey);
    }
  }

  // Decode the single `?t=<base64url(JSON)>` envelope used by all delete tile
  // URLs. iOS / Infuse handoff truncates URLs at the first `&`, so the tile
  // packs every input into one query param (same pattern as regular tiles).
  function readPackedTile(t: unknown): Record<string, unknown> | null {
    if (typeof t !== 'string' || t.length === 0) return null;
    try {
      const parsed = JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  router.get('/library-delete', async (req, res) => {
    const manifestKey = (req.params as { manifestKey?: string }).manifestKey;
    const packed = readPackedTile(req.query.t);
    const sk = typeof packed?.sk === 'string' ? packed.sk : undefined;
    const rawPath = typeof packed?.p === 'string' ? packed.p : undefined;
    const scope: 'file' | 'pack' = packed?.scope === 'pack' ? 'pack' : 'file';
    const type = typeof packed?.type === 'string' ? packed.type : undefined;
    const id = typeof packed?.id === 'string' ? packed.id : undefined;
    if (!manifestKey || !sk || !rawPath) return sendDeleteFailedVideo(req, res);

    const v = validateDeletePath(rawPath, scope);
    if (!v.ok) {
      console.warn(`\u{1F5D1}\uFE0F Delete request rejected (${scope}): ${v.reason} (raw="${rawPath}")`);
      return sendDeleteFailedVideo(req, res);
    }
    const targetPath = v.path;

    // Stremio sends multiple Range requests against the placeholder video as
    // it plays it. Without dedup, each Range request would re-run the delete
    // and re-log. The first request actually does the work; subsequent
    // hits within 30s short-circuit to the same placeholder silently.
    const dedupKey = `${manifestKey}::${scope}::${targetPath}`;
    const sendScopeSuccess = scope === 'pack' ? sendDeletePackSuccessVideo : sendDeleteFileSuccessVideo;
    if (alreadyHandled(dedupKey)) {
      return sendScopeSuccess(req, res);
    }

    const result = await runWebdavDelete(targetPath, scope);
    if (result.ok) {
      console.log(`\u{1F5D1}\uFE0F Deleted from WebDAV (${scope}): ${targetPath}`);
      invalidateAfterDelete(targetPath, scope, manifestKey, type, id);
      // File scope leaves behind empty parent folders (release dir, season
      // subfolder for pack-extracted episodes). Pack scope already removed
      // the whole release folder via Depth: infinity, so no cleanup.
      if (scope === 'file') await pruneEmptyAncestors(targetPath);
      await cleanupHistoryForPath(targetPath, scope, buildNzbdavConfig());
      return sendScopeSuccess(req, res);
    }
    console.error(`\u274C WebDAV delete failed (${scope}) for ${targetPath}: ${result.error}`);
    return sendDeleteFailedVideo(req, res);
  });

  router.get('/library-delete-all', async (req, res) => {
    const manifestKey = (req.params as { manifestKey?: string }).manifestKey;
    const packed = readPackedTile(req.query.t);
    const sk = typeof packed?.sk === 'string' ? packed.sk : undefined;
    const type = typeof packed?.type === 'string' ? packed.type : undefined;
    const id = typeof packed?.id === 'string' ? packed.id : undefined;
    const tk = typeof packed?.tk === 'string' ? packed.tk : undefined;
    if (!manifestKey || !sk || !type || !id || !tk) {
      return sendDeleteFailedVideo(req, res);
    }

    // Dedup repeat Range requests from Stremio's placeholder playback.
    if (alreadyHandled(`${manifestKey}::all::${type}::${id}`)) {
      return sendDeleteAllSuccessVideo(req, res);
    }

    // Targets live in deleteAllTargetsStore; the tile envelope carries only
    // the token. Per-target validation below still gates everything before
    // it reaches WebDAV.
    const targets = getDeleteAllTargets(tk);
    if (!targets || targets.length === 0) {
      console.warn(`\u{1F5D1}\uFE0F Delete-all: token miss (restart, expired, or invalid)`);
      return sendDeleteFailedVideo(req, res);
    }

    let okCount = 0;
    let failCount = 0;
    for (const t of targets) {
      const v = validateDeletePath(t.path, t.scope);
      if (!v.ok) {
        console.warn(`\u{1F5D1}\uFE0F Delete-all skipped (validation, ${t.scope}): ${v.reason} for ${t.path}`);
        failCount++;
        continue;
      }
      const result = await runWebdavDelete(v.path, t.scope);
      if (result.ok) {
        console.log(`\u{1F5D1}\uFE0F Delete-all removed (${t.scope}): ${v.path}`);
        invalidateAfterDelete(v.path, t.scope, manifestKey, type, id);
        // File-scope leaves empty parents; pack-scope already removed the
        // release folder via Depth: infinity so there's nothing to prune.
        if (t.scope === 'file') await pruneEmptyAncestors(v.path);
        await cleanupHistoryForPath(v.path, t.scope, buildNzbdavConfig());
        okCount++;
      } else {
        console.error(`\u274C Delete-all failed (${t.scope}) for ${v.path}: ${result.error}`);
        failCount++;
      }
    }
    console.log(`\u{1F5D1}\uFE0F Delete-all done: ${okCount} removed, ${failCount} failed (of ${targets.length})`);
    return okCount > 0 ? sendDeleteAllSuccessVideo(req, res) : sendDeleteFailedVideo(req, res);
  });

  // NZBDav stream endpoint (key-protected)
  // Uses history API polling to detect job completion/failure
  // :filename? is cosmetic — external video players display the URL path as the stream name
  router.get('/stream/:filename?', async (req, res) => {
    // One-liner for external-player regression diagnosis. Throttled so Range
    // probes from an active player don't flood the log.
    const kind = req.params.filename === 'ultimate-fallback' ? 'UF'
      : req.query.t ? 'user_pick'
      : 'other';
    const hitKey = `${kind}::${req.params.filename ?? '-'}`;
    if (!loggedStreamHits.has(hitKey)) {
      loggedStreamHits.add(hitKey);
      setTimeout(() => loggedStreamHits.delete(hitKey), STREAM_HIT_LOG_TTL_MS);
      const qKeys = Object.keys(req.query).sort().join(',') || '(none)';
      console.log(`\u{1F39F}\uFE0F /stream hit: kind=${kind} filename=${req.params.filename ?? '-'} q=[${qKeys}] ua=${(req.headers['user-agent'] ?? '').slice(0, 80)}`);
    }

    // Grab tracking happens inside the stream handler once the `t` envelope
    // is decoded (route-level tracking would need to decode here too just to
    // extract nzb/title/indexer for the dedup key, so route-level was duplicated
    // work). The handler calls `dedupedTrackGrab` below for first-time grabs.

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
            markVideoPathBroken(videoPath);
            if (evicted) console.log(`  🔄 Player retry will use fallback candidate`);
          } else if (newUpstream.statusCode >= 500) {
            // 5xx: mark broken so library check skips this path on retry
            markVideoPathBroken(videoPath);
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
        // Evict ready cache so fallback advances to the next candidate, and
        // mark the videoPath broken so library/lobby checks skip it on retry
        // (NZBDav's PROPFIND can lie after content eviction — the marker
        // bridges that gap with a short TTL; see streamCache.ts).
        if (err instanceof WebDav404Error) {
          const evicted = evictReadyByVideoPath(videoPath);
          if (evicted) console.warn(`🗑️ Evicted stale stream (upstream ${err.statusCode}): ${evicted}`);
          markVideoPathBroken(videoPath);
        } else {
          const evicted = evictReadyByVideoPath(videoPath, false);
          if (evicted) console.warn(`🗑️ Evicted stream for retry (upstream error): ${evicted}`);
          markVideoPathBroken(videoPath);
        }

        // Redirect to fallback for ANY upstream error when _fb available.
        // _fb contains the relative path — reconstruct as same-origin URL.
        const fb = req.query._fb;
        if (typeof fb === 'string' && fb.startsWith('/') && !fb.startsWith('//')) {
          const fallbackUrl = new URL(`${resolveBaseUrl(req)}${fb}`);
          // Site 6 of 6 redirect sites. Operates on the reconstructed
          // `fallbackUrl` (built from `_fb`) rather than the original request
          // URL, so it uses `incrementRedirectCounterOnUrl` instead of the
          // request-based variant. For non-404 errors (file exists on disk
          // but server can't serve it), advance ci so /stream doesn't
          // re-resolve to the same broken video via library check. 404
          // doesn't need ci++ because the file is genuinely gone; library
          // check on the next request returns null.
          incrementRedirectCounterOnUrl(fallbackUrl, !(err instanceof WebDav404Error));
          // Any error here means the candidate file is being abandoned: the
          // next /v hop will serve a different file, so the player's Range
          // is invalid. Signal _norange=1 unconditionally; the next /v drops it.
          fallbackUrl.searchParams.set('_norange', '1');
          const label = err instanceof WebDav404Error ? `${err.statusCode}` : 'error';
          console.log(`🔄 Upstream ${label} → fallback redirect to /stream`);
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

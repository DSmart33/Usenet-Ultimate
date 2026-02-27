/**
 * NZBDav routes — /api/nzbdav/*
 *
 * POST   /api/nzbdav/test   — Test NZBDav + WebDAV connection
 * GET    /api/nzbdav/cache  — Stream cache stats
 * DELETE /api/nzbdav/cache  — Clear stream cache
 *
 * Also mounts the key-protected stream proxy:
 *   GET /:manifestKey/nzbdav/stream — NZBDav stream proxy (mounted separately in server.ts)
 */

import { Router } from 'express';
import type { Config } from '../types.js';
import type { NZBDavConfig } from '../nzbdav/index.js';

interface NzbdavDeps {
  config: Config;
  handleStream: (req: any, res: any, nzbdavConfig: NZBDavConfig, trackGrab: (indexer: string, title: string) => void) => Promise<void>;
  getCacheStats: () => any;
  clearStreamCache: () => void;
  isStreamCached: (nzbUrl: string, title: string) => boolean;
  trackGrab: (indexerName: string, title: string) => void;
  getLatestVersions: () => { chrome: string };
}

export function createNzbdavRoutes(deps: NzbdavDeps): Router {
  const router = Router();
  const { config, getCacheStats, clearStreamCache, getLatestVersions } = deps;

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
        headers: nzbdavHeaders
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
          headers: { ...webdavHeaders, 'Depth': '0' }
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
        console.log('\u{1F4E4} Request to test NZB submission:', { url: nzbApiUrl, method: 'POST', headers: { 'Content-Type': 'multipart/form-data', 'User-Agent': userAgent2 } });
        const testNzbResponse = await fetch(nzbApiUrl, {
          method: 'POST',
          body: formData,
          headers: { 'User-Agent': userAgent2 }
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

  return router;
}

/**
 * Creates the key-protected NZBDav stream proxy router.
 * Mounted at /:manifestKey/nzbdav in server.ts.
 */
export function createNzbdavStreamRoutes(deps: NzbdavDeps): Router {
  const router = Router({ mergeParams: true });
  const { config, handleStream, isStreamCached, trackGrab } = deps;

  // Dedup set for grab tracking — prevents concurrent requests from tracking the same grab
  // before the stream cache is populated. Entries are cleaned up after 60s.
  const trackedGrabKeys = new Set<string>();
  const GRAB_DEDUP_TTL_MS = 60_000;

  // NZBDav stream endpoint (key-protected)
  // Uses history API polling to detect job completion/failure
  router.get('/stream', async (req, res) => {
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

    // Build NZBDav config from global config
    const nzbdavConfig: NZBDavConfig = {
      url: config.nzbdavUrl || 'http://localhost:3000',
      apiKey: config.nzbdavApiKey || '',
      webdavUrl: config.nzbdavWebdavUrl || config.nzbdavUrl || 'http://localhost:3000',
      webdavUser: config.nzbdavWebdavUser || '',
      webdavPassword: config.nzbdavWebdavPassword || '',
      moviesCategory: config.nzbdavMoviesCategory || 'Usenet-Ultimate-Movies',
      tvCategory: config.nzbdavTvCategory || 'Usenet-Ultimate-TV',
    };

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
      await handleStream(req, res, nzbdavConfig, dedupedTrackGrab);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream handler failed' });
      }
    }
  });

  return router;
}

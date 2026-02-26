/**
 * Integration routes — Prowlarr, NZBHydra, Zyclops, EasyNews test/sync
 *
 * Prowlarr:  POST /api/prowlarr/test, POST /api/prowlarr/sync
 * NZBHydra:  POST /api/nzbhydra/test, POST /api/nzbhydra/sync
 * Zyclops:   POST /api/zyclops/test
 * EasyNews:  POST /api/easynews/test
 * Synced indexer management (shared by Prowlarr & NZBHydra):
 *   PUT  /api/synced-indexers/:id
 *   PUT  /api/synced-indexers
 *   POST /api/synced-indexers/reorder
 */

import { Router } from 'express';
import axios from 'axios';
import type { Config, SyncedIndexer } from '../types.js';
import { matchIndexerLogo } from '../utils/indexerHelpers.js';

interface IntegrationDeps {
  config: Config;
  updateSettings: (settings: Record<string, any>) => void;
  reorderSyncedIndexers: (syncedIndexers: SyncedIndexer[]) => void;
  getLatestVersions: () => { chrome: string };
}

export function createIntegrationRoutes(deps: IntegrationDeps): Router {
  const router = Router();
  const { config, updateSettings, reorderSyncedIndexers, getLatestVersions } = deps;

  // === Prowlarr Integration ===

  router.post('/prowlarr/test', async (req, res) => {
    try {
      const url = req.body.url ?? config.prowlarrUrl;
      const apiKey = req.body.apiKey ?? config.prowlarrApiKey;
      if (!url || !apiKey) return res.status(400).json({ success: false, message: 'Prowlarr URL and API key are required' });

      const response = await axios.get(`${url}/api/v1/indexer`, {
        headers: { 'X-Api-Key': apiKey },
        timeout: 10000,
      });
      const usenet = response.data.filter((i: any) => i.protocol === 'usenet');
      const enabled = usenet.filter((i: any) => i.enable);
      res.json({ success: true, message: `Connected! Found ${enabled.length} enabled usenet indexer(s) (${usenet.length} total)` });
    } catch (error: any) {
      const msg = error.response?.status === 401 ? 'Invalid API key' : error.message;
      res.status(500).json({ success: false, message: msg });
    }
  });

  router.post('/prowlarr/sync', async (req, res) => {
    try {
      const url = req.body?.url ?? config.prowlarrUrl;
      const apiKey = req.body?.apiKey ?? config.prowlarrApiKey;
      if (!url || !apiKey) return res.status(400).json({ error: 'Prowlarr not configured' });

      const response = await axios.get(`${url}/api/v1/indexer`, {
        headers: { 'X-Api-Key': apiKey },
        timeout: 10000,
      });

      // Filter to enabled usenet indexers only
      const usenetIndexers = response.data.filter((i: any) => i.protocol === 'usenet' && i.enable);

      // Merge with existing synced indexers (preserve user's per-indexer settings)
      const existing = new Map((config.syncedIndexers || []).map((i: SyncedIndexer) => [i.id, i]));
      const synced: SyncedIndexer[] = usenetIndexers.map((i: any) => {
        const prev = existing.get(i.id.toString());
        const baseUrl = i.fields?.find((f: any) => f.name === 'baseUrl')?.value;
        // Always re-match logo from presets on each sync
        const logo = matchIndexerLogo(i.name, baseUrl);

        // Extract capabilities from Prowlarr's response
        const caps = i.capabilities;
        const paramMap: Record<string, string> = {
          'Q': 'q', 'ImdbId': 'imdbid', 'TmdbId': 'tmdbid', 'TvdbId': 'tvdbid',
          'TvMazeId': 'tvmazeid', 'TraktId': 'traktid', 'DoubanId': 'doubanid',
          'Season': 'season', 'Ep': 'ep', 'ImdbTitle': 'imdbtitle', 'ImdbYear': 'imdbyear',
          'Genre': 'genre', 'Year': 'year', 'RId': 'rid',
        };
        const movieSearchParams = (caps?.movieSearchParams || []).map((p: string) => paramMap[p] || p.toLowerCase());
        const tvSearchParams = (caps?.tvSearchParams || []).map((p: string) => paramMap[p] || p.toLowerCase());
        const capabilities = { movieSearchParams, tvSearchParams };

        // Determine best available method for each search type
        const bestMovie = movieSearchParams.includes('imdbid') ? 'imdb'
          : movieSearchParams.includes('tmdbid') ? 'tmdb' : 'text';
        const bestTv = tvSearchParams.includes('imdbid') ? 'imdb'
          : tvSearchParams.includes('tvdbid') ? 'tvdb'
          : tvSearchParams.includes('tvmazeid') ? 'tvmaze' : 'text';

        // Validate existing methods are still supported, otherwise auto-correct
        const movieMethodMap: Record<string, string> = { imdb: 'imdbid', tmdb: 'tmdbid', tvdb: 'tvdbid' };
        const tvMethodMap: Record<string, string> = { imdb: 'imdbid', tvdb: 'tvdbid', tvmaze: 'tvmazeid' };
        type MovieMethod = 'imdb' | 'tmdb' | 'tvdb' | 'text';
        type TvMethod = 'imdb' | 'tvdb' | 'tvmaze' | 'text';
        const prevMovie = prev?.movieSearchMethod;
        const prevTv = prev?.tvSearchMethod;
        const prevMovieArr = Array.isArray(prevMovie) ? prevMovie : prevMovie ? [prevMovie] : null;
        const prevTvArr = Array.isArray(prevTv) ? prevTv : prevTv ? [prevTv] : null;
        const movieSearchMethod: MovieMethod[] = prevMovieArr
          ? prevMovieArr.filter(m => m === 'text' || movieSearchParams.includes(movieMethodMap[m] || ''))
          : [bestMovie as MovieMethod];
        const tvSearchMethod: TvMethod[] = prevTvArr
          ? prevTvArr.filter(m => m === 'text' || tvSearchParams.includes(tvMethodMap[m] || ''))
          : [bestTv as TvMethod];
        if (movieSearchMethod.length === 0) movieSearchMethod.push(bestMovie as MovieMethod);
        if (tvSearchMethod.length === 0) tvSearchMethod.push(bestTv as TvMethod);

        console.log(`\u{1F4CB} Prowlarr sync: "${i.name}" \u2192 logo: ${logo || '(none)'}, movie: [${movieSearchParams.join(',')}], tv: [${tvSearchParams.join(',')}]`);

        return {
          id: i.id.toString(),
          name: i.name,
          enabledForSearch: prev?.enabledForSearch ?? true,
          enabledForHealthCheck: prev?.enabledForHealthCheck ?? true,
          movieSearchMethod,
          tvSearchMethod,
          capabilities,
          logo,
        };
      });

      updateSettings({ syncedIndexers: synced });
      res.json({ indexers: synced, total: usenetIndexers.length });
    } catch (error: any) {
      const msg = error.response?.status === 401 ? 'Invalid API key' : error.message;
      res.status(500).json({ error: msg });
    }
  });

  // === NZBHydra Integration ===

  router.post('/nzbhydra/test', async (req, res) => {
    try {
      const url = req.body.url ?? config.nzbhydraUrl;
      const apiKey = req.body.apiKey ?? config.nzbhydraApiKey;
      const username = req.body.username ?? config.nzbhydraUsername ?? '';
      const password = req.body.password ?? config.nzbhydraPassword ?? '';
      if (!url || !apiKey) return res.status(400).json({ success: false, message: 'NZBHydra URL and API key are required' });

      // Build auth headers (Basic Auth for auth-protected instances)
      const authHeaders: Record<string, string> = {};
      if (username && password) {
        authHeaders['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      }

      // Test with a caps request (standard Newznab)
      const response = await axios.get(`${url}/api`, {
        params: { t: 'caps', apikey: apiKey },
        headers: authHeaders,
        timeout: 10000,
      });
      if (!response.data || (!response.data.includes('<caps') && !response.data.includes('<server'))) {
        return res.json({ success: false, message: 'Invalid API key' });
      }

      // Also verify internal API access (gated when auth is enabled)
      try {
        await axios.get(`${url}/internalapi/indexerstatuses`, {
          headers: authHeaders,
          timeout: 10000,
        });
        res.json({ success: true, message: 'Connected to NZBHydra2 successfully!' });
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          // Internal API requires auth — credentials missing or wrong
          if (username && password) {
            res.json({ success: false, message: 'API key valid but credentials rejected — check username/password' });
          } else {
            res.json({ success: false, message: 'API key valid but auth is enabled — add username and password' });
          }
        } else {
          // Internal API unavailable (old version, timeout, etc.) — caps passed, so connection is good
          res.json({ success: true, message: 'Connected to NZBHydra2 successfully!' });
        }
      }
    } catch (error: any) {
      const msg = error.response?.status === 401 ? 'Invalid API key or credentials' : error.message;
      res.status(500).json({ success: false, message: msg });
    }
  });

  router.post('/nzbhydra/sync', async (req, res) => {
    try {
      const url = req.body?.url ?? config.nzbhydraUrl;
      const apiKey = req.body?.apiKey ?? config.nzbhydraApiKey;
      const username = req.body?.username ?? config.nzbhydraUsername ?? '';
      const password = req.body?.password ?? config.nzbhydraPassword ?? '';
      if (!url || !apiKey) return res.status(400).json({ error: 'NZBHydra not configured' });

      // Build auth headers (Basic Auth for auth-protected instances)
      const authHeaders: Record<string, string> = {};
      if (username && password) {
        authHeaders['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      }

      // Validate credentials via Newznab caps (also used for capability parsing below)
      let capsData: string;
      try {
        const capsResp = await axios.get(`${url}/api`, {
          params: { t: 'caps', apikey: apiKey },
          headers: authHeaders,
          timeout: 10000,
        });
        capsData = capsResp.data;
        if (!capsData || (!capsData.includes('<caps') && !capsData.includes('<server'))) {
          return res.status(400).json({ error: 'Invalid API key' });
        }
      } catch (authErr: any) {
        const msg = authErr.response?.status === 401 ? 'Invalid API key or credentials' : authErr.message;
        return res.status(500).json({ error: msg });
      }

      // NZBHydra2 exposes indexer info via its internal API
      let indexerList: { name: string; enabled: boolean }[] = [];

      try {
        // Attempt the internal API (NZBHydra2 v5+)
        const statusResp = await axios.get(`${url}/internalapi/indexerstatuses`, {
          headers: authHeaders,
          timeout: 10000,
        });
        if (Array.isArray(statusResp.data)) {
          indexerList = statusResp.data
            .filter((s: any) => s.state !== 'DISABLED_SYSTEM')
            .map((s: any) => ({ name: s.indexerName || s.indexer, enabled: s.state !== 'DISABLED_USER' }));
        }
      } catch {
        // Fall back: caps already validated above, use it for indexer info
        indexerList = [{ name: 'NZBHydra (All)', enabled: true }];
      }

      if (indexerList.length === 0) {
        return res.status(404).json({ error: 'No indexers found in NZBHydra2' });
      }

      // Parse aggregate capabilities from the caps response we already fetched
      let aggregateCaps: { movieSearchParams: string[]; tvSearchParams: string[] } | undefined;
      try {
        const { parseStringPromise } = await import('xml2js');
        const parsed = await parseStringPromise(capsData);
        const searching = parsed?.caps?.searching?.[0];
        const extractParams = (el: any) => (el?.$?.supportedParams || '').split(',').filter(Boolean);
        aggregateCaps = {
          movieSearchParams: extractParams(searching?.['movie-search']?.[0]),
          tvSearchParams: extractParams(searching?.['tv-search']?.[0]),
        };
        console.log(`\u{1F4CB} NZBHydra caps: movie=[${aggregateCaps.movieSearchParams.join(',')}] tv=[${aggregateCaps.tvSearchParams.join(',')}]`);
      } catch (err: any) {
        console.warn(`\u26A0\uFE0F  Failed to parse NZBHydra caps: ${err.message}`);
      }

      // Merge with existing synced indexers
      const existing = new Map((config.syncedIndexers || []).map((i: SyncedIndexer) => [i.id, i]));
      const synced: SyncedIndexer[] = indexerList
        .filter(i => i.enabled)
        .map(i => {
          const prev = existing.get(i.name);

          // Use aggregate caps for all NZBHydra indexers (NZBHydra proxies to all)
          const capabilities = aggregateCaps || prev?.capabilities;

          // Determine best available method, validate existing selection
          const mp = capabilities?.movieSearchParams || [];
          const tp = capabilities?.tvSearchParams || [];
          const bestMovie = mp.includes('imdbid') ? 'imdb' : mp.includes('tmdbid') ? 'tmdb' : 'text';
          const bestTv = tp.includes('imdbid') ? 'imdb' : tp.includes('tvdbid') ? 'tvdb' : tp.includes('tvmazeid') ? 'tvmaze' : 'text';

          type MovieMethod = 'imdb' | 'tmdb' | 'tvdb' | 'text';
          type TvMethod = 'imdb' | 'tvdb' | 'tvmaze' | 'text';
          const movieMethodMap: Record<string, string> = { imdb: 'imdbid', tmdb: 'tmdbid', tvdb: 'tvdbid' };
          const tvMethodMap: Record<string, string> = { imdb: 'imdbid', tvdb: 'tvdbid', tvmaze: 'tvmazeid' };
          const prevMovie = prev?.movieSearchMethod;
          const prevTv = prev?.tvSearchMethod;
          const prevMovieArr = Array.isArray(prevMovie) ? prevMovie : prevMovie ? [prevMovie] : null;
          const prevTvArr = Array.isArray(prevTv) ? prevTv : prevTv ? [prevTv] : null;
          const movieSearchMethod: MovieMethod[] = prevMovieArr
            ? (capabilities ? prevMovieArr.filter(m => m === 'text' || mp.includes(movieMethodMap[m] || '')) : prevMovieArr)
            : [bestMovie as MovieMethod];
          const tvSearchMethod: TvMethod[] = prevTvArr
            ? (capabilities ? prevTvArr.filter(m => m === 'text' || tp.includes(tvMethodMap[m] || '')) : prevTvArr)
            : [bestTv as TvMethod];
          if (movieSearchMethod.length === 0) movieSearchMethod.push(bestMovie as MovieMethod);
          if (tvSearchMethod.length === 0) tvSearchMethod.push(bestTv as TvMethod);

          return {
            id: i.name,
            name: i.name,
            enabledForSearch: prev?.enabledForSearch ?? true,
            enabledForHealthCheck: prev?.enabledForHealthCheck ?? true,
            movieSearchMethod,
            tvSearchMethod,
            capabilities,
            logo: matchIndexerLogo(i.name),
          };
        });

      updateSettings({ syncedIndexers: synced });
      res.json({ indexers: synced, total: indexerList.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // === Zyclops Integration ===

  router.post('/zyclops/test', async (req, res) => {
    try {
      const endpoint = req.body.endpoint ?? config.zyclopsEndpoint ?? 'https://zyclops.elfhosted.com';
      const testUrl = `${endpoint.replace(/\/$/, '')}/api`;
      console.log(`\u{1F916} Testing Zyclops connection: ${testUrl}`);

      const response = await axios.get(testUrl, {
        params: { t: 'caps' },
        timeout: 10000,
        headers: { 'User-Agent': config.userAgents?.indexerSearch || getLatestVersions().chrome },
      });

      if (response.status === 200) {
        console.log(`\u{1F916} Zyclops test success: ${testUrl}`);
        res.json({ success: true, message: 'Connected to Zyclops successfully!' });
      } else {
        res.json({ success: false, message: `Unexpected status: ${response.status}` });
      }
    } catch (error: any) {
      const msg = error.response?.status
        ? `HTTP ${error.response.status}: ${(error.response.data?.substring?.(0, 100) || 'Unknown error')}`
        : error.message;
      console.error(`\u{1F916} Zyclops test failed: ${msg}`);
      res.status(500).json({ success: false, message: msg });
    }
  });

  // === EasyNews Integration ===

  router.post('/easynews/test', async (req, res) => {
    try {
      const username = req.body.username ?? config.easynewsUsername;
      const password = req.body.password ?? config.easynewsPassword;
      if (!username || !password) {
        return res.status(400).json({ success: false, message: 'EasyNews username and password are required' });
      }

      // Just verify credentials with an authenticated request — no search performed
      const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      const response = await axios.get('https://members.easynews.com/', {
        headers: {
          Authorization: authHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 15000,
        maxRedirects: 5,
      });

      // If we got here without a 401, credentials are valid
      res.json({ success: true, message: 'Authenticated successfully' });
    } catch (error: any) {
      if (error.response?.status === 401) {
        res.status(502).json({ success: false, message: 'Authentication failed \u2014 check your username and password' });
      } else {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  // === Synced Indexer Management (shared by Prowlarr & NZBHydra) ===

  router.put('/synced-indexers/:id', (req, res) => {
    try {
      const synced = [...(config.syncedIndexers || [])];
      const idx = synced.findIndex(i => i.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Synced indexer not found' });

      synced[idx] = { ...synced[idx], ...req.body, id: req.params.id }; // Preserve id
      updateSettings({ syncedIndexers: synced });
      res.json(synced[idx]);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/synced-indexers', (req, res) => {
    try {
      if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array of synced indexers' });
      updateSettings({ syncedIndexers: req.body });
      res.json(config.syncedIndexers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/synced-indexers/reorder', (req, res) => {
    try {
      const { syncedIndexers } = req.body;
      if (!Array.isArray(syncedIndexers)) return res.status(400).json({ error: 'Expected syncedIndexers array' });
      reorderSyncedIndexers(syncedIndexers);
      res.json({ success: true, syncedIndexers: config.syncedIndexers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

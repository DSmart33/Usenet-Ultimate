/**
 * Settings routes — /api/settings, /api/config, /api/user-agents/latest,
 *                   /api/proxy/status, /api/ip/local, /api/search-cache
 *
 * GET  /api/config              — Full config for the frontend
 * PUT  /api/settings            — Update settings
 * POST /api/settings            — Update settings (backwards compatibility)
 * GET  /api/user-agents/latest  — Fetch latest user-agent versions
 * GET  /api/proxy/status        — Test HTTP proxy connection
 * GET  /api/ip/local            — Get server's public IP (no proxy)
 * DELETE /api/search-cache      — Clear search results cache
 */

import { Router } from 'express';
import type { Config } from '../types.js';

interface SettingsDeps {
  config: Config;
  updateSettings: (settings: Record<string, any>) => void;
  configureSegmentCache: (cacheConfig: { enabled: boolean; ttlHours: number; maxSizeMB: number }) => void;
  fetchLatestVersions: (force: boolean) => Promise<void>;
  getLatestVersions: () => { chrome: string; prowlarr: string; sabnzbd: string };
  testProxyConnection: (proxyUrl?: string) => Promise<any>;
  clearSearchCache: () => void;
}

/** Build the full config response object (shared by GET /config, PUT /settings, POST /settings) */
function buildConfigResponse(config: Config) {
  return {
    addonEnabled: config.addonEnabled,
    indexers: config.indexers.map(i => ({
      name: i.name,
      url: i.url,
      enabled: i.enabled,
      apiKey: i.apiKey,
      website: i.website,
      logo: i.logo,
      movieSearchMethod: i.movieSearchMethod,
      tvSearchMethod: i.tvSearchMethod,
      caps: i.caps,
      pagination: i.pagination,
      maxPages: i.maxPages,
      zyclops: i.zyclops,
    })),
    cacheEnabled: config.cacheEnabled,
    cacheTTL: config.cacheTTL,
    streamingMode: config.streamingMode,
    indexManager: config.indexManager,
    prowlarrUrl: config.prowlarrUrl,
    prowlarrApiKey: config.prowlarrApiKey,
    nzbhydraUrl: config.nzbhydraUrl,
    nzbhydraApiKey: config.nzbhydraApiKey,
    nzbhydraUsername: config.nzbhydraUsername,
    nzbhydraPassword: config.nzbhydraPassword,
    nzbdavUrl: config.nzbdavUrl,
    nzbdavApiKey: config.nzbdavApiKey,
    nzbdavWebdavUrl: config.nzbdavWebdavUrl,
    nzbdavWebdavUser: config.nzbdavWebdavUser,
    nzbdavWebdavPassword: config.nzbdavWebdavPassword,
    nzbdavMoviesCategory: config.nzbdavMoviesCategory,
    nzbdavTvCategory: config.nzbdavTvCategory,
    nzbdavFallbackEnabled: config.nzbdavFallbackEnabled,
    nzbdavMaxFallbacks: config.nzbdavMaxFallbacks,
    nzbdavJobTimeoutSeconds: config.nzbdavJobTimeoutSeconds,
    nzbdavMoviesTimeoutSeconds: config.nzbdavMoviesTimeoutSeconds,
    nzbdavTvTimeoutSeconds: config.nzbdavTvTimeoutSeconds,
    nzbdavFallbackOrder: config.nzbdavFallbackOrder,
    easynewsEnabled: config.easynewsEnabled,
    easynewsUsername: config.easynewsUsername,
    easynewsPassword: config.easynewsPassword,
    easynewsPagination: config.easynewsPagination,
    easynewsMaxPages: config.easynewsMaxPages,
    easynewsMode: config.easynewsMode,
    easynewsHealthCheck: config.easynewsHealthCheck,
    proxyMode: config.proxyMode,
    proxyUrl: config.proxyUrl,
    proxyIndexers: config.proxyIndexers,
    searchConfig: config.searchConfig,
    useTextSearch: config.useTextSearch,
    includeSeasonPacks: config.includeSeasonPacks,
    cardOrder: config.cardOrder,
    userAgents: config.userAgents,
    filters: config.filters,
    movieFilters: config.movieFilters,
    tvFilters: config.tvFilters,
    healthChecks: config.healthChecks,
    autoPlay: config.autoPlay,
    streamDisplayConfig: config.streamDisplayConfig,
    syncedIndexers: config.syncedIndexers,
    indexerPriority: config.indexerPriority,
    zyclopsEndpoint: config.zyclopsEndpoint,
  };
}

export function createSettingsRoutes(deps: SettingsDeps): Router {
  const router = Router();
  const { config, updateSettings, configureSegmentCache, fetchLatestVersions, getLatestVersions, testProxyConnection, clearSearchCache } = deps;

  // Configuration API endpoint for frontend
  router.get('/config', (req, res) => {
    res.json(buildConfigResponse(config));
  });

  // Shared handler for PUT and POST /settings
  function handleSettingsUpdate(req: any, res: any) {
    try {
      updateSettings(req.body);
      // Reconfigure segment cache if health check settings changed
      if (config.healthChecks?.segmentCache) {
        configureSegmentCache(config.healthChecks.segmentCache);
      }
      res.json(buildConfigResponse(config));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  router.put('/settings', handleSettingsUpdate);
  // Keep POST for backwards compatibility
  router.post('/settings', handleSettingsUpdate);

  // Get latest user-agent versions
  router.get('/user-agents/latest', async (req, res) => {
    try {
      await fetchLatestVersions(true); // Force refresh
      const versions = getLatestVersions();
      res.json({
        indexerSearch: versions.prowlarr,
        nzbDownload: versions.sabnzbd,
        nzbdavOperations: versions.sabnzbd,
        webdavOperations: versions.sabnzbd,
        general: versions.chrome
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // HTTP proxy status endpoint
  router.get('/proxy/status', async (req, res) => {
    try {
      const proxyUrl = req.query.url as string | undefined;
      const result = await testProxyConnection(proxyUrl);
      res.json(result);
    } catch (error) {
      res.json({ connected: false, error: (error as Error).message });
    }
  });

  // Local (direct) IP endpoint — fetches public IP without any proxy
  router.get('/ip/local', async (req, res) => {
    try {
      const response = await fetch('https://api.ipify.org?format=json');
      const data = await response.json() as { ip: string };
      res.json({ ip: data.ip });
    } catch (error) {
      res.json({ ip: null, error: (error as Error).message });
    }
  });

  // Clear search results cache endpoint
  router.delete('/search-cache', (req, res) => {
    clearSearchCache();
    res.json({ success: true });
  });

  return router;
}

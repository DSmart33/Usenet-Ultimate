/**
 * HTTP Server
 *
 * Express app serving the React UI, Stremio addon manifest, and all API routes.
 * Default port: 1337 (override with PORT env var).
 */


import './logBuffer.js';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import addonSDK from 'stremio-addon-sdk';
import addon, { clearSearchCache, addonManifest } from './addon/index.js';
import { config, getIndexers, addIndexer, updateIndexer, deleteIndexer, reorderIndexers, reorderSyncedIndexers, updateSettings, getProviders, addProvider, updateProvider, deleteProvider, reorderProviders } from './config/index.js';
import { getLogBuffer, subscribeToLogs } from './logBuffer.js';
import { getAllStats, getIndexerStats, resetIndexerStats, resetAllStats, trackGrab } from './statsTracker.js';
import { fetchLatestVersions, getLatestVersions } from './versionFetcher.js';
import { handleStream, getCacheStats, clearStreamCache, clearReadyCache, clearFailedCache, deleteCacheEntry, getCacheEntries, isStreamCached, saveCacheToDisk } from './nzbdav/index.js';
import { proxyFetch, testProxyConnection } from './proxy.js';
import { fetchIndexerCaps } from './parsers/newznabClient.js';
import { hasAnyUsers, createUser, authenticateUser, generateToken, verifyToken, getUserById, getManifests, createManifest, updateManifest, regenerateManifest, deleteManifest } from './auth/auth.js';
import { createManifestRoutes } from './routes/manifests.js';
import { requireAuth, validateManifestKey } from './auth/authMiddleware.js';
import { requestContext } from './requestContext.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../package.json');

// Route modules
import { createAuthRoutes } from './routes/auth.js';
import { createIndexerRoutes } from './routes/indexers.js';
import { createIntegrationRoutes } from './routes/integrations.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createNzbdavRoutes, createNzbdavStreamRoutes } from './routes/nzbdav.js';
import { createEasynewsProxyRoutes } from './routes/easynewsProxy.js';
import { createHealthCheckRoutes } from './routes/healthCheck.js';
import { createExternalApiRoutes } from './routes/externalApis.js';
import { createStatsRoutes } from './routes/stats.js';
import { createLogRoutes } from './routes/logs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { getRouter } = addonSDK;
const PORT = process.env.PORT || 1337;

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files — hashed assets get long cache, non-hashed files (sw.js, index.html) get no-cache
const staticMiddleware = express.static('ui/dist', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('registerSW.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
});
app.use(staticMiddleware);
app.use('/stremio', staticMiddleware);

// Health check (public — used by Docker HEALTHCHECK)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    indexers: config.indexers.length,
    syncedIndexers: (config.syncedIndexers || []).length,
    easynewsEnabled: config.easynewsEnabled ?? false,
    version: APP_VERSION,
  });
});

// --- Auth endpoints (public, no auth required) ---
// Mounted at /api so routes are /api/auth/status, /api/auth/setup, /api/auth/login, /api/favicon
app.use('/api', createAuthRoutes({
  config,
  hasAnyUsers,
  createUser,
  authenticateUser,
  generateToken,
  verifyToken,
  getUserById,
  getLatestVersions,
}));

// --- Auth middleware for all remaining /api/* routes ---
app.use('/api', requireAuth);

// --- Manifest management (protected) ---
app.use('/api/manifests', createManifestRoutes({
  getManifests,
  createManifest,
  updateManifest,
  regenerateManifest,
  deleteManifest,
}));

// --- Protected API routes ---

// Shared NZBDav deps (used by both API routes and key-protected stream proxy)
const nzbdavDeps = {
  config,
  handleStream,
  getCacheStats,
  clearStreamCache,
  clearReadyCache,
  clearFailedCache,
  deleteCacheEntry,
  getCacheEntries,
  isStreamCached,
  trackGrab,
  getLatestVersions,
};

app.use('/api/indexers', createIndexerRoutes({
  config,
  getIndexers,
  addIndexer,
  updateIndexer,
  deleteIndexer,
  reorderIndexers,
  fetchIndexerCaps,
  proxyFetch,
  getLatestVersions,
}));

app.use('/api', createIntegrationRoutes({
  config,
  updateSettings,
  reorderSyncedIndexers,
  getLatestVersions,
}));

app.use('/api', createSettingsRoutes({
  config,
  updateSettings,
  fetchLatestVersions,
  getLatestVersions,
  testProxyConnection,
  clearSearchCache,
}));

app.use('/api/nzbdav', createNzbdavRoutes(nzbdavDeps));

app.use('/api/health-check', createHealthCheckRoutes({
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
}));

app.use('/api/search-config', createExternalApiRoutes());

app.use('/api/stats', createStatsRoutes({
  getAllStats,
  getIndexerStats,
  resetIndexerStats,
  resetAllStats,
}));

app.use('/api/logs', createLogRoutes({
  getLogBuffer,
  subscribeToLogs,
}));

// --- Key-protected proxy routes (no JWT auth, validated by manifest key) ---
// Mounted at both /:manifestKey/ (legacy) and /stremio/:manifestKey/ (recommended for reverse proxy setups)

const easynewsRoutes = createEasynewsProxyRoutes({ config, getLatestVersions });
const nzbdavRoutes = createNzbdavStreamRoutes(nzbdavDeps);
const stremioRouter = express.Router({ mergeParams: false });
// Serve manifest with absolute logo URL (Stremio doesn't resolve relative paths correctly)
stremioRouter.get('/manifest.json', (req, res) => {
  const baseUrl = requestContext.getStore()?.baseUrl || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ...addonManifest, logo: `${baseUrl}/pwa-512x512.png` }));
});
stremioRouter.use(getRouter(addon));

const contextMiddleware = (pathPrefix: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  requestContext.run({ manifestKey: req.params.manifestKey, baseUrl: process.env.BASE_URL || `${req.protocol}://${req.get('host')}`, pathPrefix }, () => next());
};

// /stremio/ prefixed routes (recommended for new installations and reverse proxy setups)
// Must be mounted BEFORE root-level routes so /stremio/:manifestKey matches before /:manifestKey captures "stremio"
app.use('/stremio/:manifestKey/easynews', validateManifestKey, easynewsRoutes);
app.use('/stremio/:manifestKey/nzbdav', validateManifestKey, nzbdavRoutes);
app.use('/stremio/:manifestKey', validateManifestKey, contextMiddleware('/stremio'), stremioRouter);

// Root-level routes (legacy, still works for existing installations)
app.use('/:manifestKey/easynews', validateManifestKey, easynewsRoutes);
app.use('/:manifestKey/nzbdav', validateManifestKey, nzbdavRoutes);
app.use('/:manifestKey', validateManifestKey, contextMiddleware(''), stremioRouter);

// SPA fallback — serve index.html for all non-API, non-asset routes
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'ui', 'dist', 'index.html'));
});

// Start server
// Clean up orphaned segment cache file from previous versions
import fs from 'fs';
try { fs.unlinkSync(path.join(__dirname, '..', 'config', 'segment-cache.json')); } catch {}

// Graceful shutdown — persist caches before exit
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received, saving caches...');
  saveCacheToDisk();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[shutdown] SIGINT received, saving caches...');
  saveCacheToDisk();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n\u{1F680} Usenet Ultimate is running!\n`);
  console.log(`\u{1F3A8} Configuration UI: http://localhost:${PORT}`);
  console.log(`\u{1F4CB} Configured indexers: ${config.indexers.length} Newznab, ${(config.syncedIndexers || []).length} synced${config.easynewsEnabled ? ', EasyNews enabled' : ''}`);
  console.log(`\u{1F512} Auth: ${hasAnyUsers() ? 'Configured' : 'Setup required (first run)'}\n`);

  const totalSources = config.indexers.length + (config.syncedIndexers || []).length + (config.easynewsEnabled ? 1 : 0);
  if (totalSources === 0) {
    console.warn('\u26A0\uFE0F  No indexers configured! Please add indexers via the UI or configure Prowlarr/NZBHydra/EasyNews\n');
  }
});

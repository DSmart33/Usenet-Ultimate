/**
 * Configuration Schema & File I/O
 *
 * Defines the ConfigData interface, manages loading/saving the config JSON,
 * and exports the shared configData state used by all other config modules.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { UsenetIndexer, UsenetProvider, SearchConfig, AutoPlayConfig, SyncedIndexer, StreamDisplayConfig, FilterConfig } from '../types.js';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'config.json');
export const ZYCLOPS_DEFAULT_ENDPOINT = process.env.ZYCLOPS_ENDPOINT || 'https://zyclops.elfhosted.com';

export interface ConfigData {
  addonEnabled?: boolean;
  indexers: UsenetIndexer[];
  cacheEnabled: boolean;
  cacheTTL: number;
  streamingMode: 'nzbdav' | 'stremio';
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  prowlarrUrl?: string;
  prowlarrApiKey?: string;
  prowlarrTimeoutEnabled?: boolean;
  prowlarrTimeout?: number;
  nzbhydraUrl?: string;
  nzbhydraApiKey?: string;
  nzbhydraUsername?: string;
  nzbhydraPassword?: string;
  nzbhydraTimeoutEnabled?: boolean;
  nzbhydraTimeout?: number;
  nzbdavUrl?: string;
  nzbdavApiKey?: string;
  nzbdavWebdavUrl?: string;
  nzbdavWebdavUser?: string;
  nzbdavWebdavPassword?: string;
  nzbdavMoviesCategory?: string;
  nzbdavTvCategory?: string;
  nzbdavCacheTimeouts?: boolean;
  nzbdavStreamBufferMB?: number;
  nzbdavPipeBufferMB?: number;
  nzbdavProxyEnabled?: boolean;
  nzbdavStreamingMethod?: 'pipe' | 'proxy' | 'direct';
  healthyNzbDbMode?: 'time' | 'storage';
  healthyNzbDbTTL?: number;
  healthyNzbDbMaxSizeMB?: number;
  filterDeadNzbs?: boolean;
  deadNzbDbMode?: 'time' | 'storage';
  deadNzbDbTTL?: number;
  deadNzbDbMaxSizeMB?: number;
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;
  easynewsMaxPages?: number;
  easynewsTimeoutEnabled?: boolean;
  easynewsTimeout?: number;
  easynewsMode?: 'ddl' | 'nzb';
  easynewsHealthCheck?: boolean;
  indexerPriority?: string[];
  zyclopsEndpoint?: string;
  proxyMode?: 'disabled' | 'http';
  proxyUrl?: string;
  proxyIndexers?: Record<string, boolean>;
  searchConfig?: SearchConfig;
  useTextSearch?: boolean;
  includeSeasonPacks?: boolean;
  cardOrder?: string[];
  userAgents?: {
    indexerSearch?: string;
    nzbDownload?: string;
    nzbdavOperations?: string;
    webdavOperations?: string;
    general?: string;
  };
  syncedIndexers?: SyncedIndexer[];
  autoPlay?: AutoPlayConfig;
  streamDisplayConfig?: StreamDisplayConfig;
  filters?: FilterConfig;
  movieFilters?: FilterConfig;
  tvFilters?: FilterConfig;
  healthChecks?: {
    enabled: boolean;
    mode?: 'full' | 'quick';           // Legacy — migrated to archiveInspection + sampleCount
    archiveInspection?: boolean;
    sampleCount?: 3 | 7;
    providers: UsenetProvider[];
    nzbsToInspect: number;
    inspectionMethod?: 'fixed' | 'smart';
    smartBatchSize?: number;
    smartAdditionalRuns?: number;
    smartMinHealthy?: number;
    autoQueueMode: 'off' | 'top' | 'all';
    hideBlocked: boolean;
    libraryPreCheck?: boolean;
    healthCheckIndexers?: Record<string, boolean>;
    // Legacy single-provider fields (auto-migrated to providers array)
    usenetHost?: string;
    usenetPort?: number;
    useTLS?: boolean;
    usenetUsername?: string;
    usenetPassword?: string;
    maxConnections?: number;
  };
  ultimateFallback?: {
    enabled: boolean;
    healthCheckEnabled?: boolean;
    whenToResolve?: 'on-results' | 'on-tile-selection';
    userPickFallback?: 'uf-lobby' | 'failure-video' | 'fallback-chain';
    candidateCount?: number;
    preferenceMode?: 'priority' | 'speed';
    archiveInspection?: boolean;
    sampleCount?: 3 | 7;
    maxAttempts?: number;
    desiredBackups?: number;
    backupProcessingLimit?: number;
    priorityMoviesTimeoutSeconds?: number;
    priorityTvTimeoutSeconds?: number;
    prioritySeasonPackTimeoutSeconds?: number;
    speedMoviesTimeoutSeconds?: number;
    speedTvTimeoutSeconds?: number;
    speedSeasonPackTimeoutSeconds?: number;
    healthCheckIndexers?: Record<string, boolean>;
  };

  // One-time cleanup of stale release folders left over from the legacy
  // file-scope delete (which left release dirs behind when only extras
  // remained). Runs once on update when this flag is below the migration's
  // target, then bumps the flag so it never runs again.
  staleLibraryFolderCleanupVersion?: number;

  // One-time stats hygiene migration: purges the synthetic "WebDAV Library"
  // row and merges case-variant indexer rows. Bumps once on update; never
  // runs again.
  staleIndexerStatsCleanupVersion?: number;
}

// Load config from file or create default
function loadConfigFile(): ConfigData {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading config file:', error);
  }

  // Default config
  return {
    indexers: [],
    cacheEnabled: true,
    cacheTTL: 9000,
    streamingMode: 'nzbdav',
    indexManager: 'newznab',
  };
}

// Save config to file (atomic: write to .tmp, then rename)
export function saveConfigFile(data: ConfigData): void {
  const tmpFile = CONFIG_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    console.error('Error saving config file:', error);
    throw new Error('Failed to save configuration');
  }
}

/**
 * The shared mutable config state.
 * All modules import this and read/write it directly.
 */
export let configData: ConfigData = loadConfigFile();

// Initialize config (write default to disk if no config file exists yet)
if (!fs.existsSync(CONFIG_FILE)) {
  const configDir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  try {
    saveConfigFile(configData);
    console.log('✅ Created default config.json');
  } catch {
    console.warn('⚠️ Could not write default config.json (will use in-memory defaults until first save)');
  }
}

// Log active environment variable overrides at startup
const ENV_OVERRIDES: readonly string[] = [
  'STREAMING_MODE', 'INDEX_MANAGER',
  'NZBDAV_URL', 'NZBDAV_API_KEY', 'NZBDAV_WEBDAV_URL', 'NZBDAV_WEBDAV_USER', 'NZBDAV_WEBDAV_PASS',
  'NZBDAV_PROXY_ENABLED', 'NZBDAV_STREAMING_METHOD',
  'NZBDAV_STREAM_BUFFER_MB', 'STREAM_BUFFER_MB', 'NZBDAV_PIPE_BUFFER_MB', 'NZBDAV_STREAM_MAX_RECONNECTS', 'STREAM_MAX_RECONNECTS', 'NZBDAV_MAX_SELF_REDIRECTS',
  'NZBDAV_JOB_TIMEOUT', 'NZBDAV_MOVIES_TIMEOUT', 'NZBDAV_TV_TIMEOUT', 'NZBDAV_SEASON_PACK_TIMEOUT',
  'SEARCH_TIMEOUT',
  'PROWLARR_URL', 'PROWLARR_API_KEY',
  'NZBHYDRA_URL', 'NZBHYDRA_API_KEY', 'NZBHYDRA_USERNAME', 'NZBHYDRA_PASSWORD',
  'EASYNEWS_ENABLED', 'EASYNEWS_USERNAME', 'EASYNEWS_PASSWORD',
  'PROXY_MODE', 'PROXY_URL',
  'INCLUDE_TIMEOUTS_AS_DEAD_NZBS', 'FILTER_DEAD_NZBS',
  'ENABLE_REMAKE_DETECTION', 'ALLOW_MULTI_EPISODE_FILES', 'URL_DEDUP', 'DISPLAY_LIBRARY_IN_RESULTS', 'ABSOLUTE_EPISODE_FALLBACK', 'PARALLEL_ALTERNATE_TITLE_SEARCH', 'LIBRARY_SEARCH_THRESHOLD',
  'HEALTH_CHECK_ENABLED', 'HEALTH_CHECK_NNTP_HOST', 'HEALTH_CHECK_NNTP_PORT',
  'HEALTH_CHECK_NNTP_TLS', 'HEALTH_CHECK_NNTP_USER', 'HEALTH_CHECK_NNTP_PASS',
  'ZYCLOPS_ENDPOINT',
  'ULTIMATE_FALLBACK_ENABLED', 'ULTIMATE_FALLBACK_CANDIDATE_COUNT', 'ULTIMATE_FALLBACK_PREFERENCE_MODE',
  'ULTIMATE_FALLBACK_SAMPLE_COUNT', 'ULTIMATE_FALLBACK_HEALTH_CHECK_ENABLED',
  'ULTIMATE_FALLBACK_WHEN_TO_RESOLVE', 'ULTIMATE_FALLBACK_USER_PICK_FALLBACK',
  'ULTIMATE_FALLBACK_MAX_ATTEMPTS', 'ULTIMATE_FALLBACK_DESIRED_BACKUPS', 'ULTIMATE_FALLBACK_BACKUP_PROCESSING_LIMIT',
  'ULTIMATE_FALLBACK_PRIORITY_MOVIES_TIMEOUT', 'ULTIMATE_FALLBACK_PRIORITY_TV_TIMEOUT', 'ULTIMATE_FALLBACK_PRIORITY_SEASON_PACK_TIMEOUT',
  'ULTIMATE_FALLBACK_SPEED_MOVIES_TIMEOUT', 'ULTIMATE_FALLBACK_SPEED_TV_TIMEOUT', 'ULTIMATE_FALLBACK_SPEED_SEASON_PACK_TIMEOUT',
] as const;
const active = ENV_OVERRIDES.filter(name => process.env[name] !== undefined && process.env[name] !== '');
if (active.length > 0) {
  console.log(`⚙️  Env var overrides active: ${active.join(', ')}`);
}

// Timeout summary — logs the effective per-searcher defaults so operators can trace any later timeout event back to a known baseline.
{
  const prowEnabled = configData.prowlarrTimeoutEnabled ?? true;
  const prowSec = configData.prowlarrTimeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS;
  const hydraEnabled = configData.nzbhydraTimeoutEnabled ?? true;
  const hydraSec = configData.nzbhydraTimeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS;
  const enEnabled = configData.easynewsTimeoutEnabled ?? true;
  const enSec = configData.easynewsTimeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS;
  const fmt = (on: boolean, s: number) => on ? `${s}s` : 'disabled';
  console.log(`⏱️  Search timeouts — Prowlarr: ${fmt(prowEnabled, prowSec)}, NZBHydra: ${fmt(hydraEnabled, hydraSec)}, EasyNews: ${fmt(enEnabled, enSec)} (Newznab: per-indexer, default ${DEFAULT_INDEXER_TIMEOUT_SECONDS}s, max 45s)`);
  const searchTimeoutRaw = process.env.SEARCH_TIMEOUT;
  if (searchTimeoutRaw && Number.isFinite(parseInt(searchTimeoutRaw, 10))) {
    const clamped = Math.max(1, Math.min(45, parseInt(searchTimeoutRaw, 10)));
    console.log(`⏱️  SEARCH_TIMEOUT=${clamped}s override active — forcing all indexer timeouts`);
  }
}

/**
 * Configuration Schema & File I/O
 *
 * Defines the ConfigData interface, manages loading/saving the config JSON,
 * and exports the shared configData state used by all other config modules.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { UsenetIndexer, UsenetProvider, SearchConfig, AutoPlayConfig, SyncedIndexer, StreamDisplayConfig } from '../types.js';

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
  nzbhydraUrl?: string;
  nzbhydraApiKey?: string;
  nzbhydraUsername?: string;
  nzbhydraPassword?: string;
  nzbdavUrl?: string;
  nzbdavApiKey?: string;
  nzbdavWebdavUrl?: string;
  nzbdavWebdavUser?: string;
  nzbdavWebdavPassword?: string;
  nzbdavMoviesCategory?: string;
  nzbdavTvCategory?: string;
  nzbdavFallbackEnabled?: boolean;
  nzbdavMaxFallbacks?: number;
  nzbdavJobTimeoutSeconds?: number;
  nzbdavMoviesTimeoutSeconds?: number;
  nzbdavTvTimeoutSeconds?: number;
  nzbdavFallbackOrder?: 'selected' | 'top';
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;
  easynewsMaxPages?: number;
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
  filters?: {
    sortOrder: string[];
    maxFileSize?: number;
    maxStreamsPerQuality?: number;
    videoPriority?: string[];
    encodePriority?: string[];
  };
  movieFilters?: any;
  tvFilters?: any;
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
    autoQueueMode: 'off' | 'top' | 'all';
    hideBlocked: boolean;
    libraryPreCheck?: boolean;
    healthCheckIndexers?: Record<string, boolean>;
    segmentCache?: { enabled: boolean; ttlHours: number; maxSizeMB: number };
    // Legacy single-provider fields (auto-migrated to providers array)
    usenetHost?: string;
    usenetPort?: number;
    useTLS?: boolean;
    usenetUsername?: string;
    usenetPassword?: string;
    maxConnections?: number;
  };
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
    cacheTTL: 43200,
    streamingMode: 'nzbdav',
    indexManager: 'newznab',
  };
}

// Save config to file
export function saveConfigFile(data: ConfigData): void {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
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
  'NZBDAV_FALLBACK_ENABLED', 'NZBDAV_MAX_FALLBACKS', 'NZBDAV_FALLBACK_ORDER',
  'NZBDAV_JOB_TIMEOUT', 'NZBDAV_MOVIES_TIMEOUT', 'NZBDAV_TV_TIMEOUT',
  'PROWLARR_URL', 'PROWLARR_API_KEY',
  'NZBHYDRA_URL', 'NZBHYDRA_API_KEY', 'NZBHYDRA_USERNAME', 'NZBHYDRA_PASSWORD',
  'EASYNEWS_ENABLED', 'EASYNEWS_USERNAME', 'EASYNEWS_PASSWORD',
  'PROXY_MODE', 'PROXY_URL',
  'HEALTH_CHECK_ENABLED', 'HEALTH_CHECK_NNTP_HOST', 'HEALTH_CHECK_NNTP_PORT',
  'HEALTH_CHECK_NNTP_TLS', 'HEALTH_CHECK_NNTP_USER', 'HEALTH_CHECK_NNTP_PASS',
  'ZYCLOPS_ENDPOINT',
] as const;
const active = ENV_OVERRIDES.filter(name => process.env[name] !== undefined && process.env[name] !== '');
if (active.length > 0) {
  console.log(`⚙️  Env var overrides active: ${active.join(', ')}`);
}

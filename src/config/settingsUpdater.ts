/**
 * Settings Updater
 *
 * Handles the updateSettings function that applies bulk setting changes
 * from the UI settings panel.
 */

import type { UsenetProvider, SearchConfig, AutoPlayConfig, SyncedIndexer, StreamDisplayConfig } from '../types.js';
import { configData, saveConfigFile } from './schema.js';

export function updateSettings(settings: {
  addonEnabled?: boolean;
  cacheEnabled?: boolean;
  cacheTTL?: number;
  streamingMode?: 'nzbdav' | 'stremio';
  indexManager?: 'newznab' | 'prowlarr' | 'nzbhydra';
  prowlarrUrl?: string;
  prowlarrApiKey?: string;
  nzbhydraUrl?: string;
  nzbhydraApiKey?: string;
  nzbhydraUsername?: string;
  nzbhydraPassword?: string;
  zyclopsEndpoint?: string;
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
  filters?: any;
  movieFilters?: any;
  tvFilters?: any;
  syncedIndexers?: SyncedIndexer[];
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;
  easynewsMaxPages?: number;
  easynewsMode?: 'ddl' | 'nzb';
  easynewsHealthCheck?: boolean;
  indexerPriority?: string[];
  autoPlay?: AutoPlayConfig;
  streamDisplayConfig?: StreamDisplayConfig;
  healthChecks?: {
    enabled: boolean;
    mode?: 'full' | 'quick';
    archiveInspection?: boolean;
    sampleCount?: 3 | 7;
    providers?: UsenetProvider[];
    nzbsToInspect: number;
    inspectionMethod?: 'fixed' | 'smart';
    smartBatchSize?: number;
    smartAdditionalRuns?: number;
    maxConnections?: number;
    autoQueueMode?: 'off' | 'top' | 'all';
    hideBlocked: boolean;
    healthCheckIndexers?: Record<string, boolean>;
    segmentCache?: { enabled: boolean; ttlHours: number; maxSizeMB: number };
  };
}): void {
  if (settings.addonEnabled !== undefined) {
    configData.addonEnabled = settings.addonEnabled;
  }
  if (settings.cacheEnabled !== undefined) {
    configData.cacheEnabled = settings.cacheEnabled;
  }
  if (settings.cacheTTL !== undefined) {
    configData.cacheTTL = settings.cacheTTL;
  }
  if (settings.streamingMode !== undefined) {
    configData.streamingMode = settings.streamingMode;
  }
  if (settings.indexManager !== undefined) {
    configData.indexManager = settings.indexManager;
  }
  if (settings.prowlarrUrl !== undefined) {
    configData.prowlarrUrl = settings.prowlarrUrl;
  }
  if (settings.prowlarrApiKey !== undefined) {
    configData.prowlarrApiKey = settings.prowlarrApiKey;
  }
  if (settings.nzbhydraUrl !== undefined) {
    configData.nzbhydraUrl = settings.nzbhydraUrl;
  }
  if (settings.nzbhydraApiKey !== undefined) {
    configData.nzbhydraApiKey = settings.nzbhydraApiKey;
  }
  if (settings.nzbhydraUsername !== undefined) {
    configData.nzbhydraUsername = settings.nzbhydraUsername;
  }
  if (settings.nzbhydraPassword !== undefined) {
    configData.nzbhydraPassword = settings.nzbhydraPassword;
  }
  if (settings.zyclopsEndpoint !== undefined) {
    configData.zyclopsEndpoint = settings.zyclopsEndpoint;
  }
  if (settings.nzbdavUrl !== undefined) {
    configData.nzbdavUrl = settings.nzbdavUrl;
  }
  if (settings.nzbdavApiKey !== undefined) {
    configData.nzbdavApiKey = settings.nzbdavApiKey;
  }
  if (settings.nzbdavWebdavUrl !== undefined) {
    configData.nzbdavWebdavUrl = settings.nzbdavWebdavUrl;
  }
  if (settings.nzbdavWebdavUser !== undefined) {
    configData.nzbdavWebdavUser = settings.nzbdavWebdavUser;
  }
  if (settings.nzbdavWebdavPassword !== undefined) {
    configData.nzbdavWebdavPassword = settings.nzbdavWebdavPassword;
  }
  if (settings.nzbdavMoviesCategory !== undefined) {
    configData.nzbdavMoviesCategory = settings.nzbdavMoviesCategory;
  }
  if (settings.nzbdavTvCategory !== undefined) {
    configData.nzbdavTvCategory = settings.nzbdavTvCategory;
  }
  if (settings.nzbdavFallbackEnabled !== undefined) {
    configData.nzbdavFallbackEnabled = settings.nzbdavFallbackEnabled;
  }
  if (settings.nzbdavMaxFallbacks !== undefined) {
    configData.nzbdavMaxFallbacks = settings.nzbdavMaxFallbacks;
  }
  if (settings.nzbdavJobTimeoutSeconds !== undefined) {
    configData.nzbdavJobTimeoutSeconds = settings.nzbdavJobTimeoutSeconds;
  }
  if (settings.nzbdavMoviesTimeoutSeconds !== undefined) {
    configData.nzbdavMoviesTimeoutSeconds = settings.nzbdavMoviesTimeoutSeconds;
  }
  if (settings.nzbdavTvTimeoutSeconds !== undefined) {
    configData.nzbdavTvTimeoutSeconds = settings.nzbdavTvTimeoutSeconds;
  }
  if (settings.nzbdavFallbackOrder !== undefined) {
    configData.nzbdavFallbackOrder = settings.nzbdavFallbackOrder;
  }
  if (settings.proxyMode !== undefined) {
    configData.proxyMode = settings.proxyMode;
    // Clear cached proxy agents when switching modes
    if (settings.proxyMode === 'disabled') {
      import('../proxy.js').then(m => m.clearProxyCache()).catch(() => {});
    }
  }
  if (settings.proxyUrl !== undefined) {
    configData.proxyUrl = settings.proxyUrl;
  }
  if (settings.proxyIndexers !== undefined) {
    configData.proxyIndexers = settings.proxyIndexers;
  }
  if (settings.searchConfig !== undefined) {
    configData.searchConfig = settings.searchConfig;
    configData.includeSeasonPacks = settings.searchConfig.includeSeasonPacks;
  }
  if (settings.useTextSearch !== undefined) {
    configData.useTextSearch = settings.useTextSearch;
  }
  if (settings.includeSeasonPacks !== undefined) {
    configData.includeSeasonPacks = settings.includeSeasonPacks;
  }
  if (settings.cardOrder !== undefined) {
    configData.cardOrder = settings.cardOrder;
  }
  if (settings.userAgents !== undefined) {
    configData.userAgents = settings.userAgents;
  }
  if (settings.filters !== undefined) {
    configData.filters = settings.filters;
  }
  if (settings.movieFilters !== undefined) {
    configData.movieFilters = settings.movieFilters;
  }
  if (settings.tvFilters !== undefined) {
    configData.tvFilters = settings.tvFilters;
  }
  if (settings.autoPlay !== undefined) {
    configData.autoPlay = settings.autoPlay;
  }
  if (settings.syncedIndexers !== undefined) {
    configData.syncedIndexers = settings.syncedIndexers;
  }
  if (settings.easynewsEnabled !== undefined) {
    configData.easynewsEnabled = settings.easynewsEnabled;
  }
  if (settings.easynewsUsername !== undefined) {
    configData.easynewsUsername = settings.easynewsUsername;
  }
  if (settings.easynewsPassword !== undefined) {
    configData.easynewsPassword = settings.easynewsPassword;
  }
  if (settings.easynewsPagination !== undefined) {
    configData.easynewsPagination = settings.easynewsPagination;
  }
  if (settings.easynewsMaxPages !== undefined) {
    configData.easynewsMaxPages = settings.easynewsMaxPages;
  }
  if (settings.easynewsMode !== undefined) {
    configData.easynewsMode = settings.easynewsMode;
  }
  if (settings.easynewsHealthCheck !== undefined) {
    configData.easynewsHealthCheck = settings.easynewsHealthCheck;
  }
  if (settings.indexerPriority !== undefined) {
    configData.indexerPriority = settings.indexerPriority;
  }
  if (settings.healthChecks !== undefined) {
    // Preserve providers if not included (providers are managed via CRUD endpoints)
    const existingProviders = configData.healthChecks?.providers || [];
    configData.healthChecks = {
      ...settings.healthChecks,
      providers: settings.healthChecks.providers ?? existingProviders,
      autoQueueMode: settings.healthChecks.autoQueueMode || configData.healthChecks?.autoQueueMode || 'all',
    };
  }
  if (settings.streamDisplayConfig !== undefined) {
    configData.streamDisplayConfig = settings.streamDisplayConfig;
  }

  // Mutual exclusion: force-disable health checks for Zyclops-enabled indexers
  // Note: proxy is NOT force-disabled — runtime already skips proxy for Zyclops indexers,
  // and preserving the user's proxy preference allows it to restore when Zyclops is turned off.
  if (configData.indexers) {
    for (const indexer of configData.indexers) {
      if (indexer.zyclops?.enabled) {
        console.log(`🤖 Zyclops mutual exclusion (settings save): disabling health checks for ${indexer.name}`);
        if (configData.healthChecks?.healthCheckIndexers) {
          configData.healthChecks.healthCheckIndexers[indexer.name] = false;
        }
      }
    }
  }

  saveConfigFile(configData);
}

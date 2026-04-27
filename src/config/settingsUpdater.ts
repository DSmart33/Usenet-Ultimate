/**
 * Settings Updater
 *
 * Handles the updateSettings function that applies bulk setting changes
 * from the UI settings panel.
 */

import type { UsenetProvider, SearchConfig, AutoPlayConfig, SyncedIndexer, StreamDisplayConfig } from '../types.js';
import { configData, saveConfigFile } from './schema.js';
import { enforceZyclopsEnabled } from './indexerCrud.js';
import { validateRulesBlock } from '../rules/importers.js';

// Clamp a timeout value to the integer-seconds domain. Rejects non-finite/non-number input.
function coerceTimeoutSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(45, Math.round(raw)));
}

// Emit a one-line audit log when a top-level searcher's timeout changed.
function logTimeoutChange(
  label: string,
  prevEnabled: boolean | undefined,
  prevSeconds: number | undefined,
  nextEnabled: boolean | undefined,
  nextSeconds: number | undefined,
): void {
  const enabledChanged = nextEnabled !== undefined && nextEnabled !== prevEnabled;
  const secondsChanged = nextSeconds !== undefined && nextSeconds !== prevSeconds;
  if (!enabledChanged && !secondsChanged) return;

  const effEnabled = nextEnabled ?? prevEnabled ?? true;
  if (effEnabled === false) {
    console.log(`⏱️  ${label} timeout disabled`);
  } else {
    const effSeconds = nextSeconds ?? prevSeconds;
    console.log(`⏱️  ${label} timeout updated: enabled=true, timeout=${effSeconds ?? 'default'}s`);
  }
}

export function updateSettings(settings: {
  addonEnabled?: boolean;
  cacheEnabled?: boolean;
  cacheTTL?: number;
  streamingMode?: 'nzbdav' | 'stremio';
  indexManager?: 'newznab' | 'prowlarr' | 'nzbhydra';
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
  nzbdavSeasonPackTimeoutSeconds?: number;
  nzbdavFallbackOrder?: 'selected' | 'top';
  autoResolveOnSearch?: boolean;
  autoResolveTargets?: number;
  nzbdavStreamBufferMB?: number;
  nzbdavPipeBufferMB?: number;
  nzbdavStreamingMethod?: 'pipe' | 'proxy' | 'direct';
  nzbdavCacheTimeouts?: boolean;
  healthyNzbDbMode?: 'time' | 'storage';
  healthyNzbDbTTL?: number;
  healthyNzbDbMaxSizeMB?: number;
  filterDeadNzbs?: boolean;
  deadNzbDbMode?: 'time' | 'storage';
  deadNzbDbTTL?: number;
  deadNzbDbMaxSizeMB?: number;
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
  easynewsTimeoutEnabled?: boolean;
  easynewsTimeout?: number;
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
  };
  ultimateResolve?: {
    enabled: boolean;
    healthCheckEnabled?: boolean;
    whenToResolve?: 'on-results' | 'on-tile-selection';
    userPickFallback?: 'ur-lobby' | 'failure-video' | 'fallback-chain';
    candidateCount?: number;
    preferenceMode?: 'priority' | 'speed';
    archiveInspection?: boolean;
    sampleCount?: 3 | 7;
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
  if (settings.prowlarrTimeoutEnabled !== undefined || settings.prowlarrTimeout !== undefined) {
    const prevEnabled = configData.prowlarrTimeoutEnabled;
    const prevSeconds = configData.prowlarrTimeout;
    let nextSeconds: number | undefined;
    if (settings.prowlarrTimeoutEnabled !== undefined && typeof settings.prowlarrTimeoutEnabled === 'boolean') {
      configData.prowlarrTimeoutEnabled = settings.prowlarrTimeoutEnabled;
    }
    if (settings.prowlarrTimeout !== undefined) {
      nextSeconds = coerceTimeoutSeconds(settings.prowlarrTimeout);
      if (nextSeconds !== undefined) configData.prowlarrTimeout = nextSeconds;
    }
    logTimeoutChange('Prowlarr', prevEnabled, prevSeconds, configData.prowlarrTimeoutEnabled, configData.prowlarrTimeout);
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
  if (settings.nzbhydraTimeoutEnabled !== undefined || settings.nzbhydraTimeout !== undefined) {
    const prevEnabled = configData.nzbhydraTimeoutEnabled;
    const prevSeconds = configData.nzbhydraTimeout;
    if (settings.nzbhydraTimeoutEnabled !== undefined && typeof settings.nzbhydraTimeoutEnabled === 'boolean') {
      configData.nzbhydraTimeoutEnabled = settings.nzbhydraTimeoutEnabled;
    }
    if (settings.nzbhydraTimeout !== undefined) {
      const nextSeconds = coerceTimeoutSeconds(settings.nzbhydraTimeout);
      if (nextSeconds !== undefined) configData.nzbhydraTimeout = nextSeconds;
    }
    logTimeoutChange('NZBHydra', prevEnabled, prevSeconds, configData.nzbhydraTimeoutEnabled, configData.nzbhydraTimeout);
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
  if (settings.nzbdavSeasonPackTimeoutSeconds !== undefined) {
    configData.nzbdavSeasonPackTimeoutSeconds = settings.nzbdavSeasonPackTimeoutSeconds;
  }
  if (settings.nzbdavFallbackOrder !== undefined) {
    configData.nzbdavFallbackOrder = settings.nzbdavFallbackOrder;
  }
  if (settings.autoResolveOnSearch !== undefined) {
    configData.autoResolveOnSearch = settings.autoResolveOnSearch;
  }
  if (settings.autoResolveTargets !== undefined) {
    configData.autoResolveTargets = settings.autoResolveTargets;
  }
  if (settings.nzbdavStreamBufferMB !== undefined) {
    configData.nzbdavStreamBufferMB = settings.nzbdavStreamBufferMB;
  }
  if (settings.nzbdavPipeBufferMB !== undefined) {
    configData.nzbdavPipeBufferMB = settings.nzbdavPipeBufferMB;
  }
  if (settings.nzbdavStreamingMethod !== undefined) {
    configData.nzbdavStreamingMethod = settings.nzbdavStreamingMethod;
    delete configData.nzbdavProxyEnabled;
  }
  if (settings.nzbdavCacheTimeouts !== undefined) {
    configData.nzbdavCacheTimeouts = settings.nzbdavCacheTimeouts;
  }
  if (settings.healthyNzbDbMode !== undefined) {
    configData.healthyNzbDbMode = settings.healthyNzbDbMode;
  }
  if (settings.healthyNzbDbTTL !== undefined) {
    configData.healthyNzbDbTTL = Math.min(345600, Math.max(15, settings.healthyNzbDbTTL));
  }
  if (settings.healthyNzbDbMaxSizeMB !== undefined) {
    configData.healthyNzbDbMaxSizeMB = Math.min(50, Math.max(1, settings.healthyNzbDbMaxSizeMB));
  }
  if (settings.filterDeadNzbs !== undefined) {
    configData.filterDeadNzbs = settings.filterDeadNzbs;
  }
  if (settings.deadNzbDbMode !== undefined) {
    configData.deadNzbDbMode = settings.deadNzbDbMode;
  }
  if (settings.deadNzbDbTTL !== undefined) {
    configData.deadNzbDbTTL = Math.min(345600, Math.max(15, settings.deadNzbDbTTL));
  }
  if (settings.deadNzbDbMaxSizeMB !== undefined) {
    configData.deadNzbDbMaxSizeMB = Math.min(50, Math.max(1, settings.deadNzbDbMaxSizeMB));
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
    validateRulesBlock(settings.filters?.rules);
    configData.filters = settings.filters;
  }
  if (settings.movieFilters !== undefined) {
    validateRulesBlock(settings.movieFilters?.rules);
    configData.movieFilters = settings.movieFilters;
  }
  if (settings.tvFilters !== undefined) {
    validateRulesBlock(settings.tvFilters?.rules);
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
  if (settings.easynewsTimeoutEnabled !== undefined || settings.easynewsTimeout !== undefined) {
    const prevEnabled = configData.easynewsTimeoutEnabled;
    const prevSeconds = configData.easynewsTimeout;
    if (settings.easynewsTimeoutEnabled !== undefined && typeof settings.easynewsTimeoutEnabled === 'boolean') {
      configData.easynewsTimeoutEnabled = settings.easynewsTimeoutEnabled;
    }
    if (settings.easynewsTimeout !== undefined) {
      const nextSeconds = coerceTimeoutSeconds(settings.easynewsTimeout);
      if (nextSeconds !== undefined) configData.easynewsTimeout = nextSeconds;
    }
    logTimeoutChange('EasyNews', prevEnabled, prevSeconds, configData.easynewsTimeoutEnabled, configData.easynewsTimeout);
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
      autoQueueMode: settings.healthChecks.autoQueueMode ?? configData.healthChecks?.autoQueueMode ?? 'all',
    };
  }
  if (settings.streamDisplayConfig !== undefined) {
    configData.streamDisplayConfig = settings.streamDisplayConfig;
  }
  // UR transition detection — gate cancel + cache-clear narrowly so unrelated
  // UR field tweaks don't nuke in-flight playback or purge useful search caches.
  let urEnableTransitioned = false;
  let urIndexersChanged = false;
  if (settings.ultimateResolve !== undefined) {
    const wasUrEnabled = configData.ultimateResolve?.enabled === true;
    const prevHcIndexersJson = JSON.stringify(configData.ultimateResolve?.healthCheckIndexers ?? {});
    configData.ultimateResolve = { ...configData.ultimateResolve, ...settings.ultimateResolve };
    const isUrEnabled = configData.ultimateResolve?.enabled === true;
    urEnableTransitioned = wasUrEnabled && !isUrEnabled;
    urIndexersChanged =
      JSON.stringify(configData.ultimateResolve?.healthCheckIndexers ?? {}) !== prevHcIndexersJson;
  }

  // Enforce minimum cacheTTL when auto play is enabled
  if ((configData.autoPlay?.enabled ?? true) && configData.cacheTTL < 9000) {
    configData.cacheTTL = 9000;
  }

  // Cancel auto-resolves when preconditions change
  if (settings.nzbdavFallbackEnabled === false
      || settings.nzbdavFallbackOrder === 'selected'
      || settings.autoResolveOnSearch === false
      || settings.autoResolveTargets !== undefined) {
    import('../nzbdav/autoResolve.js').then(m => m.cancelAllAutoResolves()).catch(() => {});
  }

  // Only cancel UR sessions on a genuine enable→disable transition. Tweaks to
  // timeouts / candidate count / etc. let in-flight pipelines finish — users
  // are already watching them. Search cache only needs clearing when the set
  // of vetting indexers changes (or on a disable, since UR tile injection
  // depends on the enabled flag).
  if (urEnableTransitioned) {
    import('../nzbdav/ultimateResolve.js').then(m => m.cancelAllUltimateResolves()).catch(() => {});
  }
  if (urEnableTransitioned || urIndexersChanged) {
    import('../addon/index.js').then(m => m.clearSearchCache()).catch(() => {});
  }

  // Mutual exclusion: force enabled + disable proxy/health checks for Zyclops-enabled indexers
  for (const indexer of configData.indexers) {
    enforceZyclopsEnabled(indexer, 'settings save');
  }

  saveConfigFile(configData);
}

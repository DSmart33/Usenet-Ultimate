/**
 * Configuration Accessors
 *
 * Exports the `config` object with getter-based accessors that read from
 * the shared configData state. This is the main Config object consumed
 * by the rest of the application.
 *
 * Environment variable overrides follow the priority:
 *   env var > config.json > hardcoded default
 */

import type { Config, SearchConfig, HealthCheckConfig, AutoPlayConfig, StreamDisplayConfig, SyncedIndexer } from '../types.js';
import { getLatestVersions } from '../versionFetcher.js';
import { configData, ZYCLOPS_DEFAULT_ENDPOINT } from './schema.js';

/** Parse a 'true'/'false' env var string. Returns undefined if not set. */
function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v.toLowerCase() === 'true' || v === '1';
}

/** Return env var value if set (non-empty), otherwise undefined. */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : undefined;
}

/** Parse an env var as an integer. Returns undefined if not set or invalid. */
function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Validate an env var against a list of allowed values. */
function envEnum<T extends string>(name: string, allowed: T[]): T | undefined {
  const v = envStr(name);
  return v !== undefined && (allowed as string[]).includes(v) ? v as T : undefined;
}

// Export config in the format expected by the rest of the app
export const config: Config = {
  get addonEnabled() {
    return configData.addonEnabled !== false;
  },
  get indexers() {
    return configData.indexers;
  },
  get cacheEnabled() {
    return configData.cacheEnabled;
  },
  get cacheTTL() {
    return configData.cacheTTL;
  },
  get streamingMode() {
    return envEnum('STREAMING_MODE', ['nzbdav', 'stremio']) || configData.streamingMode;
  },
  get indexManager() {
    return envEnum('INDEX_MANAGER', ['newznab', 'prowlarr', 'nzbhydra']) || configData.indexManager;
  },
  get nzbdavUrl() {
    return envStr('NZBDAV_URL') || configData.nzbdavUrl;
  },
  get nzbdavApiKey() {
    return envStr('NZBDAV_API_KEY') || configData.nzbdavApiKey;
  },
  get nzbdavWebdavUrl() {
    return envStr('NZBDAV_WEBDAV_URL') || configData.nzbdavWebdavUrl;
  },
  get nzbdavWebdavUser() {
    return envStr('NZBDAV_WEBDAV_USER') || configData.nzbdavWebdavUser;
  },
  get nzbdavWebdavPassword() {
    return envStr('NZBDAV_WEBDAV_PASS') || configData.nzbdavWebdavPassword;
  },
  get nzbdavMoviesCategory() {
    return configData.nzbdavMoviesCategory;
  },
  get nzbdavTvCategory() {
    return configData.nzbdavTvCategory;
  },
  get nzbdavFallbackEnabled() {
    const env = envBool('NZBDAV_FALLBACK_ENABLED');
    if (env !== undefined) return env;
    if (configData.nzbdavFallbackEnabled !== undefined) return configData.nzbdavFallbackEnabled;
    // Default: disabled — user must explicitly enable fallback
    return false;
  },
  get nzbdavLibraryCheckEnabled() {
    const env = envBool('NZBDAV_LIBRARY_CHECK');
    if (env !== undefined) return env;
    return configData.nzbdavLibraryCheckEnabled !== false;
  },
  get nzbdavMaxFallbacks() {
    return envInt('NZBDAV_MAX_FALLBACKS') ?? configData.nzbdavMaxFallbacks ?? 0;
  },
  get nzbdavJobTimeoutSeconds() {
    return envInt('NZBDAV_JOB_TIMEOUT') ?? configData.nzbdavJobTimeoutSeconds ?? 120;
  },
  get nzbdavMoviesTimeoutSeconds() {
    const raw = envInt('NZBDAV_MOVIES_TIMEOUT') ?? configData.nzbdavMoviesTimeoutSeconds ?? (envInt('NZBDAV_JOB_TIMEOUT') ?? configData.nzbdavJobTimeoutSeconds) ?? 30;
    return Math.max(1, Math.min(90, raw));
  },
  get nzbdavTvTimeoutSeconds() {
    const raw = envInt('NZBDAV_TV_TIMEOUT') ?? configData.nzbdavTvTimeoutSeconds ?? (envInt('NZBDAV_JOB_TIMEOUT') ?? configData.nzbdavJobTimeoutSeconds) ?? 15;
    return Math.max(1, Math.min(90, raw));
  },
  get nzbdavSeasonPackTimeoutSeconds() {
    const raw = envInt('NZBDAV_SEASON_PACK_TIMEOUT') ?? configData.nzbdavSeasonPackTimeoutSeconds ?? 30;
    return Math.max(1, Math.min(90, raw));
  },
  get nzbdavFallbackOrder() {
    return envEnum('NZBDAV_FALLBACK_ORDER', ['selected', 'top']) || configData.nzbdavFallbackOrder || 'selected';
  },
  get nzbdavCacheTimeouts() {
    const env = envBool('INCLUDE_TIMEOUTS_AS_DEAD_NZBS');
    if (env !== undefined) return env;
    return configData.nzbdavCacheTimeouts !== false;
  },
  get nzbdavStreamBufferMB() {
    const envMB = envInt('NZBDAV_STREAM_BUFFER_MB') ?? envInt('STREAM_BUFFER_MB');
    if (envMB != null && envMB > 0) return Math.max(8, envMB);
    return Math.max(8, configData.nzbdavStreamBufferMB ?? 128);
  },
  get nzbdavProxyEnabled() {
    const env = envBool('NZBDAV_PROXY_ENABLED');
    if (env !== undefined) return env;
    return configData.nzbdavProxyEnabled !== false;
  },
  get healthyNzbDbMode(): 'time' | 'storage' {
    return configData.healthyNzbDbMode || 'time';
  },
  get healthyNzbDbTTL() {
    return configData.healthyNzbDbTTL ?? 259200;
  },
  get healthyNzbDbMaxSizeMB() {
    return Math.min(50, Math.max(1, configData.healthyNzbDbMaxSizeMB ?? 50));
  },
  get filterDeadNzbs() {
    const env = envBool('FILTER_DEAD_NZBS');
    if (env !== undefined) return env;
    return configData.filterDeadNzbs !== false;
  },
  get deadNzbDbMode(): 'time' | 'storage' {
    return configData.deadNzbDbMode || 'storage';
  },
  get deadNzbDbTTL() {
    return configData.deadNzbDbTTL ?? 86400;
  },
  get deadNzbDbMaxSizeMB() {
    return Math.min(50, Math.max(1, configData.deadNzbDbMaxSizeMB ?? 50));
  },
  get proxyMode() {
    return envEnum('PROXY_MODE', ['disabled', 'http']) || configData.proxyMode || 'disabled';
  },
  get proxyUrl() {
    return envStr('PROXY_URL') || configData.proxyUrl;
  },
  get proxyIndexers() {
    return configData.proxyIndexers;
  },
  get searchConfig(): SearchConfig {
    const sc = configData.searchConfig || { includeSeasonPacks: true };
    const remakeEnv = envBool('ENABLE_REMAKE_DETECTION');
    const multiEpEnv = envBool('ALLOW_MULTI_EPISODE_FILES');
    const urlDedupEnv = envBool('URL_DEDUP');
    return {
      ...sc,
      ...(remakeEnv !== undefined && { enableRemakeFiltering: remakeEnv }),
      ...(multiEpEnv !== undefined && { allowMultiEpisodeFiles: multiEpEnv }),
      ...(urlDedupEnv !== undefined && { urlDedup: urlDedupEnv }),
    };
  },
  get useTextSearch() {
    // Backward compat: derive from searchConfig
    const sc = configData.searchConfig;
    return sc ? (sc.movieSearchMethod === 'text' || sc.tvSearchMethod === 'text') : (configData.useTextSearch || false);
  },
  get includeSeasonPacks() {
    return configData.searchConfig?.includeSeasonPacks ?? configData.includeSeasonPacks ?? true;
  },
  get cardOrder() {
    return configData.cardOrder;
  },
  get userAgents() {
    const versions = getLatestVersions();
    const defaults = {
      indexerSearch: versions.prowlarr,
      nzbDownload: versions.sabnzbd,
      nzbdavOperations: versions.sabnzbd,
      webdavOperations: versions.sabnzbd,
      general: versions.chrome
    };
    if (!configData.userAgents) return defaults;
    // Auto-generated fields match Prowlarr/*, SABnzbd/*, or Chrome/* patterns.
    // If saved value matches that pattern, replace with latest fetched version.
    // If user set a custom value, preserve it.
    const useLatest = (saved: string | undefined, pattern: RegExp, latest: string) =>
      !saved || pattern.test(saved) ? latest : saved;
    return {
      indexerSearch: useLatest(configData.userAgents.indexerSearch, /^Prowlarr\//, defaults.indexerSearch),
      nzbDownload: useLatest(configData.userAgents.nzbDownload, /^SABnzbd\//, defaults.nzbDownload),
      nzbdavOperations: useLatest(configData.userAgents.nzbdavOperations, /^SABnzbd\//, defaults.nzbdavOperations),
      webdavOperations: useLatest(configData.userAgents.webdavOperations, /^SABnzbd\//, defaults.webdavOperations),
      general: useLatest(configData.userAgents.general, /Chrome\/[\d.]+/, defaults.general),
    };
  },
  get filters() {
    return configData.filters || {
      sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition'],
      enabledSorts: {
        quality: true,
        videoTag: true,
        size: true,
        encode: true,
        visualTag: true,
        audioTag: true,
        language: false,
        edition: false
      },
      enabledPriorities: {
        resolution: {},
        video: {},
        encode: {},
        visualTag: { '3D': false },
        audioTag: {},
        language: {},
        edition: {}
      },
      minFileSize: undefined,
      maxFileSize: undefined,
      minSeasonPackSize: undefined,
      maxSeasonPackSize: undefined,
      minSeasonPackEpisodeSize: undefined,
      maxSeasonPackEpisodeSize: undefined,
      maxStreams: undefined,
      maxStreamsPerResolution: undefined,
      maxStreamsPerQuality: undefined,
      resolutionPriority: ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '540p', '480p', '360p', '240p', '144p'],
      videoPriority: ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'],
      encodePriority: ['av1', 'hevc', 'vp9', 'avc', 'vp8', 'xvid', 'mpeg2', 'Unknown'],
      visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', '3D', 'Unknown'],
      audioTagPriority: ['Atmos (TrueHD)', 'DTS Lossless', 'TrueHD', 'Atmos (DDP)', 'DTS Lossy', 'DDP', 'DD', 'FLAC', 'PCM', 'AAC', 'OPUS', 'MP3', 'Unknown'],
      languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'],
      editionPriority: ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard']
    };
  },
  get movieFilters() {
    return configData.movieFilters;
  },
  get tvFilters() {
    return configData.tvFilters;
  },
  get healthChecks(): HealthCheckConfig {
    const hc = configData.healthChecks;
    const envEnabled = envBool('HEALTH_CHECK_ENABLED');

    if (!hc) {
      const defaults: HealthCheckConfig = {
        enabled: envEnabled ?? false,
        archiveInspection: true,
        sampleCount: 3,
        providers: [],
        nzbsToInspect: 6,
        inspectionMethod: 'smart' as const,
        smartBatchSize: 3,
        smartAdditionalRuns: 1,
        maxConnections: 12,
        autoQueueMode: 'all' as const,
        hideBlocked: true,
        libraryPreCheck: true,
      };
      // Inject env-based NNTP provider if configured
      const envHost = envStr('HEALTH_CHECK_NNTP_HOST');
      if (envHost) {
        defaults.enabled = envEnabled ?? true;
        defaults.providers = [{
          id: 'env-provider',
          name: 'Primary Provider (env)',
          host: envHost,
          port: envInt('HEALTH_CHECK_NNTP_PORT') ?? 563,
          useTLS: envBool('HEALTH_CHECK_NNTP_TLS') ?? true,
          username: envStr('HEALTH_CHECK_NNTP_USER') ?? '',
          password: envStr('HEALTH_CHECK_NNTP_PASS') ?? '',
          enabled: true,
          type: 'pool',
        }];
      }
      return defaults;
    }
    // Migrate legacy mode field to granular controls
    let archiveInspection = hc.archiveInspection;
    let sampleCount = hc.sampleCount;
    if (archiveInspection === undefined || sampleCount === undefined) {
      const legacyMode = hc.mode || 'full';
      archiveInspection = archiveInspection ?? (legacyMode === 'full');
      sampleCount = sampleCount ?? (legacyMode === 'full' ? 7 : 3);
    }

    // Build the result with defaults
    const result: HealthCheckConfig = {
      ...hc,
      enabled: envEnabled ?? hc.enabled,
      archiveInspection,
      sampleCount,
      inspectionMethod: hc.inspectionMethod || 'smart',
      smartBatchSize: hc.smartBatchSize ?? 3,
      smartAdditionalRuns: hc.smartAdditionalRuns ?? 1,
      maxConnections: hc.maxConnections ?? 12,
      autoQueueMode: hc.autoQueueMode ?? 'all',
      libraryPreCheck: hc.libraryPreCheck !== false,
    };

    // Inject env-based NNTP provider (prepended so it takes priority)
    const envHost = envStr('HEALTH_CHECK_NNTP_HOST');
    if (envHost) {
      const envProvider = {
        id: 'env-provider',
        name: 'Primary Provider (env)',
        host: envHost,
        port: envInt('HEALTH_CHECK_NNTP_PORT') ?? 563,
        useTLS: envBool('HEALTH_CHECK_NNTP_TLS') ?? true,
        username: envStr('HEALTH_CHECK_NNTP_USER') ?? '',
        password: envStr('HEALTH_CHECK_NNTP_PASS') ?? '',
        enabled: true,
        type: 'pool' as const,
      };
      // Replace if already injected, otherwise prepend
      const existing = result.providers.findIndex(p => p.id === 'env-provider');
      if (existing >= 0) {
        result.providers[existing] = envProvider;
      } else {
        result.providers = [envProvider, ...result.providers];
      }
    }

    return result;
  },
  get autoPlay(): AutoPlayConfig {
    return configData.autoPlay || {
      enabled: true,
      method: 'firstFile',
      attributes: ['resolution', 'quality', 'edition'],
    };
  },
  get streamDisplayConfig(): StreamDisplayConfig | undefined {
    return configData.streamDisplayConfig;
  },
  get syncedIndexers(): SyncedIndexer[] {
    return configData.syncedIndexers || [];
  },
  get prowlarrUrl() {
    return envStr('PROWLARR_URL') || configData.prowlarrUrl;
  },
  get prowlarrApiKey() {
    return envStr('PROWLARR_API_KEY') || configData.prowlarrApiKey;
  },
  get nzbhydraUrl() {
    return envStr('NZBHYDRA_URL') || configData.nzbhydraUrl;
  },
  get nzbhydraApiKey() {
    return envStr('NZBHYDRA_API_KEY') || configData.nzbhydraApiKey;
  },
  get nzbhydraUsername() {
    return envStr('NZBHYDRA_USERNAME') || configData.nzbhydraUsername || '';
  },
  get nzbhydraPassword() {
    return envStr('NZBHYDRA_PASSWORD') || configData.nzbhydraPassword || '';
  },
  get zyclopsEndpoint() {
    return configData.zyclopsEndpoint || ZYCLOPS_DEFAULT_ENDPOINT;
  },
  get easynewsEnabled() {
    return envBool('EASYNEWS_ENABLED') ?? configData.easynewsEnabled ?? false;
  },
  get easynewsUsername() {
    return envStr('EASYNEWS_USERNAME') || configData.easynewsUsername || '';
  },
  get easynewsPassword() {
    return envStr('EASYNEWS_PASSWORD') || configData.easynewsPassword || '';
  },
  get easynewsPagination() {
    return configData.easynewsPagination || false;
  },
  get easynewsMaxPages() {
    return configData.easynewsMaxPages || 3;
  },
  get easynewsMode() {
    return configData.easynewsMode || 'nzb';
  },
  get easynewsHealthCheck() {
    return configData.easynewsHealthCheck ?? true;
  },
  get indexerPriority() {
    return configData.indexerPriority;
  },
};

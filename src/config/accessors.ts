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
  get nzbdavMaxFallbacks() {
    return configData.nzbdavMaxFallbacks;
  },
  get nzbdavStreamBufferMB() {
    return configData.nzbdavStreamBufferMB;
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
    return configData.searchConfig || {
      includeSeasonPacks: true,
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
        visualTag: {},
        audioTag: {},
        language: {},
        edition: {}
      },
      maxFileSize: undefined,
      maxStreams: 10,
      maxStreamsPerQuality: undefined,
      resolutionPriority: ['2160p', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'],
      videoPriority: ['BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDRip', 'HC HD-Rip', 'DVDRip', 'HDTV', 'Unknown'],
      encodePriority: ['AV1', 'HEVC', 'AVC', 'Unknown'],
      visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'IMAX', 'HDR10', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'],
      audioTagPriority: ['Atmos', 'DTS:X', 'DTS-HD MA', 'TrueHD', 'DTS-HD', 'DD+', 'DD'],
      languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'],
      editionPriority: ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard']
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
        segmentCache: { enabled: true, ttlHours: 0, maxSizeMB: 50 },
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
      segmentCache: hc.segmentCache ?? { enabled: true, ttlHours: 0, maxSizeMB: 50 },
      autoQueueMode: hc.autoQueueMode || 'all',
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
    return configData.easynewsHealthCheck || false;
  },
  get indexerPriority() {
    return configData.indexerPriority;
  },
};

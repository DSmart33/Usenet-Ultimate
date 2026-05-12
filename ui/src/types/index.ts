// What this does:
//   Shared TypeScript interfaces and types for the Usenet Ultimate UI

export interface Manifest {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface IndexerCaps {
  movieSearchParams: string[];
  tvSearchParams: string[];
}

export interface ZyclopsIndexerConfig {
  enabled: boolean;
  backbone?: string[];
  providerHosts?: string;
  showUnknown?: boolean;
  singleIp?: boolean;
  preZyclopsState?: {
    enabled: boolean;
    proxy: boolean;
    healthCheck: boolean;
  };
}

export interface Indexer {
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  website?: string;
  logo?: string;
  movieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  tvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  animeMovieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  animeTvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  caps?: IndexerCaps;
  pagination?: boolean;
  maxPages?: number;
  timeoutEnabled?: boolean;
  timeout?: number;
  zyclops?: ZyclopsIndexerConfig;
}

export interface SyncedIndexer {
  id: string;
  name: string;
  enabledForSearch: boolean;
  enabledForHealthCheck: boolean;
  movieSearchMethod: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  tvSearchMethod: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  animeMovieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  animeTvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  capabilities?: IndexerCaps;
  logo?: string;
  pagination?: boolean;
  additionalPages?: number;
}

export interface UsenetProvider {
  id: string;
  name: string;
  host: string;
  port: number;
  useTLS: boolean;
  username: string;
  password: string;
  enabled: boolean;
  type: 'pool' | 'backup';
}

export interface SearchConfig {
  tmdbApiKey?: string;
  tvdbApiKey?: string;
  includeSeasonPacks?: boolean;
  includeMultiSeasonPacks?: boolean;
  seasonPackPagination?: boolean;
  seasonPackAdditionalPages?: number;
  useTextSearchForAnime?: boolean;
  skipAnimeTitleResolve?: boolean;
  indexerPriorityDedup?: boolean;
  urlDedup?: boolean;
  junkFilter?: boolean;
  seriesPackKeywords?: string[];
  seriesPackPagination?: boolean;
  seriesPackAdditionalPages?: number;
  librarySearchThreshold?: number;
  libraryApplyToMovies?: boolean;
  libraryApplyToSeries?: boolean;
  librarySearchScanUncategorized?: boolean;
  displayLibraryInResults?: boolean;
  absoluteEpisodeFallback?: boolean;
  parallelAlternateTitleSearch?: boolean;
  tvdbPreferEnglishTitle?: boolean;
  aliasTitleFallback?: boolean;
  cacheEmptyResults?: boolean;
  movieSearchMethod?: string;
  tvSearchMethod?: string;
}

// Mirrors backend SERIES_PACK_KEYWORDS. Keep alphabetical so chip order is stable.
export const SERIES_PACK_KEYWORDS = ['All Seasons', 'Anthology', 'Boxset', 'Collection', 'Complete', 'Saga'] as const;

export interface StreamDisplayElement {
  id: string;
  label: string;
  enabled: boolean;
  prefix: string;
}

export interface StreamDisplayLineGroup {
  id: string;
  elementIds: string[];
  indent: boolean;
}

export interface StreamDisplayConfig {
  nameElements: string[];
  elements: Record<string, StreamDisplayElement>;
  seasonPackPrefix: string;
  regularPrefix: string;
  lineGroups: StreamDisplayLineGroup[];
  cleanTitles: boolean;
}

export interface Config {
  addonEnabled?: boolean;
  indexers: Indexer[];
  cacheEnabled: boolean;
  cacheTTL: number;
  streamingMode: 'nzbdav' | 'stremio';
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
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
  healthChecks?: {
    enabled: boolean;
    providers: UsenetProvider[];
    nzbsToInspect: number;
    maxConnections: number;
    autoQueueMode: 'off' | 'top' | 'all';
    hideBlocked: boolean;
    healthCheckIndexers?: Record<string, boolean>;
  };
  syncedIndexers?: SyncedIndexer[];
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
  nzbdavStreamBufferMB?: number;
  nzbdavPipeBufferMB?: number;
  nzbdavStreamingMethod?: 'pipe' | 'proxy' | 'direct';
  nzbdavProxyEnabled?: boolean;
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
  streamDisplayConfig?: StreamDisplayConfig;
  zyclopsEndpoint?: string;
}

export interface IndexerPreset {
  name: string;
  url: string;
  website: string;
  logo: string;
}

export type Tab = 'dashboard' | 'install';


export type OverlayType = 'indexManager' | 'streaming' | 'nzbDatabase' | 'cache' | 'stats' | 'userAgent' | 'filters' | 'healthChecks' | 'ultimateFallback' | 'proxy' | 'logs' | 'autoPlay' | 'streamDisplay' | 'zyclops' | null;

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HealthChecksState {
  enabled: boolean;
  archiveInspection: boolean;
  sampleCount: 3 | 7;
  providers: UsenetProvider[];
  nzbsToInspect: number;
  inspectionMethod: 'fixed' | 'smart';
  smartBatchSize: number;
  smartAdditionalRuns: number;
  smartMinHealthy: number;
  maxConnections: number;
  autoQueueMode: 'off' | 'top' | 'all';
  hideBlocked: boolean;
  libraryPreCheck: boolean;
  healthCheckIndexers: Record<string, boolean>;
}

export interface AutoPlayState {
  enabled: boolean;
  method: string;
  attributes: string[];
}

export interface FiltersState {
  sortOrder: string[];
  enabledSorts: Record<string, boolean>;
  sortDirections?: Record<string, 'asc' | 'desc'>;
  enabledPriorities: Record<string, Record<string, boolean>>;
  minFileSize: number | undefined;
  maxFileSize: number | undefined;
  minSeasonPackSize: number | undefined;
  maxSeasonPackSize: number | undefined;
  minSeasonPackEpisodeSize: number | undefined;
  maxSeasonPackEpisodeSize: number | undefined;
  maxStreams: number | undefined;
  maxStreamsPerResolution: number | undefined;
  maxStreamsPerQuality: number | undefined;
  maxSeasonPacks: number | undefined;
  resolutionPriority: string[];
  videoPriority: string[];
  encodePriority: string[];
  visualTagPriority: string[];
  audioTagPriority: string[];
  languagePriority: string[];
  editionPriority: string[];
  preferNonStandardEdition?: boolean;
  preferSeasonPacks?: boolean;
  preferLibraryResults?: boolean;
  enableRemakeFiltering?: boolean;
  allowMultiEpisodeFiles?: boolean;
  rules?: RulesBlock;
}

export interface RankedRegexRule {
  id: string;
  name: string;
  pattern: string;
  flags?: string;
  score: number;
  enabled?: boolean;
  mode?: 'score' | 'keep' | 'drop';
}

export interface RankedSelRule {
  id: string;
  name: string;
  expression: string;
  score: number;
  enabled?: boolean;
}

export interface RulesBlock {
  rankedRegexPatterns?: RankedRegexRule[];
  rankedStreamExpressions?: RankedSelRule[];
  remoteRankedRegexUrls?: string[];
  remoteRankedStreamExpressionUrls?: string[];
}

export interface NewIndexerForm {
  name: string;
  url: string;
  apiKey: string;
  website: string;
  logo: string;
  movieSearchMethod: string[];
  tvSearchMethod: string[];
  animeMovieSearchMethod: string[];
  animeTvSearchMethod: string[];
  caps: IndexerCaps | null;
  pagination: boolean;
  maxPages: number;
  timeoutEnabled: boolean;
  timeout: number;
}

export interface EditIndexerForm {
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  website: string;
  logo: string;
  movieSearchMethod: string[];
  tvSearchMethod: string[];
  animeMovieSearchMethod: string[];
  animeTvSearchMethod: string[];
  caps: IndexerCaps | null;
  pagination: boolean;
  maxPages: number;
  timeoutEnabled: boolean;
  timeout: number;
}

export interface ElementDragState {
  elementId: string;
  sourceType: 'name' | 'title';
  sourceGroupId?: string;
}

export interface ElementDragOverState {
  targetType: 'name' | 'title';
  targetGroupId?: string;
  targetElementId?: string;
  position: 'before' | 'after';
}

export interface UserAgents {
  indexerSearch: string;
  nzbDownload: string;
  nzbdavOperations: string;
  webdavOperations: string;
  general: string;
}

export type ApiFetch = (url: string, options?: RequestInit) => Promise<Response>;

export interface MockStreamData {
  cleanTitle: string;
  rawTitle: string;
  resolution: string;
  quality: string;
  encode: string;
  size: string;
  displaySize: string;
  visualTag: string;
  audioTag: string;
  releaseGroup: string;
  indexer: string;
  healthBadge: string;
  healthProviders: string;
  edition: string;
  language: string;
  age?: string;
  bitrate?: string;
  isSeasonPack: boolean;
}

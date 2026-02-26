// What this does:
//   Shared TypeScript interfaces and types for the Usenet Ultimate UI

export interface IndexerCaps {
  movieSearchParams: string[];
  tvSearchParams: string[];
}

export interface ZyclopsIndexerConfig {
  enabled: boolean;
  backbone?: string;
  providerHost?: string;
  showUnknown?: boolean;
  singleIp?: boolean;
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
  caps?: IndexerCaps;
  pagination?: boolean;
  maxPages?: number;
  zyclops?: ZyclopsIndexerConfig;
}

export interface SyncedIndexer {
  id: string;
  name: string;
  enabledForSearch: boolean;
  enabledForHealthCheck: boolean;
  movieSearchMethod: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  tvSearchMethod: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
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
  seasonPackPagination?: boolean;
  seasonPackAdditionalPages?: number;
  useTextSearchForAnime?: boolean;
  skipAnimeTitleResolve?: boolean;
  indexerPriorityDedup?: boolean;
  movieSearchMethod?: string;
  tvSearchMethod?: string;
}

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
  nzbdavMaxFallbacks?: number;
  nzbdavStreamBufferMB?: number;
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;
  easynewsMaxPages?: number;
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


export type OverlayType = 'indexManager' | 'streaming' | 'cache' | 'stats' | 'userAgent' | 'filters' | 'healthChecks' | 'proxy' | 'logs' | 'autoPlay' | 'streamDisplay' | 'zyclops' | null;

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
  maxConnections: number;
  autoQueueMode: 'off' | 'top' | 'all';
  hideBlocked: boolean;
  libraryPreCheck: boolean;
  healthCheckIndexers: Record<string, boolean>;
  segmentCache?: {
    enabled: boolean;
    ttlHours: number;
    maxSizeMB: number;
  };
}

export interface AutoPlayState {
  enabled: boolean;
  method: string;
  attributes: string[];
}

export interface FiltersState {
  sortOrder: string[];
  enabledSorts: Record<string, boolean>;
  enabledPriorities: Record<string, Record<string, boolean>>;
  maxFileSize: number | undefined;
  maxStreams: number | undefined;
  maxStreamsPerQuality: number | undefined;
  resolutionPriority: string[];
  videoPriority: string[];
  encodePriority: string[];
  visualTagPriority: string[];
  audioTagPriority: string[];
  languagePriority: string[];
  editionPriority: string[];
  preferNonStandardEdition?: boolean;
}

export interface NewIndexerForm {
  name: string;
  url: string;
  apiKey: string;
  website: string;
  logo: string;
  movieSearchMethod: string[];
  tvSearchMethod: string[];
  caps: IndexerCaps | null;
  pagination: boolean;
  maxPages: number;
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
  caps: IndexerCaps | null;
  pagination: boolean;
  maxPages: number;
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
  isSeasonPack: boolean;
}

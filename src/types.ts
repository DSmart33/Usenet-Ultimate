/** 
* Stremio Addon Stream Response Types
* Defines the structure of streams and metadata returned by the addon
* Matches:
*     Stremio Addon Spec:
*       Main SDK: https://github.com/Stremio/stremio-addon-sdk
*       API Documentation: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/README.md
*       Stream Response Format: The SDK defines the Stream interface we're using
*       Manifest Spec: Defines addon capabilities (resources, types, catalogs)
*
*      Newznab API Format:
*       API Specification: https://github.com/nZEDb/nZEDb/blob/develop/docs/newznab_api_specification.txt
*       Key points:
*           Returns RSS 2.0 XML with <newznab:attr> extensions
*           Supports searches by IMDB ID, season/episode
*           Returns NZB download links in <link> or <enclosure> tags
*           Standard categories: 2000 = Movies, 5000 = TV
* 
*      Stream matches Stremio's expected format
*      NZBSearchResult matches what Newznab returns in RSS XML
*/

// Stremio Stream - what we return to Stremio
export interface Stream {
  name?: string;           // Addon name shown in stream list
  title?: string;          // Stream description (quality, size, etc)
  url?: string;            // Direct video URL (we won't use this)
  externalUrl?: string;    // NZB download link (what we'll use!)
  infoHash?: string;       // For torrents (not needed for us)
  behaviorHints?: {
    notWebReady?: boolean; // True = can't play in browser
    bingeGroup?: string;   // Groups streams for Stremio auto-play/binge watching
  };
}


// Usenet Indexer Configuration
export interface UsenetIndexer {
  name: string;      // Display name (e.g., "My Indexer")
  url: string;       // Newznab API URL
  apiKey: string;    // Your API key
  enabled: boolean;  // Can turn indexers on/off
  website?: string;  // Website URL for getting API key
  logo?: string;     // Logo/favicon URL
  movieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];   // Per-indexer movie search methods
  tvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];    // Per-indexer TV search methods
  animeMovieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];   // Per-indexer anime movie search methods
  animeTvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];    // Per-indexer anime TV search methods
  caps?: IndexerCaps;  // Discovered capabilities from ?t=caps
  pagination?: boolean; // Enable paginated search (default false)
  maxPages?: number;    // Max extra pages to fetch when pagination enabled (1-10, default 3)
  timeoutEnabled?: boolean; // Enable request timeout (default true)
  timeout?: number;         // Request timeout in seconds, 0.5s steps (1-120, default 8)
  zyclops?: ZyclopsIndexerConfig;  // Zyclops health-check proxy settings (Newznab mode only)
}

// Discovered indexer capabilities from Newznab ?t=caps endpoint
export interface IndexerCaps {
  movieSearchParams: string[];   // e.g. ['q', 'imdbid', 'tmdbid']
  tvSearchParams: string[];      // e.g. ['q', 'tvdbid', 'imdbid', 'season', 'ep']
}

// Zyclops health-check proxy configuration (per-indexer, Newznab mode only)
export interface ZyclopsIndexerConfig {
  enabled: boolean;                    // Whether to route this indexer through Zyclops
  backbone?: string[];                 // Usenet backbone identifiers — sent as comma-separated list to Zyclops
  providerHosts?: string;              // NNTP provider hostnames (comma-separated) — takes priority over backbone
  showUnknown?: boolean;               // Show results with unknown health status (default false)
  singleIp?: boolean;                  // Single IP mode — only Zyclops IP touches upstream (default true)
  preZyclopsState?: {                  // Snapshot of settings before Zyclops was enabled — restored on disable
    enabled: boolean;
    proxy: boolean;
    healthCheck: boolean;
  };
}

// Default timeout for indexer search requests (seconds). 15s balances
// responsiveness on fast networks with headroom for slower indexers;
// users can raise the per-indexer value (max 45s) or the top-level
// Prowlarr/NZBHydra/EasyNews override.
export const DEFAULT_INDEXER_TIMEOUT_SECONDS = 15;

// Valid Zyclops backbone identifiers
export const ZYCLOPS_BACKBONES = [
  'abavia', 'base-ip', 'elbracht', 'eweka-internet-services',
  'giganews', 'its-hosted', 'netnews', 'omicron',
  'usenetexpress', 'uzo-reto'
] as const;

// Raw result origin discriminator. Library results bypass NZB-specific code paths
// (submitNzb, getCacheKey, dead-NZB checks, health checks) — handlers gate on this.
export type ResultOrigin = 'indexer' | 'easynews' | 'library';

// Shape used by dedup, sort, score, and stream-builder. Indexer/EasyNews searchers
// return loosely-typed objects today; this interface documents the contract and is
// enforced for library-origin results emitted by searchLibrary().
export interface RawResult {
  origin: ResultOrigin;
  title: string;
  link: string;          // dedup key — see src/addon/dedup.ts
  nzbUrl: string;        // for indexer/easynews: same as link; for library: 'library:<videoPath>'
  size: number;
  indexerName: string;
  pubDate?: string;
  quality?: string;
  codec?: string;
  source?: string;
  audioTag?: string;
  visualTag?: string;
  edition?: string;
  releaseGroup?: string;
  language?: string;
  isSeasonPack?: boolean;
  /** Set only when origin === 'library' AND the inner file is a per-episode file inside a pack folder.
   *  Pack-total size filters skip these entries since `size` is the per-episode size, not the pack total.
   *  Per-episode-in-pack filters still apply via the existing isSeasonPack branch. */
  extractedFromPack?: boolean;
  duration?: string;
  easynewsMeta?: any;
  /** Set only when origin === 'library' — direct WebDAV path; handleStream uses this for the fast-path serve. */
  libraryVideoPath?: string;
}

// Search configuration - global API keys and settings shared across all indexers
export interface SearchConfig {
  tmdbApiKey?: string;          // Required when any indexer uses TMDB search
  tvdbApiKey?: string;          // Required when any indexer uses TVDB search
  includeSeasonPacks?: boolean; // Include season packs in episode results (default true)
  seasonPackPagination?: boolean; // Enable pagination for season pack searches (default true)
  seasonPackAdditionalPages?: number;  // Additional pages for season pack searches (1-10)
  useTextSearchForAnime?: boolean; // Override per-indexer search method to use text search for anime (Animation+Japan)
  skipAnimeTitleResolve?: boolean; // Skip TVDB/TMDB title resolution for anime (Animation+Japan) to avoid Japanese titles
  indexerPriorityDedup?: boolean;  // Deduplicate results across indexers, keeping only the copy from the highest-priority indexer (default false)
  urlDedup?: boolean;  // Remove duplicate results with identical download URLs (default true)
  junkFilter?: boolean;  // Strip bare archive parts and NZB containers from search results (default true)
  displayLibraryInResults?: boolean;  // Mark search results that exist in the WebDAV library with the 📚 icon (default true)
  cacheEmptyResults?: boolean;  // Cache search responses that returned zero results (default true)
  absoluteEpisodeFallback?: boolean;  // Series text-search: retry with absolute episode numbering (Title E31) when the SxxExx query returns zero results. UTS only. (default true)
  parallelAlternateTitleSearch?: boolean;  // Run primary + alt-title searches in parallel from the start instead of using alts only as a zero-result fallback. UTS only. (default false)
  tvdbPreferEnglishTitle?: boolean;  // When TVDB's canonical title is non-English, substitute the English translation for indexer text search (default true)
  aliasTitleFallback?: boolean;  // When a UTS search returns zero results, retry once per English alias from TVDB whose normalized form is a strict substring of the canonical title and substantially shorter. UTS only. (default true)
  includeMultiSeasonPacks?: boolean;  // Series Packs master toggle. When true (default for fresh installs, false for users upgrading from before this field existed), gates the multi-season fanout query and keyword queries.
  seriesPackKeywords?: string[];  // Each enabled keyword fires a '<Title> <Keyword>' indexer query to catch keyword-only releases without Sxx tokens. Empty array means no keyword queries fire. Allowed values come from SERIES_PACK_KEYWORDS.
  seriesPackPagination?: boolean;  // Enable pagination for series-pack queries (multi-season fanout + keyword queries). Independent of seasonPackPagination. (default true)
  seriesPackAdditionalPages?: number;  // Additional pages for series-pack queries (1-10).
  librarySearchThreshold?: number;  // 0 = disabled, 1-10 = WebDAV library short-circuit: when scan returns ≥ threshold matches, skip indexer queries entirely
  libraryApplyToMovies?: boolean;  // When false, Ultimate Library is skipped for movie requests (default true)
  libraryApplyToSeries?: boolean;  // When false, Ultimate Library is skipped for series requests (default true)
  librarySearchScanUncategorized?: boolean;  // Include `/content/uncategorized` as a second scan root so manually uploaded NZBDav content is searchable (default true)
  libraryRunOnCacheHit?: boolean;  // When true, Ultimate Library runs on cache hits and short-circuits to UL-only results when the post-filter threshold is met. Below threshold, cached results are returned unchanged. The one-shot Skip tile bypass still wins. (default false)
  libraryDeleteAllTile?: boolean;  // Show one "Delete All Ultimate Library Results" tile near the top of the list. Two-step click-confirm. Scoped to the current request only. (default false)
  libraryDeletePerStreamTile?: boolean;  // Show a delete tile after each library result. Pack results get two tiles (delete file + delete whole pack); non-pack results get one. Two-step click-confirm. (default false)
  libraryDeleteAllPackScope?: 'episode' | 'pack';  // For series/season pack results, the "Delete All" tile deletes the per-episode file ('episode', default) or the entire release folder ('pack')
  librarySkipTilePosition?: 'second' | 'last';  // Where the "Skip Ultimate Library" stream tile appears in the results list (default 'second')
  // Legacy fields - migrated to per-indexer settings, kept for migration
  movieSearchMethod?: 'imdb' | 'tmdb' | 'tvdb' | 'text';
  tvSearchMethod?: 'imdb' | 'tvdb' | 'tvmaze' | 'text';
}

// Canonical chip values for seriesPackKeywords. Single source of truth shared
// by the UI chip selector, the settings whitelist, and the fresh-install
// migration default. Order is alphabetical (matches UI chip order).
export const SERIES_PACK_KEYWORDS = ['All Seasons', 'Anthology', 'Boxset', 'Collection', 'Complete', 'Saga'] as const;
export type SeriesPackKeyword = typeof SERIES_PACK_KEYWORDS[number];

// Our app configuration
export interface Config {
  addonEnabled: boolean;
  indexers: UsenetIndexer[];
  cacheEnabled: boolean;
  cacheTTL: number;  // Cache time in seconds
  streamingMode: 'nzbdav' | 'stremio';  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  proxyMode?: 'disabled' | 'http';  // Proxy mode for indexer requests
  proxyUrl?: string;           // HTTP proxy URL (e.g. http://localhost:8888)
  proxyIndexers?: Record<string, boolean>;  // Per-indexer proxy toggle
  searchConfig?: SearchConfig; // Search method and ID service configuration
  useTextSearch?: boolean;     // Legacy: use text queries instead of ID-based searches
  includeSeasonPacks?: boolean; // Legacy: include season packs in episode results
  cardOrder?: string[];        // Dashboard card order
  userAgents?: UserAgentConfig; // Custom user-agents for different request types
  filters?: FilterConfig;       // Sorting and filtering options (default/fallback)
  movieFilters?: FilterConfig;   // Movie-specific sort/filter overrides (falls back to filters)
  tvFilters?: FilterConfig;      // TV-specific sort/filter overrides (falls back to filters)
  healthChecks?: HealthCheckConfig; // Health check settings for NZB verification
  ultimateFallback?: UltimateFallbackConfig; // Ultimate-Fallback: combined fallback + health checking
  autoPlay?: AutoPlayConfig;   // Auto-play / binge group settings
  streamDisplayConfig?: StreamDisplayConfig; // Stream display customization
  syncedIndexers?: SyncedIndexer[]; // Indexers synced from Prowlarr or NZBHydra
  prowlarrUrl?: string;
  prowlarrApiKey?: string;
  // Accessor applies defaults — always defined at runtime even when absent from config.json.
  prowlarrTimeoutEnabled: boolean;
  prowlarrTimeout: number;
  nzbhydraUrl?: string;
  nzbhydraApiKey?: string;
  nzbhydraUsername?: string;
  nzbhydraPassword?: string;
  // Accessor applies defaults — always defined at runtime.
  nzbhydraTimeoutEnabled: boolean;
  nzbhydraTimeout: number;
  zyclopsEndpoint?: string;            // Zyclops API endpoint URL (default: https://zyclops.elfhosted.com)
  nzbdavUrl?: string;
  nzbdavApiKey?: string;
  nzbdavWebdavUrl?: string;
  nzbdavWebdavUser?: string;
  nzbdavWebdavPassword?: string;
  nzbdavMoviesCategory?: string;
  nzbdavTvCategory?: string;
  nzbdavCacheTimeouts?: boolean;              // Store timed-out NZBs in dead cache (default true)
  nzbdavStreamBufferMB?: number;              // Dual-stage proxy buffer size in MB (default 128, range 8-256)
  nzbdavPipeBufferMB?: number;                // Pipe mode buffer size in MB (default 8, range 1-16)
  nzbdavStreamingMethod?: 'pipe' | 'proxy' | 'direct';  // Streaming delivery: proxy (default, dual-stage buffer), pipe, or direct (WebDAV redirect)
  healthyNzbDbMode?: 'time' | 'storage';      // Database limit mode for successful streams (default 'time')
  healthyNzbDbTTL?: number;                   // TTL in seconds for successful streams when mode is 'time' (default 259200 / 3 days)
  healthyNzbDbMaxSizeMB?: number;             // Max storage in MB for successful streams when mode is 'storage' (default 50)
  filterDeadNzbs?: boolean;                    // Filter dead NZBs from search results (default true)
  deadNzbDbMode?: 'time' | 'storage';         // Database limit mode for dead NZBs (default 'storage')
  deadNzbDbTTL?: number;                      // TTL in seconds for dead NZBs when mode is 'time' (default 86400)
  deadNzbDbMaxSizeMB?: number;                // Max storage in MB for dead NZBs when mode is 'storage' (default 50)
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;  // Enable paginated search (default false)
  easynewsMaxPages?: number;     // Additional pages when pagination enabled (1-10, default 3)
  // Accessor applies defaults — always defined at runtime.
  easynewsTimeoutEnabled: boolean;
  easynewsTimeout: number;
  easynewsMode?: 'ddl' | 'nzb'; // DDL = direct download/stream, NZB = send to download client
  easynewsHealthCheck?: boolean; // Include EasyNews NZB results in health checks (default true)
  indexerPriority?: string[];    // Ordered indexer names for dedup priority (position 0 = highest priority)
  searchTimeoutOverride?: number; // SEARCH_TIMEOUT env var override (seconds, 1-120)
}

// Auto-play / binge group configuration
export type AutoPlayMethod = 'matchingFile' | 'matchingIndex' | 'firstFile';
export type AutoPlayAttribute = 'resolution' | 'quality' | 'encode' | 'visualTag' | 'audioTag' | 'releaseGroup' | 'indexer' | 'edition';

export interface AutoPlayConfig {
  enabled: boolean;
  method: AutoPlayMethod;
  attributes: AutoPlayAttribute[];
}

// Stream display customization config
export interface StreamDisplayElement {
  id: string;                    // Stable identifier: 'resolution', 'quality', 'healthBadge', etc.
  label: string;                 // Human-readable name: "Resolution", "Quality", etc.
  enabled: boolean;              // Whether this element is shown
  prefix: string;                // Emoji/text prefix, e.g. "💾", "⚙️", "🎨"
}

export interface StreamDisplayLineGroup {
  id: string;                    // Unique group id
  elementIds: string[];          // Element IDs in this group, rendered left-to-right
  indent: boolean;               // Whether to indent the line with "  " prefix
}

export interface StreamDisplayConfig {
  nameElements: string[];        // Ordered list of element IDs for the `name` column
  elements: Record<string, StreamDisplayElement>; // All element definitions
  seasonPackPrefix: string;      // Prefix for season pack title lines (default "📦")
  regularPrefix: string;         // Prefix for regular title lines (default "▸")
  lineGroups: StreamDisplayLineGroup[]; // Groups of elements that share a line in the title
  cleanTitles: boolean;          // true = parsed clean title, false = raw release title
}

// User-Agent configuration for different request types
export interface UserAgentConfig {
  indexerSearch?: string;    // For indexer API searches
  nzbDownload?: string;      // For downloading NZB files
  nzbdavOperations?: string; // For NZBDav API operations
  webdavOperations?: string; // For WebDAV operations
  general?: string;          // For general requests (favicon, etc.)
}

// Sorting and filtering configuration
export interface FilterConfig {
  sortOrder: string[];                       // Sort priority order ['quality', 'size', 'videoTag', 'encode', 'visualTag', 'audioTag']
  enabledSorts?: Record<string, boolean>;    // Which sort methods are enabled
  sortDirections?: Record<string, 'asc' | 'desc'>; // Sort direction per method (age, bitrate)
  enabledPriorities?: {
    resolution?: Record<string, boolean>;    // Which resolutions are enabled
    video?: Record<string, boolean>;         // Which video sources are enabled
    encode?: Record<string, boolean>;        // Which encodes are enabled
    visualTag?: Record<string, boolean>;     // Which visual tags are enabled
    audioTag?: Record<string, boolean>;      // Which audio tags are enabled
    language?: Record<string, boolean>;      // Which languages are enabled
    edition?: Record<string, boolean>;       // Which editions are enabled
  };
  minFileSize?: number;                      // Min file size in bytes — individual files only, excludes season packs (undefined = no minimum)
  maxFileSize?: number;                      // Max file size in bytes — individual files only, excludes season packs (undefined = unlimited)
  minSeasonPackSize?: number;                // Min season pack total size in bytes (undefined = no minimum)
  maxSeasonPackSize?: number;                // Max season pack total size in bytes (undefined = unlimited)
  minSeasonPackEpisodeSize?: number;         // Min per-episode size for season packs in bytes (undefined = no minimum)
  maxSeasonPackEpisodeSize?: number;         // Max per-episode size for season packs in bytes (undefined = unlimited)
  maxStreams?: number;                       // Max total streams to return (default unlimited)
  maxStreamsPerResolution?: number;           // Max streams per resolution level (undefined = unlimited)
  maxStreamsPerQuality?: number;             // Max streams per video source quality level (undefined = unlimited)
  maxSeasonPacks?: number;                   // TV-only. Max season packs in results (undefined = unlimited). Excludes deprioritized yearless packs from the count.
  resolutionPriority?: string[];             // Resolution priority order for sorting
  videoPriority?: string[];                  // Video source priority order for sorting
  encodePriority?: string[];                 // Video encode priority order for sorting
  visualTagPriority?: string[];              // Visual tag priority order for sorting (HDR, DV, etc)
  audioTagPriority?: string[];               // Audio tag priority order for sorting (Atmos, DTS, etc)
  languagePriority?: string[];               // Language priority order for sorting
  editionPriority?: string[];                // Edition priority order for sorting (Extended, DC, etc)
  preferNonStandardEdition?: boolean;        // Prioritize all enabled non-standard editions equally over Standard
  preferSeasonPacks?: boolean;               // TV-only. Sort season packs above non-packs; secondary sort still applies within each group.
  preferLibraryResults?: boolean;            // Sort indexer/EasyNews results flagged as in-library above the rest. Library short-circuit case is unaffected (all results are library).
  enableRemakeFiltering?: boolean;           // TV-only. Cross-reference TVDB to filter wrong-version results for shows with remakes. Default true. Env: ENABLE_REMAKE_DETECTION.
  allowMultiEpisodeFiles?: boolean;          // TV-only. Allow multi-episode files (e.g. S01E01E02.mkv). Default true. Env: ALLOW_MULTI_EPISODE_FILES.
  rules?: {
    rankedRegexPatterns?: RankedRegexRule[];
    rankedStreamExpressions?: RankedSelRule[];
    remoteRankedRegexUrls?: string[];
    remoteRankedStreamExpressionUrls?: string[];
  };
}

// Ranked rule shared shape. score: positive boosts, negative penalizes (regex
// rules also support 'keep'/'drop' modes that filter the pool — see RankedRegexRule.mode).
interface RankedRuleBase {
  id: string;                   // Stable UUID for React keys and cross-tab identity
  name: string;                 // Display name
  score: number;                // Boosts/penalizes when score mode; clamped to ±10_000 at save time
  enabled?: boolean;            // Defaults to true when undefined
}

export interface RankedRegexRule extends RankedRuleBase {
  pattern: string;              // Regex source, no leading/trailing slashes
  flags?: string;               // Regex flags (e.g. 'i')
  mode?: 'score' | 'keep' | 'drop';  // 'score' (default) adds to score; 'keep' acts as include filter (only match-any-keep candidates survive); 'drop' removes matches from pool
}

export interface RankedSelRule extends RankedRuleBase {
  expression: string;           // Stream Expression Language source
}

// Usenet provider for health checking
export interface UsenetProvider {
  id: string;                    // UUID for stable identity
  name: string;                  // Display name (e.g., "Eweka", "UsenetExpress")
  host: string;                  // Usenet provider hostname
  port: number;                  // Usenet provider port (typically 119 or 563)
  useTLS: boolean;               // Use SSL/TLS for secure connection
  username: string;              // Usenet account username
  password: string;              // Usenet account password
  enabled: boolean;              // Can turn providers on/off
  type: 'pool' | 'backup';      // Pool = primary, Backup = fallback for missing articles
}

// Health check configuration for verifying NZB availability
export interface HealthCheckConfig {
  enabled: boolean;              // Enable/disable health checking
  mode?: 'full' | 'quick';      // Legacy — migrated to archiveInspection + sampleCount
  archiveInspection: boolean;    // Download and inspect archive headers (encryption, nested archives, video content)
  sampleCount: 3 | 7;           // Number of article segments to sample for availability
  providers: UsenetProvider[];   // Usenet providers for article checking
  nzbsToInspect: number;         // Number of top results to health check (used in 'fixed' mode)
  inspectionMethod: 'fixed' | 'smart'; // Fixed count vs smart stop-on-healthy
  smartBatchSize: number;        // NZBs per batch in smart mode (1-6; default 3)
  smartAdditionalRuns: number;   // Additional batches if threshold not met (0-5; default 1)
  smartMinHealthy: number;       // Healthy results required before smart mode stops (1-10; default 1)
  maxConnections: number;        // Max concurrent health check workers
  autoQueueMode: 'off' | 'top' | 'all';  // Auto-queue mode: off, top verified result, or all verified results
  hideBlocked: boolean;          // Filter out blocked NZBs from results
  libraryPreCheck: boolean;      // Check NZBDav library before NNTP checks — skip checking content already downloaded
  healthCheckIndexers?: Record<string, boolean>; // Per-indexer health check enable/disable
}

// Ultimate-Fallback: combines retry-on-failure with Health Checking for fastest resolution
export interface UltimateFallbackConfig {
  enabled: boolean;
  healthCheckEnabled?: boolean;        // Run NNTP health-check pre-flight before nzbdav submission (default false)
  whenToResolve: 'on-results' | 'on-tile-selection';   // When to fire UF — on search results or on user tile click (default on-tile-selection)
  userPickFallback: 'uf-lobby' | 'failure-video' | 'fallback-chain';      // When an individual stream tile fails — show failure video (default), fall into UF lobby, or walk the chain
  candidateCount: number;              // Active pool size (1-10, default 1)
  preferenceMode: 'priority' | 'speed';
  archiveInspection: boolean;
  sampleCount: 3 | 7;
  maxAttempts: number;                 // Cap on total primary search attempts before giving up (0 = unlimited, 1-20 = cap, default 0). Library hits don't count.
  desiredBackups: number;              // Target backups post-primary (0 = no replacement pulls; free library/in-flight still cache. 1-10 = target count, default 0)
  backupProcessingLimit: number;       // Max candidates to evaluate for backup (0 = all, 1-20 = limit, default 3)
  // Per-mode nzbdav job-completion wait times (0-90s, 0 = wait forever). Active set picked by preferenceMode at runtime.
  priorityMoviesTimeoutSeconds: number;
  priorityTvTimeoutSeconds: number;
  prioritySeasonPackTimeoutSeconds: number;
  speedMoviesTimeoutSeconds: number;
  speedTvTimeoutSeconds: number;
  speedSeasonPackTimeoutSeconds: number;
  healthCheckIndexers?: Record<string, boolean>;
}

// Device manifest — each represents a Stremio installation
export interface Manifest {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

// User account for authentication
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  manifestKey?: string;   // Legacy — kept for rollback compatibility
  manifests: Manifest[];
  createdAt: string;
}

// Persisted users data file structure
export interface UsersData {
  jwtSecret: string;
  users: User[];
}

// Synced indexer from Prowlarr or NZBHydra (distinct from manually-added UsenetIndexer)
export interface SyncedIndexer {
  id: string;                       // Prowlarr numeric ID (as string) or NZBHydra indexer name
  name: string;                     // Display name from remote service
  enabledForSearch: boolean;        // Include in searches
  enabledForHealthCheck: boolean;   // Include in health checks
  movieSearchMethod: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  tvSearchMethod: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  animeMovieSearchMethod?: ('imdb' | 'tmdb' | 'tvdb' | 'text')[];
  animeTvSearchMethod?: ('imdb' | 'tvdb' | 'tvmaze' | 'text')[];
  capabilities?: IndexerCaps;
  logo?: string;
  pagination?: boolean;             // Enable paginated search (default false)
  additionalPages?: number;         // Additional pages to fetch when pagination enabled (1-10, default 3)
}

// Prowlarr API search result shape
export interface ProwlarrSearchResult {
  title: string;
  downloadUrl: string;
  size: number;
  publishDate: string;
  indexer: string;
  indexerId: number;
  categories: { id: number; name: string }[];
  imdbId?: number;
  tmdbId?: number;
  tvdbId?: number;
}

// Raw search result from Newznab API
export interface NZBSearchResult {
  title: string;        // Release name
  link: string;         // NZB download URL
  size: number;         // Size in bytes
  pubDate: string;      // When it was posted
  category: string;     // Movie/TV category
  isSeasonPack?: boolean;           // True if this is a full-season download
  estimatedEpisodeSize?: number;    // Estimated per-episode size (pack size / episode count)
  attributes: {         // Extra metadata
    size?: string;
    grabs?: string;     // How many times downloaded
    files?: string;     // Number of files
  };
  duration?: number;                   // Duration in seconds (EasyNews, or from Newznab runtime attribute)
  zyclopsVerified?: boolean;           // True if result came through Zyclops (pre-verified healthy)
  easynewsMeta?: {      // EasyNews direct download metadata (only present for EasyNews results)
    hash: string;
    filename: string;
    ext: string;
    dlFarm: string;
    dlPort: string;
    downURL: string;
    sig?: string;        // Signature required for NZB download via dl-nzb API
  };
}
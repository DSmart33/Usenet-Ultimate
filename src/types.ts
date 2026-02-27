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
  caps?: IndexerCaps;  // Discovered capabilities from ?t=caps
  pagination?: boolean; // Enable paginated search (default false)
  maxPages?: number;    // Max extra pages to fetch when pagination enabled (1-10, default 3)
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
}

// Valid Zyclops backbone identifiers
export const ZYCLOPS_BACKBONES = [
  'abavia', 'base-ip', 'elbracht', 'eweka-internet-services',
  'giganews', 'its-hosted', 'netnews', 'omicron',
  'usenetexpress', 'uzo-reto'
] as const;

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
  // Legacy fields - migrated to per-indexer settings, kept for migration
  movieSearchMethod?: 'imdb' | 'tmdb' | 'tvdb' | 'text';
  tvSearchMethod?: 'imdb' | 'tvdb' | 'tvmaze' | 'text';
}

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
  autoPlay?: AutoPlayConfig;   // Auto-play / binge group settings
  streamDisplayConfig?: StreamDisplayConfig; // Stream display customization
  syncedIndexers?: SyncedIndexer[]; // Indexers synced from Prowlarr or NZBHydra
  prowlarrUrl?: string;
  prowlarrApiKey?: string;
  nzbhydraUrl?: string;
  nzbhydraApiKey?: string;
  nzbhydraUsername?: string;
  nzbhydraPassword?: string;
  zyclopsEndpoint?: string;            // Zyclops API endpoint URL (default: https://zyclops.elfhosted.com)
  nzbdavUrl?: string;
  nzbdavApiKey?: string;
  nzbdavWebdavUrl?: string;
  nzbdavWebdavUser?: string;
  nzbdavWebdavPassword?: string;
  nzbdavMoviesCategory?: string;
  nzbdavTvCategory?: string;
  nzbdavFallbackEnabled?: boolean; // Master toggle for fallback feature (default true)
  nzbdavMaxFallbacks?: number;  // 0 = try all results (default), 1-20 = limit
  nzbdavJobTimeoutSeconds?: number;            // Legacy — use nzbdavMoviesTimeoutSeconds / nzbdavTvTimeoutSeconds
  nzbdavMoviesTimeoutSeconds?: number;         // Max seconds to wait for movie streams (default 30)
  nzbdavTvTimeoutSeconds?: number;             // Max seconds to wait for TV streams (default 15)
  nzbdavFallbackOrder?: 'selected' | 'top';   // Start from clicked NZB or top of quality-sorted list
  easynewsEnabled?: boolean;
  easynewsUsername?: string;
  easynewsPassword?: string;
  easynewsPagination?: boolean;  // Enable paginated search (default false)
  easynewsMaxPages?: number;     // Additional pages when pagination enabled (1-10, default 3)
  easynewsMode?: 'ddl' | 'nzb'; // DDL = direct download/stream, NZB = send to download client
  easynewsHealthCheck?: boolean; // Include EasyNews NZB results in health checks (default false = auto healthy)
  indexerPriority?: string[];    // Ordered indexer names for dedup priority (position 0 = highest priority)
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
  enabledPriorities?: {
    resolution?: Record<string, boolean>;    // Which resolutions are enabled
    video?: Record<string, boolean>;         // Which video sources are enabled
    encode?: Record<string, boolean>;        // Which encodes are enabled
    visualTag?: Record<string, boolean>;     // Which visual tags are enabled
    audioTag?: Record<string, boolean>;      // Which audio tags are enabled
    language?: Record<string, boolean>;      // Which languages are enabled
    edition?: Record<string, boolean>;       // Which editions are enabled
  };
  maxFileSize?: number;                      // Max file size in bytes (undefined = unlimited)
  maxStreams?: number;                       // Max total streams to return (default 10)
  maxStreamsPerQuality?: number;             // Max streams per quality level (undefined = unlimited)
  resolutionPriority?: string[];             // Resolution priority order for sorting
  videoPriority?: string[];                  // Video source priority order for sorting
  encodePriority?: string[];                 // Video encode priority order for sorting
  visualTagPriority?: string[];              // Visual tag priority order for sorting (HDR, DV, etc)
  audioTagPriority?: string[];               // Audio tag priority order for sorting (Atmos, DTS, etc)
  languagePriority?: string[];               // Language priority order for sorting
  editionPriority?: string[];                // Edition priority order for sorting (Extended, DC, etc)
  preferNonStandardEdition?: boolean;        // Prioritize all enabled non-standard editions equally over Standard
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
  smartBatchSize: number;        // NZBs per batch in smart mode (1, 2, or 3; default 3)
  smartAdditionalRuns: number;   // Additional batches if no healthy found (0-5; default 1)
  maxConnections: number;        // Max concurrent health check workers
  autoQueueMode: 'off' | 'top' | 'all';  // Auto-queue mode: off, top verified result, or all verified results
  hideBlocked: boolean;          // Filter out blocked NZBs from results
  libraryPreCheck: boolean;      // Check NZBDav library before NNTP checks — skip checking content already downloaded
  healthCheckIndexers?: Record<string, boolean>; // Per-indexer health check enable/disable
  segmentCache?: {               // Missing segment cache for instant rejection of known-dead NZBs
    enabled: boolean;            // default true
    ttlHours: number;            // default 0 (no expiry), 0 = never expire
    maxSizeMB: number;           // default 50
  };
}

// User account for authentication
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  manifestKey: string;
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
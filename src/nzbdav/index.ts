/**
 * NZBDav Module
 * Re-exports all public symbols from the nzbdav submodules.
 */

// Types
export type { NZBDavConfig, FallbackCandidate } from './types.js';

// Fallback management
export { createFallbackGroup, getFallbackGroup, clearFallbackGroups } from './fallbackManager.js';

// Stream cache
export { getOrCreateStream, isStreamCached, isDeadNzbByUrl, addDeadNzbByUrl } from './streamCache.js';

// Cache utilities
export { getCacheStats, clearStreamCache, clearReadyCache, clearFailedCache, deleteCacheEntry, getCacheEntries, saveCacheToDisk } from './cacheUtils.js';

// Stream handler (Express endpoint)
export { handleStream } from './streamHandler.js';

/**
 * Cache Utilities
 * Re-exports cache stats and clear functions for external consumers.
 */

export { getCacheStats, clearStreamCache, clearReadyCache, clearFailedCache, clearTimeoutDeadEntries, deleteCacheEntry, getCacheEntries, isStreamCached, saveCacheToDisk, evictReadyByVideoPath } from './streamCache.js';

/**
 * NZBDav Module
 * Re-exports all public symbols from the nzbdav submodules.
 */

// Types
export type { NZBDavConfig, FallbackCandidate } from './types.js';

// Fallback management
export { createFallbackGroup, getFallbackGroup } from './fallbackManager.js';

// Stream cache
export { getOrCreateStream, isStreamCached } from './streamCache.js';

// Cache utilities
export { getCacheStats, clearStreamCache } from './cacheUtils.js';

// Stream handler (Express endpoint)
export { handleStream } from './streamHandler.js';

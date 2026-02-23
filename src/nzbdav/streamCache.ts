/**
 * Stream Cache
 * Three-state caching with promise sharing for stream preparation.
 * States: pending (promise), ready (video path), failed (error).
 * Concurrent requests for the same stream share a single promise.
 */

import type { CacheEntry, StreamData, NZBDavConfig } from './types.js';

const streamCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAILED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for failures (allow retry)

/** Injected stream preparation function (set by streamHandler to break circular dep) */
type PrepareFn = (nzbUrl: string, title: string, config: NZBDavConfig, episodePattern?: string, contentType?: string, episodesInSeason?: number) => Promise<StreamData>;
let prepareFn: PrepareFn | null = null;

export function setPrepareFn(fn: PrepareFn): void {
  prepareFn = fn;
}

export function getCacheKey(nzbUrl: string, title: string): string {
  return `${nzbUrl}::${title}`;
}

function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of streamCache.entries()) {
    if (entry.expiresAt < now) {
      streamCache.delete(key);
    }
  }
}

/**
 * Get or create a stream preparation task with promise sharing
 */
export async function getOrCreateStream(
  nzbUrl: string,
  title: string,
  config: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number
): Promise<StreamData> {
  cleanupExpiredCache();

  const cacheKey = getCacheKey(nzbUrl, title) + (episodePattern ? `:${episodePattern}` : '');
  const existing = streamCache.get(cacheKey);

  if (existing) {
    switch (existing.status) {
      case 'ready':
        // Don't log ready-state cache hits — they fire on every range request
        // during active playback and flood the console. The proxy log covers it.
        return existing.data!;

      case 'pending':
        console.log(`\u23F3 Cache hit (pending): ${title}`);
        return existing.promise!;

      case 'failed':
        console.log(`\u274C Cache hit (failed): ${title} - ${existing.error?.message}`);
        throw existing.error!;
    }
  }

  if (!prepareFn) throw new Error('Stream cache not initialised: prepareFn not set');

  // Create new preparation task
  console.log(`\u{1F195} Starting new stream preparation: ${title}`);

  const promise = prepareFn(nzbUrl, title, config, episodePattern, contentType, episodesInSeason);

  // Set as pending immediately
  streamCache.set(cacheKey, {
    status: 'pending',
    promise,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  // Handle completion
  promise.then((data) => {
    streamCache.set(cacheKey, {
      status: 'ready',
      data,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }).catch((error) => {
    // Only cache NZBDav failures (not network errors, etc.)
    if (error.isNzbdavFailure) {
      streamCache.set(cacheKey, {
        status: 'failed',
        error,
        expiresAt: Date.now() + FAILED_CACHE_TTL_MS,
      });
    } else {
      // Allow retry for transient errors
      streamCache.delete(cacheKey);
    }
  });

  return promise;
}

/**
 * Get the raw stream cache map (used by streamHandler for fallback skip logic)
 */
export function getStreamCache(): Map<string, CacheEntry> {
  return streamCache;
}

/**
 * Clear the stream cache (useful for testing/debugging)
 */
export function clearStreamCache(): void {
  streamCache.clear();
  console.log('\u{1F9F9} Stream cache cleared');
}

/**
 * Check if a stream is already cached (pending, ready, or failed)
 */
export function isStreamCached(nzbUrl: string, title: string): boolean {
  const cacheKey = getCacheKey(nzbUrl, title);
  return streamCache.has(cacheKey);
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { total: number; ready: number; pending: number; failed: number } {
  let ready = 0, pending = 0, failed = 0;

  for (const entry of streamCache.values()) {
    switch (entry.status) {
      case 'ready': ready++; break;
      case 'pending': pending++; break;
      case 'failed': failed++; break;
    }
  }

  return { total: streamCache.size, ready, pending, failed };
}

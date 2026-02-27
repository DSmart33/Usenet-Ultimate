/**
 * Stream Cache
 * Three-state caching with promise sharing for stream preparation.
 * States: pending (promise), ready (video path), failed (error).
 * Concurrent requests for the same stream share a single promise.
 */

import type { CacheEntry, StreamData, NZBDavConfig } from './types.js';
import { config as globalConfig } from '../config/index.js';

const streamCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getFailedCacheTTLMs(): number {
  return (globalConfig.cacheTTL || 43200) * 1000;
}

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

      case 'pending': {
        // Safety net: if the entry has expired since cleanup ran, evict and retry
        if (existing.expiresAt <= Date.now()) {
          console.log(`\u23F3 Pending entry expired — evicting stale cache: ${title}`);
          streamCache.delete(cacheKey);
          break; // Fall through to create new preparation
        }
        console.log(`\u23F3 Cache hit (pending): ${title}`);
        return existing.promise!;
      }

      case 'failed':
        console.log(`\u274C Cache hit (failed): ${title} - ${existing.error?.message}`);
        throw existing.error!;
    }
  }

  if (!prepareFn) throw new Error('Stream cache not initialised: prepareFn not set');

  // Create new preparation task
  console.log(`\u{1F195} Starting new stream preparation: ${title}`);

  const promise = prepareFn(nzbUrl, title, config, episodePattern, contentType, episodesInSeason);

  // Set as pending with a short TTL — if the promise hangs, the entry
  // expires and subsequent requests can retry instead of hanging forever.
  const maxTimeout = Math.max(globalConfig.nzbdavMoviesTimeoutSeconds ?? 30, globalConfig.nzbdavTvTimeoutSeconds ?? 15);
  const pendingTTLMs = (maxTimeout + 30) * 1000;
  streamCache.set(cacheKey, {
    status: 'pending',
    promise,
    expiresAt: Date.now() + pendingTTLMs,
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
        expiresAt: Date.now() + getFailedCacheTTLMs(),
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
 * Check if a stream is already cached (pending, ready, or failed).
 * Uses only the base key (nzbUrl + title) as a coarse check — any episode
 * of the same NZB being cached will match. This is intentional for grab
 * tracking dedup: we don't want to count the same NZB grab multiple times
 * even if different episodes are requested.
 */
export function isStreamCached(nzbUrl: string, title: string): boolean {
  const baseKey = getCacheKey(nzbUrl, title);
  const now = Date.now();
  // Check both the base key and any episode-suffixed keys, skipping expired entries
  for (const [key, entry] of streamCache.entries()) {
    if ((key === baseKey || key.startsWith(baseKey + ':')) && entry.expiresAt > now) return true;
  }
  return false;
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

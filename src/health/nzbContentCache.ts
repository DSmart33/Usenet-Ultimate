/**
 * NZB Content Cache
 *
 * Caches raw NZB XML content downloaded during health checks so that
 * auto-queue to NZBDav can reuse it without re-downloading from the indexer.
 * This saves an API grab on indexers that count downloads.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 50;

interface CacheEntry {
  content: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/** Store raw NZB XML content keyed by URL */
export function cacheNzbContent(url: string, content: string): void {
  // Evict expired entries opportunistically
  const now = Date.now();
  if (cache.size >= MAX_ENTRIES) {
    for (const [key, entry] of cache) {
      if (now - entry.timestamp > TTL_MS) cache.delete(key);
    }
  }
  // If still at capacity, evict oldest
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(url, { content, timestamp: now });
}

/** Retrieve cached NZB content, or undefined if expired/missing */
export function getCachedNzbContent(url: string): string | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  return entry.content;
}

/**
 * Stream Cache
 * Three independent caches:
 *   1. pendingCache  — in-flight preparation promises (transient, resolve on their own)
 *   2. readyCache    — successful streams with video paths (configurable TTL, up to 4 days)
 *   3. deadNzbCache  — known-bad NZBs to skip on retry (configurable TTL, up to 4 days)
 * Concurrent requests for the same stream share a single pending promise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CacheEntry, StreamData, NZBDavConfig } from './types.js';
import { config as globalConfig } from '../config/index.js';
import { clearFallbackGroups } from './fallbackManager.js';
import { clearDeliveryLog } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const READY_CACHE_FILE = path.join(__dirname, '..', '..', 'config', 'healthy-nzbs.json');
const DEAD_NZB_CACHE_FILE = path.join(__dirname, '..', '..', 'config', 'dead-nzbs.json');

/** Pending preparations — in-flight promises that resolve into readyCache or deadNzbCache */
const pendingCache = new Map<string, CacheEntry>();

/** Dynamic TTL helpers — when mode is 'storage', entries never expire by time */
function getReadyTTLMs(): number {
  if (globalConfig.healthyNzbDbMode === 'storage') return Infinity;
  return (globalConfig.healthyNzbDbTTL ?? 259200) * 1000;
}
function getDeadTTLMs(): number {
  if (globalConfig.deadNzbDbMode === 'storage') return Infinity;
  return (globalConfig.deadNzbDbTTL ?? 86400) * 1000;
}

/** Estimate byte size of the ready cache (plain objects — JSON.stringify is accurate) */
function estimateReadyCacheSize(): number {
  let total = 0;
  for (const [key, value] of readyCache.entries()) {
    total += key.length + JSON.stringify(value).length;
  }
  return total;
}

/** Estimate byte size of the dead NZB cache (Error properties are non-enumerable) */
function estimateDeadCacheSize(): number {
  let total = 0;
  for (const [key, entry] of deadNzbCache.entries()) {
    total += key.length + (entry.title?.length ?? 0) + (entry.indexerName?.length ?? 0) + (entry.error.message?.length ?? 0) + 50;
  }
  return total;
}

/** FIFO-evict oldest entries until the cache is under the given MB limit */
function enforceStorageLimit(cache: Map<string, any>, sizeFn: () => number, maxMB: number): void {
  const maxBytes = maxMB * 1024 * 1024;
  while (sizeFn() > maxBytes && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
    else break;
  }
}

/**
 * Healthy cache — successful streams, persisted to disk, survives restarts.
 * Used to short-circuit repeat requests for the same stream within the TTL window.
 * The first request runs the full prep pipeline; subsequent requests return the cached result.
 */
interface ReadyEntry { data: StreamData; indexerName?: string; createdAt: number; expiresAt: number }
const readyCache = new Map<string, ReadyEntry>();

/** Dead NZBs — persisted to disk, survives restarts */
interface DeadNzbEntry { title: string; indexerName?: string; error: Error; createdAt: number; expiresAt: number }
const deadNzbCache = new Map<string, DeadNzbEntry>();

// ── Disk persistence ──────────────────────────────────────────────────

interface SerializedDeadEntry {
  title?: string;
  indexerName?: string;
  error: { message: string; isNzbdavFailure: boolean };
  createdAt?: number;
  expiresAt: number;
}

function loadCacheFromDisk(): void {
  const now = Date.now();
  try {
    const raw = JSON.parse(fs.readFileSync(READY_CACHE_FILE, 'utf-8')) as Record<string, ReadyEntry>;
    for (const [key, entry] of Object.entries(raw)) {
      const expiresAt = entry.expiresAt || Infinity;
      if (expiresAt > now) {
        readyCache.set(key, { ...entry, createdAt: (entry as any).createdAt || now, expiresAt });
      }
    }
    if (readyCache.size) console.log(`💾 Loaded ${readyCache.size} ready streams from disk`);
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(DEAD_NZB_CACHE_FILE, 'utf-8')) as Record<string, SerializedDeadEntry>;
    for (const [key, entry] of Object.entries(raw)) {
      const expiresAt = entry.expiresAt || Infinity;
      if (expiresAt > now) {
        const error = new Error(entry.error.message);
        (error as any).isNzbdavFailure = entry.error.isNzbdavFailure;
        if (entry.title) {
          // New format — key is url or url::episodePattern, title stored in entry
          deadNzbCache.set(key, { title: entry.title, indexerName: entry.indexerName, error, createdAt: (entry as any).createdAt || now, expiresAt });
        } else {
          // Old format — key is url::title or url::title:episodePattern, migrate
          const title = extractTitle(key);
          const url = key.substring(0, key.indexOf('::'));
          const afterSep = key.substring(key.indexOf('::') + 2);
          const epMatch = afterSep.match(/:S\d+[\[. _-]/);
          const episodePattern = epMatch ? afterSep.substring(epMatch.index! + 1) : undefined;
          const newKey = getDeadCacheKey(url, episodePattern);
          deadNzbCache.set(newKey, { title, indexerName: entry.indexerName, error, createdAt: (entry as any).createdAt || now, expiresAt });
        }
      }
    }
    if (deadNzbCache.size) console.log(`💾 Loaded ${deadNzbCache.size} dead NZBs from disk`);
  } catch {}
}

export function saveCacheToDisk(): void {
  const now = Date.now();
  const readyData: Record<string, ReadyEntry> = {};
  for (const [key, entry] of readyCache.entries()) {
    if (entry.expiresAt > now) {
      readyData[key] = { ...entry, createdAt: entry.createdAt, expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0 };
    }
  }
  try { fs.writeFileSync(READY_CACHE_FILE, JSON.stringify(readyData, null, 2)); } catch {}

  const deadData: Record<string, SerializedDeadEntry> = {};
  for (const [key, entry] of deadNzbCache.entries()) {
    if (entry.expiresAt > now) {
      deadData[key] = {
        title: entry.title,
        indexerName: entry.indexerName,
        error: { message: entry.error.message, isNzbdavFailure: (entry.error as any).isNzbdavFailure ?? false },
        createdAt: entry.createdAt,
        expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0,
      };
    }
  }
  try { fs.writeFileSync(DEAD_NZB_CACHE_FILE, JSON.stringify(deadData, null, 2)); } catch {}
}

loadCacheFromDisk();
recalculateTTLExpirations();

/** Injected stream preparation function (set by streamHandler to break circular dep) */
type PrepareFn = (nzbUrl: string, title: string, config: NZBDavConfig, episodePattern?: string, contentType?: string, episodesInSeason?: number) => Promise<StreamData>;
let prepareFn: PrepareFn | null = null;

export function setPrepareFn(fn: PrepareFn): void {
  prepareFn = fn;
}

export function getCacheKey(nzbUrl: string, title: string): string {
  return `${nzbUrl}::${title}`;
}

export function getDeadCacheKey(nzbUrl: string, episodePattern?: string): string {
  return episodePattern ? `${nzbUrl}::${episodePattern}` : nzbUrl;
}

export function cleanupExpiredCache(): void {
  const now = Date.now();
  let removed = false;
  for (const [key, entry] of pendingCache.entries()) {
    if (entry.expiresAt < now) pendingCache.delete(key);
  }
  for (const [key, entry] of readyCache.entries()) {
    if (entry.expiresAt < now) { readyCache.delete(key); removed = true; }
  }
  for (const [key, entry] of deadNzbCache.entries()) {
    if (entry.expiresAt < now) { deadNzbCache.delete(key); removed = true; }
  }
  if (removed) saveCacheToDisk();
}

/**
 * Recalculate expiresAt for all existing entries based on current TTL settings.
 * Called when TTL or mode changes so existing entries reflect the new policy.
 */
export function recalculateTTLExpirations(): void {
  const readyTTL = getReadyTTLMs();
  for (const entry of readyCache.values()) {
    entry.expiresAt = entry.createdAt + readyTTL;
  }
  const deadTTL = getDeadTTLMs();
  for (const entry of deadNzbCache.values()) {
    entry.expiresAt = entry.createdAt + deadTTL;
  }
  cleanupExpiredCache();
  // Enforce storage limits when in storage mode (handles mode switch or reduced MaxSizeMB)
  if (globalConfig.healthyNzbDbMode === 'storage') {
    enforceStorageLimit(readyCache, estimateReadyCacheSize, globalConfig.healthyNzbDbMaxSizeMB ?? 50);
  }
  if (globalConfig.deadNzbDbMode === 'storage') {
    enforceStorageLimit(deadNzbCache, estimateDeadCacheSize, globalConfig.deadNzbDbMaxSizeMB ?? 50);
  }
  saveCacheToDisk();
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
  episodesInSeason?: number,
  indexerName?: string,
  verbose = true
): Promise<StreamData> {
  cleanupExpiredCache();

  const cacheKey = getCacheKey(nzbUrl, title) + (episodePattern ? `:${episodePattern}` : '');

  // Check healthy cache — return immediately if already prepared
  const ready = readyCache.get(cacheKey);
  if (ready && ready.expiresAt > Date.now()) {
    if (verbose) console.log(`\u2705 NZB Database (healthy): ${title}`);
    return ready.data;
  }

  // Check dead NZB cache — known-bad NZBs are skipped instantly
  const deadKey = getDeadCacheKey(nzbUrl, episodePattern);
  const dead = deadNzbCache.get(deadKey);
  if (dead) {
    if (verbose) console.log(`\u274C NZB Database (dead): ${title} - ${dead.error.message}`);
    throw dead.error;
  }

  // Check pending cache — share the in-flight promise
  const pending = pendingCache.get(cacheKey);
  if (pending) {
    if (pending.expiresAt <= Date.now()) {
      if (verbose) console.log(`\u23F3 NZB Database (expired): ${title}`);
      pendingCache.delete(cacheKey);
    } else {
      if (verbose) console.log(`\u23F3 NZB Database (pending): ${title}`);
      return pending.promise!;
    }
  }

  if (!prepareFn) throw new Error('Stream cache not initialised: prepareFn not set');

  // Create new preparation task
  if (verbose) console.log(`\u{1F195} Starting new stream preparation: ${title}`);

  const promise = prepareFn(nzbUrl, title, config, episodePattern, contentType, episodesInSeason);

  // Set as pending with a short TTL — if the promise hangs, the entry
  // expires and subsequent requests can retry instead of hanging forever.
  const maxTimeout = Math.max(globalConfig.nzbdavMoviesTimeoutSeconds ?? 30, globalConfig.nzbdavTvTimeoutSeconds ?? 15);
  const pendingTTLMs = (maxTimeout + 30) * 1000;
  pendingCache.set(cacheKey, {
    status: 'pending',
    promise,
    expiresAt: Date.now() + pendingTTLMs,
  });

  promise.then((data) => {
    pendingCache.delete(cacheKey);
    const createdAt = Date.now();
    readyCache.set(cacheKey, {
      data,
      indexerName,
      createdAt,
      expiresAt: createdAt + getReadyTTLMs(),
    });
    if (globalConfig.healthyNzbDbMode === 'storage') {
      enforceStorageLimit(readyCache, estimateReadyCacheSize, globalConfig.healthyNzbDbMaxSizeMB ?? 50);
    }
    saveCacheToDisk();
  }).catch((error) => {
    pendingCache.delete(cacheKey);
    if (error.isNzbdavFailure) {
      const deadCreatedAt = Date.now();
      deadNzbCache.set(deadKey, {
        title,
        indexerName,
        error,
        createdAt: deadCreatedAt,
        expiresAt: deadCreatedAt + getDeadTTLMs(),
      });
      if (globalConfig.deadNzbDbMode === 'storage') {
        enforceStorageLimit(deadNzbCache, estimateDeadCacheSize, globalConfig.deadNzbDbMaxSizeMB ?? 50);
      }
      saveCacheToDisk();
    }
  });

  return promise;
}

/**
 * Get the raw pending cache map (used by streamHandler for pending checks)
 */
export function getStreamCache(): Map<string, CacheEntry> {
  return pendingCache;
}

/**
 * Check if an NZB is known-dead (failed with isNzbdavFailure)
 */
export function isDeadNzb(cacheKey: string): boolean {
  return deadNzbCache.has(cacheKey);
}

/** Clear fallback state and delivery log */
export function clearStreamCache(): void {
  clearFallbackGroups();
  clearDeliveryLog();
  console.log('\u{1F9F9} Pending entries + fallback groups cleared');
}

/**
 * Clear all ready (successful) stream entries
 */
export function clearReadyCache(): number {
  const count = readyCache.size;
  readyCache.clear();
  if (count) {
    console.log(`\u{1F9F9} Cleared ${count} successful stream cache entries`);
    saveCacheToDisk();
  }
  return count;
}

/**
 * Clear all dead NZB entries
 */
export function clearFailedCache(): number {
  const count = deadNzbCache.size;
  deadNzbCache.clear();
  if (count) {
    console.log(`\u{1F9F9} Cleared ${count} dead NZB cache entries`);
    saveCacheToDisk();
  }
  return count;
}

/**
 * Delete a single cache entry by key (checks ready cache, dead NZB cache, and pending cache)
 */
export function deleteCacheEntry(cacheKey: string): boolean {
  let deleted = false;
  if (readyCache.delete(cacheKey)) { deleted = true; }
  else if (deadNzbCache.delete(cacheKey)) { deleted = true; }
  else if (pendingCache.delete(cacheKey)) { deleted = true; }
  if (deleted) saveCacheToDisk();
  return deleted;
}

/**
 * Evict a ready cache entry by its videoPath (reverse lookup).
 * Creates an episode-specific dead entry for TV (so other episodes from the
 * same season pack remain accessible), or a URL-only dead entry for movies.
 * Returns the evicted cache key, or null if no match found.
 */
export function evictReadyByVideoPath(videoPath: string): string | null {
  for (const [key, entry] of readyCache.entries()) {
    if (entry.data.videoPath === videoPath) {
      readyCache.delete(key);
      const sepIdx = key.indexOf('::');
      if (sepIdx !== -1) {
        const nzbUrl = key.substring(0, sepIdx);
        // Extract episode pattern from cache key suffix (e.g. ":S04[. _-]?E08")
        const epMatch = key.match(/:S\d+(\[.*?\]\??)?E\d+$/);
        const episodePattern = epMatch ? epMatch[0].substring(1) : undefined;
        const deadKey = getDeadCacheKey(nzbUrl, episodePattern);
        if (!deadNzbCache.has(deadKey)) {
          const now = Date.now();
          const error = new Error('Video file no longer available (404)');
          (error as any).isNzbdavFailure = true;
          deadNzbCache.set(deadKey, {
            title: extractTitle(key),
            indexerName: entry.indexerName,
            error,
            createdAt: now,
            expiresAt: now + getDeadTTLMs(),
          });
          if (globalConfig.deadNzbDbMode === 'storage') {
            enforceStorageLimit(deadNzbCache, estimateDeadCacheSize, globalConfig.deadNzbDbMaxSizeMB ?? 50);
          }
        }
      }
      saveCacheToDisk();
      return key;
    }
  }
  return null;
}

/**
 * Extract title from a ready cache key (format: `${nzbUrl}::${title}` optionally with `:${episodePattern}`).
 * Dead cache entries store title in the entry value instead.
 */
function extractTitle(cacheKey: string): string {
  const separatorIdx = cacheKey.indexOf('::');
  if (separatorIdx === -1) return cacheKey;
  const afterSep = cacheKey.substring(separatorIdx + 2);
  // Strip episode pattern suffix — handles both literal (":S01E02") and
  // regex-pattern form (":S04[. _-]?E08") used by season pack file selection
  return afterSep.replace(/:S\d+(\[.*?\]\??)?E\d+$/, '');
}

/**
 * Get detailed cache entries grouped by status
 */
export function getCacheEntries(): {
  ready: { key: string; title: string; indexerName?: string; videoPath: string; videoSize: number; createdAt: number; expiresAt: number }[];
  failed: { key: string; title: string; indexerName?: string; error: string; createdAt: number; expiresAt: number }[];
} {
  const now = Date.now();
  const ready: { key: string; title: string; indexerName?: string; videoPath: string; videoSize: number; createdAt: number; expiresAt: number }[] = [];
  const failed: { key: string; title: string; indexerName?: string; error: string; createdAt: number; expiresAt: number }[] = [];

  for (const [key, entry] of readyCache.entries()) {
    if (entry.expiresAt < now) continue;
    ready.push({ key, title: extractTitle(key), indexerName: entry.indexerName, videoPath: entry.data.videoPath, videoSize: entry.data.videoSize, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
  }

  for (const [key, entry] of deadNzbCache.entries()) {
    if (entry.expiresAt < now) continue;
    failed.push({ key, title: entry.title, indexerName: entry.indexerName, error: entry.error.message, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
  }

  return { ready, failed };
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
  // Check ready cache
  for (const [key, entry] of readyCache.entries()) {
    if ((key === baseKey || key.startsWith(baseKey + ':')) && entry.expiresAt > now) return true;
  }
  // Check pending cache
  for (const [key, entry] of pendingCache.entries()) {
    if ((key === baseKey || key.startsWith(baseKey + ':')) && entry.expiresAt > now) return true;
  }
  // Check dead NZB cache (URL-only — if the URL itself is dead, the grab already happened)
  const deadEntry = deadNzbCache.get(nzbUrl);
  if (deadEntry && deadEntry.expiresAt > now) return true;
  return false;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  total: number; ready: number; pending: number; failed: number;
  readySizeMB: number; deadSizeMB: number;
} {
  const now = Date.now();
  let ready = 0;
  for (const entry of readyCache.values()) {
    if (entry.expiresAt > now) ready++;
  }
  const pending = pendingCache.size;
  let failed = 0;
  for (const entry of deadNzbCache.values()) {
    if (entry.expiresAt > now) failed++;
  }
  const readySizeMB = Math.round(estimateReadyCacheSize() / 1024 / 1024 * 100) / 100;
  const deadSizeMB = Math.round(estimateDeadCacheSize() / 1024 / 1024 * 100) / 100;
  return { total: ready + pending + failed, ready, pending, failed, readySizeMB, deadSizeMB };
}

// ── URL-only lookups (used by health check coordinator) ──────────────

/** Check if a non-expired URL-only dead entry exists (health-check entries use bare URL as key) */
export function isDeadNzbByUrl(nzbUrl: string): boolean {
  const entry = deadNzbCache.get(nzbUrl);
  return !!entry && entry.expiresAt > Date.now();
}

/** Write a URL-only dead entry for a health-check-blocked NZB (caller must call saveCacheToDisk) */
export function addDeadNzbByUrl(nzbUrl: string, title: string): void {
  if (deadNzbCache.has(nzbUrl)) return;
  const createdAt = Date.now();
  const error = new Error('Health check: blocked');
  (error as any).isNzbdavFailure = true;
  deadNzbCache.set(nzbUrl, { title, error, createdAt, expiresAt: createdAt + getDeadTTLMs() });
  if (globalConfig.deadNzbDbMode === 'storage') {
    enforceStorageLimit(deadNzbCache, estimateDeadCacheSize, globalConfig.deadNzbDbMaxSizeMB ?? 50);
  }
}

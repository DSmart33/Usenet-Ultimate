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
    total += key.length + (entry.error.message?.length ?? 0) + 50;
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

/** Successful streams — persisted to disk, survives restarts */
interface ReadyEntry { data: StreamData; createdAt: number; expiresAt: number }
const readyCache = new Map<string, ReadyEntry>();

/** Dead NZBs — persisted to disk, survives restarts */
interface DeadNzbEntry { error: Error; createdAt: number; expiresAt: number }
const deadNzbCache = new Map<string, DeadNzbEntry>();

// ── Secondary URL index (for O(1) URL-only lookups by health checks) ──
const readyByUrl = new Map<string, Set<string>>();
const deadByUrl = new Map<string, Set<string>>();

function extractUrlFromKey(key: string): string {
  const idx = key.indexOf('::');
  return idx === -1 ? key : key.substring(0, idx);
}

function addToUrlIndex(index: Map<string, Set<string>>, key: string): void {
  const url = extractUrlFromKey(key);
  let set = index.get(url);
  if (!set) { set = new Set(); index.set(url, set); }
  set.add(key);
}

function removeFromUrlIndex(index: Map<string, Set<string>>, key: string): void {
  const url = extractUrlFromKey(key);
  const set = index.get(url);
  if (set) {
    set.delete(key);
    if (set.size === 0) index.delete(url);
  }
}

// ── Disk persistence ──────────────────────────────────────────────────

interface SerializedDeadEntry {
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
        addToUrlIndex(readyByUrl, key);
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
        deadNzbCache.set(key, { error, createdAt: (entry as any).createdAt || now, expiresAt });
        addToUrlIndex(deadByUrl, key);
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

export function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of pendingCache.entries()) {
    if (entry.expiresAt < now) pendingCache.delete(key);
  }
  for (const [key, entry] of readyCache.entries()) {
    if (entry.expiresAt < now) { readyCache.delete(key); removeFromUrlIndex(readyByUrl, key); }
  }
  for (const [key, entry] of deadNzbCache.entries()) {
    if (entry.expiresAt < now) { deadNzbCache.delete(key); removeFromUrlIndex(deadByUrl, key); }
  }
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
  verbose = true
): Promise<StreamData> {
  cleanupExpiredCache();

  const cacheKey = getCacheKey(nzbUrl, title) + (episodePattern ? `:${episodePattern}` : '');

  // Check dead NZB cache first — known-bad NZBs are skipped instantly
  const dead = deadNzbCache.get(cacheKey);
  if (dead) {
    if (verbose) console.log(`\u274C NZB Database (dead): ${title} - ${dead.error.message}`);
    throw dead.error;
  }

  // Check ready cache — successful streams served instantly on replay
  const ready = readyCache.get(cacheKey);
  if (ready) {
    if (verbose) console.log(`\u2705 NZB Database (ready): ${title}`);
    return ready.data;
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
      createdAt,
      expiresAt: createdAt + getReadyTTLMs(),
    });
    addToUrlIndex(readyByUrl, cacheKey);
    if (globalConfig.healthyNzbDbMode === 'storage') {
      enforceStorageLimit(readyCache, estimateReadyCacheSize, globalConfig.healthyNzbDbMaxSizeMB ?? 50);
    }
    saveCacheToDisk();
  }).catch((error) => {
    pendingCache.delete(cacheKey);
    if (error.isNzbdavFailure) {
      const deadCreatedAt = Date.now();
      deadNzbCache.set(cacheKey, {
        error,
        createdAt: deadCreatedAt,
        expiresAt: deadCreatedAt + getDeadTTLMs(),
      });
      addToUrlIndex(deadByUrl, cacheKey);
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
 * Look up a ready stream by cache key
 */
export function getReadyStream(cacheKey: string): StreamData | undefined {
  return readyCache.get(cacheKey)?.data;
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
  readyByUrl.clear();
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
  deadByUrl.clear();
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
  if (readyCache.delete(cacheKey)) { removeFromUrlIndex(readyByUrl, cacheKey); deleted = true; }
  else if (deadNzbCache.delete(cacheKey)) { removeFromUrlIndex(deadByUrl, cacheKey); deleted = true; }
  else if (pendingCache.delete(cacheKey)) { deleted = true; }
  if (deleted) saveCacheToDisk();
  return deleted;
}

/**
 * Extract title from a cache key (format: `${nzbUrl}::${title}` optionally with `:${episodePattern}`)
 */
function extractTitle(cacheKey: string): string {
  const separatorIdx = cacheKey.indexOf('::');
  if (separatorIdx === -1) return cacheKey;
  const afterSep = cacheKey.substring(separatorIdx + 2);
  // Strip episode pattern suffix (e.g. ":S01E02") but preserve colons in titles
  return afterSep.replace(/:S\d+E\d+$/, '');
}

/**
 * Get detailed cache entries grouped by status
 */
export function getCacheEntries(): {
  ready: { key: string; title: string; videoPath: string; videoSize: number; createdAt: number; expiresAt: number }[];
  failed: { key: string; title: string; error: string; createdAt: number; expiresAt: number }[];
} {
  const now = Date.now();
  const ready: { key: string; title: string; videoPath: string; videoSize: number; createdAt: number; expiresAt: number }[] = [];
  const failed: { key: string; title: string; error: string; createdAt: number; expiresAt: number }[] = [];

  for (const [key, entry] of readyCache.entries()) {
    if (entry.expiresAt < now) continue;
    ready.push({ key, title: extractTitle(key), videoPath: entry.data.videoPath, videoSize: entry.data.videoSize, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
  }

  for (const [key, entry] of deadNzbCache.entries()) {
    if (entry.expiresAt < now) continue;
    failed.push({ key, title: extractTitle(key), error: entry.error.message, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
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
  // Check dead NZB cache
  for (const [key, entry] of deadNzbCache.entries()) {
    if ((key === baseKey || key.startsWith(baseKey + ':')) && entry.expiresAt > now) return true;
  }
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

/** Check if any non-expired dead entry exists for this NZB URL */
export function isDeadNzbByUrl(nzbUrl: string): boolean {
  const keys = deadByUrl.get(nzbUrl);
  if (!keys) return false;
  const now = Date.now();
  for (const key of keys) {
    const entry = deadNzbCache.get(key);
    if (entry && entry.expiresAt > now) return true;
    if (!entry) keys.delete(key);
  }
  if (keys.size === 0) deadByUrl.delete(nzbUrl);
  return false;
}

/** Check if any non-expired ready entry exists for this NZB URL */
export function isReadyNzbByUrl(nzbUrl: string): boolean {
  const keys = readyByUrl.get(nzbUrl);
  if (!keys) return false;
  const now = Date.now();
  for (const key of keys) {
    const entry = readyCache.get(key);
    if (entry && entry.expiresAt > now) return true;
    if (!entry) keys.delete(key);
  }
  if (keys.size === 0) readyByUrl.delete(nzbUrl);
  return false;
}

/** Write a dead entry for a health-check-blocked NZB (caller must call saveCacheToDisk) */
export function addDeadNzbByUrl(nzbUrl: string, title: string): void {
  const key = `${nzbUrl}::${title}`;
  if (deadNzbCache.has(key)) return;
  const createdAt = Date.now();
  const error = new Error('Health check: blocked');
  (error as any).isNzbdavFailure = true;
  deadNzbCache.set(key, { error, createdAt, expiresAt: createdAt + getDeadTTLMs() });
  addToUrlIndex(deadByUrl, key);
  if (globalConfig.deadNzbDbMode === 'storage') {
    enforceStorageLimit(deadNzbCache, estimateDeadCacheSize, globalConfig.deadNzbDbMaxSizeMB ?? 50);
  }
}

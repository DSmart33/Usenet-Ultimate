/**
 * Missing Segment Cache
 *
 * Caches message IDs confirmed missing across all providers.
 * If a subsequent health check encounters a cached-missing segment, it short-circuits to 'blocked'.
 * Supports TTL expiry, size-based eviction, and disk persistence.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '..', '..', 'config', 'segment-cache.json');

// === Missing Segment Cache ===
// Caches message IDs confirmed missing across all providers.
// If a subsequent health check encounters a cached-missing segment, it short-circuits to 'blocked'.
const missingSegmentCache = new Map<string, number>(); // messageId → timestamp (ms)
let segmentCacheHits = 0;

// Configurable via config — these are runtime defaults, overridden per-check
let cacheEnabled = true;
let cacheTtlMs = 0;      // 0 = no expiry
let cacheMaxSizeMB = 50;
let lastSaveTime = 0;
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // Auto-save every 5 minutes

const BYTES_PER_ENTRY = 80; // Estimated: ~50-byte key + 8-byte value + Map overhead

export function configureSegmentCache(opts: { enabled: boolean; ttlHours: number; maxSizeMB: number }): void {
  cacheEnabled = opts.enabled;
  cacheTtlMs = opts.ttlHours > 0 ? opts.ttlHours * 3600 * 1000 : 0;
  cacheMaxSizeMB = opts.maxSizeMB;
}

export function clearSegmentCache(): void {
  missingSegmentCache.clear();
  segmentCacheHits = 0;
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

export function getSegmentCacheStats(): { entries: number; estimatedMB: number; hits: number } {
  const entries = missingSegmentCache.size;
  const estimatedMB = Math.round((entries * BYTES_PER_ENTRY) / (1024 * 1024) * 100) / 100;
  return { entries, estimatedMB, hits: segmentCacheHits };
}

export function addToSegmentCache(messageIds: string[]): void {
  if (!cacheEnabled || messageIds.length === 0) return;
  const now = Date.now();
  for (const id of messageIds) {
    missingSegmentCache.set(id, now);
  }
  // Evict oldest entries until under size limit
  const maxEntries = Math.floor((cacheMaxSizeMB * 1024 * 1024) / BYTES_PER_ENTRY);
  if (missingSegmentCache.size > maxEntries) {
    const entries = [...missingSegmentCache.entries()].sort((a, b) => a[1] - b[1]);
    const evictCount = missingSegmentCache.size - maxEntries;
    for (let i = 0; i < evictCount && i < entries.length; i++) {
      missingSegmentCache.delete(entries[i][0]);
    }
    console.log(`  [segment-cache] Evicted ${evictCount} oldest entries (${missingSegmentCache.size} remaining)`);
  }
  // Periodic auto-save to protect against hard kills
  if (Date.now() - lastSaveTime >= SAVE_INTERVAL_MS) {
    saveSegmentCache();
  }
}

export function checkSegmentCache(messageIds: string[]): string | null {
  if (!cacheEnabled) return null;
  const now = Date.now();
  for (const id of messageIds) {
    const cachedAt = missingSegmentCache.get(id);
    if (cachedAt !== undefined) {
      // Check TTL (0 = no expiry)
      if (cacheTtlMs === 0 || (now - cachedAt) < cacheTtlMs) {
        segmentCacheHits++;
        return id;
      }
      // Expired — remove it
      missingSegmentCache.delete(id);
    }
  }
  return null;
}

export function saveSegmentCache(): void {
  if (missingSegmentCache.size === 0) return;
  try {
    const data = {
      version: 1,
      hits: segmentCacheHits,
      entries: Object.fromEntries(missingSegmentCache),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');
    lastSaveTime = Date.now();
  } catch (err) {
    console.error('[segment-cache] Failed to save cache to disk:', err);
  }
}

export function loadSegmentCache(): void {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } catch {
      console.warn('[segment-cache] Corrupt cache file, deleting and starting fresh');
      try { fs.unlinkSync(CACHE_FILE); } catch {}
      return;
    }
    if (raw.version !== 1 || !raw.entries) return;
    const now = Date.now();
    let loaded = 0;
    let expired = 0;
    for (const [id, ts] of Object.entries(raw.entries)) {
      if (cacheTtlMs > 0 && (now - (ts as number)) >= cacheTtlMs) {
        expired++;
        continue;
      }
      missingSegmentCache.set(id, ts as number);
      loaded++;
    }
    segmentCacheHits = raw.hits || 0;
    lastSaveTime = Date.now();
    console.log(`[segment-cache] Restored ${loaded} entries from disk${expired > 0 ? ` (${expired} expired)` : ''}`);
  } catch (err) {
    console.error('[segment-cache] Failed to load cache from disk:', err);
  }
}

export function shutdownSegmentCache(): void {
  saveSegmentCache();
}

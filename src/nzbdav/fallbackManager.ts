/**
 * Fallback Manager
 * Manages ordered lists of alternative NZBs for automatic retry when a primary
 * NZB download fails. Groups expire after a TTL to avoid unbounded growth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { FallbackCandidate, FallbackGroup } from './types.js';
import { config as globalConfig } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fallbackGroups = new Map<string, FallbackGroup>();

// Fallback groups live as long as the search cache.
// When cacheTTL is 0 (cache disabled), fall back to 2 hours so groups
// remain usable throughout a streaming session.
export function getFallbackGroupTTLMs(): number {
  return (globalConfig.cacheTTL || 7200) * 1000;
}

// Disk persistence so the _fb redirect chain survives an addon restart;
// otherwise a post-restart /v 404 redirects to /stream?t=<envelope> with
// the original fbg inside, finds no in-memory group, and breaks the
// alternative-candidate fallback. Mirrors streamCache.ts.
const FALLBACK_GROUPS_FILE = path.join(__dirname, '..', '..', 'config', 'fallback-groups.json');
const FALLBACK_GROUPS_SCHEMA_VERSION = 2;

interface SerializedFallbackGroup {
  version: number;
  id: string;
  candidates: FallbackCandidate[];
  type: string;
  season?: string;
  episode?: string;
  episodesInSeason?: number;
  createdAt: number;
}

function loadFallbackGroupsFromDisk(): void {
  const ttl = getFallbackGroupTTLMs();
  const now = Date.now();
  try {
    const raw = JSON.parse(fs.readFileSync(FALLBACK_GROUPS_FILE, 'utf-8')) as SerializedFallbackGroup[];
    for (const entry of raw) {
      if (entry.version !== FALLBACK_GROUPS_SCHEMA_VERSION) {
        console.warn(`⚠️  Discarding fallback group (schema v${entry.version} != v${FALLBACK_GROUPS_SCHEMA_VERSION})`);
        continue;
      }
      if (now - entry.createdAt > ttl) continue;
      const { version: _v, id, ...group } = entry;
      void _v;
      fallbackGroups.set(id, group);
    }
    if (fallbackGroups.size) console.log(`💾 Loaded ${fallbackGroups.size} fallback group(s) from disk`);
  } catch {}
}

function saveFallbackGroupsToDisk(): void {
  const ttl = getFallbackGroupTTLMs();
  const now = Date.now();
  const data: SerializedFallbackGroup[] = [];
  for (const [id, group] of fallbackGroups) {
    if (now - group.createdAt <= ttl) {
      data.push({ version: FALLBACK_GROUPS_SCHEMA_VERSION, id, ...group });
    }
  }
  try { fs.writeFileSync(FALLBACK_GROUPS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

loadFallbackGroupsFromDisk();

export function createFallbackGroup(
  id: string,
  candidates: FallbackCandidate[],
  type: string,
  season?: string,
  episode?: string,
  episodesInSeason?: number,
): void {
  // Clean up expired groups opportunistically
  const now = Date.now();
  for (const [key, group] of fallbackGroups.entries()) {
    if (now - group.createdAt > getFallbackGroupTTLMs()) {
      fallbackGroups.delete(key);
    }
  }

  fallbackGroups.set(id, {
    candidates,
    type,
    season,
    episode,
    episodesInSeason,
    createdAt: now,
  });
  saveFallbackGroupsToDisk();
}

export function clearFallbackGroups(): void {
  fallbackGroups.clear();
  saveFallbackGroupsToDisk();
}

export function getFallbackGroup(id: string): FallbackGroup | undefined {
  const group = fallbackGroups.get(id);
  if (group && Date.now() - group.createdAt > getFallbackGroupTTLMs()) {
    fallbackGroups.delete(id);
    saveFallbackGroupsToDisk();
    return undefined;
  }
  return group;
}

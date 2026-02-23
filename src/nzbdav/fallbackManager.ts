/**
 * Fallback Manager
 * Manages ordered lists of alternative NZBs for automatic retry when a primary
 * NZB download fails. Groups expire after a TTL to avoid unbounded growth.
 */

import type { FallbackCandidate, FallbackGroup } from './types.js';

const fallbackGroups = new Map<string, FallbackGroup>();
const FALLBACK_GROUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createFallbackGroup(
  id: string,
  candidates: FallbackCandidate[],
  type: string,
  season?: string,
  episode?: string
): void {
  // Clean up expired groups opportunistically
  const now = Date.now();
  for (const [key, group] of fallbackGroups.entries()) {
    if (now - group.createdAt > FALLBACK_GROUP_TTL_MS) {
      fallbackGroups.delete(key);
    }
  }

  fallbackGroups.set(id, {
    candidates,
    type,
    season,
    episode,
    createdAt: now,
  });
}

export function getFallbackGroup(id: string): FallbackGroup | undefined {
  const group = fallbackGroups.get(id);
  if (group && Date.now() - group.createdAt > FALLBACK_GROUP_TTL_MS) {
    fallbackGroups.delete(id);
    return undefined;
  }
  return group;
}

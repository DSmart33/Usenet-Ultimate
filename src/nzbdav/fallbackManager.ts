/**
 * Fallback Manager
 * Manages ordered lists of alternative NZBs for automatic retry when a primary
 * NZB download fails. Groups expire after a TTL to avoid unbounded growth.
 */

import type { FallbackCandidate, FallbackGroup } from './types.js';
import { config as globalConfig } from '../config/index.js';

const fallbackGroups = new Map<string, FallbackGroup>();

function getFallbackGroupTTLMs(): number {
  return (globalConfig.cacheTTL || 43200) * 1000;
}

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
    if (now - group.createdAt > getFallbackGroupTTLMs()) {
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
  if (group && Date.now() - group.createdAt > getFallbackGroupTTLMs()) {
    fallbackGroups.delete(id);
    return undefined;
  }
  return group;
}

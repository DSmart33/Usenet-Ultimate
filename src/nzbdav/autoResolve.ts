/**
 * Auto-Resolve
 *
 * Background NZB resolution for "from top of list" fallback mode.
 * Sequentially resolves candidates until the first healthy one is found,
 * populating the ready cache so user clicks are instant.
 */

import { getOrCreateStream, isDeadNzbByUrl } from './streamCache.js';
import type { FallbackCandidate, NZBDavConfig } from './types.js';

// ── Active resolve tracking ──────────────────────────────────────────
// Keyed by content identity (e.g. "series:tt123:1:1") to prevent
// duplicate resolves across cache hits where fallbackGroupId differs.

const activeResolves = new Map<string, AbortController>();

/**
 * Sequentially resolve candidates until one succeeds or all fail.
 * Each successful resolution is cached in readyCache; failures go to deadNzbCache.
 * Stops on first success, abort signal, or exhaustion.
 */
export async function autoResolveFromCandidates(
  contentKey: string,
  candidates: FallbackCandidate[],
  nzbdavConfig: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
): Promise<void> {
  if (activeResolves.has(contentKey)) return;

  const controller = new AbortController();
  activeResolves.set(contentKey, controller);
  const tag = `🔄 Auto-resolve [${contentKey}]`;

  try {
    console.log(`${tag} Starting — ${candidates.length} candidate(s)`);

    for (let i = 0; i < candidates.length; i++) {
      if (controller.signal.aborted) {
        console.log(`${tag} Cancelled`);
        break;
      }

      const candidate = candidates[i];

      if (isDeadNzbByUrl(candidate.nzbUrl)) continue;

      try {
        await getOrCreateStream(
          candidate.nzbUrl,
          candidate.title,
          nzbdavConfig,
          episodePattern,
          contentType,
          episodesInSeason,
          candidate.indexerName,
          false,
          candidate.isSeasonPack,
          true, // skipReadyCache — rely on library check instead
        );
        console.log(`${tag} Ready — ${candidate.title} [${candidate.indexerName}]`);
        return;
      } catch {
        // Failed — getOrCreateStream already cached it as dead; try next
      }
    }

    console.log(`${tag} Exhausted all candidates`);
  } finally {
    activeResolves.delete(contentKey);
  }
}

/** Cancel all running auto-resolves (called on settings change). */
export function cancelAllAutoResolves(): void {
  for (const [, controller] of activeResolves) {
    controller.abort();
  }
  activeResolves.clear();
}

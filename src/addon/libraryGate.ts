/**
 * Ultimate Library Gate
 *
 * Live WebDAV library scan + post-filter threshold check. Returns whether the
 * library should short-circuit the indexer flow for this request.
 *
 * Used by the search orchestrator at two call sites: the fresh-search path
 * (before indexer queries) and the cache-hit path (when
 * `libraryRunOnCacheHit` is on). Both call sites share identical gating so
 * cache hits and fresh searches behave the same once the gate fires.
 *
 * Caller responsibilities:
 *   - Skip the call when the per-request bypass marker is armed (consumed
 *     elsewhere via consumeLibraryBypass).
 *   - When shortCircuited is true, run the downstream pipeline against the
 *     returned libraryResults instead of indexer/EasyNews results, and pass
 *     shortCircuited=true to processFromRaw / buildStreams.
 */

import { config } from '../config/index.js';
import { searchLibrary } from '../nzbdav/librarySearch.js';
import { deduplicateAndPreFilter, applyUserFilters } from './resultProcessor.js';
import type { SearchContext } from './searchOrchestrator.js';
import type { ResolvedTitleInfo } from './titleResolver.js';
import type { NZBDavConfig } from '../nzbdav/types.js';

export interface LibraryGateResult {
  /** True when post-filter library results meet the configured threshold and the indexer flow should be skipped. */
  shortCircuited: boolean;
  /** Raw (unfiltered) library results from searchLibrary. Empty when shortCircuited is false; downstream processFromRaw re-runs filters. */
  libraryResults: any[];
}

/**
 * Decide whether Ultimate Library should short-circuit this request.
 *
 * Returns immediately (no network, no log) when the gate is structurally
 * disabled: threshold of 0, type excluded by `libraryApplyToMovies` /
 * `libraryApplyToSeries`, or streamingMode/nzbdavUrl not set up for nzbdav.
 *
 * On enable, prints the section header, runs `searchLibrary`, then runs the
 * SAME dedup + user-filter pipeline that the main flow runs on the library-
 * only set so the threshold check fires on POST-FILTER survivor count. When
 * filters drop library hits below threshold, they are discarded so the user
 * never sees a blank result list because their filters wiped out the library
 * candidates.
 *
 * On short-circuit, the same dedup + filter chain runs again downstream in
 * processFromRaw (idempotent, deterministic), so inner filter sub-logs fire
 * twice. Library results are typically a small set so the duplication is
 * brief; accepted trade for not threading a quiet flag through the entire
 * filter pipeline.
 */
export async function runLibraryGate(
  searchCtx: SearchContext,
  titleInfo: ResolvedTitleInfo,
  buildNzbdavConfig: () => NZBDavConfig,
): Promise<LibraryGateResult> {
  const type = searchCtx.type;
  const libraryThreshold = config.searchConfig?.librarySearchThreshold ?? 0;
  const libraryTypeAllowed = type === 'movie'
    ? config.searchConfig?.libraryApplyToMovies !== false
    : config.searchConfig?.libraryApplyToSeries !== false;
  if (libraryThreshold <= 0 || !libraryTypeAllowed || config.streamingMode !== 'nzbdav' || !config.nzbdavUrl) {
    return { shortCircuited: false, libraryResults: [] };
  }

  console.log('');
  console.log('═══ Ultimate Library ' + '═'.repeat(42));
  const libraryResults = await searchLibrary(searchCtx, buildNzbdavConfig());
  if (libraryResults.length === 0) {
    return { shortCircuited: false, libraryResults: [] };
  }

  const { results: libDeduped, deprioritizedPacks: libDepri } = deduplicateAndPreFilter(
    libraryResults, titleInfo.hasRemake, titleInfo.episodeName, titleInfo.year, titleInfo.titleYear,
  );
  const libFiltered = applyUserFilters(libDeduped, type, Date.now(), titleInfo.runtime, libDepri, { quiet: true });
  if (libFiltered.length >= libraryThreshold) {
    console.log(`📚 Ultimate Library short-circuit fired (${libFiltered.length} ≥ ${libraryThreshold} after filters), skipping indexer queries`);
    return { shortCircuited: true, libraryResults };
  }
  console.log(`📚 Ultimate Library: scan returned ${libraryResults.length} match(es), ${libFiltered.length} after filters, below threshold (${libraryThreshold}), discarding`);
  return { shortCircuited: false, libraryResults: [] };
}

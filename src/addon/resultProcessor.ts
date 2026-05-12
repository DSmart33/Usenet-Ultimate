/**
 * Result Processor — orchestration layer
 *
 * Ties together the two processing stages:
 *  - deduplicateAndPreFilter: content-only passes (cacheable) — junk strip,
 *    indexer-priority dedup, remake filter.
 *  - applyUserFilters: user-preference passes (re-run on every request) —
 *    URL dedup, multi-episode filter, quality filters, sort, stream limits.
 *
 * The actual implementations live in dedup.ts / filters.ts / sort.ts /
 * limits.ts. This file wires them together and re-exports the individual
 * passes for callers that want to invoke them directly.
 */

import { config, getTvAllowMultiEpisode } from '../config/index.js';
import { stripBareArchiveParts, deduplicateByUrl, deduplicateByPriority, deduplicateByIndexerContent } from './dedup.js';
import { applyRemakeFilter, applyMultiEpisodeFilter, applyQualityFilters, applyRankedRules } from './filters.js';
import { sortResults } from './sort.js';
import { applyStreamLimits } from './limits.js';

// Re-export the individual passes so downstream callers can import from
// resultProcessor without caring about the submodule split.
export { stripBareArchiveParts, deduplicateByUrl, deduplicateByPriority, deduplicateByIndexerContent } from './dedup.js';
export { applyRemakeFilter, applyMultiEpisodeFilter, applyQualityFilters, applyRankedRules } from './filters.js';
export { sortResults } from './sort.js';
export { applyStreamLimits } from './limits.js';

/**
 * Content-dependent pre-processing: dedup-by-priority, remake filter.
 * These steps depend on the content, not user preferences — safe to cache.
 */
export function deduplicateAndPreFilter(allResults: any[], hasRemake?: boolean, episodeName?: string, year?: string, titleYear?: string): { results: any[]; deprioritizedPacks: any[] } {
  let results = deduplicateByPriority(allResults);
  const { results: remakeFiltered, deprioritizedPacks } = applyRemakeFilter(results, hasRemake, episodeName, year, titleYear);
  results = remakeFiltered;

  return { results, deprioritizedPacks };
}

/**
 * User-preference-dependent processing: junk filter, dedup-by-url,
 * multi-episode filter, quality filter, sort, stream limits.
 * Runs on every request (including cache hits) to reflect current settings.
 * Deprioritized packs (yearless remake season packs) are filtered separately
 * and appended after sorting but before stream limits.
 */
export function applyUserFilters(results: any[], type: string, now?: number, runtime?: number, deprioritizedPacks?: any[], options?: { quiet?: boolean }): any[] {
  results = stripBareArchiveParts(results);
  results = deduplicateByIndexerContent(results);
  results = deduplicateByUrl(results);

  if (type !== 'movie' && !getTvAllowMultiEpisode(config)) {
    results = applyMultiEpisodeFilter(results);
  }

  const filterConfig = (type === 'movie' ? config.movieFilters : config.tvFilters) || config.filters;
  const queryType = type === 'movie' ? 'movie' : 'series';
  results = applyQualityFilters(results, filterConfig);
  results = applyRankedRules(results, filterConfig, queryType, runtime);
  let filteredDeprioritized = deprioritizedPacks?.length ? applyQualityFilters(deprioritizedPacks, filterConfig) : [];
  if (filteredDeprioritized.length) {
    filteredDeprioritized = applyRankedRules(filteredDeprioritized, filterConfig, queryType, runtime);
    filteredDeprioritized = sortResults(filteredDeprioritized, filterConfig, now, runtime);
  }
  results = sortResults(results, filterConfig, now, runtime);
  results = [...results, ...filteredDeprioritized];
  results = applyStreamLimits(results, filterConfig);
  // Suppressed for the library-gate pre-check call so the UL short-circuit
  // path doesn't print a duplicate "Final Results" block (the gate's pass is
  // a counting pass, not a real final list — processFromRaw runs the pipeline
  // again and emits the real one).
  if (!options?.quiet) {
    console.log(`📊 Returning ${results.length} streams after filtering`);
    if (results.length > 0) {
      // Cap the dump so a 200-result search doesn't flood the log; truncated tail
      // still shows the count so it's clear the list is longer than what's printed.
      const FINAL_RESULTS_LOG_LIMIT = 30;
      const visible = results.slice(0, FINAL_RESULTS_LOG_LIMIT);
      console.log('');
      console.log('═══ Final Results ' + '═'.repeat(45));
      console.log(`📊 Final results (after filtering + sorting):`);
      visible.forEach((r, i) => {
        const tag = r.isSeasonPack ? '📦' : '🎬';
        const idx = (i + 1).toString().padStart(3, ' ');
        console.log(`   ${idx}. ${tag} ${r.title} [${r.indexerName ?? 'unknown'}]`);
      });
      if (results.length > FINAL_RESULTS_LOG_LIMIT) {
        console.log(`   ... and ${results.length - FINAL_RESULTS_LOG_LIMIT} more`);
      }
    }
  }
  return results;
}

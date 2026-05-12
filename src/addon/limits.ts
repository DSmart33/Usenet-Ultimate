/**
 * Stream Count Limits
 *
 * Caps applied after sorting: per-resolution, per-quality, and total.
 * Runs last in the user-filter pipeline so limits operate on already-ranked
 * results (the top-ranked streams survive the cap).
 */

import { parseQuality, parseSource } from '../parsers/metadataParsers.js';
import type { FilterConfig } from '../types.js';

/**
 * Apply per-resolution, per-quality, and max-total-streams limits.
 */
export function applyStreamLimits(allResults: any[], filterConfig?: FilterConfig): any[] {
  let results = allResults;

  // Apply max streams per resolution limit if configured
  if (filterConfig?.maxStreamsPerResolution != null) {
    const resolutionCounts: Record<string, number> = {};
    results = results.filter(r => {
      const resolution = parseQuality(r.title);
      resolutionCounts[resolution] = (resolutionCounts[resolution] || 0) + 1;
      return resolutionCounts[resolution] <= (filterConfig?.maxStreamsPerResolution ?? Infinity);
    });
    console.log(`🎯 Limited to ${filterConfig.maxStreamsPerResolution} per resolution (${results.length} remaining)`);
  }

  // Apply max streams per video source quality limit if configured
  if (filterConfig?.maxStreamsPerQuality != null) {
    const qualityCounts: Record<string, number> = {};
    results = results.filter(r => {
      const source = parseSource(r.title);
      qualityCounts[source] = (qualityCounts[source] || 0) + 1;
      return qualityCounts[source] <= (filterConfig?.maxStreamsPerQuality ?? Infinity);
    });
    console.log(`🎯 Limited to ${filterConfig.maxStreamsPerQuality} per quality (${results.length} remaining)`);
  }

  // Apply max season pack limit if configured. Walks the already-sorted list,
  // counts season packs, and drops any pack beyond the cap so the highest-priority
  // packs survive. Non-pack results pass through unconditionally. Yearless packs
  // tagged `_deprioritized` (by applyRemakeFilter) are also exempt — they ride at
  // the bottom of the list and shouldn't evict prioritized packs from the cap.
  if (filterConfig?.maxSeasonPacks != null && filterConfig.maxSeasonPacks > 0) {
    const cap = filterConfig.maxSeasonPacks;
    let packCount = 0;
    const before = results.length;
    results = results.filter(r => {
      if (!r.isSeasonPack || r._deprioritized) return true;
      packCount++;
      return packCount <= cap;
    });
    if (results.length < before) {
      console.log(`🎯 Limited to ${cap} season packs (${results.length} remaining)`);
    }
  }

  // Apply max total streams limit if configured
  if (filterConfig?.maxStreams != null) {
    results = results.slice(0, filterConfig.maxStreams);
    console.log(`🎯 Limited to ${filterConfig.maxStreams} total streams`);
  }

  return results;
}

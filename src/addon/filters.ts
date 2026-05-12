/**
 * Result Filters
 *
 * Filtering passes applied to search results:
 *  - applyRemakeFilter: content-dependent — drops results from the wrong
 *    version of a remade/rebooted show; deprioritizes yearless packs
 *  - applyMultiEpisodeFilter: user-preference — drops multi-episode files
 *    for TV when the "allow multi-episode" setting is off
 *  - applyQualityFilters: user-preference — drops results whose parsed
 *    attributes are explicitly disabled (resolution, codec, source, etc.)
 *    and enforces configurable size bounds
 */

import { parseMetadata, parseQuality, parseCodec, parseSource, parseVisualTag, parseAudioTag, parseLanguage, parseEdition, parseYear, parseDurationAttr, formatBytes } from '../parsers/metadataParsers.js';
import { isRemakeFiltered } from '../parsers/titleMatching.js';
import { applyRules as engineApplyRules, buildStreamContext } from '../rules/rankEngine.js';
import type { FilterConfig } from '../types.js';

/**
 * Filter out results from the wrong version of a remade/rebooted show.
 * For season packs: correct year → kept; wrong year → removed; no year → deprioritized to end.
 * For episodes: yearless releases must contain the episode name; year-present releases must
 * match the expected year within ±1. Episode filtering is skipped when episodeName is unavailable.
 * Returns two arrays: results kept in their normal position, and packs deprioritized to the end.
 */
export function applyRemakeFilter(allResults: any[], hasRemake?: boolean, episodeName?: string, year?: string, titleYear?: string): { results: any[]; deprioritizedPacks: any[] } {
  if (!hasRemake || !year) return { results: allResults, deprioritizedPacks: [] };

  const yearMatchesAny = (parsed: string) => {
    const p = parseInt(parsed, 10);
    if (Math.abs(p - parseInt(year, 10)) <= 1) return true;
    if (titleYear && Math.abs(p - parseInt(titleYear, 10)) <= 1) return true;
    return false;
  };

  const removed: string[] = [];
  const deprioritizedTitles: string[] = [];
  const deprioritizedPacks: any[] = [];

  const results = allResults.filter(r => {
    if (r.isSeasonPack) {
      const parsedYear = parseYear(r.title);
      if (!parsedYear) {
        // Tag so the maxSeasonPacks cap can exempt these from its count.
        // They already ride at the bottom of the list; they shouldn't evict
        // a year-correct pack just because they sit in the same isSeasonPack
        // bucket.
        r._deprioritized = true;
        deprioritizedPacks.push(r);
        deprioritizedTitles.push(r.title);
        return false;
      }
      if (!yearMatchesAny(parsedYear)) {
        removed.push(r.title);
        return false;
      }
      return true;
    }
    // Regular episode — skip if episodeName unavailable (e.g. TVDB lookup failed)
    if (episodeName && isRemakeFiltered(r.title, episodeName, year, titleYear)) {
      removed.push(r.title);
      return false;
    }
    return true;
  });

  if (removed.length > 0) {
    console.log(`🎯 Remake filter: removed ${removed.length} result(s) from wrong version (${results.length} remaining)`);
    for (const title of removed) console.log(`   ✂️  "${title}"`);
  }
  if (deprioritizedTitles.length > 0) {
    console.log(`🎯 Remake filter: deprioritized ${deprioritizedTitles.length} yearless season pack(s) to end of results`);
    for (const title of deprioritizedTitles) console.log(`   ⬇️  "${title}"`);
  }

  return { results, deprioritizedPacks };
}

/**
 * Drop multi-episode files when the TV config disallows them.
 * Matches titles with S01E01E02, S01E01-02, etc. Skipped for movies and when allowed.
 */
export function applyMultiEpisodeFilter(allResults: any[]): any[] {
  const multiEpRegex = /S\d+[. _-]?E\d+(?:[. _-]?E\d+|-\d{1,2}(?!\d))/i;
  const filtered: string[] = [];
  const kept = allResults.filter(r => {
    if (multiEpRegex.test(r.title)) { filtered.push(r.title); return false; }
    return true;
  });
  if (filtered.length > 0) {
    console.log(`🎯 Filtered ${filtered.length} multi-episode result(s) (${kept.length} remaining)`);
    for (const title of filtered) console.log(`   ✂️  "${title}"`);
  }
  return kept;
}

/**
 * Apply enabled-priority filters: remove results whose parsed attribute
 * is explicitly disabled in the filter config.
 */
export function applyQualityFilters(allResults: any[], filterConfig?: FilterConfig): any[] {
  if (!filterConfig) return allResults;

  let results = allResults;

  // File size filters — individual files only (season packs have separate filters)
  if (filterConfig.minFileSize != null) {
    const before = results.length;
    results = results.filter(r => r.isSeasonPack || r.size >= (filterConfig.minFileSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min file size (${results.length} remaining)`);
  }
  if (filterConfig.maxFileSize != null) {
    const before = results.length;
    results = results.filter(r => r.isSeasonPack || r.size <= (filterConfig.maxFileSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max file size (${results.length} remaining)`);
  }
  // Season pack size filters — total pack size. Skip extracted-pack-episodes
  // (Ultimate Library results where the inner file is per-episode); their `size`
  // is the per-episode file size, not the pack total.
  if (filterConfig.minSeasonPackSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || r.extractedFromPack || r.size >= (filterConfig.minSeasonPackSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min season pack size (${results.length} remaining)`);
  }
  if (filterConfig.maxSeasonPackSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || r.extractedFromPack || r.size <= (filterConfig.maxSeasonPackSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max season pack size (${results.length} remaining)`);
  }
  // Season pack per-episode size filters — estimated per-episode size
  if (filterConfig.minSeasonPackEpisodeSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || (r.estimatedEpisodeSize ?? r.size) >= (filterConfig.minSeasonPackEpisodeSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min season pack per-episode size (${results.length} remaining)`);
  }
  if (filterConfig.maxSeasonPackEpisodeSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || (r.estimatedEpisodeSize ?? r.size) <= (filterConfig.maxSeasonPackEpisodeSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max season pack per-episode size (${results.length} remaining)`);
  }

  // Filter out results with disabled priorities
  const ep = filterConfig.enabledPriorities || {};
  const hasDisabled = (obj: Record<string, boolean> | undefined) => obj && Object.values(obj).some(v => v === false);

  if (hasDisabled(ep.resolution)) {
    const before = results.length;
    results = results.filter(r => ep.resolution?.[parseQuality(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled resolutions`);
  }
  if (hasDisabled(ep.video)) {
    const before = results.length;
    results = results.filter(r => ep.video?.[parseSource(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled video sources`);
  }
  if (hasDisabled(ep.encode)) {
    const before = results.length;
    results = results.filter(r => ep.encode?.[parseCodec(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled encodes`);
  }
  if (hasDisabled(ep.visualTag)) {
    const before = results.length;
    results = results.filter(r => ep.visualTag?.[parseVisualTag(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled visual tags`);
  }
  if (hasDisabled(ep.audioTag)) {
    const before = results.length;
    results = results.filter(r => ep.audioTag?.[parseAudioTag(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled audio tags`);
  }
  if (hasDisabled(ep.language)) {
    const before = results.length;
    results = results.filter(r => ep.language?.[parseLanguage(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled languages`);
  }
  if (hasDisabled(ep.edition)) {
    const before = results.length;
    results = results.filter(r => ep.edition?.[parseEdition(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled editions`);
  }

  return results;
}

/**
 * Apply user-defined ranked rules (regex tags + SEL set-level scoring).
 * Decorates candidates with `_rankRegexScore`, `_rankSeScore`,
 * `_rankTotalScore`, `_rankMatched`, `_rankRegexTags` so the sort pass can
 * consume the scores. Exclusion is NOT done here — it lives in the existing
 * attribute filters (encode, visualTag, etc.).
 *
 * The no-rules path clears any lingering `_rank*` decoration so that
 * disabling rules doesn't leave stale scores on cached raw results.
 *
 * `queryType` is 'movie' or 'series' — SEL templates branch on this.
 */
export function applyRankedRules(allResults: any[], filterConfig?: FilterConfig, queryType?: string, runtime?: number): any[] {
  const regexCount = filterConfig?.rules?.rankedRegexPatterns?.length ?? 0;
  const selCount   = filterConfig?.rules?.rankedStreamExpressions?.length ?? 0;
  if (!filterConfig?.rules || (regexCount === 0 && selCount === 0)) {
    for (const r of allResults) {
      if (r._rankTotalScore !== undefined) {
        delete r._rankRegexScore;
        delete r._rankSeScore;
        delete r._rankTotalScore;
        delete r._rankMatched;
        delete r._rankRegexTags;
        delete r._rankErrors;
      }
    }
    return allResults;
  }

  const decorated = engineApplyRules(
    allResults,
    filterConfig,
    (r) => {
      const parsed = parseMetadata(r.title || '');
      // Resolve duration via the same fallback chain used in streamBuilder.ts:
      // EasyNews-provided duration → Newznab attribute → query-level runtime.
      let durationSec: number | undefined = r.duration;
      if (!durationSec) {
        const runtimeAttr = r.attributes?.runtime || r.attributes?.duration;
        if (runtimeAttr) durationSec = parseDurationAttr(String(runtimeAttr));
      }
      if (!durationSec && runtime) durationSec = runtime;
      const bitrate = durationSec && r.size ? Math.round((r.size * 8) / durationSec) : null;
      return buildStreamContext({
        title: r.title,
        filename: r.filename ?? r.title,
        size: r.size,
        indexer: r.indexerName,
        age: r.pubDate ? (Date.now() - new Date(r.pubDate).getTime()) / 3600_000 : 0,
        resolution: parsed.resolution,
        codec: parsed.codec,
        releaseGroup: parsed.releaseGroup,
        visualTag: parsed.visualTag,
        audioTag: parsed.audioTag,
        videoTag: parsed.source,
        edition: parsed.edition,
        language: parsed.language,
        seeders: null,
        bitrate,
        seasonPack: r.isSeasonPack ?? false,
      });
    },
    queryType,
  );

  // Filter out candidates marked excluded by 'drop' rules or 'keep'-gate
  // exclusion, before the telemetry log + downstream sort.
  const totalCount = decorated.length;
  const survivors = decorated.filter(r => !r._rankExcluded);
  const excludedCount = totalCount - survivors.length;
  if (excludedCount > 0) {
    // Per-rule attribution: count how many candidates each rule (or the
    // keep-gate) dropped. Sorted by count desc so the loudest offenders lead.
    const byRule = new Map<string, number>();
    for (const r of decorated) {
      if (!r._rankExcluded) continue;
      const reason = r._rankExcludedBy ?? '(unknown)';
      byRule.set(reason, (byRule.get(reason) ?? 0) + 1);
    }
    const breakdown = [...byRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}: ${n}`)
      .join(', ');
    console.log(`🚫 Filters dropped ${excludedCount}/${totalCount} candidate(s) — ${breakdown}`);
  }

  // Observability: log the top-5 scored candidates after rules decorate so the
  // user can confirm rules are firing on real searches (answers "how do I know
  // rules are running vs the sorts set?"). Only emits when at least one
  // candidate picked up a non-zero score.
  const scored = survivors.filter(r => typeof r._rankTotalScore === 'number' && r._rankTotalScore !== 0);
  if (scored.length > 0) {
    const top = [...scored].sort((a, b) => (b._rankTotalScore ?? 0) - (a._rankTotalScore ?? 0)).slice(0, 5);
    const medals = ['🏆', '🥈', '🥉', '  ', '  '];
    console.log('');
    console.log('═══ Ranked Rules ' + '═'.repeat(46));
    console.log(`📊 Ranked rules: top ${top.length} of ${scored.length} scored candidate(s)`);
    top.forEach((r, i) => {
      const scoreStr = String(r._rankTotalScore).padStart(5);
      const sizeStr = (typeof r.size === 'number' && r.size > 0 ? formatBytes(r.size) : '—').padStart(8);
      const title = String(r.title ?? '').slice(0, 100);
      console.log(`   ${medals[i]}  ${scoreStr}  ${sizeStr}  ${title}`);
    });
  }

  return survivors;
}

/**
 * Result Processor
 *
 * Handles cross-indexer deduplication (by priority), quality filtering,
 * priority-based sorting, and stream count limits.
 */

import { config } from '../config/index.js';
import { parseQuality, parseCodec, parseSource, parseVisualTag, parseAudioTag, parseLanguage, parseEdition, getAgeHours, getBitrateValue, formatBytes, parseYear } from '../parsers/metadataParsers.js';
import { isRemakeFiltered } from '../parsers/titleMatching.js';
import type { FilterConfig } from '../types.js';

/**
 * Cross-indexer deduplication by indexer priority.
 * Keeps only the copy from the highest-priority indexer when the same
 * title+size combination appears from multiple indexers.
 */
export function deduplicateByPriority(allResults: any[]): any[] {
  if (!config.searchConfig?.indexerPriorityDedup || allResults.length === 0) {
    return allResults;
  }

  // Build priority map: indexer name → priority number (lower = higher priority)
  const priorityMap = new Map<string, number>();
  if (config.indexerPriority && config.indexerPriority.length > 0) {
    // Use explicit priority list
    config.indexerPriority.forEach((name, i) => priorityMap.set(name, i));
  } else {
    // Fall back to indexer array order + EasyNews last
    if (config.indexManager === 'newznab') {
      config.indexers.forEach((idx, i) => { if (idx.enabled) priorityMap.set(idx.name, i); });
    } else {
      (config.syncedIndexers || []).forEach((idx, i) => { if (idx.enabledForSearch) priorityMap.set(idx.name, i); });
    }
    priorityMap.set('EasyNews', 9999);
  }

  console.log(`🔀 Indexer priority order: ${[...priorityMap.entries()].sort((a, b) => a[1] - b[1]).map(([name, p]) => `${name}(#${p + 1})`).join(', ')}`);

  const beforeDedup = allResults.length;
  const seen = new Map<string, { priority: number; index: number; indexerName: string }>();
  const dropped: { title: string; droppedFrom: string; keptFrom: string }[] = [];
  allResults.forEach((result, i) => {
    const key = `${result.title}-${formatBytes(result.size)}`;
    const priority = priorityMap.get(result.indexerName) ?? 9998;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { priority, index: i, indexerName: result.indexerName });
    } else if (priority < existing.priority) {
      // New result has higher priority — drop the old one, keep the new
      dropped.push({ title: result.title, droppedFrom: existing.indexerName, keptFrom: result.indexerName });
      seen.set(key, { priority, index: i, indexerName: result.indexerName });
    } else {
      // Existing has higher priority — drop the new one
      dropped.push({ title: result.title, droppedFrom: result.indexerName, keptFrom: existing.indexerName });
    }
  });
  const keepIndices = new Set([...seen.values()].map(v => v.index));
  const deduped = allResults.filter((_, i) => keepIndices.has(i));
  const removed = beforeDedup - deduped.length;
  if (removed > 0) {
    console.log(`🔀 Indexer priority dedup: removed ${removed} duplicate(s) (${deduped.length} remaining)`);
    for (const d of dropped) {
      console.log(`   ✂️  "${d.title}" — dropped ${d.droppedFrom}, kept ${d.keptFrom}`);
    }
  }
  return deduped;
}

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
 * Apply enabled-priority filters: remove results whose parsed attribute
 * is explicitly disabled in the filter config.
 */
export function applyQualityFilters(allResults: any[], filterConfig?: FilterConfig): any[] {
  if (!filterConfig) return allResults;

  let results = allResults;

  // Apply file size filters if configured
  // For season packs, each filter independently compares against per-episode or full pack size
  const getSizeForMode = (r: any, mode: 'episode' | 'pack' | undefined) =>
    (mode ?? 'episode') === 'episode' ? (r.estimatedEpisodeSize ?? r.size) : r.size;
  if (filterConfig.minFileSize != null) {
    const before = results.length;
    results = results.filter(r => getSizeForMode(r, filterConfig.minFileSizeMode) >= (filterConfig.minFileSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min file size (${results.length} remaining)`);
  }
  if (filterConfig.maxFileSize != null) {
    const before = results.length;
    results = results.filter(r => getSizeForMode(r, filterConfig.maxFileSizeMode) <= (filterConfig.maxFileSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max file size (${results.length} remaining)`);
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
 * Sort results by configured preference using the sortOrder array.
 */
export function sortResults(allResults: any[], filterConfig?: FilterConfig, now?: number, runtime?: number): any[] {
  const sortOrder = filterConfig?.sortOrder || ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition'];
  const enabledSorts = filterConfig?.enabledSorts || {};
  const sortDirections = filterConfig?.sortDirections || {};
  const enabledPriorities = filterConfig?.enabledPriorities || {};
  const resolutionPriority = filterConfig?.resolutionPriority || ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '540p', '480p', '360p', '240p', '144p'];
  const videoPriority = filterConfig?.videoPriority || ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'];
  const encodePriority = filterConfig?.encodePriority || ['av1', 'hevc', 'vp9', 'avc', 'vp8', 'xvid', 'mpeg2', 'Unknown'];
  const visualTagPriority = filterConfig?.visualTagPriority || ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', '3D', 'Unknown'];
  const audioTagPriority = filterConfig?.audioTagPriority || ['Atmos (TrueHD)', 'DTS Lossless', 'TrueHD', 'Atmos (DDP)', 'DTS Lossy', 'DDP', 'DD', 'FLAC', 'PCM', 'AAC', 'OPUS', 'MP3', 'Unknown'];
  const languagePriority = filterConfig?.languagePriority || ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'];
  const editionPriority = filterConfig?.editionPriority || ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard'];
  const preferNonStandardEdition = filterConfig?.preferNonStandardEdition || false;

  // Pre-compute age/bitrate values for efficient sorting (avoids Date.parse per comparison)
  const sortNow = now ?? Date.now();
  const ageMap = new Map(allResults.map(r => [r, getAgeHours(r.pubDate, sortNow)]));
  const bitrateMap = new Map(allResults.map(r => [r, getBitrateValue(r.estimatedEpisodeSize ?? r.size, r.duration ?? runtime)]));

  const sorted = [...allResults];
  sorted.sort((a, b) => {
    // Apply sort methods in order of priority (skip disabled methods)
    for (const method of sortOrder) {
      // Skip if this sort method is disabled
      if (enabledSorts[method] === false) continue;

      if (method === 'quality') {
        const qualityA = parseQuality(a.title);
        const qualityB = parseQuality(b.title);
        const priorityA = resolutionPriority.indexOf(qualityA);
        const priorityB = resolutionPriority.indexOf(qualityB);

        // Treat disabled items as lowest priority
        const isDisabledA = enabledPriorities.resolution?.[qualityA] === false;
        const isDisabledB = enabledPriorities.resolution?.[qualityB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'size') {
        const aSize = a.estimatedEpisodeSize ?? a.size;
        const bSize = b.estimatedEpisodeSize ?? b.size;
        const sizeDir = sortDirections.size === 'asc' ? 1 : -1;
        if (aSize !== bSize) return (aSize - bSize) * sizeDir;
      } else if (method === 'videoTag') {
        const sourceA = parseSource(a.title);
        const sourceB = parseSource(b.title);
        const priorityA = videoPriority.indexOf(sourceA);
        const priorityB = videoPriority.indexOf(sourceB);

        // Treat disabled items as lowest priority
        const isDisabledA = enabledPriorities.video?.[sourceA] === false;
        const isDisabledB = enabledPriorities.video?.[sourceB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'encode') {
        const codecA = parseCodec(a.title);
        const codecB = parseCodec(b.title);
        const priorityA = encodePriority.indexOf(codecA);
        const priorityB = encodePriority.indexOf(codecB);

        // Treat disabled items as lowest priority
        const isDisabledA = enabledPriorities.encode?.[codecA] === false;
        const isDisabledB = enabledPriorities.encode?.[codecB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'visualTag') {
        const visualA = parseVisualTag(a.title);
        const visualB = parseVisualTag(b.title);
        const priorityA = visualTagPriority.indexOf(visualA);
        const priorityB = visualTagPriority.indexOf(visualB);

        // Treat disabled items as lowest priority
        const isDisabledA = enabledPriorities.visualTag?.[visualA] === false;
        const isDisabledB = enabledPriorities.visualTag?.[visualB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'audioTag') {
        const audioA = parseAudioTag(a.title);
        const audioB = parseAudioTag(b.title);
        const priorityA = audioTagPriority.indexOf(audioA);
        const priorityB = audioTagPriority.indexOf(audioB);

        // Treat disabled items as lowest priority
        const isDisabledA = enabledPriorities.audioTag?.[audioA] === false;
        const isDisabledB = enabledPriorities.audioTag?.[audioB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'language') {
        const langA = parseLanguage(a.title);
        const langB = parseLanguage(b.title);
        const priorityA = languagePriority.indexOf(langA);
        const priorityB = languagePriority.indexOf(langB);

        const isDisabledA = enabledPriorities.language?.[langA] === false;
        const isDisabledB = enabledPriorities.language?.[langB] === false;
        const indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
        const indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'edition') {
        const editionA = parseEdition(a.title);
        const editionB = parseEdition(b.title);

        const isDisabledA = enabledPriorities.edition?.[editionA] === false;
        const isDisabledB = enabledPriorities.edition?.[editionB] === false;

        let indexA: number, indexB: number;

        if (preferNonStandardEdition) {
          // All enabled non-Standard editions are equal priority (0), Standard is 1
          indexA = isDisabledA ? 9999 : (editionA === 'Standard' ? 1 : 0);
          indexB = isDisabledB ? 9999 : (editionB === 'Standard' ? 1 : 0);
        } else {
          const priorityA = editionPriority.indexOf(editionA);
          const priorityB = editionPriority.indexOf(editionB);
          indexA = isDisabledA ? 9999 : (priorityA >= 0 ? priorityA : 999);
          indexB = isDisabledB ? 9999 : (priorityB >= 0 ? priorityB : 999);
        }

        if (indexA !== indexB) return indexA - indexB;
      } else if (method === 'age') {
        const ageA = ageMap.get(a) ?? Infinity;
        const ageB = ageMap.get(b) ?? Infinity;
        // Default asc = newest first (smallest age hours first)
        const dir = sortDirections.age === 'desc' ? -1 : 1;
        if (ageA !== ageB) return (ageA - ageB) * dir;
      } else if (method === 'bitrate') {
        const brA = bitrateMap.get(a) ?? 0;
        const brB = bitrateMap.get(b) ?? 0;
        // Default desc = highest bitrate first
        const dir = sortDirections.bitrate === 'asc' ? 1 : -1;
        if (brA !== brB) return (brA - brB) * dir;
      }
    }
    return 0;
  });

  return sorted;
}

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

  // Apply max total streams limit if configured
  if (filterConfig?.maxStreams != null) {
    results = results.slice(0, filterConfig.maxStreams);
    console.log(`🎯 Limited to ${filterConfig.maxStreams} total streams`);
  }

  return results;
}

/**
 * Full processing pipeline: dedup → remake filter → quality filter → sort → limit.
 * Yearless season packs for remake shows are appended after the sorted results.
 */
export function processResults(allResults: any[], type: string, now?: number, runtime?: number, hasRemake?: boolean, episodeName?: string, year?: string, titleYear?: string): any[] {
  // Step 1: Cross-indexer dedup by priority
  let results = deduplicateByPriority(allResults);

  // Step 2: Remake filter — applies globally regardless of search method.
  // Yearless season packs for remake shows are separated and appended after sorting.
  const { results: remakeFiltered, deprioritizedPacks } = applyRemakeFilter(results, hasRemake, episodeName, year, titleYear);
  results = remakeFiltered;

  // Step 2.5: Filter multi-episode results if setting is disabled
  if (type !== 'movie' && config.searchConfig?.allowMultiEpisodeFiles === false) {
    const multiEpRegex = /S\d+[. _-]?E\d+(?:[. _-]?E\d+|-\d{1,2}(?!\d))/i;
    const filtered: string[] = [];
    results = results.filter(r => {
      if (multiEpRegex.test(r.title)) {
        filtered.push(r.title);
        return false;
      }
      return true;
    });
    if (filtered.length > 0) {
      console.log(`🎯 Filtered ${filtered.length} multi-episode result(s) (${results.length} remaining)`);
      for (const title of filtered) console.log(`   ✂️  "${title}"`);
    }
  }

  // Step 3: Select per-type filter config, falling back to global filters
  const filterConfig = (type === 'movie' ? config.movieFilters : config.tvFilters) || config.filters;

  // Step 4: Quality filters
  results = applyQualityFilters(results, filterConfig);
  const filteredDeprioritized = applyQualityFilters(deprioritizedPacks, filterConfig);

  // Step 5: Sort
  results = sortResults(results, filterConfig, now, runtime);

  // Yearless remake season packs appear after all sorted results, in post-dedup order
  results = [...results, ...filteredDeprioritized];

  // Step 6: Stream limits
  results = applyStreamLimits(results, filterConfig);

  console.log(`📊 Returning ${results.length} streams after filtering`);
  return results;
}

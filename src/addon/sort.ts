/**
 * Result Sorting
 *
 * Multi-key sort driven by `filterConfig.sortOrder`. Each method in the
 * order array contributes a comparator; the first non-zero comparison
 * decides the pair's order.
 */

import { parseQuality, parseCodec, parseSource, parseVisualTag, visualTagFilterKey, parseAudioTag, parseLanguage, parseEdition, getAgeHours, getBitrateValue } from '../parsers/metadataParsers.js';
import type { FilterConfig } from '../types.js';

/**
 * Sort results by configured preference using the sortOrder array.
 */
export function sortResults(allResults: any[], filterConfig?: FilterConfig, now?: number, runtime?: number): any[] {
  const sortOrder = filterConfig?.sortOrder || ['regexScore', 'quality', 'videoTag', 'seScore', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition'];
  const enabledSorts = filterConfig?.enabledSorts || {};
  const sortDirections = filterConfig?.sortDirections || {};
  const enabledPriorities = filterConfig?.enabledPriorities || {};
  const resolutionPriority = filterConfig?.resolutionPriority || ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '540p', '480p', '360p', '240p', '144p'];
  const videoPriority = filterConfig?.videoPriority || ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'DCP', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'];
  const encodePriority = filterConfig?.encodePriority || ['vvc', 'av1', 'hevc', 'vp9', 'avc', 'vc1', 'vp8', 'xvid', 'mpeg2', 'Unknown'];
  const visualTagPriority = filterConfig?.visualTagPriority || ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', '3D', 'Unknown'];
  const audioTagPriority = filterConfig?.audioTagPriority || ['Atmos (TrueHD)', 'DTS:X', 'Atmos (DD+)', 'TrueHD', 'DTS-HD MA', 'FLAC', 'DTS-HD', 'DD+', 'DTS-ES', 'DTS', 'AAC', 'DD', 'Opus', 'PCM', 'MP3', 'Unknown'];
  const languagePriority = filterConfig?.languagePriority || ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'];
  const editionPriority = filterConfig?.editionPriority || ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard'];
  const preferNonStandardEdition = filterConfig?.preferNonStandardEdition || false;
  const preferSeasonPacks = filterConfig?.preferSeasonPacks === true;
  const preferLibraryResults = filterConfig?.preferLibraryResults === true;

  // Pre-compute age/bitrate values for efficient sorting (avoids Date.parse per comparison)
  const sortNow = now ?? Date.now();
  const ageMap = new Map(allResults.map(r => [r, getAgeHours(r.pubDate, sortNow)]));
  const bitrateMap = new Map(allResults.map(r => [r, getBitrateValue(r.estimatedEpisodeSize ?? r.size, r.duration ?? runtime)]));

  const sorted = [...allResults];
  sorted.sort((a, b) => {
    // Tier 0: deprioritized always sorts to the bottom. Set by applyRemakeFilter
    // for yearless season packs of remade titles. Without this guard, later
    // tiers (library, pack, score) would hoist a deprioritized pack back up —
    // a yearless remake pack that happens to be in the WebDAV library would
    // get pulled to the top by the library tier on the second sort pass in
    // addon/index.ts, defeating the whole point of remake deprioritization.
    const aDep = a._deprioritized === true;
    const bDep = b._deprioritized === true;
    if (aDep !== bDep) return aDep ? 1 : -1;

    // Tier 1: pack-vs-episode grouping. With both toggles on, season packs
    // group at top and library status acts as tiebreaker WITHIN each group
    // (library packs → non-library packs → library episodes → non-library
    // episodes). Checked before the library tier so individual library
    // episodes don't break the grouping by hoisting above non-library packs.
    if (preferSeasonPacks && a.isSeasonPack !== b.isSeasonPack) {
      return a.isSeasonPack ? -1 : 1;
    }
    // Tier 2: library preference within the pack/non-pack group above. The
    // library-short-circuit case is unaffected: every result has the flag (or
    // none do) so the comparator returns 0 and existing sort keys take over.
    if (preferLibraryResults && a.inLibrary !== b.inLibrary) {
      return a.inLibrary ? -1 : 1;
    }
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
        const visualA = visualTagFilterKey(parseVisualTag(a.title));
        const visualB = visualTagFilterKey(parseVisualTag(b.title));
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
      } else if (method === 'regexScore') {
        // Ranked-rule regex score — decorated by filters.ts::applyRankedRules.
        // Default desc = highest score first.
        const sA = (a._rankRegexScore as number | undefined) ?? 0;
        const sB = (b._rankRegexScore as number | undefined) ?? 0;
        const dir = sortDirections.regexScore === 'asc' ? 1 : -1;
        if (sA !== sB) return (sA - sB) * dir;
      } else if (method === 'seScore') {
        // Ranked-rule Stream Expression score — decorated by filters.ts::applyRankedRules.
        // Default desc = highest score first.
        const sA = (a._rankSeScore as number | undefined) ?? 0;
        const sB = (b._rankSeScore as number | undefined) ?? 0;
        const dir = sortDirections.seScore === 'asc' ? 1 : -1;
        if (sA !== sB) return (sA - sB) * dir;
      }
    }
    return 0;
  });

  return sorted;
}

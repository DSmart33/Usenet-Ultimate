/**
 * Title normalization and text search matching logic.
 *
 * Handles diacritics stripping, title normalization, release-name title
 * extraction, and fuzzy matching for text-based indexer searches.
 */

import { parseYear } from './metadataParsers.js';

// --- Title normalization ---

/** Strip diacritics/accents, apostrophes, and punctuation that doesn't appear in release names */
export function stripDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[;:!?~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip to lowercase alphanumeric only for comparison */
export function normalizeTitle(str: string): string {
  return stripDiacritics(str).toLowerCase().replace(/[&+]/g, 'and').replace(/[^a-z0-9]/g, '');
}

/** Extract the media title portion from a release name by finding the first
 *  anchor marker (S01E01, a release year 1920-2030, resolution, or source tag)
 *  and taking everything before it. */
export function extractTitleFromRelease(releaseTitle: string): string {
  // Replace dots, underscores, dashes with spaces first
  let cleaned = releaseTitle.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  // Find the earliest anchor and slice everything before it
  const yearPattern = /\b(19|20)\d{2}\b/;
  const anchors = [
    /\bS\d{1,2}(?:E\d{1,2})+/i,         // S01E01 (also S01E01E02E03)
    /\bS\d{1,2}\b(?!\w)/i,              // S01 (season pack, but not part of a word)
    yearPattern,                         // Release year 1920-2030
    /\b(2160p|1440p|1080p|720p|576p|480p|360p|240p|144p|4K|UHD)\b/i,
    /\b(BluRay|Blu-ray|WEB-DL|WEBDL|WEBRip|HDRip|DVDRip|HDTV|REMUX)\b/i,
    /\b(HEVC|H\.?265|x265|H\.?264|x264|AV1|AVC)\b/i,
  ];

  let cutoff = cleaned.length;
  for (const anchor of anchors) {
    // For year pattern, find the LAST year match before other anchors rather than the first,
    // since titles can start with or contain years (e.g. a year at the start or end of the title)
    if (anchor === yearPattern) {
      const allYears = [...cleaned.matchAll(new RegExp(yearPattern, 'g'))];
      // Use the last year occurrence (most likely the release year, not part of the title)
      const match = allYears.length > 0 ? allYears[allYears.length - 1] : null;
      if (match && match.index !== undefined && match.index > 0 && match.index < cutoff) {
        cutoff = match.index;
      }
      continue;
    }

    const match = cleaned.match(anchor);
    if (match && match.index !== undefined && match.index < cutoff) {
      cutoff = match.index;
    }
  }

  const title = cleaned.substring(0, cutoff).trim();
  return title || cleaned;
}

// --- Country code mapping ---

/** Map country names (from Cinemeta) to release-title country codes */
const COUNTRY_CODES: Record<string, string[]> = {
  'united states': ['us', 'usa'],
  'united kingdom': ['uk', 'gb'],
  'australia': ['au', 'aus'],
  'new zealand': ['nz'],
  'canada': ['ca', 'can'],
  'germany': ['de'],
  'france': ['fr'],
  'japan': ['jp', 'jpn'],
  'south korea': ['kr'],
  'india': ['in'],
  'brazil': ['br'],
  'spain': ['es'],
  'italy': ['it'],
  'netherlands': ['nl'],
  'sweden': ['se'],
  'norway': ['no'],
  'denmark': ['dk'],
  'finland': ['fi'],
};

/** Get all known country codes as a set (for quick lookup) */
const ALL_COUNTRY_CODES = new Set(Object.values(COUNTRY_CODES).flat());

// --- Text search matching ---

/** Check if a release title matches the expected media title for text search.
 *  Returns true if the normalized titles are close enough.
 *  Optionally accepts additional titles (e.g. Cinemeta title alongside TMDB title)
 *  and returns true if ANY title matches. */
export function isTextSearchMatch(expectedTitle: string, releaseTitle: string, year?: string, country?: string, additionalTitles?: string[]): boolean {
  if (isTextSearchMatchSingle(expectedTitle, releaseTitle, year, country)) return true;

  // Try additional titles (e.g. Cinemeta title when primary is TMDB, or vice versa)
  if (additionalTitles) {
    for (const altTitle of additionalTitles) {
      if (altTitle && altTitle !== expectedTitle && isTextSearchMatchSingle(altTitle, releaseTitle, year, country)) {
        return true;
      }
    }
  }

  return false;
}

// --- Stylized title detection ---

/** Common digit-to-letter substitutions used in stylized titles */
const STYLIZED_DIGIT_MAP: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
};

/** Detect if a title uses digit-for-letter substitutions compared to a reference title.
 *  Returns true if mapping digits back to letters in the candidate makes it match
 *  the reference, indicating the candidate is a stylized variant. */
export function isStylizedTitle(candidate: string, reference: string): boolean {
  if (!candidate || !reference) return false;

  const normCandidate = normalizeTitle(candidate);
  const normReference = normalizeTitle(reference);

  // If they already match after normalization, no stylization issue
  if (normCandidate === normReference) return false;

  // Map digits back to letters in the candidate and check if it matches the reference
  const demapped = normCandidate.replace(/[013457]/g, d => STYLIZED_DIGIT_MAP[d] || d);
  return demapped === normReference;
}

/**
 * Returns true if a release should be filtered out due to remake detection.
 * Year-present releases are rejected if the year differs significantly from the expected version.
 * Yearless releases must contain the episode name to prove they are the correct version.
 */
export function isRemakeFiltered(releaseTitle: string, episodeName: string, year: string): boolean {
  const parsedYear = parseYear(releaseTitle);
  if (!parsedYear) {
    // Yearless release — must contain the episode name to prove it's the correct version
    const epNameNorm = normalizeTitle(episodeName.replace(/\s*\(\d+\)\s*$/, ''));
    if (epNameNorm && !normalizeTitle(releaseTitle).includes(epNameNorm)) {
      return true;
    }
  } else {
    // Year-present release — reject if the year differs significantly from the expected version
    if (Math.abs(parseInt(parsedYear, 10) - parseInt(year, 10)) > 1) {
      return true;
    }
  }
  return false;
}

/** Core single-title matching logic */
function isTextSearchMatchSingle(expectedTitle: string, releaseTitle: string, year?: string, country?: string): boolean {
  const extracted = extractTitleFromRelease(releaseTitle);
  const normExpected = normalizeTitle(expectedTitle);
  const normExtracted = normalizeTitle(extracted);

  // Year validation: use the library parser to extract the year from the release title.
  // Reject if the parsed year differs significantly from the expected year.
  if (year) {
    const expectedYear = parseInt(year, 10);
    const parsedYear = parseYear(releaseTitle);
    if (parsedYear && !expectedTitle.includes(parsedYear)) {
      if (Math.abs(parseInt(parsedYear, 10) - expectedYear) > 1) {
        return false;
      }
    }
  }

  // Strip known edition terms from extracted title for comparison
  // (editions like "Extended Edition" or "Director's Cut" are metadata, not part of the title)
  const editionStripped = extracted.replace(
    /\b(extended(\s*(edition|cut))?|superfan(\s*episodes?)?|directors?\s*cut|unrated|uncut|special\s*edition|theatrical|remastered(\s*(edition|cut))?|imax(\s*edition)?|collector'?s?\s*(edition|cut)?)\b/gi, ''
  );
  const normStripped = normalizeTitle(editionStripped);

  // Exact match after normalization (with or without edition terms)
  if (normExpected === normExtracted || normExpected === normStripped) return true;

  // Check if the only difference is a country code suffix.
  // Accept if the country code matches the show's actual country, reject if it doesn't.
  if (normStripped.length > normExpected.length && normStripped.startsWith(normExpected)) {
    const suffix = normStripped.substring(normExpected.length);
    if (ALL_COUNTRY_CODES.has(suffix)) {
      // It's a country code — only accept if we know the show's country and it matches
      if (country) {
        const validCodes = COUNTRY_CODES[country.toLowerCase()] || [];
        return validCodes.includes(suffix);
      }
      // No country info available — reject to be safe
      return false;
    }
  }

  // Tolerate small differences (<=3 chars) ONLY when extracted is shorter than expected.
  // This handles cases where the extractor cuts the title slightly short.
  const lenDiff = Math.abs(normExpected.length - normStripped.length);
  if (lenDiff <= 3 && normExpected.startsWith(normStripped)) {
    return true;
  }

  // Handle titles containing years (e.g. a year that is part of the title, not a release year)
  // The extractor may have cut at a year that's actually part of the title.
  // If extracted is a prefix of expected and the missing part is just digits, accept it.
  if (normExpected.startsWith(normStripped) && normStripped.length >= normExpected.length * 0.5) {
    const missing = normExpected.substring(normStripped.length);
    if (/^\d+$/.test(missing)) return true;
  }

  // If year is provided, try matching with year appended (some releases include year in title portion)
  if (year) {
    const normWithYear = normalizeTitle(`${expectedTitle} ${year}`);
    if (normWithYear === normExtracted || normWithYear === normStripped) return true;
    const yearDiff = Math.abs(normWithYear.length - normStripped.length);
    if (yearDiff <= 3 && normWithYear.startsWith(normStripped)) {
      return true;
    }
  }

  return false;
}

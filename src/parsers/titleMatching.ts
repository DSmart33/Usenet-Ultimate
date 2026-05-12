/**
 * Title normalization and text search matching logic.
 *
 * Handles diacritics stripping, title normalization, release-name title
 * extraction, and fuzzy matching for text-based indexer searches.
 */

import { parseYear } from './metadataParsers.js';
import type { NZBSearchResult, SearchConfig } from '../types.js';
import { slog } from './searchLogger.js';

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

/** When the expected title is longer than the extracted title and the trailing
 *  characters are pure digits, decide whether those digits are the release's
 *  own year (legitimate "year-as-title", e.g. expected ends in the same year
 *  the release file is tagged with) or a sequel marker the release doesn't
 *  carry (false match: extracted is the parent film, expected is the sequel).
 *  Returns true only for the year-as-title case; callers should reject the
 *  match when this returns false. */
function tailIsReleaseYear(missing: string, parsedReleaseYear: string | undefined): boolean {
  if (!/^\d+$/.test(missing) || !parsedReleaseYear) return false;
  return missing === parsedReleaseYear || parsedReleaseYear.endsWith(missing);
}

// --- Text search matching ---

/** Check if a release title matches the expected media title for text search.
 *  Returns true if the normalized titles are close enough.
 *  Optionally accepts additional titles (e.g. Cinemeta title alongside TMDB title)
 *  and returns true if ANY title matches. */
export function isTextSearchMatch(expectedTitle: string, releaseTitle: string, year?: string, country?: string, additionalTitles?: string[], titleYear?: string): boolean {
  if (isTextSearchMatchSingle(expectedTitle, releaseTitle, year, country, titleYear)) return true;

  // Try additional titles (e.g. Cinemeta title when primary is TMDB, or vice versa)
  if (additionalTitles) {
    for (const altTitle of additionalTitles) {
      if (altTitle && altTitle !== expectedTitle && isTextSearchMatchSingle(altTitle, releaseTitle, year, country, titleYear)) {
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
export function isRemakeFiltered(releaseTitle: string, episodeName: string, year: string, titleYear?: string): boolean {
  const parsedYear = parseYear(releaseTitle);
  if (!parsedYear) {
    // Yearless release — must contain the episode name to prove it's the correct version
    const epNameNorm = normalizeTitle(episodeName.replace(/\s*\(\d+\)\s*$/, ''));
    if (epNameNorm && !normalizeTitle(releaseTitle).includes(epNameNorm)) {
      return true;
    }
  } else {
    // Year-present release — reject if the year differs from all accepted years
    const p = parseInt(parsedYear, 10);
    const yearOk = Math.abs(p - parseInt(year, 10)) <= 1;
    const titleYearOk = titleYear ? Math.abs(p - parseInt(titleYear, 10)) <= 1 : false;
    if (!yearOk && !titleYearOk) {
      return true;
    }
  }
  return false;
}

/** Core single-title matching logic */
function isTextSearchMatchSingle(expectedTitle: string, releaseTitle: string, year?: string, country?: string, titleYear?: string): boolean {
  // Miniseries keyword mismatch: reject if one has "miniseries" and the other doesn't
  const miniseriesRegex = /\bmini[.\s_-]?series\b/i;
  if (miniseriesRegex.test(releaseTitle) !== miniseriesRegex.test(expectedTitle)) {
    return false;
  }

  const extracted = extractTitleFromRelease(releaseTitle);
  const normExpected = normalizeTitle(expectedTitle);
  const normExtracted = normalizeTitle(extracted);
  // Hoisted so the loose-match paths can reuse it for the sequel-vs-year check.
  const parsedReleaseYear = parseYear(releaseTitle);

  // Year validation: reject if the parsed year doesn't match any accepted year (±1 tolerance each).
  // When titleYear is available (extracted from TVDB title suffix), accept releases matching either year.
  if (year || titleYear) {
    if (parsedReleaseYear && !expectedTitle.includes(parsedReleaseYear)) {
      const p = parseInt(parsedReleaseYear, 10);
      const yearOk = year ? Math.abs(p - parseInt(year, 10)) <= 1 : false;
      const titleYearOk = titleYear ? Math.abs(p - parseInt(titleYear, 10)) <= 1 : false;
      if (!yearOk && !titleYearOk) {
        return false;
      }
    }
  }

  // Strip known edition terms from extracted title for comparison
  // (editions like "Extended Edition" or "Director's Cut" are metadata, not part of the title).
  // Replace hyphens with spaces first so hyphen-separated edition tags
  // ("Mohicans-Director's Cut") are reachable by the word-boundary regex.
  let editionStripped = extracted.replace(/-/g, ' ').replace(
    /\b(extended(\s+(edition|cut))?|superfan(\s+episodes?)?|director'?s?(\s+\w+)?\s+cut|unrated|uncut|special\s+edition|theatrical(\s+(edition|cut))?|remastered(\s+(edition|cut))?|imax(\s+edition)?|collector'?s?\s+(edition|cut)?)\b/gi, ''
  );
  // Abbreviations with high false-positive risk in mid-title position. Only
  // strip when they appear as the LAST token of the extracted title (i.e. the
  // token immediately preceding the release year that the extractor cut at).
  // `\bdir\s*cut\b` covers both `DirCut` (no separator) and `Dir.Cut`/`Dir Cut`
  // (post-extraction dot-to-space).
  editionStripped = editionStripped.replace(/\s+(dc|dir\s*cut)\s*$/i, '');
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
    const missing = normExpected.substring(normStripped.length);
    // Accept non-digit tails outright; for digit tails, only accept when those digits
    // are the release's own year. A bare sequel number on the expected title that the
    // release lacks falls through, since matching the parent film would be a false hit.
    if (!/^\d+$/.test(missing) || tailIsReleaseYear(missing, parsedReleaseYear)) {
      return true;
    }
  }

  // Handle titles containing years (e.g. a year that is part of the title, not a release year).
  // The extractor may have cut at a year that's actually part of the title. Accept only when the
  // missing digits are the release's own year; a sequel-number-only mismatch falls through.
  if (normExpected.startsWith(normStripped) && normStripped.length >= normExpected.length * 0.5) {
    const missing = normExpected.substring(normStripped.length);
    if (tailIsReleaseYear(missing, parsedReleaseYear)) return true;
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

// --- Season-pack title matching ---

// Range patterns are season-independent so we pre-compile once at module load.
// Hyphen/underscore form keeps the optional second S (covers S01-08 too); the
// dot/space form REQUIRES both endpoints to start with S so quality markers
// like "S02.1080p" cannot misread as a range (commit b40cfd9 closed that hole).
const HYPHEN_RANGE_REGEX = /S(\d{1,2})[-_]S?(\d{1,2})/gi;
const DOT_RANGE_REGEX = /S(\d{1,2})[._\s]+S(\d{1,2})/gi;

/**
 * Returns whether `title` represents a pack that contains `season`, plus the
 * season-span of the matched range (1 for direct Sxx, larger for ranges).
 * Callers scale per-episode size estimates by seasonSpan so multi-season
 * packs produce a proportional bytes-per-episode number.
 *
 * Range detection runs two passes:
 *   1. Hyphen or underscore (S01-S08, S01_S08, S01-08). Second S optional.
 *   2. Dot or whitespace (S01.S08, S01 S08). Second S REQUIRED so quality
 *      markers like "S02.1080p" cannot misread as a range.
 *
 * Logs at debug level when a result passes only via range expansion, so
 * "why was this release kept" is diagnosable from logs alone.
 */
export function titleContainsSeasonPack(title: string, season: number): { matched: boolean; seasonSpan: number } {
  const direct = new RegExp(`\\bS0?${season}\\b(?![._\\s-]?E\\d)`, 'i');
  if (direct.test(title)) return { matched: true, seasonSpan: 1 };

  for (const m of title.matchAll(HYPHEN_RANGE_REGEX)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Math.min(a, b) <= season && season <= Math.max(a, b)) {
      const seasonSpan = Math.abs(b - a) + 1;
      console.debug(`📦 Range match: S${m[1]}-S${m[2]} covers S${season} in ${title}`);
      return { matched: true, seasonSpan };
    }
  }
  for (const m of title.matchAll(DOT_RANGE_REGEX)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Math.min(a, b) <= season && season <= Math.max(a, b)) {
      const seasonSpan = Math.abs(b - a) + 1;
      console.debug(`📦 Range match: S${m[1]}.S${m[2]} covers S${season} in ${title}`);
      return { matched: true, seasonSpan };
    }
  }
  // Keyword fallthrough: 'Show.Complete.Series', 'Show.Anthology', etc.
  // seasonSpan=0 signals "covers but span unknown" so size estimation
  // gracefully degrades in tagSeasonPack. Guards:
  //   1) Reject titles with a single-episode token (`SxxExx`); a release like
  //      `Show.S01E01.Complete` is one episode, not a series pack.
  //   2) If the title has explicit season tokens, only accept when one of
  //      them is the requested season. This prevents `Show.S06.Complete`
  //      from matching an S01 query just because it has the keyword.
  if (hasSeriesPackKeyword(title)) {
    if (/\bS\d{1,2}[._\s-]?E\d{1,3}\b/i.test(title)) return { matched: false, seasonSpan: 0 };
    const seasonTokens = extractSeasonTokens(title);
    if (seasonTokens.length === 0) return { matched: true, seasonSpan: 0 };
    if (seasonTokens.includes(season)) return { matched: true, seasonSpan: 0 };
  }
  return { matched: false, seasonSpan: 0 };
}

/**
 * Keyword detector for series-pack release titles. Single source of truth
 * shared by the indexer-result filter (titleContainsSeasonPack) and the
 * WebDAV scanner's folder check (folderCouldContainSeason). Catches the
 * canonical pack keywords that don't include explicit Sxx tokens:
 * Complete, All Seasons, Full Series, Anthology, Boxset, Collection, Saga.
 *
 * Used as a fallthrough only after direct/range checks fail, so a single-
 * episode release like 'Show.Saga.S01E01.1080p' won't keyword-match before
 * the upstream parser excludes it via parseTorrentTitle's episode detection.
 */
const SERIES_PACK_KEYWORD_RE = /\b(complete|all\s*seasons|full\s*series|the\s*complete|anthology|box[\s.-]?set|collection|saga)\b/i;
export function hasSeriesPackKeyword(text: string): boolean {
  return SERIES_PACK_KEYWORD_RE.test(text);
}

/**
 * Extract every Sxx season token from a release title or folder name.
 * Handles single-episode (`S01E01`), bare seasons (`S01`), and multi-episode
 * chains (`S06E14E15`). Two-digit seasons only; `S100+` won't match.
 *
 * Shared by the indexer-result season filter, the WebDAV folder filter, and
 * the EasyNews wrong-season reject in the absolute-episode fallback.
 */
export function extractSeasonTokens(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9])S(\d{1,2})(?:E\d{1,3})*(?![A-Za-z0-9])/gi)) {
    out.push(parseInt(m[1], 10));
  }
  return out;
}

/**
 * Filter `results` to those whose title contains `season` (direct or range),
 * tag matched results with isSeasonPack=true, and scale estimatedEpisodeSize
 * by the matched season-span. Always produces NEW result objects via spread,
 * so callers never see input arrays mutated.
 */
export function tagSeasonPack<T extends NZBSearchResult>(
  results: T[],
  season: number,
  episodesInSeason: number | undefined,
): T[] {
  return results
    .map(r => ({ r, span: titleContainsSeasonPack(r.title, season) }))
    .filter(({ span }) => span.matched)
    .map(({ r, span }) => ({
      ...r,
      isSeasonPack: true,
      estimatedEpisodeSize:
        episodesInSeason && episodesInSeason > 0 && span.seasonSpan > 0
          ? Math.round(r.size / (episodesInSeason * span.seasonSpan))
          : undefined,
    }));
}

/**
 * Build a pagination override for series-pack queries (multi-season fanout +
 * keyword queries) using the Newznab `maxPages` shape. Used by usenetSearcher.
 * Returns undefined when pagination is disabled or no extra pages are
 * configured, so callers can pass it through directly.
 */
export function buildSeriesPackPaginationMaxPages(cfg: SearchConfig | undefined): { enabled: true; maxPages: number } | undefined {
  const enabled = cfg?.seriesPackPagination !== false;
  const pages = cfg?.seriesPackAdditionalPages;
  return enabled && pages ? { enabled: true, maxPages: pages } : undefined;
}

/**
 * Variant of {@link buildSeriesPackPaginationMaxPages} that returns the
 * Prowlarr/NZBHydra `additionalPages` shape.
 */
export function buildSeriesPackPaginationAdditionalPages(cfg: SearchConfig | undefined): { enabled: true; additionalPages: number } | undefined {
  const enabled = cfg?.seriesPackPagination !== false;
  const pages = cfg?.seriesPackAdditionalPages;
  return enabled && pages ? { enabled: true, additionalPages: pages } : undefined;
}

/**
 * Variant for callers (EasyNews) whose pagination override is just a number
 * of additional pages, not an object.
 */
export function getSeriesPackAdditionalPages(cfg: SearchConfig | undefined): number | undefined {
  return cfg?.seriesPackPagination === false ? undefined : cfg?.seriesPackAdditionalPages;
}

/**
 * Build a pagination override for the season-pack query (`Title S{nn}`) using
 * the Newznab `maxPages` shape. Used by usenetSearcher. Returns undefined when
 * pagination is disabled or no extra pages are configured, so callers can pass
 * it through directly.
 */
export function buildSeasonPackPaginationMaxPages(cfg: SearchConfig | undefined): { enabled: true; maxPages: number } | undefined {
  const enabled = cfg?.seasonPackPagination !== false;
  const pages = cfg?.seasonPackAdditionalPages;
  return enabled && pages ? { enabled: true, maxPages: pages } : undefined;
}

/**
 * Variant of {@link buildSeasonPackPaginationMaxPages} that returns the
 * Prowlarr/NZBHydra `additionalPages` shape.
 */
export function buildSeasonPackPaginationAdditionalPages(cfg: SearchConfig | undefined): { enabled: true; additionalPages: number } | undefined {
  const enabled = cfg?.seasonPackPagination !== false;
  const pages = cfg?.seasonPackAdditionalPages;
  return enabled && pages ? { enabled: true, additionalPages: pages } : undefined;
}

/**
 * Variant for callers (EasyNews) whose pagination override is just a number
 * of additional pages, not an object.
 */
export function getSeasonPackAdditionalPages(cfg: SearchConfig | undefined): number | undefined {
  return cfg?.seasonPackPagination === false ? undefined : cfg?.seasonPackAdditionalPages;
}

/**
 * Run series-pack keyword queries (e.g. '<Title> Complete'). Each query is run
 * via the caller-supplied searchFn so each indexer client can bind its own
 * pagination/category options. Results are title-matched and tagged via
 * tagSeasonPack so the same filter the per-season pack search uses applies here.
 *
 * Returns an empty array when the Series Packs master toggle is off OR no
 * keywords are selected, so callers can append-and-forget. Note: this function
 * gates only the keyword half of Series Packs; the multi-season fanout has its
 * own gate inside each searcher.
 */
export async function runSeriesPackQueries<T extends NZBSearchResult>(opts: {
  searchFn: (query: string) => Promise<T[]>,
  title: string,
  season: number,
  episodesInSeason: number | undefined,
  isTitleMatch: (resultTitle: string) => boolean,
  searchConfig: SearchConfig | undefined,
  logPrefix?: string,  // e.g. indexer name; tags log lines for parallel-search disambiguation
}): Promise<T[]> {
  const cfg = opts.searchConfig;
  // Gated on the Series Packs master toggle (includeMultiSeasonPacks). When the
  // user disables Series Packs, all card features (fanout + keyword queries) go silent.
  const seriesPacksEnabled = cfg?.includeMultiSeasonPacks ?? true;
  if (!seriesPacksEnabled) return [];
  const keywords = cfg?.seriesPackKeywords ?? [];
  if (keywords.length === 0) {
    const tag = opts.logPrefix ? `[${opts.logPrefix}] ` : '';
    slog(`📦 ${tag}Series-pack: skipped (no keywords selected)`);
    return [];
  }

  const baseTitle = stripDiacritics(opts.title);
  const tag = opts.logPrefix ? `[${opts.logPrefix}] ` : '';

  const runQuery = async (q: string, label: string): Promise<T[]> => {
    slog(`🔍 ${tag}Series-pack search for: ${q}`);
    const results = await opts.searchFn(q);
    const before = results.length;
    const matched = results.filter(r => opts.isTitleMatch(r.title));
    const tagged = tagSeasonPack(matched, opts.season, opts.episodesInSeason);
    if (before !== tagged.length) {
      const keptLinks = new Set(tagged.map(p => p.link));
      const removed = results.filter(r => !keptLinks.has(r.link));
      slog(`   📦 ${tag}Series-pack filter [${label}]: ${before} → ${tagged.length} (removed ${removed.length} mismatches)`);
      removed.forEach(r => slog(`      ✂️  ${r.title}`));
    }
    if (tagged.length > 0) {
      slog(`   📦 ${tag}Found ${tagged.length} series-pack candidate(s) for "${label}"`);
    }
    return tagged;
  };

  const arrays = await Promise.all(keywords.map(kw => runQuery(`${baseTitle} ${kw}`, kw)));
  return arrays.flat();
}

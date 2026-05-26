/**
 * Title Resolver
 *
 * Resolves IMDB IDs to titles, years, and metadata via Stremio Cinemeta,
 * then optionally refines with TVDB (TV) or TMDB (movies) for canonical titles.
 * Also resolves episode counts per season and detects anime content.
 */

import axios from 'axios';
import { config, getTvRemakeFiltering } from '../config/index.js';
import { resolveTitleFromTmdb, resolveTitleFromTvdb, resolveEpisodeCountFromTvdb, resolveEpisodeCountFromTvdbId, resolveRuntimeFromTmdb, getCachedPremiereYear, detectRemake, fetchTvdbRecordById } from '../idResolver.js';
import { isStylizedTitle } from '../parsers/titleMatching.js';
import { isAnimeByImdbId, lookupByImdbId, lookupByTvdbId, getKitsuImdbEntries } from '../anime/animeDatabase.js';

export interface ResolvedTitleInfo {
  /** Final title to use for search (TVDB/TMDB resolved, or Cinemeta fallback) */
  title: string;
  /** Cinemeta title (may differ from resolved title) */
  cinemetaTitle: string;
  /** Release year */
  year?: string;
  /** Country of origin */
  country?: string;
  /** Genre list */
  genres?: string[];
  /** Number of episodes in the requested season */
  episodesInSeason?: number;
  /** Cumulative episode count across seasons before the requested one (excludes specials/season 0). Used by the absolute-numbering fallback. */
  priorSeasonsEpisodeCount?: number;
  /** Canonical absolute episode number from TVDB (when set for this episode). Tier-1 source for the absolute-numbering fallback. */
  absoluteEpisodeNumber?: number;
  /** Cumulative episode count across prior aired seasons from TVDB (excludes S0 specials). Tier-2 source when canonical isn't set. */
  tvdbPriorSeasonsCount?: number;
  /** Additional title variants for text search (e.g. Cinemeta title when different from resolved) */
  additionalTitles?: string[];
  /** Whether this content is detected as anime (Animation + Japan) */
  isAnime: boolean;
  /** Estimated runtime in seconds (from TMDB/TVDB/Cinemeta) for bitrate estimation */
  runtime?: number;
  /** Episode name from TVDB (for remake/version detection via episode name cross-referencing) */
  episodeName?: string;
  /** Whether this show has a known remake/reboot (detected via TMDB search) */
  hasRemake?: boolean;
  /** Year extracted from parenthetical suffix in resolved title, e.g. "2003" from "Show (2003)" */
  titleYear?: string;
  /** English aliases from TVDB whose normalized form is a strict substring of the resolved title and substantially shorter (< 70% length). Used as a zero-result UTS fallback for shows whose release groups publish under a shortened name. */
  searchAliases?: string[];
  /** Air date of the targeted episode in `YYYY-MM-DD` form, when TVDB has it. Used by the alias fallback to send date-formatted queries (e.g. `Jimmy Fallon 2024.05.21`) for shows whose releases are dated rather than season/episode-numbered. */
  episodeAired?: string;
}

/**
 * Resolve IMDB ID to title/year via Stremio Cinemeta
 */
async function resolveFromCinemeta(
  type: string,
  imdbId: string,
  season?: number
): Promise<{ title: string; year?: string; country?: string; genres?: string[]; episodesInSeason?: number; priorSeasonsEpisodeCount?: number; runtime?: number }> {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const response = await axios.get(url, { timeout: 5000 });
    const meta = response.data?.meta;
    if (meta?.name) {
      const year = meta.releaseInfo?.match(/^\d{4}/)?.[0] || meta.year?.toString();
      const country = meta.country || undefined;
      const genres: string[] | undefined = Array.isArray(meta.genres) ? meta.genres : undefined;
      // Count episodes in the requested season + cumulative count of prior seasons
      // (skipping specials at season 0). The prior count feeds the absolute-
      // numbering fallback in the orchestrator.
      let episodesInSeason: number | undefined;
      let priorSeasonsEpisodeCount: number | undefined;
      if (season !== undefined && Array.isArray(meta.videos)) {
        episodesInSeason = meta.videos.filter((v: any) => v.season === season).length;
        if (episodesInSeason === 0) episodesInSeason = undefined;
        priorSeasonsEpisodeCount = meta.videos.filter((v: any) => v.season > 0 && v.season < season).length;
      }
      // Parse runtime (e.g. "148 min" → 8880 seconds)
      let runtime: number | undefined;
      if (meta.runtime) {
        const mins = parseInt(String(meta.runtime), 10);
        if (mins > 0) runtime = mins * 60;
      }
      console.log(`🎯 Resolved ${imdbId} → "${meta.name}" (${year || 'unknown year'}, ${country || 'unknown country'})${episodesInSeason ? ` [S${season}: ${episodesInSeason} episodes]` : ''}${genres ? ` [${genres.join(', ')}]` : ''}${runtime ? ` [${Math.round(runtime / 60)}min]` : ''}`);
      return { title: meta.name, year, country, genres, episodesInSeason, priorSeasonsEpisodeCount, runtime };
    }
  } catch (error) {
    console.warn(`⚠️  Failed to resolve title for ${imdbId}:`, (error as Error).message);
  }
  return { title: '', year: '' };
}

/**
 * Full title resolution pipeline:
 * 1. Cinemeta lookup
 * 2. TVDB episode count (for series)
 * 3. TVDB/TMDB canonical title resolution
 * 4. Anime detection
 */
export async function resolveTitle(
  type: string,
  imdbId: string,
  season?: number,
  episode?: number,
  tvdbIdHint?: number,
): Promise<ResolvedTitleInfo> {
  // When tvdbIdHint is set the request arrived via the `tvdb:` Stremio prefix.
  // Skip Cinemeta + TMDB entirely (neither is reachable without an IMDB id) and
  // drive title/episode resolution directly from TVDB. Anime detection mirrors
  // the IMDB path's Fribb lookup, just keyed by tvdb id.
  let cinemetaTitle = '';
  let year: string | undefined;
  let country: string | undefined;
  let genres: string[] | undefined;
  let episodesInSeason: number | undefined;
  let priorSeasonsEpisodeCount: number | undefined;
  let runtime: number | undefined;
  let episodeName: string | undefined;
  let absoluteEpisodeNumber: number | undefined;
  let tvdbPriorSeasonsCount: number | undefined;
  let episodeAired: string | undefined;
  let isAnime = false;
  let resolvedTitle: string | null = null;
  let tvdbAliases: string[] | undefined;
  let tvdbNativeTitle: string | undefined;

  if (tvdbIdHint !== undefined) {
    const record = await fetchTvdbRecordById(tvdbIdHint, type === 'series' ? 'series' : 'movie');
    if (!record) {
      console.warn(`⚠️  TVDB record not found for tvdb:${tvdbIdHint}`);
      return { title: '', cinemetaTitle: '', isAnime: false };
    }
    year = record.year;
    resolvedTitle = record.title;
    tvdbAliases = record.aliases;
    tvdbNativeTitle = record.nativeTitle;
    if (record.runtime) runtime = record.runtime;

    if (type === 'series' && season !== undefined) {
      const epData = await resolveEpisodeCountFromTvdbId(tvdbIdHint, season, episode);
      if (epData) {
        episodesInSeason = epData.count;
        if (epData.runtime) runtime = epData.runtime;
        if (epData.episodeName) episodeName = epData.episodeName;
        if (epData.absoluteNumber) absoluteEpisodeNumber = epData.absoluteNumber;
        if (epData.priorSeasonsCount !== undefined) tvdbPriorSeasonsCount = epData.priorSeasonsCount;
        if (epData.episodeAired) episodeAired = epData.episodeAired;
      }
    }
    console.log(`📌 Title: "${resolvedTitle}"${year ? ` (${year})` : ''}${episodesInSeason ? ` — ${episodesInSeason} eps in season` : ''}`);

    // Mirror IMDB anime detection. Fribb-by-tvdb is the same primary signal the
    // imdb path uses (titleResolver.ts:137). Fribb is an anime-only DB by
    // construction, so any hit implies isAnime regardless of whether a Kitsu
    // title is recoverable.
    const fribb = lookupByTvdbId(tvdbIdHint);
    if (fribb) {
      isAnime = true;
      if (fribb.kitsu_id) {
        const kitsuEntries = getKitsuImdbEntries(fribb.kitsu_id);
        if (kitsuEntries.length > 0 && kitsuEntries[0].title) {
          const originalTvdbTitle = resolvedTitle;
          resolvedTitle = kitsuEntries[0].title;
          console.log(`🎌  Anime detected via Fribb tvdb-index, using Kitsu title "${resolvedTitle}"`);
          // Preserve the TVDB title as a fallback search variant, matching the
          // imdb path's preservation of cinemetaTitle in additionalTitles.
          if (originalTvdbTitle && originalTvdbTitle !== resolvedTitle) {
            cinemetaTitle = originalTvdbTitle;
          }
        }
      }
    }
  } else {
    // Step 1: Cinemeta
    const resolved = await resolveFromCinemeta(type, imdbId, season);
    cinemetaTitle = resolved.title;
    year = resolved.year;
    country = resolved.country;
    genres = resolved.genres;

    // Step 2: Episode count + runtime + episode name — prefer TVDB (authoritative for TV) over Cinemeta (fallback)
    episodesInSeason = resolved.episodesInSeason;
    priorSeasonsEpisodeCount = resolved.priorSeasonsEpisodeCount;
    runtime = resolved.runtime;
    if (type === 'series' && season !== undefined) {
      const tvdbResult = await resolveEpisodeCountFromTvdb(imdbId, season, episode);
      if (tvdbResult) {
        if (episodesInSeason && tvdbResult.count !== episodesInSeason) {
          console.log(`📌 TVDB episode count (${tvdbResult.count}) differs from Cinemeta (${episodesInSeason}) — using TVDB`);
        }
        episodesInSeason = tvdbResult.count;
        if (tvdbResult.runtime) runtime = tvdbResult.runtime;
        if (tvdbResult.episodeName) episodeName = tvdbResult.episodeName;
        if (tvdbResult.absoluteNumber) absoluteEpisodeNumber = tvdbResult.absoluteNumber;
        if (tvdbResult.priorSeasonsCount !== undefined) tvdbPriorSeasonsCount = tvdbResult.priorSeasonsCount;
        if (tvdbResult.episodeAired) episodeAired = tvdbResult.episodeAired;
      }
    }
    console.log(`📌 Title: "${cinemetaTitle}"${year ? ` (${year})` : ''}${country ? ` [${country}]` : ''}${episodesInSeason ? ` — ${episodesInSeason} eps in season` : ''}`);

    // Step 3: Anime detection — database lookup first (authoritative), Cinemeta fallback
    isAnime = isAnimeByImdbId(imdbId) || !!(country?.includes('Japan') && genres?.some(g => g.toLowerCase() === 'animation'));

    // Step 4: Resolve canonical title
    // For anime: use Kitsu-IMDB title (series-level canonical name), skip TVDB/TMDB
    // (so tvdbNativeTitle never sets for anime; native-language alts via TVDB
    // don't apply to the anime path).
    // For non-anime: TVDB for TV, TMDB for movies
    if (isAnime) {
      const fribb = lookupByImdbId(imdbId);
      if (fribb?.kitsu_id) {
        const kitsuEntries = getKitsuImdbEntries(fribb.kitsu_id);
        if (kitsuEntries.length > 0 && kitsuEntries[0].title) {
          resolvedTitle = kitsuEntries[0].title;
          console.log(`🎌 Anime detected — using Kitsu title "${resolvedTitle}" (Cinemeta: "${cinemetaTitle}")`);
        }
      }
      if (!resolvedTitle) {
        console.log(`🎌 Anime detected — no Kitsu title found, using Cinemeta title "${cinemetaTitle}"`);
      }
    } else {
      if (type === 'series') {
        const tvdbTitleResult = await resolveTitleFromTvdb(imdbId, 'series');
        resolvedTitle = tvdbTitleResult?.title ?? null;
        if (tvdbTitleResult?.year && tvdbTitleResult.year !== year) {
          console.log(`📅 Using TVDB year ${tvdbTitleResult.year} (Cinemeta: ${year})`);
          year = tvdbTitleResult.year;
        }
        tvdbAliases = tvdbTitleResult?.aliases;
        tvdbNativeTitle = tvdbTitleResult?.nativeTitle;
      } else {
        const tmdbResult = await resolveTitleFromTmdb(imdbId, 'movie');
        resolvedTitle = tmdbResult?.title ?? null;
        if (tmdbResult?.year && tmdbResult.year !== year) {
          console.log(`📅 Using TMDB year ${tmdbResult.year} (Cinemeta: ${year})`);
          year = tmdbResult.year;
        }
      }
    }
  }
  // Strip parenthetical year suffix from resolved title (e.g. "Show (2003)" → "Show")
  // TVDB/TMDB add these for disambiguation but release groups don't use them.
  // Same strip applies to the native-language title since the disambiguating
  // suffix carries through TVDB's translation regardless of locale.
  let titleYear: string | undefined;
  if (tvdbNativeTitle) {
    tvdbNativeTitle = tvdbNativeTitle.replace(/\s*\(\d{4}\)\s*$/, '');
  }
  if (resolvedTitle) {
    const yearMatch = resolvedTitle.match(/\s*\((\d{4})\)\s*$/);
    if (yearMatch) {
      titleYear = yearMatch[1];
      const originalTitle = resolvedTitle;
      resolvedTitle = resolvedTitle.replace(/\s*\(\d{4}\)\s*$/, '');
      const minYear = Math.min(parseInt(titleYear, 10), year ? parseInt(year, 10) : parseInt(titleYear, 10)) - 1;
      const maxYear = Math.max(parseInt(titleYear, 10), year ? parseInt(year, 10) : parseInt(titleYear, 10)) + 1;
      console.log(`📅 Stripped year suffix from resolved title: "${originalTitle}" → "${resolvedTitle}" (titleYear: ${titleYear}, accepted range: ${minYear}–${maxYear})`);
    }
  }
  // Detect stylized titles (digit-for-letter substitutions like 1→i, 3→e, 0→o)
  // Prefer Cinemeta for search since release groups use the natural spelling
  let title: string;
  if (resolvedTitle && cinemetaTitle && resolvedTitle !== cinemetaTitle && isStylizedTitle(resolvedTitle, cinemetaTitle)) {
    console.log(`🔤 Stylized title detected: "${resolvedTitle}" → using Cinemeta "${cinemetaTitle}" for search`);
    title = cinemetaTitle;
  } else {
    title = resolvedTitle || cinemetaTitle;
  }
  let additionalTitles: string[] | undefined;
  if (resolvedTitle && resolvedTitle !== title) {
    // Stylized case: resolved title was swapped out, keep it as fallback
    additionalTitles = [resolvedTitle];
  } else if (cinemetaTitle && cinemetaTitle !== title) {
    // Normal case: Cinemeta differs from resolved, keep it as fallback
    additionalTitles = [cinemetaTitle];
  }
  // When force-English replaced a non-English TVDB title, append the original
  // native-language form as an additional alt. parallelAlternateTitleSearch then
  // fans English + native concurrently; sequential alt-title retry uses native
  // on zero-result fallback. nativeTitle is only set when an actual substitution
  // occurred, so the !== title guard is sufficient (no normalize dedup needed).
  if (tvdbNativeTitle && tvdbNativeTitle !== title) {
    additionalTitles = additionalTitles ? [...additionalTitles, tvdbNativeTitle] : [tvdbNativeTitle];
  }
  if (resolvedTitle && resolvedTitle !== cinemetaTitle && title === resolvedTitle) {
    if (isAnime && additionalTitles?.length) {
      console.log(`🎯 Anime search titles: "${resolvedTitle}" + "${cinemetaTitle}"`);
    } else {
      console.log(`🎯 Using resolved title "${resolvedTitle}" for search (Cinemeta: "${cinemetaTitle}")`);
    }
  }

  // Step 5: Resolve runtime — TMDB for movies (if key configured and Cinemeta didn't provide it or for higher accuracy)
  // Skipped on tvdb: requests since TMDB is keyed by IMDB id which isn't
  // available on that path; TVDB record runtime is the authoritative source.
  if (type === 'movie' && tvdbIdHint === undefined) {
    const tmdbRuntime = await resolveRuntimeFromTmdb(imdbId);
    if (tmdbRuntime) runtime = tmdbRuntime;

    // Release groups tag films with the year IMDB shows (the earliest public
    // release); TMDB/Cinemeta report the later theatrical year, so text searches
    // miss the scene releases. Prefer the premiere year when it is exactly one
    // year earlier. resolveRuntimeFromTmdb cached it above (same request).
    const premiereYear = getCachedPremiereYear(imdbId);
    if (year && premiereYear && parseInt(year, 10) - parseInt(premiereYear, 10) === 1) {
      console.log(`📅 Using premiere year ${premiereYear} from TMDB release_dates (theatrical: ${year})`);
      year = premiereYear;
    }
  }

  // Step 6: Detect remakes — check if another show shares the same title (for text search filtering)
  // Empty/whitespace title can happen when both Cinemeta and TVDB fail to
  // resolve; without the trim guard, detectRemake('') hits TMDB with an empty
  // query and returns a 400.
  const hasRemake = (type === 'series' && getTvRemakeFiltering(config) && title?.trim())
    ? await detectRemake(title)
    : undefined;

  // Step 7: Substring-shortcut alias filter for the zero-result UTS fallback.
  // Keeps an alias only when it is a strict substring of the canonical title
  // and substantially shorter (< 70% length ratio). Excludes length-similar
  // variants and longer supplemental aliases that wouldn't help the search.
  let searchAliases: string[] | undefined;
  if (tvdbAliases?.length && title) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const titleNorm = norm(title);
    if (titleNorm.length > 0) {
      const kept: string[] = [];
      for (const alias of tvdbAliases) {
        const aliasNorm = norm(alias);
        if (aliasNorm.length === 0) continue;
        if (!titleNorm.includes(aliasNorm)) continue;
        if (aliasNorm.length / titleNorm.length >= 0.7) continue;
        kept.push(alias);
      }
      if (kept.length > 0) {
        searchAliases = kept;
        console.log(`🎤 Substring alias(es) for "${title}": [${kept.map(a => `"${a}"`).join(', ')}]`);
      }
    }
  }

  return {
    title,
    cinemetaTitle,
    year,
    country,
    genres,
    episodesInSeason,
    priorSeasonsEpisodeCount,
    absoluteEpisodeNumber,
    tvdbPriorSeasonsCount,
    additionalTitles,
    isAnime,
    runtime,
    episodeName,
    hasRemake,
    titleYear,
    searchAliases,
    episodeAired,
  };
}

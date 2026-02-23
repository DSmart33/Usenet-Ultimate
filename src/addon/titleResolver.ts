/**
 * Title Resolver
 *
 * Resolves IMDB IDs to titles, years, and metadata via Stremio Cinemeta,
 * then optionally refines with TVDB (TV) or TMDB (movies) for canonical titles.
 * Also resolves episode counts per season and detects anime content.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { resolveTitleFromTmdb, resolveTitleFromTvdb, resolveEpisodeCountFromTvdb } from '../idResolver.js';

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
  /** Additional title variants for text search (e.g. Cinemeta title when different from resolved) */
  additionalTitles?: string[];
  /** Whether this content is detected as anime (Animation + Japan) */
  isAnime: boolean;
  /** Whether text search should be forced for anime */
  useTextForAnime: boolean;
}

/**
 * Resolve IMDB ID to title/year via Stremio Cinemeta
 */
async function resolveFromCinemeta(
  type: string,
  imdbId: string,
  season?: number
): Promise<{ title: string; year?: string; country?: string; genres?: string[]; episodesInSeason?: number }> {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const response = await axios.get(url, { timeout: 5000 });
    const meta = response.data?.meta;
    if (meta?.name) {
      const year = meta.releaseInfo?.match(/^\d{4}/)?.[0] || meta.year?.toString();
      const country = meta.country || undefined;
      const genres: string[] | undefined = Array.isArray(meta.genres) ? meta.genres : undefined;
      // Count episodes in the requested season from the videos array
      let episodesInSeason: number | undefined;
      if (season !== undefined && Array.isArray(meta.videos)) {
        episodesInSeason = meta.videos.filter((v: any) => v.season === season).length;
        if (episodesInSeason === 0) episodesInSeason = undefined;
      }
      console.log(`🎯 Resolved ${imdbId} → "${meta.name}" (${year || 'unknown year'}, ${country || 'unknown country'})${episodesInSeason ? ` [S${season}: ${episodesInSeason} episodes]` : ''}${genres ? ` [${genres.join(', ')}]` : ''}`);
      return { title: meta.name, year, country, genres, episodesInSeason };
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
): Promise<ResolvedTitleInfo> {
  // Step 1: Cinemeta
  const resolved = await resolveFromCinemeta(type, imdbId, season);
  const cinemetaTitle = resolved.title;
  const year = resolved.year;
  const country = resolved.country;
  const genres = resolved.genres;

  // Step 2: Episode count — prefer TVDB (authoritative for TV) over Cinemeta (fallback)
  let episodesInSeason = resolved.episodesInSeason;
  if (type === 'series' && season !== undefined) {
    const tvdbCount = await resolveEpisodeCountFromTvdb(imdbId, season);
    if (tvdbCount) {
      if (episodesInSeason && tvdbCount !== episodesInSeason) {
        console.log(`📌 TVDB episode count (${tvdbCount}) differs from Cinemeta (${episodesInSeason}) — using TVDB`);
      }
      episodesInSeason = tvdbCount;
    }
  }
  console.log(`📌 Title: "${cinemetaTitle}"${year ? ` (${year})` : ''}${country ? ` [${country}]` : ''}${episodesInSeason ? ` — ${episodesInSeason} eps in season` : ''}`);

  // Step 3: Anime detection
  const isAnime = !!(country?.includes('Japan') && genres?.some(g => g.toLowerCase() === 'animation'));
  const skipAnimeResolve = config.searchConfig?.skipAnimeTitleResolve !== false; // default true
  const useTextForAnime = config.searchConfig?.useTextSearchForAnime !== false; // default true

  // Step 4: Resolve canonical title — TVDB for TV, TMDB for movies
  // Skip for anime to avoid Japanese title conversion
  let resolvedTitle: string | null = null;
  if (isAnime && skipAnimeResolve) {
    console.log(`🎌 Anime detected — using Cinemeta title "${cinemetaTitle}" (skipping TVDB/TMDB resolution)`);
  } else {
    resolvedTitle = type === 'series'
      ? await resolveTitleFromTvdb(imdbId, 'series')
      : await resolveTitleFromTmdb(imdbId, 'movie');
  }
  const title = resolvedTitle || cinemetaTitle;
  const additionalTitles = cinemetaTitle && cinemetaTitle !== title ? [cinemetaTitle] : undefined;
  if (resolvedTitle && resolvedTitle !== cinemetaTitle) {
    console.log(`🎯 Using resolved title "${resolvedTitle}" for search (Cinemeta: "${cinemetaTitle}")`);
  }

  return {
    title,
    cinemetaTitle,
    year,
    country,
    genres,
    episodesInSeason,
    additionalTitles,
    isAnime,
    useTextForAnime,
  };
}

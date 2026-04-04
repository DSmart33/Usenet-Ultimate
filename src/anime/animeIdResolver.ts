/**
 * Anime ID Resolver
 *
 * Resolves anime IDs (Kitsu, MAL, AniList, AniDB) to IMDB/TMDB/TVDB IDs
 * and correct season/episode numbers using the offline anime databases.
 *
 * Handles episode offset calculation: anime databases use flat episode numbering
 * (e.g. episode 27) while TVDB uses season-based (e.g. S02E01).
 */

import type { ParsedAnimeId, ResolvedAnimeIds, FribbEntry } from './types.js';
import {
  lookupByKitsuId, lookupByMalId, lookupByAnilistId, lookupByAnidbId,
  getKitsuImdbEntries, getManamiByMalId, getManamiByKitsuId,
  getAnitraktMovieByMalId, getAnitraktTvByMalId, getAnimeListByAnidbId,
  isDatabaseLoaded,
} from './animeDatabase.js';

/**
 * Parse an anime ID from a Stremio request ID string.
 * Formats: kitsu:12345, kitsu:12345:5, mal:12345:1:5
 * Anime IDs (kitsu/mal/anilist/anidb) use flat episode numbering (no season in ID).
 */
export function parseAnimeId(id: string): ParsedAnimeId | null {
  const prefixes = ['kitsu:', 'mal:', 'anilist:', 'anidb:'] as const;
  for (const prefix of prefixes) {
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length).split(':');
      const animeId = rest[0];
      if (!animeId) return null;
      return {
        prefix: prefix.slice(0, -1) as ParsedAnimeId['prefix'],
        id: animeId,
        // Anime IDs use flat episode numbering — no season in the ID
        // Format: prefix:id:episode (e.g. kitsu:12345:5)
        episode: rest[1] ? parseInt(rest[1], 10) : undefined,
      };
    }
  }
  return null;
}

/**
 * Look up a Fribb entry by anime ID prefix and value.
 */
function lookupFribb(prefix: ParsedAnimeId['prefix'], id: string): FribbEntry | undefined {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return undefined;
  switch (prefix) {
    case 'kitsu': return lookupByKitsuId(numId);
    case 'mal': return lookupByMalId(numId);
    case 'anilist': return lookupByAnilistId(numId);
    case 'anidb': return lookupByAnidbId(numId);
  }
}

/**
 * Get title from Manami DB for an anime.
 */
function getTitle(prefix: ParsedAnimeId['prefix'], id: string, fribb?: FribbEntry): string | undefined {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return undefined;

  // Try Manami by the original ID type
  if (prefix === 'mal') {
    const manami = getManamiByMalId(numId);
    if (manami?.title) return manami.title;
  } else if (prefix === 'kitsu') {
    const manami = getManamiByKitsuId(numId);
    if (manami?.title) return manami.title;
  }

  // Fall back to Manami via MAL ID from Fribb
  if (fribb?.mal_id) {
    const manami = getManamiByMalId(fribb.mal_id);
    if (manami?.title) return manami.title;
  }

  // Fall back to Kitsu-IMDB mapping title
  if (prefix === 'kitsu' || fribb?.kitsu_id) {
    const kitsuId = prefix === 'kitsu' ? numId : fribb?.kitsu_id;
    if (kitsuId) {
      const entries = getKitsuImdbEntries(kitsuId);
      if (entries.length > 0 && entries[0].title) return entries[0].title;
    }
  }

  // Fall back to Anitrakt title
  const malId = prefix === 'mal' ? numId : fribb?.mal_id;
  if (malId) {
    const movie = getAnitraktMovieByMalId(malId);
    if (movie?.myanimelist.title) return movie.myanimelist.title;
    const tvEntries = getAnitraktTvByMalId(malId);
    if (tvEntries.length > 0 && tvEntries[0].myanimelist.title) return tvEntries[0].myanimelist.title;
  }

  return undefined;
}

/**
 * Calculate season and episode from flat episode number using Kitsu-IMDB mapping
 * and Anime Lists XML offset data.
 */
function resolveEpisodeOffset(
  fribb: FribbEntry | undefined,
  prefix: ParsedAnimeId['prefix'],
  id: string,
  flatEpisode: number | undefined
): { season?: number; episode?: number } {
  if (flatEpisode === undefined) return {};

  const numId = parseInt(id, 10);

  // Try Kitsu-IMDB mapping for season/episode offsets
  const kitsuId = prefix === 'kitsu' ? numId : fribb?.kitsu_id;
  if (kitsuId) {
    const entries = getKitsuImdbEntries(kitsuId);
    if (entries.length > 0) {
      // Find the best matching entry for this episode
      // Entries with fromEpisode tell us where this Kitsu entry starts in TVDB numbering
      const entry = entries.find(e => e.fromSeason !== undefined) || entries[0];
      if (entry.fromSeason !== undefined && entry.fromEpisode !== undefined) {
        // Flat episode → season-based: episode offset from the start of this Kitsu entry
        const adjustedEpisode = flatEpisode - entry.fromEpisode + 1;
        if (adjustedEpisode > 0) {
          return { season: entry.fromSeason, episode: adjustedEpisode };
        }
      }
    }
  }

  // Try Anime Lists XML for AniDB → TVDB offset
  const anidbId = prefix === 'anidb' ? numId : fribb?.anidb_id;
  if (anidbId) {
    const animeList = getAnimeListByAnidbId(anidbId);
    if (animeList) {
      const season = animeList.defaultTvdbSeason;
      const offset = animeList.episodeOffset || 0;
      if (season !== undefined) {
        return { season, episode: flatEpisode + offset };
      }
    }
  }

  // Try Fribb season data
  if (fribb?.season?.tvdb !== undefined) {
    return { season: fribb.season.tvdb, episode: flatEpisode };
  }

  // Try Anitrakt TV for season info
  const malId = prefix === 'mal' ? numId : fribb?.mal_id;
  if (malId) {
    const tvEntries = getAnitraktTvByMalId(malId);
    if (tvEntries.length > 0) {
      const entry = tvEntries[0];
      if (entry.trakt?.season?.number !== undefined) {
        return { season: entry.trakt.season.number, episode: flatEpisode };
      }
    }
  }

  // No season info found — return flat episode as-is
  return { episode: flatEpisode };
}

/**
 * Get year from Anitrakt or Manami databases.
 */
function getYear(prefix: ParsedAnimeId['prefix'], id: string, fribb?: FribbEntry): string | undefined {
  const numId = parseInt(id, 10);
  const malId = prefix === 'mal' ? numId : fribb?.mal_id;

  if (malId) {
    const movie = getAnitraktMovieByMalId(malId);
    if (movie?.release_year) return String(movie.release_year);
    const tvEntries = getAnitraktTvByMalId(malId);
    if (tvEntries.length > 0 && tvEntries[0].release_year) return String(tvEntries[0].release_year);
  }

  // Manami has animeSeason.year
  if (prefix === 'mal' && !isNaN(numId)) {
    const manami = getManamiByMalId(numId);
    if (manami?.animeSeason?.year) return String(manami.animeSeason.year);
  } else if (prefix === 'kitsu' && !isNaN(numId)) {
    const manami = getManamiByKitsuId(numId);
    if (manami?.animeSeason?.year) return String(manami.animeSeason.year);
  }

  return undefined;
}

/**
 * Resolve an anime ID to all available external IDs + title + season/episode.
 * Returns null if the database is not loaded or no mapping is found.
 */
export function resolveAnimeId(parsed: ParsedAnimeId): ResolvedAnimeIds | null {
  if (!isDatabaseLoaded()) return null;

  const fribb = lookupFribb(parsed.prefix, parsed.id);

  // Extract all cross-mapped IDs from Fribb
  const imdbId = fribb?.imdb_id || undefined;
  const tmdbId = fribb?.themoviedb_id ? String(fribb.themoviedb_id) : undefined;
  const tvdbId = fribb?.thetvdb_id ? String(fribb.thetvdb_id) : undefined;

  // Supplement missing IDs from other databases
  const numId = parseInt(parsed.id, 10);
  let supplementImdb = imdbId;
  let supplementTmdb = tmdbId;
  let supplementTvdb = tvdbId;

  // Kitsu-IMDB: most direct anime IMDB source
  const kitsuId = parsed.prefix === 'kitsu' ? numId : fribb?.kitsu_id;
  if (kitsuId && !supplementImdb) {
    const kitsuEntries = getKitsuImdbEntries(kitsuId);
    if (kitsuEntries.length > 0 && kitsuEntries[0].imdb_id) {
      supplementImdb = kitsuEntries[0].imdb_id;
    }
  }

  // Anitrakt: IMDB, TMDB, TVDB via MAL ID
  const malId = parsed.prefix === 'mal' ? numId : fribb?.mal_id;
  if (malId) {
    const movie = getAnitraktMovieByMalId(malId);
    if (movie) {
      if (!supplementImdb && movie.externals.imdb) supplementImdb = movie.externals.imdb;
      if (!supplementTmdb && movie.externals.tmdb) supplementTmdb = String(movie.externals.tmdb);
    }
    const tvEntries = getAnitraktTvByMalId(malId);
    if (tvEntries.length > 0) {
      const tv = tvEntries[0];
      if (!supplementImdb && tv.externals.imdb) supplementImdb = tv.externals.imdb;
      if (!supplementTmdb && tv.externals.tmdb) supplementTmdb = String(tv.externals.tmdb);
      if (!supplementTvdb && tv.externals.tvdb) supplementTvdb = String(tv.externals.tvdb);
    }
  }

  // Anime Lists XML via AniDB ID
  const anidbId = parsed.prefix === 'anidb' ? numId : fribb?.anidb_id;
  if (anidbId) {
    const animeList = getAnimeListByAnidbId(anidbId);
    if (animeList) {
      if (!supplementImdb && animeList.imdbId) supplementImdb = animeList.imdbId;
      if (!supplementTmdb && animeList.tmdbId) supplementTmdb = String(animeList.tmdbId);
      if (!supplementTvdb && animeList.tvdbId) supplementTvdb = String(animeList.tvdbId);
    }
  }

  const title = getTitle(parsed.prefix, parsed.id, fribb);
  const year = getYear(parsed.prefix, parsed.id, fribb);
  const { season, episode } = resolveEpisodeOffset(fribb, parsed.prefix, parsed.id, parsed.episode);

  // If we have no IDs and no title, resolution failed
  if (!supplementImdb && !supplementTmdb && !supplementTvdb && !title) {
    return null;
  }

  const result: ResolvedAnimeIds = {
    imdbId: supplementImdb,
    tmdbId: supplementTmdb,
    tvdbId: supplementTvdb,
    title,
    year,
    season,
    episode,
  };

  console.log(`🎌 Anime resolved: ${parsed.prefix}:${parsed.id}${parsed.episode !== undefined ? ':' + parsed.episode : ''} → ${supplementImdb || 'no IMDB'}${title ? ' (' + title + ')' : ''}${season !== undefined ? ' S' + String(season).padStart(2, '0') : ''}${episode !== undefined ? 'E' + String(episode).padStart(2, '0') : ''}`);

  return result;
}

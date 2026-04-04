/**
 * Anime Database Types
 *
 * Type definitions for offline anime mapping databases used to resolve
 * Kitsu/MAL/AniList/AniDB IDs to IMDB/TMDB/TVDB IDs.
 */

// Supported anime ID prefixes from Stremio
export type AnimeIdPrefix = 'kitsu' | 'mal' | 'anilist' | 'anidb';

// Parsed anime ID from a Stremio request
export interface ParsedAnimeId {
  prefix: AnimeIdPrefix;
  id: string;
  season?: number;
  episode?: number;
}

// Result of resolving an anime ID through the offline databases
export interface ResolvedAnimeIds {
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  tvmazeId?: string;
  title?: string;
  year?: string;
  season?: number;      // Mapped season (from flat episode → TVDB season-based)
  episode?: number;     // Mapped episode (adjusted by offset)
}

// Fribb anime-list-full.json entry
export interface FribbEntry {
  anidb_id?: number;
  anilist_id?: number;
  anime_planet_id?: string;
  anisearch_id?: number;
  imdb_id?: string;
  kitsu_id?: number;
  livechart_id?: number;
  mal_id?: number;
  notify_moe_id?: string;
  simkl_id?: number;
  themoviedb_id?: number;
  thetvdb_id?: number;
  type?: string;
  season?: {
    tvdb?: number;
    tmdb?: number;
  };
}

// Kitsu-IMDB mapping entry (from stremio-kitsu-anime)
export interface KitsuImdbEntry {
  kitsu_id: number;
  imdb_id: string;
  title?: string;
  fromSeason?: number;
  fromEpisode?: number;
  nonImdbEpisodes?: number[];
}

// Manami anime-offline-database entry
export interface ManamiEntry {
  sources: string[];
  title: string;
  type: string;
  episodes: number;
  status: string;
  animeSeason?: { season?: string; year?: number };
  synonyms?: string[];
}

// Anitrakt movie mapping entry
export interface AnitraktMovieEntry {
  myanimelist: { title: string; id: number };
  trakt: { title: string; id: number; slug: string; type: string };
  release_year: number;
  externals: { tmdb?: number; imdb?: string; letterboxd?: string };
}

// Anitrakt TV mapping entry
export interface AnitraktTvEntry {
  myanimelist: { title: string; id: number };
  trakt: { title: string; id: number; slug: string; type: string; season?: { id: number; number: number; externals?: { tvdb?: number; tmdb?: number; imdb?: string } }; is_split_cour?: boolean };
  release_year: number;
  externals: { tvdb?: number; tmdb?: number; imdb?: string; tvrage?: number };
}

// Anime Lists XML entry (parsed from XML)
export interface AnimeListEntry {
  anidbId: number;
  tvdbId?: number;
  defaultTvdbSeason?: number;
  episodeOffset?: number;
  tmdbTv?: number;
  tmdbSeason?: number;
  tmdbOffset?: number;
  tmdbId?: number;
  imdbId?: string;
  name?: string;
}

// Database status for health endpoint
export interface AnimeDatabaseStatus {
  loaded: boolean;
  lastRefresh?: string;     // ISO timestamp
  totalMappings: number;
  sources: {
    fribb: boolean;
    manami: boolean;
    kitsuImdb: boolean;
    anitraktMovies: boolean;
    anitraktTv: boolean;
    animeLists: boolean;
  };
  failures: string[];
}

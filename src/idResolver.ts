/**
 * External ID Resolver
 *
 * Resolves IMDB IDs (from Stremio) to external service IDs (TMDB, TVDB, TVmaze)
 * for use with Newznab indexer search parameters.
 *
 * Caches resolved IDs for 24 hours since these mappings are essentially permanent.
 */

import axios from 'axios';
import NodeCache from 'node-cache';
import { config } from './config/index.js';

// Cache resolved IDs for 24 hours
const idCache = new NodeCache({ stdTTL: 86400 });

/**
 * Resolve an IMDB ID to an external service ID for use as a Newznab search parameter.
 * Returns { idParam, idValue } on success, or null on failure (caller should fall back to IMDB).
 */
export async function resolveExternalId(
  imdbId: string,
  type: 'movie' | 'series',
  targetService: 'tmdb' | 'tvdb' | 'tvmaze'
): Promise<{ idParam: string; idValue: string } | null> {
  const cacheKey = `id:${imdbId}:${targetService}`;
  const cached = idCache.get<{ idParam: string; idValue: string }>(cacheKey);
  if (cached) {
    console.log(`🔗 ID cache hit: ${imdbId} → ${targetService} = ${cached.idValue}`);
    return cached;
  }

  try {
    let result: { idParam: string; idValue: string } | null = null;

    switch (targetService) {
      case 'tmdb':
        result = await resolveTmdbId(imdbId, type);
        break;
      case 'tvdb':
        result = await resolveTvdbId(imdbId, type);
        break;
      case 'tvmaze':
        result = await resolveTvmazeId(imdbId);
        break;
    }

    if (result) {
      idCache.set(cacheKey, result);
      console.log(`🔗 Resolved ${imdbId} → ${targetService} = ${result.idValue}`);
    }

    return result;
  } catch (error) {
    console.warn(`⚠️  Failed to resolve ${targetService} ID for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Shared TMDB /find lookup — returns both the numeric ID and the canonical title.
 * Used by resolveTmdbId() (for ID resolution) and resolveTitleFromTmdb() (for title resolution).
 */
async function findOnTmdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ id: number; title: string; year?: string } | null> {
  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) {
    console.warn('⚠️  TMDB API key not configured');
    return null;
  }

  // Detect v4 Read Access Token (JWT format, long) vs v3 API key (short hex)
  const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');

  const response = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
    params: {
      external_source: 'imdb_id',
      ...(isReadAccessToken ? {} : { api_key: apiKey }),
    },
    headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
    timeout: 5000,
  });

  const data = response.data;

  if (type === 'movie' && data.movie_results?.length > 0) {
    const movie = data.movie_results[0];
    const year = movie.release_date?.match(/^\d{4}/)?.[0];
    return { id: movie.id, title: movie.title, year };
  } else if (type === 'series' && data.tv_results?.length > 0) {
    const show = data.tv_results[0];
    const year = show.first_air_date?.match(/^\d{4}/)?.[0];
    return { id: show.id, title: show.name, year };
  }

  console.warn(`⚠️  No TMDB ${type} result found for ${imdbId}`);
  return null;
}

/**
 * TMDB: Find by IMDB ID — returns the numeric TMDB ID for Newznab search params.
 * Also caches the canonical title as a side effect for resolveTitleFromTmdb().
 * Supports both v3 API key (query param) and v4 Read Access Token (Bearer header).
 */
async function resolveTmdbId(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ idParam: string; idValue: string } | null> {
  const result = await findOnTmdb(imdbId, type);
  if (!result) return null;

  // Cache the canonical title and year as side effects (avoids a second API call in resolveTitleFromTmdb)
  if (result.title) {
    idCache.set(`title:tmdb:${imdbId}`, result.title);
  }
  if (result.year) {
    idCache.set(`year:tmdb:${imdbId}`, result.year);
  }

  return { idParam: 'tmdbid', idValue: result.id.toString() };
}

/**
 * Map a numeric TMDB id to its external ids (IMDB, plus TVDB for series) via
 * /3/{movie|tv}/{id}/external_ids. Drives the tmdb: Stremio prefix, which
 * delegates to the imdb or tvdb pipeline instead of resolving titles itself.
 * No 401-retry: TMDB v3 keys / v4 tokens do not expire mid-session like the
 * TVDB bearer token. v3 api_key vs v4 bearer detection mirrors findOnTmdb.
 */
export async function resolveTmdbExternalIds(
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<{ imdbId?: string; tvdbId?: number } | null> {
  const cacheKey = `tmdb:external:${type}:${tmdbId}`;
  const cached = idCache.get<{ imdbId?: string; tvdbId?: number }>(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) return null;
  const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');
  const pathSeg = type === 'movie' ? 'movie' : 'tv';

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/${pathSeg}/${tmdbId}/external_ids`, {
      params: isReadAccessToken ? {} : { api_key: apiKey },
      headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });
    const data = response.data ?? {};
    const imdbId = typeof data.imdb_id === 'string' && /^tt\d+$/.test(data.imdb_id) ? data.imdb_id : undefined;
    const tvdbId = typeof data.tvdb_id === 'number' && data.tvdb_id > 0 ? data.tvdb_id : undefined;
    const result = { imdbId, tvdbId };
    // Cache only positive results. A record with no external ids is left
    // uncached so it is re-checked next request (TMDB may add an imdb id later).
    if (imdbId || tvdbId) idCache.set(cacheKey, result);
    console.log(`🆔 TMDB external ids: ${pathSeg} id=${tmdbId}${imdbId ? ` imdb=${imdbId}` : ''}${tvdbId ? ` tvdb=${tvdbId}` : ''}`);
    return result;
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 404) {
      console.warn(`⚠️  TMDB record not found: ${pathSeg} id=${tmdbId} (404)`);
      return null;
    }
    console.warn(`⚠️  TMDB external-ids error: ${pathSeg} id=${tmdbId}: ${status || (error as Error).message}`);
    return null;
  }
}

/**
 * Resolve the canonical movie title for an IMDB ID via TMDB.
 * Stremio's Cinemeta sometimes returns truncated or incorrect titles
 * (e.g. truncated or missing subtitle portions of full titles).
 * TMDB titles match what release groups actually use, improving text search accuracy.
 * For TV shows, use resolveTitleFromTvdb() instead.
 *
 * If resolveTmdbId() was already called (for ID-based search), the title will be
 * in cache and this returns instantly with no extra API call.
 *
 * Returns null if TMDB API key isn't configured or the lookup fails.
 */
export async function resolveTitleFromTmdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ title: string; year?: string } | null> {
  const titleCacheKey = `title:tmdb:${imdbId}`;
  const cachedTitle = idCache.get<string>(titleCacheKey);
  if (cachedTitle) {
    const cachedYear = idCache.get<string>(`year:tmdb:${imdbId}`);
    console.log(`🎯 TMDB title cache hit: ${imdbId} → "${cachedTitle}"`);
    return { title: cachedTitle, year: cachedYear };
  }

  try {
    const result = await findOnTmdb(imdbId, type);
    if (!result?.title) return null;

    idCache.set(titleCacheKey, result.title);
    if (result.year) {
      idCache.set(`year:tmdb:${imdbId}`, result.year);
    }

    // Also cache the ID as a bonus (avoids a duplicate API call if ID resolution happens later)
    const idCacheKey = `id:${imdbId}:tmdb`;
    if (!idCache.has(idCacheKey)) {
      idCache.set(idCacheKey, { idParam: 'tmdbid', idValue: result.id.toString() });
    }

    console.log(`🎯 TMDB title resolved: ${imdbId} → "${result.title}"`);
    return { title: result.title, year: result.year };
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TMDB title for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Resolve movie runtime in seconds from TMDB detail endpoint.
 * Requires an extra API call to /3/movie/{id} since /find doesn't include runtime.
 * The same request also pulls release_dates (append_to_response), so it records the
 * premiere year (earliest release, when earlier than the theatrical date) under
 * `premiereYear:tmdb:{imdbId}` for getCachedPremiereYear to read.
 */
export async function resolveRuntimeFromTmdb(imdbId: string): Promise<number | undefined> {
  const cacheKey = `runtime:tmdb:${imdbId}`;
  const cached = idCache.get<number>(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) return undefined;

  try {
    // Get TMDB ID (likely already cached from title resolution)
    const tmdbResult = await findOnTmdb(imdbId, 'movie');
    if (!tmdbResult) return undefined;

    const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');
    const response = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbResult.id}`, {
      params: {
        append_to_response: 'release_dates',
        ...(isReadAccessToken ? {} : { api_key: apiKey }),
      },
      headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });

    // Derive the premiere year:
    // The earliest release when it falls before the primary (theatrical) date.
    // The movie search-year resolver prefers it, since that is the year IMDB shows
    // and release groups tag. Stored under its own key for getCachedPremiereYear.
    const primaryYear = response.data?.release_date?.match(/^\d{4}/)?.[0];
    const regions = response.data?.release_dates?.results;
    if (primaryYear && Array.isArray(regions)) {
      let earliest: string | undefined;
      for (const region of regions) {
        if (!Array.isArray(region?.release_dates)) continue;
        for (const d of region.release_dates) {
          const rd = d?.release_date;
          if (typeof rd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rd) && (!earliest || rd < earliest)) earliest = rd;
        }
      }
      const earliestYear = earliest?.slice(0, 4);
      if (earliestYear && earliestYear < primaryYear) {
        idCache.set(`premiereYear:tmdb:${imdbId}`, earliestYear);
      }
    }

    const runtime = response.data?.runtime;
    if (typeof runtime === 'number' && runtime > 0) {
      const seconds = runtime * 60;
      idCache.set(cacheKey, seconds);
      console.log(`🎯 TMDB runtime: ${imdbId} → ${runtime}min`);
      return seconds;
    }
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TMDB runtime for ${imdbId}:`, (error as Error).message);
  }
  return undefined;
}

/**
 * Earliest-release ("premiere") year recorded by resolveRuntimeFromTmdb, set only
 * when it predates the primary/theatrical date. Used by the movie search-year
 * resolver to prefer the year IMDB shows. Returns undefined when there is no earlier release.
 */
export function getCachedPremiereYear(imdbId: string): string | undefined {
  return idCache.get<string>(`premiereYear:tmdb:${imdbId}`);
}

/**
 * Detect if a TV show has a remake/reboot by searching TVDB for shows with the same title.
 * Returns true if 2+ results share the same normalized title with different years.
 * Cached for 24 hours since remake status doesn't change.
 * Falls back to false if TVDB key is not configured (year-only filtering still applies).
 */
export async function detectRemake(title: string): Promise<boolean> {
  const cacheKey = `remake:${title.toLowerCase()}`;
  const cached = idCache.get<{ remake: boolean; years?: string[] }>(cacheKey);
  if (cached !== undefined) {
    if (cached.remake) console.log(`🔄 Remake detected for "${title}": ${cached.years?.join(', ') ?? '?'} (cached)`);
    return cached.remake;
  }

  const token = await getTvdbToken();
  if (!token) return false;

  try {
    const response = await axios.get('https://api4.thetvdb.com/v4/search', {
      params: { query: title, type: 'series' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    const results = response.data?.data;
    if (!Array.isArray(results) || results.length < 2) {
      idCache.set(cacheKey, { remake: false });
      return false;
    }

    // Check if 2+ results share the same normalized title but have different years.
    // Strip parenthetical year suffixes like "(2003)" since TVDB often appends these to remakes.
    // Compare against translations.eng when present so non-English-primary shows
    // (e.g. anime returned under their Japanese name) match the English query title.
    const stripYearSuffix = (s: string) => s.replace(/\s*\(\d{4}\)\s*$/, '');
    const norm = (s: string) => stripYearSuffix(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTarget = norm(title);
    const matchingShows = results.filter((r: any) => {
      const eng = (r.translations && typeof r.translations.eng === 'string' && r.translations.eng) || r.name || '';
      return norm(eng) === normalizedTarget;
    });

    if (matchingShows.length >= 2) {
      const years = [...new Set(matchingShows.map((r: any) => r.year).filter(Boolean))].sort() as string[];
      if (years.length >= 2) {
        console.log(`🔄 Remake detected for "${title}": ${years.join(', ')}`);
        idCache.set(cacheKey, { remake: true, years });
        return true;
      }
    }

    idCache.set(cacheKey, { remake: false });
    return false;
  } catch (error) {
    console.warn(`⚠️  Remake detection failed for "${title}":`, (error as Error).message);
    return false;
  }
}

/**
 * Shared TVDB /search/remoteid lookup — returns both the numeric ID and the canonical title.
 * Used by resolveTvdbId() (for ID resolution) and resolveTitleFromTvdb() (for title resolution).
 * Requires bearer token auth.
 */
async function findOnTvdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ id: number; title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> {
  const tvdbType = type === 'movie' ? 'movie' : 'series';

  const doSearch = async (token: string): Promise<{ id: number; title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> => {
    const response = await axios.get(`https://api4.thetvdb.com/v4/search/remoteid/${imdbId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    const results = response.data?.data;
    if (results?.length > 0) {
      // /search/remoteid returns objects with typed fields: { series, movie, people, episode, company }
      for (const result of results) {
        const record = result[tvdbType];
        if (record?.id) {
          const year = record.year ? String(record.year) : record.firstAired?.match(/^\d{4}/)?.[0];
          let title: string = record.name || '';
          const originalLang: string | undefined = record.originalLanguage;
          const nameTranslations: string[] = Array.isArray(record.nameTranslations) ? record.nameTranslations : [];
          // Substitute the English translation when TVDB's canonical title is in
          // a non-English language and an English translation exists. Release
          // groups publish in English regardless of the show's original locale,
          // so feeding the foreign-language canonical name into Newznab text
          // search produces zero hits. Gated by searchConfig.tvdbPreferEnglishTitle.
          // Translation 401 silently degrades to the original name; the next
          // search refreshes the token via the existing retry path.
          const preferEnglish = config.searchConfig?.tvdbPreferEnglishTitle ?? true;
          // When force-English replaces the canonical title, retain the original
          // (native-language) form so callers can search both translations in
          // parallel via parallelAlternateTitleSearch. Only set when an actual
          // substitution occurred and the two strings differ.
          let nativeTitle: string | undefined;
          if (preferEnglish && title && originalLang && originalLang !== 'eng' && nameTranslations.includes('eng')) {
            const englishTitle = await fetchTvdbTranslation(record.id, tvdbType, 'eng', token);
            if (englishTitle && englishTitle !== title) {
              console.log(`\u{1F310} TVDB translation: ${tvdbType} id=${record.id} "${title}" [${originalLang}] → "${englishTitle}" [eng]`);
              nativeTitle = title;
              title = englishTitle;
            }
          }
          // Collect English aliases for the zero-result alias-fallback path.
          // Filter is intentionally permissive here (any well-formed eng entry
          // not equal to the resolved title); the substring + length-ratio
          // shape filter is applied downstream in titleResolver so this layer
          // keeps the raw candidate list available for callers that may want it.
          const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const aliasSet = new Set<string>();
          const aliases: string[] = [];
          if (Array.isArray(record.aliases)) {
            for (const entry of record.aliases) {
              if (!entry || typeof entry !== 'object') continue;
              if (typeof entry.language !== 'string' || entry.language !== 'eng') continue;
              if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
              const norm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (norm.length === 0 || norm === titleNorm || aliasSet.has(norm)) continue;
              aliasSet.add(norm);
              aliases.push(entry.name);
            }
          }
          console.log(`🔗 TVDB remoteid result: ${tvdbType} id=${record.id} name="${title || 'unknown'}"${year ? ` (${year})` : ''}${aliases.length ? ` aliases=${aliases.length}` : ''}`);
          return { id: record.id, title, year, aliases: aliases.length ? aliases : undefined, nativeTitle };
        }
      }
    }
    return null;
  };

  // First attempt with current token
  let token = await getTvdbToken();
  if (!token) return null;

  try {
    const result = await doSearch(token);
    if (result) return result;
  } catch (error: any) {
    // If 401 (expired token), clear cache and retry with fresh token
    if (error.response?.status === 401) {
      console.log('🔗 TVDB token expired, refreshing...');
      idCache.del('tvdb:token');
      const newToken = await getTvdbToken();
      if (newToken) {
        try {
          const result = await doSearch(newToken);
          if (result) return result;
        } catch (retryError) {
          console.warn('⚠️  TVDB retry failed:', (retryError as Error).message);
        }
      }
    } else {
      const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : '';
      console.warn(`⚠️  TVDB search error: ${error.response?.status || error.message}${body ? ' ' + body : ''}`);
    }
  }

  console.warn(`⚠️  No TVDB ${type} result found for ${imdbId}`);
  return null;
}

/**
 * Fetch a localized title for a TVDB record from `/translations/{lang}`.
 * Caches both successful lookups and known-empty translations (negative cache
 * via empty-string sentinel) so repeated searches don't repeatedly hit a 404
 * for shows whose `nameTranslations` claims a translation exists but the
 * detail endpoint returns nothing.
 */
async function fetchTvdbTranslation(
  id: number,
  type: 'movie' | 'series' | 'episode',
  lang: string,
  token: string,
): Promise<string | null> {
  const cacheKey = `tvdb:translation:${type}:${id}:${lang}`;
  const cached = idCache.get<string>(cacheKey);
  if (cached !== undefined) return cached || null;

  const pathSegment = type === 'movie' ? 'movies' : type === 'episode' ? 'episodes' : 'series';
  try {
    const response = await axios.get(
      `https://api4.thetvdb.com/v4/${pathSegment}/${id}/translations/${lang}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 },
    );
    const name = response.data?.data?.name;
    if (typeof name === 'string' && name.length > 0) {
      idCache.set(cacheKey, name);
      return name;
    }
  } catch (error: any) {
    if (error.response?.status !== 404) {
      console.warn(`⚠️  TVDB translation lookup failed for ${type} ${id}/${lang}: ${error.response?.status || error.message}`);
    }
  }
  idCache.set(cacheKey, '');
  return null;
}

// Slim TVDB record fetched by numeric ID. Used by the tvdb: Stremio prefix path
// where there's no IMDB id to drive the /search/remoteid lookup that findOnTvdb
// performs. Only the fields downstream callers actually use are included.
interface TvdbRecord {
  title: string;
  year?: string;
  aliases?: string[];
  nativeTitle?: string;
  runtime?: number; // movies only; series runtime comes via episode data
}

// Dedup concurrent fetches for the same TVDB record. TVDB id namespaces are
// disjoint between movies and series, so keying by numeric id alone is safe.
const inFlightExtendedFetches = new Map<number, Promise<TvdbRecord | null>>();

/**
 * Fetch a TVDB record by numeric ID via /v4/{type}/{id}/extended. Distinct
 * from findOnTvdb(), which searches by IMDB remoteid. Drives the tvdb:
 * Stremio prefix path that arrives without an IMDB id.
 *
 * Cached for 24h (idCache default). Concurrent fetches for the same id share
 * a single in-flight promise.
 */
export async function fetchTvdbRecordById(
  tvdbId: number,
  type: 'movie' | 'series'
): Promise<TvdbRecord | null> {
  const cacheKey = `tvdb:record:${type}:${tvdbId}`;
  const cached = idCache.get<TvdbRecord>(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return null;

  const existing = inFlightExtendedFetches.get(tvdbId);
  if (existing) return existing;

  const promise = (async (): Promise<TvdbRecord | null> => {
    const pathSegment = type === 'movie' ? 'movies' : 'series';
    const url = `https://api4.thetvdb.com/v4/${pathSegment}/${tvdbId}/extended`;

    const doFetch = async (token: string): Promise<TvdbRecord | null> => {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });

      const data = response.data?.data;
      if (!data || typeof data !== 'object') return null;

      const rawTitle: string | undefined = typeof data.name === 'string' ? data.name : undefined;
      if (!rawTitle) {
        console.warn(`⚠️  TVDB record has no name: ${type} id=${tvdbId}`);
        return null;
      }

      const year: string | undefined = data.year
        ? String(data.year)
        : (typeof data.firstAired === 'string' ? data.firstAired.match(/^\d{4}/)?.[0] : undefined);

      // Scan remoteIds for an IMDB mapping. Log inline only; nothing depends
      // on it. Strict regex ensures we don't accept malformed strings.
      let foundImdb: string | undefined;
      const remoteIds = Array.isArray(data.remoteIds) ? data.remoteIds : [];
      for (const entry of remoteIds) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.sourceName !== 'string' || entry.sourceName !== 'IMDB') continue;
        if (typeof entry.id !== 'string' || !/^tt\d+$/.test(entry.id)) continue;
        foundImdb = entry.id;
        break;
      }

      // English-translation substitution. Mirrors the logic in findOnTvdb so
      // a non-English canonical title is replaced with the English form when
      // available, and the original is retained as nativeTitle.
      let title = rawTitle;
      let nativeTitle: string | undefined;
      const originalLang: string | undefined = typeof data.originalLanguage === 'string' ? data.originalLanguage : undefined;
      const nameTranslations: string[] = Array.isArray(data.nameTranslations) ? data.nameTranslations : [];
      const preferEnglish = config.searchConfig?.tvdbPreferEnglishTitle ?? true;
      if (preferEnglish && originalLang && originalLang !== 'eng' && nameTranslations.includes('eng')) {
        const englishTitle = await fetchTvdbTranslation(tvdbId, type, 'eng', token);
        if (englishTitle && englishTitle !== title) {
          console.log(`\u{1F310} TVDB translation: ${type} id=${tvdbId} "${title}" [${originalLang}] → "${englishTitle}" [eng]`);
          nativeTitle = title;
          title = englishTitle;
        }
      }

      // English aliases. Same dedup + normalize approach as findOnTvdb.
      const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const aliasSet = new Set<string>();
      const aliases: string[] = [];
      if (Array.isArray(data.aliases)) {
        for (const entry of data.aliases) {
          if (!entry || typeof entry !== 'object') continue;
          if (typeof entry.language !== 'string' || entry.language !== 'eng') continue;
          if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
          const norm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (norm.length === 0 || norm === titleNorm || aliasSet.has(norm)) continue;
          aliasSet.add(norm);
          aliases.push(entry.name);
        }
      }

      let runtime: number | undefined;
      if (type === 'movie' && typeof data.runtime === 'number' && data.runtime > 0) {
        runtime = data.runtime * 60; // minutes → seconds
      }

      const record: TvdbRecord = {
        title,
        year,
        aliases: aliases.length ? aliases : undefined,
        nativeTitle,
        runtime,
      };

      console.log(`🆔  TVDB record: ${type} id=${tvdbId} name="${title}"${year ? ` (${year})` : ''}${foundImdb ? ` [imdb=${foundImdb}]` : ''}${aliases.length ? ` aliases=${aliases.length}` : ''}`);
      return record;
    };

    // First attempt; refresh token on 401 and retry once.
    let token = await getTvdbToken();
    if (!token) return null;

    let result: TvdbRecord | null = null;
    try {
      result = await doFetch(token);
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 404) {
        console.warn(`⚠️  TVDB record not found: ${type} id=${tvdbId} (404)`);
        return null;
      }
      if (status === 401) {
        console.log('🔗 TVDB token expired, refreshing...');
        idCache.del('tvdb:token');
        const newToken = await getTvdbToken();
        if (newToken) {
          try {
            result = await doFetch(newToken);
          } catch (retryError: any) {
            const retryStatus = retryError.response?.status;
            if (retryStatus === 404) {
              console.warn(`⚠️  TVDB record not found: ${type} id=${tvdbId} (404)`);
              return null;
            }
            const body = retryError.response?.data ? JSON.stringify(retryError.response.data).substring(0, 200) : '';
            console.warn(`⚠️  TVDB record error: ${retryStatus || (retryError as Error).message}${body ? ' ' + body : ''}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : '';
        console.warn(`⚠️  TVDB record error: ${status || (error as Error).message}${body ? ' ' + body : ''}`);
        return null;
      }
    }

    // Cache then signal to other in-flight joiners via the finally below. Order
    // matters: setting the cache before clearing the in-flight slot ensures any
    // late joiner that misses the in-flight Map can still hit the cache.
    if (result) idCache.set(cacheKey, result);
    return result;
  })().finally(() => {
    inFlightExtendedFetches.delete(tvdbId);
  });

  inFlightExtendedFetches.set(tvdbId, promise);
  return promise;
}

/**
 * TVDB: Search by remote IMDB ID — returns the numeric TVDB ID for Newznab search params.
 * Also caches the canonical title as a side effect for resolveTitleFromTvdb().
 */
async function resolveTvdbId(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ idParam: string; idValue: string } | null> {
  const result = await findOnTvdb(imdbId, type);
  if (!result) return null;

  // Cache the canonical title and year as side effects
  if (result.title) {
    idCache.set(`title:${imdbId}`, result.title);
  }
  if (result.year) {
    idCache.set(`year:tvdb:${imdbId}`, result.year);
  }

  return { idParam: 'tvdbid', idValue: result.id.toString() };
}

/**
 * Resolve the canonical title for an IMDB ID via TVDB.
 * Primarily used for TV shows where TVDB titles closely match what release groups use.
 *
 * If resolveTvdbId() was already called (for ID-based search), the title will be
 * in cache and this returns instantly with no extra API call.
 *
 * Returns null if TVDB API key isn't configured or the lookup fails.
 */
export async function resolveTitleFromTvdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> {
  const titleCacheKey = `title:${imdbId}`;
  const aliasesCacheKey = `aliases:tvdb:${imdbId}`;
  const nativeTitleCacheKey = `nativeTitle:tvdb:${imdbId}`;
  const cached = idCache.get<string>(titleCacheKey);
  if (cached) {
    const cachedYear = idCache.get<string>(`year:tvdb:${imdbId}`);
    const cachedAliases = idCache.get<string[]>(aliasesCacheKey);
    const cachedNative = idCache.get<string>(nativeTitleCacheKey);
    console.log(`🎯 TVDB title cache hit: ${imdbId} → "${cached}"`);
    return { title: cached, year: cachedYear, aliases: cachedAliases, nativeTitle: cachedNative || undefined };
  }

  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return null;

  try {
    const result = await findOnTvdb(imdbId, type);
    if (!result?.title) return null;

    idCache.set(titleCacheKey, result.title);
    if (result.year) {
      idCache.set(`year:tvdb:${imdbId}`, result.year);
    }
    // Cache aliases (or empty array sentinel so we don't refetch on miss).
    idCache.set(aliasesCacheKey, result.aliases ?? []);
    // Cache native title (empty-string sentinel for known-no-substitution).
    idCache.set(nativeTitleCacheKey, result.nativeTitle ?? '');

    // Also cache the ID as a bonus
    const idCacheKey = `id:${imdbId}:tvdb`;
    if (!idCache.has(idCacheKey)) {
      idCache.set(idCacheKey, { idParam: 'tvdbid', idValue: result.id.toString() });
    }

    console.log(`🎯 TVDB title resolved: ${imdbId} → "${result.title}"`);
    return { title: result.title, year: result.year, aliases: result.aliases, nativeTitle: result.nativeTitle };
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TVDB title for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Synchronous title lookup from the in-process cache. Returns the cached
 * TVDB title for the given IMDB ID, or the TMDB-cached fallback. Returns
 * undefined on cache miss; never makes API calls. Intended for runtime
 * recovery paths that need a title quickly without blocking on network.
 */
export function getCachedTitleByImdb(imdbId: string): string | undefined {
  return idCache.get<string>(`title:${imdbId}`)
    ?? idCache.get<string>(`title:tmdb:${imdbId}`);
}

/**
 * Clear the cached TVDB bearer token. Called when the user changes their TVDB
 * API key so the next request re-authenticates with the new key instead of
 * using the stale token issued for the old key.
 */
export function clearTvdbToken(): void {
  idCache.del('tvdb:token');
}

/**
 * Clear cached TVDB-derived titles and translation lookups. Called when the
 * `tvdbPreferEnglishTitle` toggle flips so the next search re-resolves the
 * canonical title under the new preference instead of returning a stale
 * cache entry from the previous setting. Leaves TMDB title caches alone
 * (different namespace) and the bearer token alone.
 */
export function clearTvdbTitleCache(): void {
  const keys = idCache.keys();
  let count = 0;
  for (const k of keys) {
    if ((k.startsWith('title:') && !k.startsWith('title:tmdb:')) || k.startsWith('tvdb:translation:') || k.startsWith('aliases:tvdb:') || k.startsWith('nativeTitle:tvdb:')) {
      idCache.del(k);
      count++;
    }
  }
  console.log(`🔗 TVDB title cache cleared (${count} entries)`);
}

// Concurrent 401-retry sites all clear and re-fetch the token. Without dedup,
// each fires its own login. One shared promise across callers prevents the
// duplicate-login race.
let inFlightTokenRefresh: Promise<string | null> | null = null;

/**
 * Get a TVDB bearer token, cached for 23 hours. Concurrent callers share a
 * single in-flight login when the cache is empty.
 */
async function getTvdbToken(): Promise<string | null> {
  const cached = idCache.get<string>('tvdb:token');
  if (cached) {
    console.log('🔗 Using cached TVDB token');
    return cached;
  }

  if (inFlightTokenRefresh) {
    return inFlightTokenRefresh;
  }

  inFlightTokenRefresh = (async (): Promise<string | null> => {
    const apiKey = config.searchConfig?.tvdbApiKey;
    if (!apiKey) {
      console.warn('⚠️  TVDB API key not configured');
      return null;
    }

    try {
      console.log('🔗 Requesting new TVDB token...');
      const response = await axios.post('https://api4.thetvdb.com/v4/login', {
        apikey: apiKey,
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });

      const token = response.data?.data?.token;
      if (token) {
        idCache.set('tvdb:token', token, 82800); // 23 hours
        console.log('🔗 TVDB token obtained successfully');
        return token;
      }
      console.warn('⚠️  TVDB login response missing token:', JSON.stringify(response.data).substring(0, 200));
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : (error as Error).message;
      console.warn(`⚠️  Failed to authenticate with TVDB (${status || 'network error'}):`, msg);
    }

    return null;
  })().finally(() => {
    inFlightTokenRefresh = null;
  });

  return inFlightTokenRefresh;
}

/**
 * TVmaze: Lookup by IMDB ID (free, no auth needed)
 * GET https://api.tvmaze.com/lookup/shows?imdb={imdb_id}
 */
async function resolveTvmazeId(
  imdbId: string
): Promise<{ idParam: string; idValue: string } | null> {
  const response = await axios.get('https://api.tvmaze.com/lookup/shows', {
    params: { imdb: imdbId },
    timeout: 5000,
  });

  const tvmazeId = response.data?.id;
  if (tvmazeId) {
    return { idParam: 'tvmazeid', idValue: tvmazeId.toString() };
  }

  console.warn(`⚠️  No TVmaze result found for ${imdbId}`);
  return null;
}

// ── Per-series TVDB episode cache ────────────────────────────────────
// One paginated all-episodes fetch per series populates seasonCounts (used for
// cumulative-episode math) and per-(season,episode) data (runtime, name,
// canonical absoluteNumber). Cache and Promise-dedup are keyed by TVDB numeric
// ID so the imdbId path and the direct-tvdbId path (used by anime requests
// without IMDB mappings) share the same cached data.
interface TvdbSeriesEpisodeData {
  seasonCounts: Record<number, number>;  // excludes S0 specials
  episodes: Record<number, Record<number, { id?: number; runtime?: number; name?: string; absoluteNumber?: number; nameTranslations?: string[]; aired?: string }>>;
}

// In-flight fetch deduplication: concurrent callers for the same TVDB ID
// share a single TVDB call. try/finally guarantees cleanup on every path
// (success, throw, cap hit) so future callers don't await a rejected promise.
const inFlightSeriesFetches = new Map<number, Promise<TvdbSeriesEpisodeData | undefined>>();

const TVDB_PAGINATION_CAP = 50;          // ~25K episodes worst case
const TVDB_PER_PAGE_TIMEOUT_MS = 5000;

interface SeriesEpisodeResult {
  count: number;
  runtime?: number;
  episodeName?: string;
  absoluteNumber?: number;
  priorSeasonsCount?: number;
  /** Air date of the targeted episode in `YYYY-MM-DD` form, when TVDB has it. Used by date-based query fallbacks. */
  episodeAired?: string;
}

/**
 * Fetch an entire series' episode list from TVDB by numeric series ID and
 * shape it into seasonCounts + per-(season,episode) data. Paginated via
 * links.next. On 401 mid-pagination, refreshes the token and retries the
 * failed page once; any other error aborts and returns undefined.
 */
async function fetchTvdbSeriesEpisodesByTvdbId(tvdbId: number, logLabel: string): Promise<TvdbSeriesEpisodeData | undefined> {
  let token = await getTvdbToken();
  if (!token) return undefined;

  const seasonCounts: Record<number, number> = {};
  const episodes: Record<number, Record<number, { runtime?: number; name?: string; absoluteNumber?: number }>> = {};
  let pageCount = 0;

  const baseUrl = `https://api4.thetvdb.com/v4/series/${tvdbId}/episodes/default`;
  let nextUrl: string | null = `${baseUrl}?page=0`;

  while (nextUrl) {
    if (pageCount >= TVDB_PAGINATION_CAP) {
      console.warn(`⚠️  TVDB episode pagination cap reached for ${logLabel} (${TVDB_PAGINATION_CAP} pages), falling through to Cinemeta`);
      return undefined;
    }

    let response: any;
    try {
      response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: TVDB_PER_PAGE_TIMEOUT_MS,
      });
    } catch (error: any) {
      if (error.response?.status === 401) {
        // Token expired mid-pagination. Refresh and retry this page once.
        console.log('🔗 TVDB token expired mid-pagination, refreshing');
        idCache.del('tvdb:token');
        const fresh = await getTvdbToken();
        if (!fresh) return undefined;
        token = fresh;
        try {
          response = await axios.get(nextUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: TVDB_PER_PAGE_TIMEOUT_MS,
          });
        } catch (retryError) {
          console.warn(`⚠️  TVDB episode fetch retry failed for ${logLabel}:`, (retryError as Error).message);
          return undefined;
        }
      } else {
        console.warn(`⚠️  TVDB episode fetch failed for ${logLabel} on page ${pageCount}:`, error.message);
        return undefined;
      }
    }

    const data = response.data?.data;
    if (!data || !Array.isArray(data.episodes)) {
      // Malformed page — abort rather than return partial data.
      return undefined;
    }

    for (const ep of data.episodes) {
      if (typeof ep.seasonNumber !== 'number' || ep.seasonNumber < 0) continue;
      if (typeof ep.number !== 'number' || ep.number <= 0) continue;
      // Per-episode entry is built for every aired season (including S0 specials)
      // so callers can still look up specials by name. seasonCounts excludes S0
      // because absolute numbering only counts aired episodes.
      const epEntry: { id?: number; runtime?: number; name?: string; absoluteNumber?: number; nameTranslations?: string[]; aired?: string } = {};
      if (typeof ep.id === 'number' && ep.id > 0) epEntry.id = ep.id;
      if (typeof ep.runtime === 'number' && ep.runtime > 0) epEntry.runtime = ep.runtime;
      if (typeof ep.name === 'string' && ep.name.length > 0) epEntry.name = ep.name;
      if (typeof ep.absoluteNumber === 'number' && ep.absoluteNumber > 0) epEntry.absoluteNumber = ep.absoluteNumber;
      if (Array.isArray(ep.nameTranslations)) {
        epEntry.nameTranslations = ep.nameTranslations.filter((s: any) => typeof s === 'string');
      }
      if (typeof ep.aired === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ep.aired)) {
        epEntry.aired = ep.aired.slice(0, 10);
      }
      if (!episodes[ep.seasonNumber]) episodes[ep.seasonNumber] = {};
      episodes[ep.seasonNumber][ep.number] = epEntry;
      if (ep.seasonNumber > 0) {
        seasonCounts[ep.seasonNumber] = (seasonCounts[ep.seasonNumber] ?? 0) + 1;
      }
    }

    pageCount++;
    const linksNext = response.data?.links?.next;
    nextUrl = typeof linksNext === 'string' && linksNext.length > 0 ? linksNext : null;
  }

  if (pageCount === 0 || Object.keys(seasonCounts).length === 0) {
    return undefined;
  }

  return { seasonCounts, episodes };
}

/**
 * Cache + Promise-dedup wrapper around fetchTvdbSeriesEpisodesByTvdbId.
 * Cache keyed by tvdbId so concurrent calls from the imdbId path and the
 * direct-tvdbId path share a single fetch when they target the same series.
 */
async function getOrFetchSeriesEpisodes(tvdbId: number, logLabel: string): Promise<TvdbSeriesEpisodeData | undefined> {
  const cacheKey = `tvdb:series:${tvdbId}`;
  const cached = idCache.get<TvdbSeriesEpisodeData>(cacheKey);
  if (cached !== undefined) return cached;

  let inflight = inFlightSeriesFetches.get(tvdbId);
  if (!inflight) {
    inflight = (async () => {
      try {
        const data = await fetchTvdbSeriesEpisodesByTvdbId(tvdbId, logLabel);
        if (data) idCache.set(cacheKey, data);
        return data;
      } finally {
        inFlightSeriesFetches.delete(tvdbId);
      }
    })();
    inFlightSeriesFetches.set(tvdbId, inflight);
  }
  return await inflight;
}

/**
 * Build the per-(season,episode) caller-facing result from cached series data.
 * When the targeted episode's name is non-Latin (e.g. anime returned under its
 * Japanese title) and an English translation is advertised, fetches the
 * English name so downstream remake-filter substring matching works against
 * the form release groups actually publish.
 */
async function buildSeasonResult(data: TvdbSeriesEpisodeData, season: number, episode?: number): Promise<SeriesEpisodeResult | undefined> {
  const count = data.seasonCounts[season] ?? 0;
  if (count === 0) return undefined;

  const seasonEps = data.episodes[season] ?? {};
  let runtime: number | undefined;
  let episodeName: string | undefined;
  let absoluteNumber: number | undefined;
  let episodeAired: string | undefined;
  if (episode !== undefined) {
    const targetEp = seasonEps[episode];
    if (targetEp?.runtime) runtime = targetEp.runtime * 60;
    if (targetEp?.name) episodeName = targetEp.name;
    if (targetEp?.absoluteNumber) absoluteNumber = targetEp.absoluteNumber;
    if (targetEp?.aired) episodeAired = targetEp.aired;
    if (
      episodeName
      && targetEp?.id
      && targetEp.nameTranslations?.includes('eng')
      && /[^\x00-\x7F]/.test(episodeName)
    ) {
      const token = await getTvdbToken();
      if (token) {
        const eng = await fetchTvdbTranslation(targetEp.id, 'episode', 'eng', token);
        if (eng) episodeName = eng;
      }
    }
  }
  if (!runtime) {
    const runtimes = Object.values(seasonEps).map(e => e.runtime).filter((r): r is number => typeof r === 'number' && r > 0);
    if (runtimes.length > 0) {
      runtime = Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length) * 60;
    }
  }
  let priorSeasonsCount = 0;
  for (const [s, c] of Object.entries(data.seasonCounts)) {
    const sn = Number(s);
    if (sn > 0 && sn < season) priorSeasonsCount += c;
  }
  return { count, runtime, episodeName, absoluteNumber, priorSeasonsCount, episodeAired };
}

function logEpisodeResult(label: string, season: number, result: SeriesEpisodeResult): void {
  const seasonStr = season.toString().padStart(2, '0');
  const runtimeStr = result.runtime ? ` (${Math.round(result.runtime / 60)}min)` : '';
  const nameStr = result.episodeName ? ` [${result.episodeName}]` : '';
  const absStr = result.absoluteNumber ? ` [abs E${result.absoluteNumber}]` : '';
  const airedStr = result.episodeAired ? ` [aired ${result.episodeAired}]` : '';
  console.log(`🔗 TVDB episode count: ${label} S${seasonStr} → ${result.count} episodes${runtimeStr}${nameStr}${absStr}${airedStr}`);
}

/**
 * Resolve series-level TVDB episode data via IMDB ID. Returns:
 *   - count: episodes in the requested season
 *   - runtime: requested episode's runtime in seconds, else season average
 *   - episodeName: requested episode's title (used by remake/version detection)
 *   - absoluteNumber: canonical absolute episode number when TVDB has it set
 *   - priorSeasonsCount: cumulative episodes across seasons before the requested one
 *
 * One paginated TVDB call per series populates the cache for all season
 * queries against that series, so multi-season searches make one TVDB call
 * instead of N.
 */
export async function resolveEpisodeCountFromTvdb(
  imdbId: string,
  season: number,
  episode?: number
): Promise<SeriesEpisodeResult | undefined> {
  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return undefined;

  const tvdbResult = await findOnTvdb(imdbId, 'series');
  if (!tvdbResult) return undefined;

  let data: TvdbSeriesEpisodeData | undefined;
  try {
    data = await getOrFetchSeriesEpisodes(tvdbResult.id, imdbId);
  } catch (error) {
    console.warn(`⚠️  TVDB episode count lookup failed for ${imdbId} S${season}:`, (error as Error).message);
    return undefined;
  }
  if (!data) return undefined;

  const result = await buildSeasonResult(data, season, episode);
  if (!result) return undefined;

  logEpisodeResult(imdbId, season, result);
  return result;
}

/**
 * Resolve series-level TVDB episode data via a direct TVDB numeric ID. Used
 * by the anime synthetic-title path, where requests come in via a Kitsu/MAL/
 * AniList/AniDB prefix that resolves to a TVDB ID without an IMDB mapping.
 * Skips the IMDB → TVDB lookup that resolveEpisodeCountFromTvdb does.
 *
 * Cache and Promise-dedup are shared with the imdbId path via the TVDB ID,
 * so the same series is never fetched twice if hit from both paths.
 */
export async function resolveEpisodeCountFromTvdbId(
  tvdbId: number,
  season: number,
  episode?: number
): Promise<SeriesEpisodeResult | undefined> {
  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return undefined;
  if (!Number.isFinite(tvdbId) || tvdbId <= 0) return undefined;

  const logLabel = `tvdb:${tvdbId}`;
  let data: TvdbSeriesEpisodeData | undefined;
  try {
    data = await getOrFetchSeriesEpisodes(tvdbId, logLabel);
  } catch (error) {
    console.warn(`⚠️  TVDB episode count lookup failed for ${logLabel} S${season}:`, (error as Error).message);
    return undefined;
  }
  if (!data) return undefined;

  const result = await buildSeasonResult(data, season, episode);
  if (!result) return undefined;

  logEpisodeResult(logLabel, season, result);
  return result;
}

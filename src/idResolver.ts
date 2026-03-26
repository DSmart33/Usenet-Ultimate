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
      params: isReadAccessToken ? {} : { api_key: apiKey },
      headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });

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
 * Shared TVDB /search/remoteid lookup — returns both the numeric ID and the canonical title.
 * Used by resolveTvdbId() (for ID resolution) and resolveTitleFromTvdb() (for title resolution).
 * Requires bearer token auth.
 */
async function findOnTvdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ id: number; title: string } | null> {
  const tvdbType = type === 'movie' ? 'movie' : 'series';

  const doSearch = async (token: string): Promise<{ id: number; title: string } | null> => {
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
          console.log(`🔗 TVDB remoteid result: ${tvdbType} id=${record.id} name="${record.name || 'unknown'}"`);
          return { id: record.id, title: record.name || '' };
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
 * TVDB: Search by remote IMDB ID — returns the numeric TVDB ID for Newznab search params.
 * Also caches the canonical title as a side effect for resolveTitleFromTvdb().
 */
async function resolveTvdbId(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ idParam: string; idValue: string } | null> {
  const result = await findOnTvdb(imdbId, type);
  if (!result) return null;

  // Cache the canonical title as a side effect
  if (result.title) {
    idCache.set(`title:${imdbId}`, result.title);
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
): Promise<string | null> {
  const titleCacheKey = `title:${imdbId}`;
  const cached = idCache.get<string>(titleCacheKey);
  if (cached) {
    console.log(`🎯 TVDB title cache hit: ${imdbId} → "${cached}"`);
    return cached;
  }

  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return null;

  try {
    const result = await findOnTvdb(imdbId, type);
    if (!result?.title) return null;

    idCache.set(titleCacheKey, result.title);

    // Also cache the ID as a bonus
    const idCacheKey = `id:${imdbId}:tvdb`;
    if (!idCache.has(idCacheKey)) {
      idCache.set(idCacheKey, { idParam: 'tvdbid', idValue: result.id.toString() });
    }

    console.log(`🎯 TVDB title resolved: ${imdbId} → "${result.title}"`);
    return result.title;
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TVDB title for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Get a TVDB bearer token, cached for 23 hours.
 */
async function getTvdbToken(): Promise<string | null> {
  const cached = idCache.get<string>('tvdb:token');
  if (cached) {
    console.log('🔗 Using cached TVDB token');
    return cached;
  }

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

/**
 * Resolve the number of episodes in a season via TVDB.
 * Uses the TVDB series ID (resolved from IMDB ID) to query season episodes.
 * Returns the episode count, or undefined if unavailable.
 */
export async function resolveEpisodeCountFromTvdb(
  imdbId: string,
  season: number,
  episode?: number
): Promise<{ count: number; runtime?: number } | undefined> {
  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return undefined;

  // Cache key for episode counts
  const cacheKey = `epdata:${imdbId}:${season}`;
  const cached = idCache.get<{ count: number; runtime?: number }>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // Get the TVDB series ID (may already be cached from earlier lookups)
    const tvdbResult = await findOnTvdb(imdbId, 'series');
    if (!tvdbResult) return undefined;

    const token = await getTvdbToken();
    if (!token) return undefined;

    // Query episodes for the specific season
    const response = await axios.get(
      `https://api4.thetvdb.com/v4/series/${tvdbResult.id}/episodes/default`,
      {
        params: { season, page: 0 },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      }
    );

    const episodes = response.data?.data?.episodes;
    if (Array.isArray(episodes) && episodes.length > 0) {
      // TVDB may paginate — count episodes matching the requested season
      const seasonEps = episodes.filter((ep: any) => ep.seasonNumber === season);
      const count = seasonEps.length;
      if (count > 0) {
        // Extract runtime: prefer specific episode, fall back to average across season
        let runtime: number | undefined;
        if (episode !== undefined) {
          const targetEp = seasonEps.find((ep: any) => ep.number === episode);
          if (targetEp?.runtime && targetEp.runtime > 0) runtime = targetEp.runtime * 60;
        }
        if (!runtime) {
          const runtimes = seasonEps.map((ep: any) => ep.runtime).filter((r: any) => typeof r === 'number' && r > 0);
          if (runtimes.length > 0) {
            const avg = runtimes.reduce((a: number, b: number) => a + b, 0) / runtimes.length;
            runtime = Math.round(avg) * 60;
          }
        }
        const result = { count, runtime };
        idCache.set(cacheKey, result);
        console.log(`🔗 TVDB episode count: ${imdbId} S${season.toString().padStart(2, '0')} → ${count} episodes${runtime ? ` (${Math.round(runtime / 60)}min)` : ''}`);
        return result;
      }
    }
  } catch (error) {
    console.warn(`⚠️  TVDB episode count lookup failed for ${imdbId} S${season}:`, (error as Error).message);
  }

  return undefined;
}

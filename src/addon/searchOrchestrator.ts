/**
 * Search Orchestrator
 *
 * Runs index manager searches (Prowlarr, NZBHydra, or Newznab) and
 * EasyNews searches in parallel, returning combined raw results.
 */

import { config } from '../config/index.js';
import { UsenetSearcher } from '../parsers/usenetSearcher.js';
import { trackQuery } from '../statsTracker.js';
import { resolveExternalId } from '../idResolver.js';
import { ProwlarrSearcher } from '../searchers/prowlarrSearcher.js';
import { NzbhydraSearcher } from '../searchers/nzbhydraSearcher.js';
import { EasynewsSearcher } from '../searchers/easynewsSearcher.js';

export interface SearchContext {
  type: string;
  imdbId: string;
  title: string;
  year?: string;
  country?: string;
  season?: number;
  episode?: number;
  episodesInSeason?: number;
  additionalTitles?: string[];
  isAnime: boolean;
  useTextForAnime: boolean;
}

/**
 * Search via the configured index manager (Prowlarr, NZBHydra, or Newznab).
 */
export async function indexManagerSearch(ctx: SearchContext): Promise<any[]> {
  const { type, imdbId, title, year, country, season, episode, episodesInSeason, additionalTitles, isAnime, useTextForAnime } = ctx;

  if (config.indexManager === 'prowlarr' && config.prowlarrUrl && config.prowlarrApiKey) {
    // === PROWLARR MODE ===
    const enabledSynced = (config.syncedIndexers || []).filter(i => i.enabledForSearch);
    if (enabledSynced.length === 0) {
      console.log('⚠️  No synced Prowlarr indexers enabled for search');
      return [];
    }

    // Collect unique search methods needed
    const neededMethods = new Set<string>();
    for (const indexer of enabledSynced) {
      const methods = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 Prowlarr search methods: ${[...neededMethods].join(', ')} across ${enabledSynced.length} indexer(s)`);

    // Resolve external IDs needed by indexers
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text')
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}`);
        resolvedIds.set(method, result);
      }));

    // Override indexer search methods to text-only for anime
    let searchIndexers = enabledSynced;
    if (isAnime && useTextForAnime) {
      console.log(`🎌 Anime detected — overriding search methods to text for all indexers`);
      searchIndexers = enabledSynced.map(i => ({ ...i, movieSearchMethod: ['text'] as const, tvSearchMethod: ['text'] as const }));
    }

    const startTime = Date.now();
    const searcher = new ProwlarrSearcher(config.prowlarrUrl, config.prowlarrApiKey, searchIndexers);

    try {
      let results: any[];
      if (type === 'movie') {
        results = await searcher.searchMovie(imdbId, title, year, country, resolvedIds, additionalTitles);
      } else if (type === 'series' && season !== undefined && episode !== undefined) {
        results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, resolvedIds, additionalTitles);
      } else {
        results = [];
      }

      // Track queries per unique indexer name in results
      const responseTime = Date.now() - startTime;
      const indexerCounts = new Map<string, number>();
      for (const r of results) {
        indexerCounts.set(r.indexerName, (indexerCounts.get(r.indexerName) || 0) + 1);
      }
      for (const [name, count] of indexerCounts) {
        trackQuery(name, true, responseTime, count);
      }
      return results;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      trackQuery('Prowlarr', false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
      console.error(`❌ Error searching via Prowlarr:`, error);
      return [];
    }

  } else if (config.indexManager === 'nzbhydra' && config.nzbhydraUrl && config.nzbhydraApiKey) {
    // === NZBHYDRA MODE ===
    const enabledSynced = (config.syncedIndexers || []).filter(i => i.enabledForSearch);
    if (enabledSynced.length === 0) {
      console.log('⚠️  No synced NZBHydra indexers enabled for search');
      return [];
    }

    const neededMethods = new Set<string>();
    for (const indexer of enabledSynced) {
      const methods = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 NZBHydra search methods: ${[...neededMethods].join(', ')} across ${enabledSynced.length} indexer(s)`);

    // Resolve external IDs needed by indexers
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text')
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}`);
        resolvedIds.set(method, result);
      }));

    // Override indexer search methods to text-only for anime
    let searchIndexers = enabledSynced;
    if (isAnime && useTextForAnime) {
      console.log(`🎌 Anime detected — overriding search methods to text for all indexers`);
      searchIndexers = enabledSynced.map(i => ({ ...i, movieSearchMethod: ['text'] as const, tvSearchMethod: ['text'] as const }));
    }

    const startTime = Date.now();
    const searcher = new NzbhydraSearcher(config.nzbhydraUrl, config.nzbhydraApiKey, searchIndexers, config.nzbhydraUsername, config.nzbhydraPassword);

    try {
      let results: any[];
      if (type === 'movie') {
        results = await searcher.searchMovie(imdbId, title, year, country, resolvedIds, additionalTitles);
      } else if (type === 'series' && season !== undefined && episode !== undefined) {
        results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, resolvedIds, additionalTitles);
      } else {
        results = [];
      }

      const responseTime = Date.now() - startTime;
      const indexerCounts = new Map<string, number>();
      for (const r of results) {
        indexerCounts.set(r.indexerName, (indexerCounts.get(r.indexerName) || 0) + 1);
      }
      for (const [name, count] of indexerCounts) {
        trackQuery(name, true, responseTime, count);
      }
      return results;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      trackQuery('NZBHydra', false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
      console.error(`❌ Error searching via NZBHydra:`, error);
      return [];
    }

  } else {
    // === NEWZNAB MODE ===
    const enabledIndexers = config.indexers.filter(i => i.enabled);

    // Collect unique search methods needed across all enabled indexers
    const neededMethods = new Set<string>();
    for (const indexer of enabledIndexers) {
      const methods = type === 'movie'
        ? (indexer.movieSearchMethod || ['imdb'])
        : (indexer.tvSearchMethod || ['imdb']);
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 Newznab search methods: ${[...neededMethods].join(', ')} across ${enabledIndexers.length} indexer(s)`);

    // Resolve external IDs needed by indexers
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text')
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) {
          console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}, affected indexers will fall back to text search`);
        }
        resolvedIds.set(method, result);
      }));

    // Search across all enabled indexers, each with its own methods and resolved IDs
    const animeTextOverride = isAnime && useTextForAnime;
    if (animeTextOverride) {
      console.log(`🎌 Anime detected — overriding search methods to text for all indexers`);
    }
    const searchPromises = enabledIndexers
      .map(async (indexer) => {
        const startTime = Date.now();
        const methods = animeTextOverride ? ['text'] : type === 'movie'
          ? (indexer.movieSearchMethod || ['imdb'])
          : (indexer.tvSearchMethod || ['imdb']);
        const methodArr = Array.isArray(methods) ? methods : [methods];

        const searcher = new UsenetSearcher(indexer);

        try {
          const allMethodResults: any[] = [];
          for (const method of methodArr) {
            const externalId = (method !== 'imdb' && method !== 'text')
              ? resolvedIds.get(method) ?? null
              : null;

            if (type === 'movie') {
              const results = await searcher.searchMovie(imdbId, title, year, country, externalId || undefined, method, additionalTitles);
              allMethodResults.push(...results);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              const results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, externalId || undefined, method, additionalTitles);
              allMethodResults.push(...results);
            }
          }

          const responseTime = Date.now() - startTime;
          trackQuery(indexer.name, true, responseTime, allMethodResults.length);

          return allMethodResults.map(result => ({ ...result, indexerName: indexer.name }));
        } catch (error) {
          const responseTime = Date.now() - startTime;
          trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
          console.error(`❌ Error searching ${indexer.name}:`, error);
          return [];
        }
      });

    let results = (await Promise.all(searchPromises)).flat();

    // Zero-result text fallback: if ID-based searches returned nothing, retry with text
    if (results.length === 0 && title) {
      const nonTextIndexers = enabledIndexers.filter(indexer => {
        const methods = type === 'movie'
          ? (indexer.movieSearchMethod || ['imdb'])
          : (indexer.tvSearchMethod || ['imdb']);
        const methodArr = Array.isArray(methods) ? methods : [methods];
        return !methodArr.every(m => m === 'text');
      });

      if (nonTextIndexers.length > 0) {
        console.log(`🔄 ID search returned 0 — text fallback for ${nonTextIndexers.length} indexer(s)`);
        const fallbackPromises = nonTextIndexers.map(async (indexer) => {
          const startTime = Date.now();
          const searcher = new UsenetSearcher(indexer);
          try {
            let fbResults: any[] = [];
            if (type === 'movie') {
              fbResults = await searcher.searchMovie(imdbId, title, year, country, undefined, 'text', additionalTitles);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              fbResults = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, undefined, 'text', additionalTitles);
            }
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, true, responseTime, fbResults.length);
            return fbResults.map(result => ({ ...result, indexerName: indexer.name }));
          } catch (error) {
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
            console.error(`❌ Error in text fallback for ${indexer.name}:`, error);
            return [];
          }
        });

        const fallbackResults = await Promise.all(fallbackPromises);
        results = fallbackResults.flat();
        console.log(`   🎯 Text fallback returned ${results.length} results`);
      }
    }
    return results;
  }
}

/**
 * Search EasyNews (runs in parallel with index manager search).
 */
export async function easynewsSearch(ctx: SearchContext): Promise<any[]> {
  if (!config.easynewsEnabled || !config.easynewsUsername || !config.easynewsPassword) {
    return [];
  }

  const { type, title, year, country, season, episode, episodesInSeason, additionalTitles } = ctx;
  const easynewsStartTime = Date.now();
  const searcher = new EasynewsSearcher(
    config.easynewsUsername,
    config.easynewsPassword,
    config.easynewsPagination ? config.easynewsMaxPages : 1,
  );

  try {
    let results: any[];
    if (type === 'movie') {
      results = await searcher.searchMovie(title, year, country, additionalTitles);
    } else if (type === 'series' && season !== undefined && episode !== undefined) {
      results = await searcher.searchTVShow(title, season, episode, episodesInSeason, year, country, additionalTitles);
    } else {
      results = [];
    }

    const responseTime = Date.now() - easynewsStartTime;
    trackQuery('EasyNews', true, responseTime, results.length);
    console.log(`📰 EasyNews: ${results.length} results in ${responseTime}ms`);
    return results;
  } catch (error) {
    const responseTime = Date.now() - easynewsStartTime;
    trackQuery('EasyNews', false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
    console.error('❌ EasyNews search failed:', error);
    return [];
  }
}

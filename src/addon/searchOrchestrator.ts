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
import { UsenetIndexer } from '../types.js';

// When SEARCH_TIMEOUT env is set, force it onto every Newznab indexer for this search cycle.
// Returns the original reference when no override is active — no allocation cost in the common path.
function applySearchTimeoutOverride(indexer: UsenetIndexer): UsenetIndexer {
  return config.searchTimeoutOverride !== undefined
    ? { ...indexer, timeoutEnabled: true, timeout: config.searchTimeoutOverride }
    : indexer;
}

export interface SearchContext {
  type: string;
  imdbId: string;
  title: string;
  year?: string;
  country?: string;
  season?: number;
  episode?: number;
  episodesInSeason?: number;
  /** Cumulative episode count across prior seasons. Feeds the absolute-numbering fallback. */
  priorSeasonsEpisodeCount?: number;
  additionalTitles?: string[];
  isAnime: boolean;
  titleYear?: string;
  // Pre-resolved IDs from anime database (when request came from anime ID prefix)
  animeResolvedIds?: { tmdbId?: string; tvdbId?: string };
}

/**
 * Search via the configured index manager (Prowlarr, NZBHydra, or Newznab).
 */
export async function indexManagerSearch(ctx: SearchContext): Promise<any[]> {
  const { type, imdbId, title, year, country, season, episode, episodesInSeason, priorSeasonsEpisodeCount, additionalTitles, isAnime, titleYear, animeResolvedIds } = ctx;

  if (config.indexManager === 'prowlarr' && config.prowlarrUrl && config.prowlarrApiKey) {
    // === PROWLARR MODE ===
    const enabledSynced = (config.syncedIndexers || []).filter(i => i.enabledForSearch);
    if (enabledSynced.length === 0) {
      console.log('⚠️  No synced Prowlarr indexers enabled for search');
      return [];
    }

    // Per-indexer anime method swap: when anime detected, use anime-specific methods
    let searchIndexers = enabledSynced;
    if (isAnime) {
      console.log(`🎌 Anime detected — using per-indexer anime search methods`);
      searchIndexers = enabledSynced.map(i => ({
        ...i,
        movieSearchMethod: i.animeMovieSearchMethod ?? ['text'],
        tvSearchMethod: i.animeTvSearchMethod ?? ['text'],
      }));
    }

    // Collect unique search methods needed
    const neededMethods = new Set<string>();
    for (const indexer of searchIndexers) {
      const methods = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 Prowlarr search methods: ${[...neededMethods].join(', ')} across ${searchIndexers.length} indexer(s)`);
    for (const indexer of searchIndexers) {
      const m = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      console.log(`   ${indexer.name}: ${(Array.isArray(m) ? m : [m]).join(', ')}`);
    }

    // Resolve external IDs needed by indexers — seed from anime database if available
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    if (animeResolvedIds?.tmdbId) resolvedIds.set('tmdb', { idParam: 'tmdbid', idValue: animeResolvedIds.tmdbId });
    if (animeResolvedIds?.tvdbId) resolvedIds.set('tvdb', { idParam: 'tvdbid', idValue: animeResolvedIds.tvdbId });
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text' && !resolvedIds.has(m))
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}`);
        resolvedIds.set(method, result);
      }));

    const startTime = Date.now();
    const timeoutEnabled = config.searchTimeoutOverride !== undefined ? true : config.prowlarrTimeoutEnabled;
    const timeoutSeconds = config.searchTimeoutOverride ?? config.prowlarrTimeout;
    const searcher = new ProwlarrSearcher(
      config.prowlarrUrl, config.prowlarrApiKey, searchIndexers,
      timeoutEnabled, timeoutSeconds,
    );

    try {
      let results: any[];
      if (type === 'movie') {
        results = await searcher.searchMovie(imdbId, title, year, country, resolvedIds, additionalTitles, titleYear);
      } else if (type === 'series' && season !== undefined && episode !== undefined) {
        results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, resolvedIds, additionalTitles, titleYear);
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

    // Per-indexer anime method swap
    let searchIndexers = enabledSynced;
    if (isAnime) {
      console.log(`🎌 Anime detected — using per-indexer anime search methods`);
      searchIndexers = enabledSynced.map(i => ({
        ...i,
        movieSearchMethod: i.animeMovieSearchMethod ?? ['text'],
        tvSearchMethod: i.animeTvSearchMethod ?? ['text'],
      }));
    }

    const neededMethods = new Set<string>();
    for (const indexer of searchIndexers) {
      const methods = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 NZBHydra search methods: ${[...neededMethods].join(', ')} across ${searchIndexers.length} indexer(s)`);
    for (const indexer of searchIndexers) {
      const m = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      console.log(`   ${indexer.name}: ${(Array.isArray(m) ? m : [m]).join(', ')}`);
    }

    // Resolve external IDs needed by indexers — seed from anime database if available
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    if (animeResolvedIds?.tmdbId) resolvedIds.set('tmdb', { idParam: 'tmdbid', idValue: animeResolvedIds.tmdbId });
    if (animeResolvedIds?.tvdbId) resolvedIds.set('tvdb', { idParam: 'tvdbid', idValue: animeResolvedIds.tvdbId });
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text' && !resolvedIds.has(m))
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}`);
        resolvedIds.set(method, result);
      }));

    const startTime = Date.now();
    const nzbhydraTimeoutEnabled = config.searchTimeoutOverride !== undefined ? true : config.nzbhydraTimeoutEnabled;
    const nzbhydraTimeoutSeconds = config.searchTimeoutOverride ?? config.nzbhydraTimeout;
    const searcher = new NzbhydraSearcher(
      config.nzbhydraUrl, config.nzbhydraApiKey, searchIndexers,
      config.nzbhydraUsername, config.nzbhydraPassword,
      nzbhydraTimeoutEnabled, nzbhydraTimeoutSeconds,
    );

    try {
      let results: any[];
      if (type === 'movie') {
        results = await searcher.searchMovie(imdbId, title, year, country, resolvedIds, additionalTitles, titleYear);
      } else if (type === 'series' && season !== undefined && episode !== undefined) {
        results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, resolvedIds, additionalTitles, titleYear);
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

    // Per-indexer anime method swap
    const effectiveIndexers = isAnime
      ? enabledIndexers.map(i => ({
          ...i,
          movieSearchMethod: i.animeMovieSearchMethod ?? ['text'] as ('imdb' | 'tmdb' | 'tvdb' | 'text')[],
          tvSearchMethod: i.animeTvSearchMethod ?? ['text'] as ('imdb' | 'tvdb' | 'tvmaze' | 'text')[],
        }))
      : enabledIndexers;
    if (isAnime) console.log(`🎌 Anime detected — using per-indexer anime search methods`);

    // Collect unique search methods needed across all enabled indexers
    const neededMethods = new Set<string>();
    for (const indexer of effectiveIndexers) {
      const methods = type === 'movie'
        ? (indexer.movieSearchMethod || ['imdb'])
        : (indexer.tvSearchMethod || ['imdb']);
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const m of methodArr) neededMethods.add(m);
    }
    console.log(`📋 Newznab search methods: ${[...neededMethods].join(', ')} across ${effectiveIndexers.length} indexer(s)`);
    for (const indexer of effectiveIndexers) {
      const m = type === 'movie'
        ? (indexer.movieSearchMethod || ['imdb'])
        : (indexer.tvSearchMethod || ['imdb']);
      console.log(`   ${indexer.name}: ${(Array.isArray(m) ? m : [m]).join(', ')}`);
    }
    if (isAnime && neededMethods.has('text') && additionalTitles?.length) {
      console.log(`🎌 Anime dual-title search: "${title}" + ${additionalTitles.map(t => `"${t}"`).join(', ')}`);
    }

    // Resolve external IDs needed by indexers — seed from anime database if available
    const resolvedIds = new Map<string, { idParam: string; idValue: string } | null>();
    if (animeResolvedIds?.tmdbId) resolvedIds.set('tmdb', { idParam: 'tmdbid', idValue: animeResolvedIds.tmdbId });
    if (animeResolvedIds?.tvdbId) resolvedIds.set('tvdb', { idParam: 'tvdbid', idValue: animeResolvedIds.tvdbId });
    await Promise.all([...neededMethods]
      .filter(m => m !== 'imdb' && m !== 'text' && !resolvedIds.has(m))
      .map(async (method) => {
        const result = await resolveExternalId(imdbId, type as 'movie' | 'series', method as 'tmdb' | 'tvdb' | 'tvmaze');
        if (!result) {
          console.warn(`⚠️  Failed to resolve ${method} ID for ${imdbId}, affected indexers will fall back to text search`);
        }
        resolvedIds.set(method, result);
      }));

    // Indexers that timed out during the main search pass. Scoped to this single
    // indexManagerSearch invocation so the text-fallback and alt-title retries can
    // skip them and avoid stacking a second timeout wait on an already-slow backend.
    const timedOutIndexers = new Set<string>();

    // Search across all enabled indexers, each with its own methods and resolved IDs
    const searchPromises = effectiveIndexers
      .map(async (indexer) => {
        const startTime = Date.now();
        const methods = type === 'movie'
          ? (indexer.movieSearchMethod || ['imdb'])
          : (indexer.tvSearchMethod || ['imdb']);
        const methodArr = Array.isArray(methods) ? methods : [methods];

        const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));

        try {
          const allMethodResults: any[] = [];
          for (const method of methodArr) {
            const externalId = (method !== 'imdb' && method !== 'text')
              ? resolvedIds.get(method) ?? null
              : null;

            if (type === 'movie') {
              const results = await searcher.searchMovie(imdbId, title, year, country, externalId || undefined, method, additionalTitles, titleYear);
              allMethodResults.push(...results);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              const results = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, externalId || undefined, method, additionalTitles, titleYear);
              allMethodResults.push(...results);
            }

            // For anime text searches, also search with alternate titles (e.g. Cinemeta English name when Kitsu is romanized Japanese)
            if (method === 'text' && isAnime && additionalTitles?.length) {
              for (const altTitle of additionalTitles) {
                if (type === 'movie') {
                  const altResults = await searcher.searchMovie(imdbId, altTitle, year, country, undefined, 'text', additionalTitles, titleYear);
                  allMethodResults.push(...altResults);
                } else if (type === 'series' && season !== undefined && episode !== undefined) {
                  const altResults = await searcher.searchTVShow(imdbId, altTitle, season, episode, episodesInSeason, year, country, undefined, 'text', additionalTitles, titleYear);
                  allMethodResults.push(...altResults);
                }
              }
            }
          }

          if (searcher.timedOut) timedOutIndexers.add(indexer.name);
          const responseTime = Date.now() - startTime;
          trackQuery(indexer.name, true, responseTime, allMethodResults.length);

          return allMethodResults.map(result => ({ ...result, indexerName: indexer.name }));
        } catch (error) {
          if (searcher.timedOut) timedOutIndexers.add(indexer.name);
          const responseTime = Date.now() - startTime;
          trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
          console.error(`❌ Error searching ${indexer.name}:`, error);
          return [];
        }
      });

    // Parallel alt-title search: when the user toggle is on, fire each
    // additional title as a text search concurrently with the primary pass
    // instead of waiting for a zero-result fallback. UTS-only by intent;
    // anime is excluded because its inner loop above already runs Kitsu +
    // Cinemeta in parallel via the per-indexer text path.
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true
      && !!additionalTitles?.length
      && !isAnime;
    if (parallelAltEnabled) {
      console.log(`🔀 Parallel alt-title search enabled — querying [${[title, ...additionalTitles!].map(t => `"${t}"`).join(', ')}] concurrently across ${effectiveIndexers.length} indexer(s)`);
    }
    const altSearchPromises = parallelAltEnabled
      ? effectiveIndexers.flatMap(indexer => additionalTitles!.map(async (altTitle) => {
          const startTime = Date.now();
          const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));
          try {
            let altResults: any[] = [];
            if (type === 'movie') {
              altResults = await searcher.searchMovie(imdbId, altTitle, year, country, undefined, 'text', undefined, titleYear);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              altResults = await searcher.searchTVShow(imdbId, altTitle, season, episode, episodesInSeason, year, country, undefined, 'text', undefined, titleYear);
            }
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, true, responseTime, altResults.length);
            return altResults.map(result => ({ ...result, indexerName: indexer.name }));
          } catch (error) {
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
            console.error(`❌ Error in parallel alt-title search for ${indexer.name} ("${altTitle}"):`, error);
            return [];
          }
        }))
      : [];

    let results = (await Promise.all([...searchPromises, ...altSearchPromises])).flat();

    // Zero-result text fallback: if ID-based searches returned nothing, retry with text.
    // Indexers that timed out in the main pass are skipped so we don't stack another timeout.
    if (results.length === 0 && title) {
      const nonTextIndexers = enabledIndexers.filter(indexer => {
        if (timedOutIndexers.has(indexer.name)) return false;
        const methods = type === 'movie'
          ? (indexer.movieSearchMethod || ['imdb'])
          : (indexer.tvSearchMethod || ['imdb']);
        const methodArr = Array.isArray(methods) ? methods : [methods];
        return !methodArr.every(m => m === 'text');
      });
      if (timedOutIndexers.size > 0) {
        console.log(`⏱️  Skipping text fallback for ${timedOutIndexers.size} indexer(s) — prior timeout: ${[...timedOutIndexers].map(n => `"${n}"`).join(', ')}`);
      }

      if (nonTextIndexers.length > 0) {
        console.log(`🔄 ID search returned 0 — text fallback for ${nonTextIndexers.length} indexer(s)`);
        const fallbackPromises = nonTextIndexers.map(async (indexer) => {
          const startTime = Date.now();
          const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));
          try {
            let fbResults: any[] = [];
            if (type === 'movie') {
              fbResults = await searcher.searchMovie(imdbId, title, year, country, undefined, 'text', additionalTitles, titleYear);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              fbResults = await searcher.searchTVShow(imdbId, title, season, episode, episodesInSeason, year, country, undefined, 'text', additionalTitles, titleYear);
            }
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, true, responseTime, fbResults.length);
            return fbResults.map(result => ({ ...result, indexerName: indexer.name }));
          } catch (error) {
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
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

    // Absolute-episode fallback: covers indexers that file releases under
    // continuous absolute numbering (Title E31) rather than Title S03E07.
    // When combined results are zero after the main pass + standard
    // text-fallback, retry every non-timed-out indexer with E{absolute}.
    // By this point each has already had a UTS attempt (either configured
    // or via the L315 fallback above), so all are valid retry targets.
    // UTS-only — ID methods don't use the SxxExx vs E{n} distinction.
    // Downstream isTextSearchMatch still requires the resolved title to
    // appear in the result, so non-matching releases get filtered.
    if (
      results.length === 0
      && type === 'series'
      && season !== undefined
      && episode !== undefined
      && config.searchConfig?.absoluteEpisodeFallback !== false
    ) {
      const retryIndexers = enabledIndexers.filter(i => !timedOutIndexers.has(i.name));
      if (retryIndexers.length > 0) {
        if (priorSeasonsEpisodeCount === undefined) {
          console.warn(`⚠️  Absolute episode fallback: priorSeasonsEpisodeCount unavailable (Cinemeta gap), using per-season E${episode}`);
        }
        const absoluteEp = (priorSeasonsEpisodeCount ?? 0) + episode;
        // When parallel mode is on, fan the absolute pass over primary + alts
        // upfront — the standard alt-title retry below is gated off in that
        // mode, so this is the only place alts get an E{absolute} probe.
        const titlesToRetry = (parallelAltEnabled && additionalTitles?.length)
          ? [title, ...additionalTitles]
          : [title];
        console.log(`🔢 Absolute episode fallback: retrying ${retryIndexers.length} indexer(s) with E${absoluteEp}${titlesToRetry.length > 1 ? ` × ${titlesToRetry.length} title(s)` : ''}`);
        const fallbackPromises = retryIndexers.flatMap(indexer => titlesToRetry.map(async (t) => {
          const startTime = Date.now();
          const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));
          try {
            // Pass additionalTitles only for primary pass — alt passes filter
            // strictly against the alt to avoid loose cross-title matches.
            const altsForFilter = t === title ? additionalTitles : undefined;
            const fbResults = await searcher.searchTVShow(
              imdbId, t, season, episode, episodesInSeason, year, country,
              undefined, 'text', altsForFilter, titleYear,
              { numberingScheme: 'absolute', absoluteEp }
            );
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, true, responseTime, fbResults.length);
            return fbResults.map(result => ({ ...result, indexerName: indexer.name }));
          } catch (error) {
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
            console.error(`❌ Error in absolute episode fallback for ${indexer.name} ("${t}"):`, error);
            return [];
          }
        }));
        const fallbackResults = await Promise.all(fallbackPromises);
        results = fallbackResults.flat();
        console.log(`   🔢 Absolute episode fallback returned ${results.length} results`);
      }
    }

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each.
    // Skip indexers that have timed out at any prior point in this cycle.
    // Skipped entirely in parallel-alt mode — those alts already fired upfront.
    if (results.length === 0 && additionalTitles?.length && enabledIndexers.length > 0 && !parallelAltEnabled) {
      const altIndexers = enabledIndexers.filter(i => !timedOutIndexers.has(i.name));
      const skipped = enabledIndexers.length - altIndexers.length;
      if (skipped > 0) {
        console.log(`⏱️  Skipping alt-title retry for ${skipped} indexer(s) — prior timeout: ${[...timedOutIndexers].map(n => `"${n}"`).join(', ')}`);
      }
      for (const altTitle of additionalTitles) {
        if (altIndexers.length === 0) break;
        console.log(`🔄 Retrying with alternative title for ${altIndexers.length} indexer(s): "${altTitle}"`);
        const altPromises = altIndexers.map(async (indexer) => {
          const startTime = Date.now();
          const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));
          try {
            let altResults: any[] = [];
            if (type === 'movie') {
              altResults = await searcher.searchMovie(imdbId, altTitle, year, country, undefined, 'text', undefined, titleYear);
            } else if (type === 'series' && season !== undefined && episode !== undefined) {
              altResults = await searcher.searchTVShow(imdbId, altTitle, season, episode, episodesInSeason, year, country, undefined, 'text', undefined, titleYear);
            }
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, true, responseTime, altResults.length);
            return altResults.map(result => ({ ...result, indexerName: indexer.name }));
          } catch (error) {
            if (searcher.timedOut) timedOutIndexers.add(indexer.name);
            const responseTime = Date.now() - startTime;
            trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
            console.error(`❌ Error in alt-title retry for ${indexer.name}:`, error);
            return [];
          }
        });

        let altResults = (await Promise.all(altPromises)).flat();
        console.log(`   🎯 Alt-title retry returned ${altResults.length} results`);

        // Absolute-episode fallback for the alt title — same rationale as the
        // primary-title fallback above. If the alt-title SxxExx came back
        // empty and we're searching a series with the toggle on, retry the
        // alt title with E{absolute}.
        if (
          altResults.length === 0
          && type === 'series'
          && season !== undefined
          && episode !== undefined
          && config.searchConfig?.absoluteEpisodeFallback !== false
        ) {
          const absoluteEp = (priorSeasonsEpisodeCount ?? 0) + episode;
          const absoluteAltIndexers = altIndexers.filter(i => !timedOutIndexers.has(i.name));
          if (absoluteAltIndexers.length > 0) {
            console.log(`🔢 Absolute episode fallback (alt title "${altTitle}"): retrying ${absoluteAltIndexers.length} indexer(s) with E${absoluteEp}`);
            const absPromises = absoluteAltIndexers.map(async (indexer) => {
              const startTime = Date.now();
              const searcher = new UsenetSearcher(applySearchTimeoutOverride(indexer));
              try {
                const fbResults = await searcher.searchTVShow(
                  imdbId, altTitle, season, episode, episodesInSeason, year, country,
                  undefined, 'text', undefined, titleYear,
                  { numberingScheme: 'absolute', absoluteEp }
                );
                if (searcher.timedOut) timedOutIndexers.add(indexer.name);
                const responseTime = Date.now() - startTime;
                trackQuery(indexer.name, true, responseTime, fbResults.length);
                return fbResults.map(result => ({ ...result, indexerName: indexer.name }));
              } catch (error) {
                if (searcher.timedOut) timedOutIndexers.add(indexer.name);
                const responseTime = Date.now() - startTime;
                trackQuery(indexer.name, false, responseTime, 0, error instanceof Error ? error.message : 'Unknown error');
                console.error(`❌ Error in absolute episode fallback (alt title) for ${indexer.name}:`, error);
                return [];
              }
            });
            altResults = (await Promise.all(absPromises)).flat();
            console.log(`   🔢 Absolute episode fallback (alt title) returned ${altResults.length} results`);
          }
        }

        if (altResults.length > 0) {
          results = altResults;
          break;
        }
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

  const { type, title, year, country, season, episode, episodesInSeason, priorSeasonsEpisodeCount, additionalTitles, titleYear } = ctx;
  const easynewsStartTime = Date.now();
  const easynewsTimeoutEnabled = config.searchTimeoutOverride !== undefined ? true : config.easynewsTimeoutEnabled;
  const easynewsTimeoutSeconds = config.searchTimeoutOverride ?? config.easynewsTimeout;
  const searcher = new EasynewsSearcher(
    config.easynewsUsername,
    config.easynewsPassword,
    config.easynewsPagination ? config.easynewsMaxPages : 1,
    easynewsTimeoutEnabled, easynewsTimeoutSeconds,
  );

  try {
    let results: any[];
    if (type === 'movie') {
      results = await searcher.searchMovie(title, year, country, additionalTitles, titleYear);
    } else if (type === 'series' && season !== undefined && episode !== undefined) {
      results = await searcher.searchTVShow(title, season, episode, episodesInSeason, year, country, additionalTitles, titleYear, priorSeasonsEpisodeCount);
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

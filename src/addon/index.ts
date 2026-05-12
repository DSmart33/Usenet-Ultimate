/**
 * Stremio Addon — Main Entry Point
 *
 * Connects to Stremio and handles stream requests.
 *
 * What this does:
 *      manifest - Tells Stremio our addon capabilities
 *      defineStreamHandler - Called when user clicks "Watch"
 *      Parses IMDB ID and season/episode from request
 *      Searches all indexers in parallel with Promise.all()
 *      Sorts results by quality (best first)
 *      Returns NZB links as externalUrl (user's download client handles them)
 *      Caches results to avoid hitting API rate limits
 *
 * Key concept:
 *      externalUrl - means "open this URL externally" - user's NZB client will catch it
 *      notWebReady: true - tells Stremio it can't play in the web player
 */

import { createRequire } from 'node:module';
import { addonBuilder } from 'stremio-addon-sdk';

const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import NodeCache from 'node-cache';
import { config, getTvAllowMultiEpisode } from '../config/index.js';
import { createFallbackGroup, clearFallbackGroups, clearTimeoutEntries, ultimateFallbackFromCandidates, buildNzbdavConfig, buildEpisodePattern, buildDateEpisodePattern, isNzbdavLibraryConfigured, clearResolvedSessions } from '../nzbdav/index.js';
import { resolveTitle, type ResolvedTitleInfo } from './titleResolver.js';
import { indexManagerSearch, easynewsSearch, type SearchContext } from './searchOrchestrator.js';
import { runLibraryGate } from './libraryGate.js';
import { deduplicateAndPreFilter, applyUserFilters } from './resultProcessor.js';
import { sortResults } from './sort.js';
import { coordinateHealthChecks, autoMarkRemainingResults, autoQueueToNzbdav, markLibraryHits } from './healthCheckCoordinator.js';
import { buildStreams } from './streamBuilder.js';
import { isDeadNzbByUrl, isDeadNzb, getDeadCacheKey, consumeLibraryBypass } from '../nzbdav/streamCache.js';
import { requestContext } from '../requestContext.js';
import { parseAnimeId, resolveAnimeId } from '../anime/animeIdResolver.js';
import { isDatabaseLoaded } from '../anime/animeDatabase.js';
import { resolveEpisodeCountFromTvdbId } from '../idResolver.js';

// Create cache for search results
// Use stdTTL: 0 (no expiry) and manage TTL per-entry via cache.set() so runtime changes take effect
const cache = new NodeCache({ stdTTL: 0 });

export function clearSearchCache(): void {
  cache.flushAll();
  clearFallbackGroups();
  clearTimeoutEntries();
  clearResolvedSessions();
}

// Define addon manifest - tells Stremio what we support
const manifest = {
  id: 'com.usenetultimate.addon',
  version: APP_VERSION,
  name: 'Usenet Ultimate',
  description: 'Search Usenet indexers and EasyNews for media content. Supports Newznab, Prowlarr, and NZBHydra with NZB health checking, quality-based sorting, and direct streaming via NZBDav or EasyNews.',
  logo: '/pwa-512x512.png',
  resources: ['stream'],           // We only provide streams
  types: ['movie', 'series'],      // Support movies and TV shows
  catalogs: [],                    // No catalogs (don't show in discover)
  idPrefixes: ['tt', 'kitsu:', 'mal:', 'anilist:', 'anidb:'],
  behaviorHints: {
    configurable: true,            // We have a config UI
    configurationRequired: false,  // But it's optional
  },
};

const builder = addonBuilder(manifest);

/**
 * Build the manifest-scoped search cache key. Single source of truth for the
 * key composition used by the search-time write (this file) and the bypass-
 * time delete (routes/nzbdav.ts library-bypass endpoint). Manifest-scoping
 * prevents cross-manifest cache collisions in multi-tenant deployments.
 */
/** Drop a search cache entry by its full key. Used by the library-bypass
 *  endpoint to clear stale results before the user re-searches. */
export function deleteSearchCacheEntry(cacheKey: string): boolean {
  return cache.del(cacheKey) > 0;
}


export function buildSearchCacheKey(manifestKey: string, type: string, id: string, cfg: typeof config): string {
  const easynewsSuffix = cfg.easynewsEnabled ? ':en' : '';
  const packsSuffix = cfg.searchConfig?.includeSeasonPacks ? ':packs' : '';
  // Bake the alias-fallback flag into the key so toggling it invalidates
  // any cached zero-result entry whose outcome depended on the flag's state.
  const aliasFbSuffix = cfg.searchConfig?.aliasTitleFallback === false ? ':noaf' : '';
  if (cfg.indexManager === 'prowlarr' || cfg.indexManager === 'nzbhydra') {
    const syncedEnabled = (cfg.syncedIndexers || []).filter(i => i.enabledForSearch);
    const syncedFingerprint = syncedEnabled
      .map(i => `${i.id}:${type === 'movie' ? i.movieSearchMethod : i.tvSearchMethod}`)
      .join(',');
    return `${manifestKey}:stream:${type}:${id}:${cfg.indexManager}:${syncedFingerprint}${packsSuffix}${easynewsSuffix}${aliasFbSuffix}`;
  }
  const enabledIndexers = cfg.indexers.filter(i => i.enabled);
  const methodsFingerprint = enabledIndexers
    .map(i => `${i.name}:${type === 'movie' ? (i.movieSearchMethod || ['imdb']).join('+') : (i.tvSearchMethod || ['imdb']).join('+')}`)
    .join(',');
  return `${manifestKey}:stream:${type}:${id}:${methodsFingerprint}${packsSuffix}${easynewsSuffix}${aliasFbSuffix}`;
}

/**
 * Resolve title metadata and assemble the SearchContext used by all downstream
 * searchers (indexer, EasyNews, library). Centralized so the fresh-search and
 * cache-hit paths build the same searchCtx; the cache-hit path needs it when
 * libraryRunOnCacheHit is on so the library scan has full title info.
 *
 * Anime via Kitsu/MAL/AniList/AniDB without IMDB mappings uses a synthetic
 * titleInfo (no Cinemeta lookup) and only augments via TVDB when a TVDB ID is
 * provided directly. See the inline comments in the anime branch for the
 * Cinemeta-cumulative caveat.
 */
async function resolveTitleAndBuildSearchCtx(args: {
  type: string;
  imdbId: string;
  season: number | undefined;
  episode: number | undefined;
  animeId: ReturnType<typeof parseAnimeId>;
  animeResolved: ReturnType<typeof resolveAnimeId>;
}): Promise<{ titleInfo: ResolvedTitleInfo; searchCtx: SearchContext }> {
  const { type, imdbId, season, episode, animeId, animeResolved } = args;

  let titleInfo: ResolvedTitleInfo;
  if (animeResolved && !animeResolved.imdbId && animeResolved.title) {
    titleInfo = {
      title: animeResolved.title,
      cinemetaTitle: animeResolved.title,
      year: animeResolved.year,
      country: 'Japan',
      genres: ['Animation'],
      isAnime: true,
      episodesInSeason: undefined,
      priorSeasonsEpisodeCount: undefined,
      absoluteEpisodeNumber: undefined,
      tvdbPriorSeasonsCount: undefined,
      additionalTitles: undefined,
      runtime: undefined,
      episodeName: undefined,
      hasRemake: undefined,
      titleYear: undefined,
    };
    // Synthetic path has no imdbId, so resolveTitle's eager TVDB call doesn't
    // fire. When animeResolved gives us a TVDB ID directly, fetch the same
    // series data so anime via Kitsu/MAL/AniList/AniDB without IMDB mappings
    // gets full feature parity (absolute-fallback chain, bitrate display,
    // season-pack episode-size estimation). Cinemeta cumulative tier is
    // structurally unavailable on this path (no imdbId to query).
    if (animeResolved.tvdbId && season !== undefined) {
      const tvdbIdNum = parseInt(animeResolved.tvdbId, 10);
      if (Number.isFinite(tvdbIdNum) && tvdbIdNum > 0) {
        const tvdbResult = await resolveEpisodeCountFromTvdbId(tvdbIdNum, season, episode);
        if (tvdbResult) {
          titleInfo.episodesInSeason = tvdbResult.count;
          if (tvdbResult.runtime) titleInfo.runtime = tvdbResult.runtime;
          if (tvdbResult.episodeName) titleInfo.episodeName = tvdbResult.episodeName;
          if (tvdbResult.absoluteNumber) titleInfo.absoluteEpisodeNumber = tvdbResult.absoluteNumber;
          if (tvdbResult.priorSeasonsCount !== undefined) titleInfo.tvdbPriorSeasonsCount = tvdbResult.priorSeasonsCount;
        }
      }
    }
  } else {
    titleInfo = await resolveTitle(type, imdbId, season, episode);
    if (animeId) {
      titleInfo.isAnime = true;
    }
  }

  const searchCtx: SearchContext = {
    type, imdbId,
    title: titleInfo.title,
    year: titleInfo.year,
    country: titleInfo.country,
    season, episode,
    episodesInSeason: titleInfo.episodesInSeason,
    priorSeasonsEpisodeCount: titleInfo.priorSeasonsEpisodeCount,
    absoluteEpisodeNumber: titleInfo.absoluteEpisodeNumber,
    tvdbPriorSeasonsCount: titleInfo.tvdbPriorSeasonsCount,
    additionalTitles: titleInfo.additionalTitles,
    isAnime: titleInfo.isAnime,
    titleYear: titleInfo.titleYear,
    searchAliases: titleInfo.searchAliases,
    episodeAired: titleInfo.episodeAired,
    animeResolvedIds: animeResolved ? { tmdbId: animeResolved.tmdbId, tvdbId: animeResolved.tvdbId } : undefined,
  };

  return { titleInfo, searchCtx };
}

// Stream handler - called when user wants to watch something
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    // Check if addon is disabled
    if (!config.addonEnabled) {
      console.log('⏸️  Addon is disabled — returning no streams');
      return { streams: [] };
    }

    // Parse the ID — check for anime ID prefixes first, then IMDB
    const animeId = parseAnimeId(id);
    let imdbId: string;
    let season: number | undefined;
    let episode: number | undefined;
    let animeResolved: ReturnType<typeof resolveAnimeId> = null;

    if (animeId) {
      // Anime ID (kitsu:, mal:, anilist:, anidb:)
      if (!isDatabaseLoaded()) {
        console.warn(`⚠️  Anime ID ${id} received but anime databases not loaded — returning empty`);
        return { streams: [] };
      }
      animeResolved = resolveAnimeId(animeId);
      if (!animeResolved || (!animeResolved.imdbId && !animeResolved.title)) {
        console.warn(`⚠️  Could not resolve anime ID ${id} — no mapping found`);
        return { streams: [] };
      }
      imdbId = animeResolved.imdbId || `${animeId.prefix}:${animeId.id}`;
      season = animeResolved.season;
      episode = animeResolved.episode;
    } else {
      // Standard IMDB ID: tt1234567 or tt1234567:1:1
      const parts = id.split(':');
      imdbId = parts[0];
      season = parts[1] ? parseInt(parts[1], 10) : undefined;
      episode = parts[2] ? parseInt(parts[2], 10) : undefined;
    }

    // Manifest-scoped cache + bypass key. Both share the same manifestKey so a
    // bypass-tile click under manifest A doesn't affect manifest B.
    const requestManifestKey = requestContext.getStore()?.manifestKey || '';
    const cacheKey = buildSearchCacheKey(requestManifestKey, type, id, config);

    // Pre-search bypass check — fires FIRST, before the cache-hit gate below.
    // Set when the user clicks the "Query indexers on next search" tile after a
    // library short-circuit. One-shot consumption: the marker clears the moment
    // we read it. When set, library scan is skipped for THIS search and
    // indexer/EasyNews flow runs instead.
    const bypassKey = `${requestManifestKey}:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}`;
    const libraryBypassed = consumeLibraryBypass(bypassKey);
    if (libraryBypassed) {
      console.log(`📚 Ultimate Library bypassed for this search (user-armed via tile)`);
    }

    // === SHARED: Filter dead NZBs from raw results ===
    const filterDeadFromRaw = (results: any[]) => {
      if (!config.filterDeadNzbs) return results;
      const SELF_URL = `http://localhost:${process.env.PORT || 1337}`;
      const manifestKey = requestContext.getStore()?.manifestKey || '';
      let cachePattern: string | undefined;
      if (type === 'series' && season !== undefined && episode !== undefined) {
        cachePattern = buildEpisodePattern(season, episode, getTvAllowMultiEpisode(config));
      }
      const isDead = (url: string) =>
        (cachePattern && isDeadNzb(getDeadCacheKey(url, cachePattern))) || isDeadNzbByUrl(url);
      const before = results.length;
      const removed: { title: string; indexer: string }[] = [];
      const filtered = results.filter(r => {
        let dead: boolean;
        if (r.easynewsMeta) {
          const meta = r.easynewsMeta;
          const nzbParams = new URLSearchParams({ hash: meta.hash, filename: meta.filename, ext: meta.ext });
          if (meta.sig) nzbParams.set('sig', meta.sig);
          dead = isDead(`${SELF_URL}/${manifestKey}/easynews/nzb?${nzbParams.toString()}`);
        } else {
          dead = isDead(r.link);
        }
        if (dead) removed.push({ title: r.title, indexer: r.indexerName || r.origin });
        return !dead;
      });
      if (filtered.length < before) {
        console.log(`🚫 Filtered ${before - filtered.length} dead NZB(s) from results (${filtered.length} remaining)`);
        for (const { title, indexer } of removed) console.log(`   ✂️  "${title}" [${indexer}]`);
      }
      return filtered;
    };

    // === SHARED: Trigger auto-resolve or Ultimate-Fallback if enabled ===
    const triggerAutoResolve = (fallbackCandidates: any[] | undefined, episodesInSeason?: number, episodeAired?: string) => {
      if (!fallbackCandidates?.length) return;

      const contentKey = `${type}:${imdbId}:${season ?? ''}:${episode ?? ''}`;
      const ufManifestKey = requestContext.getStore()?.manifestKey || '';
      const sessionKey = `${ufManifestKey}:${contentKey}`;
      const nzbdavConfig = buildNzbdavConfig();
      let cachePattern: string | undefined;
      let filePattern: string | undefined;
      if (type === 'series' && season !== undefined && episode !== undefined) {
        cachePattern = buildEpisodePattern(season, episode, getTvAllowMultiEpisode(config));
        const datePattern = buildDateEpisodePattern(episodeAired);
        filePattern = datePattern ? `(?:${cachePattern}|${datePattern})` : cachePattern;
      }

      // Ultimate-Fallback takes priority — handles health checking + nzbdav internally.
      // Guarded by streamingMode=nzbdav: UF resolves via NZBDav, so running it for other modes
      // wastes cycles and produces a tile URL the handler can't serve.
      if (config.ultimateFallback?.enabled && config.streamingMode === 'nzbdav') {
        // On-tile-selection: defer UF until the user clicks the lobby tile.
        // The lobby handler in streamHandler.ts triggers UF there.
        if (config.ultimateFallback.whenToResolve === 'on-tile-selection') return;
        const ur = config.ultimateFallback;
        ultimateFallbackFromCandidates(
          sessionKey, fallbackCandidates, nzbdavConfig,
          { candidateCount: ur.candidateCount, preferenceMode: ur.preferenceMode, archiveInspection: ur.archiveInspection, sampleCount: ur.sampleCount, maxAttempts: ur.maxAttempts, desiredBackups: ur.desiredBackups, backupProcessingLimit: ur.backupProcessingLimit, priorityMoviesTimeoutSeconds: ur.priorityMoviesTimeoutSeconds, priorityTvTimeoutSeconds: ur.priorityTvTimeoutSeconds, prioritySeasonPackTimeoutSeconds: ur.prioritySeasonPackTimeoutSeconds, speedMoviesTimeoutSeconds: ur.speedMoviesTimeoutSeconds, speedTvTimeoutSeconds: ur.speedTvTimeoutSeconds, speedSeasonPackTimeoutSeconds: ur.speedSeasonPackTimeoutSeconds, healthCheckIndexers: ur.healthCheckIndexers },
          cachePattern, filePattern, type, episodesInSeason,
        ).catch(err => console.error('❌ Ultimate-Fallback error:', err));
        return;
      }

    };

    // === SHARED: Process from raw results → streams (filter, sort, health check, build) ===
    const processFromRaw = async (rawResults: any[], deprioritizedPacks: any[], healthMap: Map<string, any>, titleMeta: { type: string; season?: number; episode?: number; episodesInSeason?: number; episodeAired?: string; now: number; runtime?: number; shortCircuited?: boolean }) => {
      // Filter dead NZBs from both main results AND deprioritized packs — yearless
      // season packs of remade shows take the deprioritized path (applyRemakeFilter)
      // and would otherwise bypass the dead-NZB DB.
      let allResults = filterDeadFromRaw(rawResults);
      const filteredDeprioritizedPacks = filterDeadFromRaw(deprioritizedPacks);

      // Apply current user filter/sort preferences (deprioritized packs appended after sort)
      allResults = applyUserFilters(allResults, titleMeta.type, titleMeta.now, titleMeta.runtime, filteredDeprioritizedPacks);

      // Health checks pre-filter results before UF sees them; UF also performs
      // its own per-candidate verification. Pass pre-existing health data so the
      // coordinator skips already-checked results and smart mode counts them
      // toward its threshold. Inner gate respects config.healthChecks.enabled.
      const { healthResults: newHealth, filteredResults } = await coordinateHealthChecks({
        allResults,
        type: titleMeta.type,
        season: titleMeta.season,
        episode: titleMeta.episode,
        episodesInSeason: titleMeta.episodesInSeason,
        episodeAired: titleMeta.episodeAired,
        preExistingHealth: healthMap.size > 0 ? healthMap : undefined,
      });
      for (const [key, val] of newHealth) healthMap.set(key, val);
      allResults = filteredResults;

      // Auto-mark EasyNews and Zyclops results as verified
      autoMarkRemainingResults(allResults, healthMap);

      // Display library in results: mark search results that already exist in
      // the WebDAV library with the 📚 icon. Runs after auto-mark + before
      // auto-queue so library hits aren't auto-queued (auto-queue's isEligible
      // also rejects message='Library' as a defensive guard).
      if (config.searchConfig?.displayLibraryInResults && isNzbdavLibraryConfigured()) {
        const epPattern = (titleMeta.type === 'series' && titleMeta.season !== undefined && titleMeta.episode !== undefined)
          ? buildEpisodePattern(titleMeta.season, titleMeta.episode, getTvAllowMultiEpisode(config))
          : undefined;
        const contentType: 'movie' | 'series' = titleMeta.type === 'movie' ? 'movie' : 'series';
        const hits = await markLibraryHits(
          allResults,
          healthMap,
          buildNzbdavConfig(),
          epPattern,
          contentType,
          titleMeta.episodesInSeason,
          titleMeta.episodeAired,
        );
        if (hits > 0) console.log(`📚 Display-library: marked ${hits}/${allResults.length} result(s) as in-library`);
      }

      // Re-sort when preferLibraryResults is on. The inLibrary flag is mutated
      // by markLibraryHits during health checks AND the displayLibraryInResults
      // block above, both of which run AFTER applyUserFilters' initial sort.
      // On a fresh search the flag isn't visible to the first sort pass; the
      // re-sort here applies it. On cache-hit the rawResults already carry the
      // flag (set last run), so the initial sort already saw it and this pass
      // is effectively a no-op.
      const filterCfg = (titleMeta.type === 'movie' ? config.movieFilters : config.tvFilters) ?? config.filters;
      if (filterCfg?.preferLibraryResults) {
        allResults = sortResults(allResults, filterCfg, titleMeta.now, titleMeta.runtime);
      }

      // Auto-queue to NZBDav if enabled. Safe alongside Ultimate Fallback in
      // on-tile-selection mode (UF defers submit until click). Skipped when UF
      // is in on-results mode — UF already submits at search time and would
      // race auto-queue on the same NZBs.
      const ufSubmitsAtSearch = config.ultimateFallback?.enabled
        && config.ultimateFallback.whenToResolve !== 'on-tile-selection';
      if (!ufSubmitsAtSearch) {
        autoQueueToNzbdav(allResults, healthMap, titleMeta.type, titleMeta.season, titleMeta.episode, titleMeta.episodesInSeason);
      }

      // Build streams
      const { streams, fallbackGroupId, fallbackCandidates } = buildStreams({
        allResults,
        healthResults: healthMap,
        type: titleMeta.type,
        imdbId,
        season: titleMeta.season,
        episode: titleMeta.episode,
        episodesInSeason: titleMeta.episodesInSeason,
        episodeAired: titleMeta.episodeAired,
        now: titleMeta.now,
        runtime: titleMeta.runtime,
        shortCircuited: titleMeta.shortCircuited,
      });

      return { streams, fallbackGroupId, fallbackCandidates, allResults };
    };

    // Check cache first (cacheTTL of 0 means disabled)
    if (config.cacheEnabled && config.cacheTTL > 0) {
      const cached = cache.get<{ rawResults: any[]; deprioritizedPacks: any[]; healthMap: Record<string, any>; _meta: { type: string; season?: number; episode?: number; episodesInSeason?: number; episodeAired?: string; runtime?: number } }>(cacheKey);
      if (cached) {
        console.log(`💾 Cache hit for ${type} ${imdbId}`);

        // libraryRunOnCacheHit: when on, scan the WebDAV library before serving
        // cached results. The cached entry is never re-queried; we only short-
        // circuit to library results when the post-filter library scan meets
        // threshold. Below threshold, the cached entry is returned untouched.
        // The bypass marker still wins (one-shot user action overrides standing
        // preference). Library short-circuits skip both the cache.set update
        // and triggerAutoResolve below because (a) the cached indexer entry is
        // the source of truth for indexer state and must not be overwritten,
        // and (b) library hits are already-resolved files, so UF/auto-queue
        // would attempt to re-grab content that already exists in the library.
        let chShortCircuit = false;
        let chLibResults: any[] = [];
        if (config.searchConfig?.libraryRunOnCacheHit && !libraryBypassed) {
          const { titleInfo: chTitleInfo, searchCtx: chSearchCtx } = await resolveTitleAndBuildSearchCtx({
            type, imdbId, season, episode, animeId, animeResolved,
          });
          const chGate = await runLibraryGate(chSearchCtx, chTitleInfo, buildNzbdavConfig);
          chShortCircuit = chGate.shortCircuited;
          chLibResults = chGate.libraryResults;
        }

        const now = Date.now();
        const healthMap = new Map<string, any>(Object.entries(cached.healthMap || {}));

        if (chShortCircuit) {
          // Library met threshold on cache hit: serve library-only results.
          // Do NOT update the cached indexer entry, do NOT triggerAutoResolve.
          const { streams } = await processFromRaw(
            chLibResults, [], healthMap,
            { type, season, episode, episodesInSeason: cached._meta.episodesInSeason, episodeAired: cached._meta.episodeAired, now, runtime: cached._meta.runtime, shortCircuited: true },
          );
          return { streams };
        }

        // Re-apply filters, sort, health checks, and build streams with current settings
        const { streams, fallbackGroupId, fallbackCandidates } = await processFromRaw(
          cached.rawResults, cached.deprioritizedPacks || [], healthMap,
          { type, season, episode, episodesInSeason: cached._meta.episodesInSeason, episodeAired: cached._meta.episodeAired, now, runtime: cached._meta.runtime }
        );

        // Update cache with new health results
        cache.set(cacheKey, {
          ...cached,
          healthMap: Object.fromEntries(healthMap),
        }, config.cacheTTL);

        // Create fallback group from current filtered results
        if (fallbackGroupId && fallbackCandidates) {
          createFallbackGroup(fallbackGroupId, fallbackCandidates, type, season?.toString(), episode?.toString(), cached._meta.episodesInSeason);
        }

        triggerAutoResolve(fallbackCandidates, cached._meta.episodesInSeason, cached._meta.episodeAired);
        return { streams };
      }
    }

    {
      const searchHeader = `🔍 Searching for ${type} ${imdbId}${season !== undefined ? ` S${season}E${episode}` : ''} [${config.indexManager}]`;
      console.log('');
      console.log('');
      console.log('╔' + '═'.repeat(70));
      console.log(`║  ${searchHeader}`);
      console.log('╚' + '═'.repeat(70));
      console.log('');
    }
    console.log('═══ Title Resolution ' + '═'.repeat(42));

    // === STEP 1: TITLE RESOLUTION + STEP 2 SEARCH CONTEXT ===
    const { titleInfo, searchCtx } = await resolveTitleAndBuildSearchCtx({
      type, imdbId, season, episode, animeId, animeResolved,
    });

    // Optional pre-search: scan the WebDAV library first. Bypass marker (one-shot
    // user action via the Skip tile) takes precedence over the standing config; when
    // armed, the gate is skipped for this request. All threshold/type/streaming-mode
    // checks live inside runLibraryGate.
    const freshGate = !libraryBypassed
      ? await runLibraryGate(searchCtx, titleInfo, buildNzbdavConfig)
      : { shortCircuited: false, libraryResults: [] as any[] };
    let libraryResults: any[] = freshGate.libraryResults;
    let shortCircuited = freshGate.shortCircuited;

    let allRawResults: any[];
    if (shortCircuited) {
      allRawResults = libraryResults;
    } else {
      const [indexManagerResults, easynewsResults] = await Promise.all([
        indexManagerSearch(searchCtx),
        easynewsSearch(searchCtx),
      ]);
      // Tag indexer/easynews results with origin so downstream code can route correctly.
      // (Searchers don't currently emit origin natively; we tag at orchestrator level.)
      const tagOrigin = (r: any, origin: 'indexer' | 'easynews'): any =>
        r.origin ? r : { ...r, origin };
      allRawResults = [
        ...indexManagerResults.map(r => tagOrigin(r, 'indexer')),
        ...easynewsResults.map(r => tagOrigin(r, 'easynews')),
      ];
      console.log('');
      console.log('═══ Results Processing ' + '═'.repeat(40));
      console.log(`📊 Found ${allRawResults.length} total results (indexer: ${indexManagerResults.length}, easynews: ${easynewsResults.length})`);
    }

    // === STEP 3: DEDUP + CONTENT-DEPENDENT PRE-FILTERING (cacheable) ===
    const { results: rawResults, deprioritizedPacks } = deduplicateAndPreFilter(allRawResults, titleInfo.hasRemake, titleInfo.episodeName, titleInfo.year, titleInfo.titleYear);

    // === STEP 4: FILTER, SORT, HEALTH CHECK, BUILD (user-preference-dependent) ===
    const now = Date.now();
    const healthMap = new Map<string, any>();
    const { streams, fallbackGroupId, fallbackCandidates } = await processFromRaw(
      rawResults, deprioritizedPacks, healthMap,
      { type, season, episode, episodesInSeason: titleInfo.episodesInSeason, episodeAired: titleInfo.episodeAired, now, runtime: titleInfo.runtime, shortCircuited }
    );

    // Cache raw results + deprioritized packs + health map (filters/sorts reapply on cache hits).
    // Short-circuited library-only results bypass the cache: library state can change between
    // searches, and the user explicitly chose live-scan-per-search behavior.
    const skipEmptyCache = config.searchConfig?.cacheEmptyResults === false && rawResults.length === 0;
    if (config.cacheEnabled && config.cacheTTL > 0 && !skipEmptyCache && !shortCircuited) {
      cache.set(cacheKey, {
        rawResults,
        deprioritizedPacks,
        healthMap: Object.fromEntries(healthMap),
        _meta: { type, season, episode, episodesInSeason: titleInfo.episodesInSeason, episodeAired: titleInfo.episodeAired, runtime: titleInfo.runtime },
      }, config.cacheTTL);
    } else if (skipEmptyCache && config.cacheEnabled && config.cacheTTL > 0) {
      console.log(`⏭️  Skipping cache write — 0 results for ${type} ${imdbId}`);
    }

    // Create fallback group
    if (fallbackGroupId && fallbackCandidates) {
      createFallbackGroup(fallbackGroupId, fallbackCandidates, type, season?.toString(), episode?.toString(), titleInfo.episodesInSeason);
    }

    triggerAutoResolve(fallbackCandidates, titleInfo.episodesInSeason, titleInfo.episodeAired);

    return { streams };
  } catch (error) {
    console.error('❌ Stream handler error:', error);
    return { streams: [] };
  }
});

export { manifest as addonManifest };
export default builder.getInterface();

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
import { config } from '../config/index.js';
import { createFallbackGroup, clearFallbackGroups, clearTimeoutEntries } from '../nzbdav/index.js';
import { resolveTitle } from './titleResolver.js';
import { indexManagerSearch, easynewsSearch } from './searchOrchestrator.js';
import { deduplicateAndPreFilter, applyUserFilters } from './resultProcessor.js';
import { coordinateHealthChecks, autoMarkRemainingResults, autoQueueToNzbdav } from './healthCheckCoordinator.js';
import { buildStreams } from './streamBuilder.js';
import { isDeadNzbByUrl } from '../nzbdav/streamCache.js';
import { requestContext } from '../requestContext.js';
import { parseAnimeId, resolveAnimeId } from '../anime/animeIdResolver.js';
import { isDatabaseLoaded } from '../anime/animeDatabase.js';

// Create cache for search results
// Use stdTTL: 0 (no expiry) and manage TTL per-entry via cache.set() so runtime changes take effect
const cache = new NodeCache({ stdTTL: 0 });

export function clearSearchCache(): void {
  cache.flushAll();
  clearFallbackGroups();
  clearTimeoutEntries();
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

    // Build cache key based on index manager mode
    const easynewsSuffix = config.easynewsEnabled ? ':en' : '';
    let cacheKey: string;
    if (config.indexManager === 'prowlarr' || config.indexManager === 'nzbhydra') {
      const syncedEnabled = (config.syncedIndexers || []).filter(i => i.enabledForSearch);
      const syncedFingerprint = syncedEnabled
        .map(i => `${i.id}:${type === 'movie' ? i.movieSearchMethod : i.tvSearchMethod}`)
        .join(',');
      cacheKey = `stream:${type}:${id}:${config.indexManager}:${syncedFingerprint}${config.searchConfig?.includeSeasonPacks ? ':packs' : ''}${easynewsSuffix}`;
    } else {
      const enabledIndexers = config.indexers.filter(i => i.enabled);
      const methodsFingerprint = enabledIndexers
        .map(i => `${i.name}:${type === 'movie' ? (i.movieSearchMethod || ['imdb']).join('+') : (i.tvSearchMethod || ['imdb']).join('+')}`)
        .join(',');
      cacheKey = `stream:${type}:${id}:${methodsFingerprint}${config.searchConfig?.includeSeasonPacks ? ':packs' : ''}${easynewsSuffix}`;
    }

    // === SHARED: Filter dead NZBs from raw results ===
    const filterDeadFromRaw = (results: any[]) => {
      if (!config.filterDeadNzbs) return results;
      const SELF_URL = `http://localhost:${process.env.PORT || 1337}`;
      const manifestKey = requestContext.getStore()?.manifestKey || '';
      const before = results.length;
      const filtered = results.filter(r => {
        if (r.easynewsMeta) {
          const meta = r.easynewsMeta;
          const nzbParams = new URLSearchParams({ hash: meta.hash, filename: meta.filename, ext: meta.ext });
          if (meta.sig) nzbParams.set('sig', meta.sig);
          return !isDeadNzbByUrl(`${SELF_URL}/${manifestKey}/easynews/nzb?${nzbParams.toString()}`);
        }
        return !isDeadNzbByUrl(r.link);
      });
      if (filtered.length < before) {
        console.log(`🚫 Filtered ${before - filtered.length} dead NZB(s) from results (${filtered.length} remaining)`);
      }
      return filtered;
    };

    // === SHARED: Process from raw results → streams (filter, sort, health check, build) ===
    const processFromRaw = async (rawResults: any[], deprioritizedPacks: any[], healthMap: Map<string, any>, titleMeta: { type: string; season?: number; episode?: number; episodesInSeason?: number; now: number; runtime?: number }) => {
      // Filter dead NZBs
      let allResults = filterDeadFromRaw(rawResults);

      // Apply current user filter/sort preferences (deprioritized packs appended after sort)
      allResults = applyUserFilters(allResults, titleMeta.type, titleMeta.now, titleMeta.runtime, deprioritizedPacks);

      // Health checks — pass pre-existing health data so the coordinator skips
      // already-checked results and smart mode counts them toward its threshold
      const { healthResults: newHealth, filteredResults } = await coordinateHealthChecks({
        allResults,
        type: titleMeta.type,
        season: titleMeta.season,
        episode: titleMeta.episode,
        episodesInSeason: titleMeta.episodesInSeason,
        preExistingHealth: healthMap.size > 0 ? healthMap : undefined,
      });
      for (const [key, val] of newHealth) healthMap.set(key, val);
      allResults = filteredResults;

      // Auto-mark EasyNews and Zyclops results as verified
      autoMarkRemainingResults(allResults, healthMap);

      // Auto-queue to NZBDav if enabled
      autoQueueToNzbdav(allResults, healthMap, titleMeta.type, titleMeta.season, titleMeta.episode, titleMeta.episodesInSeason);

      // Build streams
      const { streams, fallbackGroupId, fallbackCandidates } = buildStreams({
        allResults,
        healthResults: healthMap,
        type: titleMeta.type,
        season: titleMeta.season,
        episode: titleMeta.episode,
        episodesInSeason: titleMeta.episodesInSeason,
        now: titleMeta.now,
        runtime: titleMeta.runtime,
      });

      return { streams, fallbackGroupId, fallbackCandidates, allResults };
    };

    // Check cache first (cacheTTL of 0 means disabled)
    if (config.cacheEnabled && config.cacheTTL > 0) {
      const cached = cache.get<{ rawResults: any[]; deprioritizedPacks: any[]; healthMap: Record<string, any>; _meta: { type: string; season?: number; episode?: number; episodesInSeason?: number; runtime?: number } }>(cacheKey);
      if (cached) {
        console.log(`💾 Cache hit for ${type} ${imdbId}`);
        const now = Date.now();

        // Re-apply filters, sort, health checks, and build streams with current settings
        const healthMap = new Map<string, any>(Object.entries(cached.healthMap || {}));
        const { streams, fallbackGroupId, fallbackCandidates } = await processFromRaw(
          cached.rawResults, cached.deprioritizedPacks || [], healthMap,
          { type, season, episode, episodesInSeason: cached._meta.episodesInSeason, now, runtime: cached._meta.runtime }
        );

        // Update cache with new health results
        cache.set(cacheKey, {
          ...cached,
          healthMap: Object.fromEntries(healthMap),
        }, config.cacheTTL);

        // Create fallback group from current filtered results
        if (fallbackGroupId && fallbackCandidates) {
          createFallbackGroup(fallbackGroupId, fallbackCandidates, type, season?.toString(), episode?.toString());
        }

        return { streams };
      }
    }

    console.log(`\n🔍 Searching for ${type} ${imdbId}${season !== undefined ? ` S${season}E${episode}` : ''} [${config.indexManager}]`);

    // === STEP 1: TITLE RESOLUTION ===
    let titleInfo;
    if (animeResolved && !animeResolved.imdbId && animeResolved.title) {
      titleInfo = {
        title: animeResolved.title,
        cinemetaTitle: animeResolved.title,
        year: animeResolved.year,
        country: 'Japan',
        genres: ['Animation'],
        isAnime: true,
        episodesInSeason: undefined,
        additionalTitles: undefined,
        runtime: undefined,
        episodeName: undefined,
        hasRemake: undefined,
        titleYear: undefined,
      };
    } else {
      titleInfo = await resolveTitle(type, imdbId, season, episode);
      if (animeId) {
        titleInfo.isAnime = true;
      }
    }

    // === STEP 2: PARALLEL SEARCH ===
    const searchCtx = {
      type, imdbId,
      title: titleInfo.title,
      year: titleInfo.year,
      country: titleInfo.country,
      season, episode,
      episodesInSeason: titleInfo.episodesInSeason,
      additionalTitles: titleInfo.additionalTitles,
      isAnime: titleInfo.isAnime,
      titleYear: titleInfo.titleYear,
      animeResolvedIds: animeResolved ? { tmdbId: animeResolved.tmdbId, tvdbId: animeResolved.tvdbId } : undefined,
    };

    const [indexManagerResults, easynewsResults] = await Promise.all([
      indexManagerSearch(searchCtx),
      easynewsSearch(searchCtx),
    ]);
    const allRawResults = [...indexManagerResults, ...easynewsResults];
    console.log(`📊 Found ${allRawResults.length} total results (indexer: ${indexManagerResults.length}, easynews: ${easynewsResults.length})`);

    // === STEP 3: DEDUP + CONTENT-DEPENDENT PRE-FILTERING (cacheable) ===
    const { results: rawResults, deprioritizedPacks } = deduplicateAndPreFilter(allRawResults, titleInfo.hasRemake, titleInfo.episodeName, titleInfo.year, titleInfo.titleYear);

    // === STEP 4: FILTER, SORT, HEALTH CHECK, BUILD (user-preference-dependent) ===
    const now = Date.now();
    const healthMap = new Map<string, any>();
    const { streams, fallbackGroupId, fallbackCandidates } = await processFromRaw(
      rawResults, deprioritizedPacks, healthMap,
      { type, season, episode, episodesInSeason: titleInfo.episodesInSeason, now, runtime: titleInfo.runtime }
    );

    // Cache raw results + deprioritized packs + health map (filters/sorts reapply on cache hits)
    if (config.cacheEnabled && config.cacheTTL > 0) {
      cache.set(cacheKey, {
        rawResults,
        deprioritizedPacks,
        healthMap: Object.fromEntries(healthMap),
        _meta: { type, season, episode, episodesInSeason: titleInfo.episodesInSeason, runtime: titleInfo.runtime },
      }, config.cacheTTL);
    }

    // Create fallback group
    if (fallbackGroupId && fallbackCandidates) {
      createFallbackGroup(fallbackGroupId, fallbackCandidates, type, season?.toString(), episode?.toString());
    }

    return { streams };
  } catch (error) {
    console.error('❌ Stream handler error:', error);
    return { streams: [] };
  }
});

export { manifest as addonManifest };
export default builder.getInterface();

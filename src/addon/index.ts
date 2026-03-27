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
import type { Stream } from '../types.js';
import { createFallbackGroup, clearFallbackGroups, clearTimeoutEntries, type FallbackCandidate } from '../nzbdav/index.js';
import { resolveTitle } from './titleResolver.js';
import { indexManagerSearch, easynewsSearch } from './searchOrchestrator.js';
import { processResults } from './resultProcessor.js';
import { coordinateHealthChecks, autoMarkRemainingResults, autoQueueToNzbdav } from './healthCheckCoordinator.js';
import { buildStreams } from './streamBuilder.js';

// Create cache for search results
// Use stdTTL: 0 (no expiry) and manage TTL per-entry via cache.set() so runtime changes take effect
const cache = new NodeCache({ stdTTL: 0 });

export function clearSearchCache(): void {
  cache.flushAll();
  clearFallbackGroups();
  clearTimeoutEntries();
}

// Define addon manifest - tells Stremio what we support
const BASE_URL = process.env.BASE_URL || 'http://localhost:1337';
const manifest = {
  id: 'com.usenetultimate.addon',
  version: APP_VERSION,
  name: 'Usenet Ultimate',
  description: 'Search Usenet indexers and EasyNews for media content. Supports Newznab, Prowlarr, and NZBHydra with NZB health checking, quality-based sorting, and direct streaming via NZBDav or EasyNews.',
  logo: `${BASE_URL}/pwa-512x512.png`,
  resources: ['stream'],           // We only provide streams
  types: ['movie', 'series'],      // Support movies and TV shows
  catalogs: [],                    // No catalogs (don't show in discover)
  idPrefixes: ['tt'],              // Only handle IMDB IDs (tt1234567)
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

    // Parse the ID
    // Movies: tt1234567
    // Series: tt1234567:1:1 (imdbId:season:episode)
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : undefined;
    const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

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

    // Check cache first (cacheTTL of 0 means disabled)
    if (config.cacheEnabled && config.cacheTTL > 0) {
      const cached = cache.get<{ streams: Stream[]; _fallback?: { id: string; candidates: FallbackCandidate[]; type: string; season?: string; episode?: string } }>(cacheKey);
      if (cached) {
        console.log(`💾 Cache hit for ${type} ${imdbId}`);
        // Re-create the fallback group so cached stream URLs have a live fallback target
        // (fallback groups expire after 30 min but search cache can last hours)
        if (cached._fallback) {
          const fb = cached._fallback;
          createFallbackGroup(fb.id, fb.candidates, fb.type, fb.season, fb.episode);
        }
        const { _fallback, ...response } = cached;
        return response;
      }
    }

    console.log(`\n🔍 Searching for ${type} ${imdbId}${season !== undefined ? ` S${season}E${episode}` : ''} [${config.indexManager}]`);

    // === STEP 1: TITLE RESOLUTION ===
    const titleInfo = await resolveTitle(type, imdbId, season, episode);

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
      useTextForAnime: titleInfo.useTextForAnime,
      episodeName: titleInfo.episodeName,
      hasRemake: titleInfo.hasRemake,
    };

    const [indexManagerResults, easynewsResults] = await Promise.all([
      indexManagerSearch(searchCtx),
      easynewsSearch(searchCtx),
    ]);
    const allRawResults = [...indexManagerResults, ...easynewsResults];
    console.log(`📊 Found ${allRawResults.length} total results (indexer: ${indexManagerResults.length}, easynews: ${easynewsResults.length})`);

    // === STEP 3: DEDUP, FILTER, SORT ===
    const now = Date.now();
    let allResults = processResults(allRawResults, type, now, titleInfo.runtime);

    // === STEP 4: HEALTH CHECKS ===
    const { healthResults, filteredResults } = await coordinateHealthChecks({
      allResults,
      type,
      season,
      episode,
      episodesInSeason: titleInfo.episodesInSeason,
    });
    allResults = filteredResults;

    // Always auto-mark EasyNews and Zyclops results as verified (even without NNTP health checks)
    autoMarkRemainingResults(allResults, healthResults);

    // Auto-queue to NZBDav if enabled
    autoQueueToNzbdav(allResults, healthResults, type, season, episode, titleInfo.episodesInSeason);

    // === STEP 5: BUILD STREMIO STREAMS ===
    const { streams, fallbackGroupId, fallbackCandidates } = buildStreams({
      allResults,
      healthResults,
      type,
      season,
      episode,
      episodesInSeason: titleInfo.episodesInSeason,
      now,
      runtime: titleInfo.runtime,
    });

    const response = { streams };

    // Cache the results (cacheTTL of 0 means disabled, otherwise use live TTL value)
    // Also cache fallback metadata so we can re-create the fallback group on cache hits
    if (config.cacheEnabled && config.cacheTTL > 0) {
      cache.set(cacheKey, {
        ...response,
        _fallback: fallbackGroupId ? { id: fallbackGroupId, candidates: fallbackCandidates!, type, season: season?.toString(), episode: episode?.toString() } : undefined,
      }, config.cacheTTL);
    }

    return response;
  } catch (error) {
    console.error('❌ Stream handler error:', error);
    return { streams: [] };
  }
});

export default builder.getInterface();

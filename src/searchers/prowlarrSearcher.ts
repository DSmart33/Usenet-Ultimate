/**
 * Prowlarr Searcher
 *
 * Uses two Prowlarr API endpoints depending on search method:
 *
 * Text searches → GET /api/v1/search (aggregate endpoint)
 *   Accepts: query, type, indexerIds[], categories[], limit, offset
 *   Returns: JSON array of results from all specified indexers
 *   One request covers all text-method indexers at once.
 *
 * ID-based searches → GET /api/v1/indexer/{id}/newznab (per-indexer Newznab endpoint)
 *   Accepts: t (string), imdbid (string), tmdbid (int), tvdbid (int),
 *            tvmazeid (int), season (int), ep (string), cat (string)
 *   Returns: Newznab XML (RSS with newznab:attr extensions)
 *   One request per indexer, parallelised with Promise.all().
 *
 * Indexers are grouped by their configured search method (imdb/tmdb/tvdb/text).
 * Each group uses the appropriate endpoint and parameters.
 */

import axios from 'axios';
import type { SyncedIndexer, NZBSearchResult, ProwlarrSearchResult } from '../types.js';
import { parseNewznabXmlWithMeta } from '../parsers/newznabClient.js';
import { isTextSearchMatch, stripDiacritics } from '../parsers/titleMatching.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';

// Params for the per-indexer Newznab endpoint — typed to match Prowlarr's API spec
interface NewznabParams {
  t: string;
  cat: string;
  q?: string;
  imdbid?: string;
  tmdbid?: number;
  tvdbid?: number;
  tvmazeid?: number;
  season?: number;
  ep?: string;
}

export class ProwlarrSearcher {
  constructor(
    private url: string,
    private apiKey: string,
    private indexers: SyncedIndexer[],
  ) {}

  async searchMovie(
    imdbId: string,
    title: string,
    year?: string,
    country?: string,
    resolvedIds?: Map<string, { idParam: string; idValue: string } | null>,
    additionalTitles?: string[],
    titleYear?: string,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('movie');
    const searches: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const textFallbackIds: string[] = [];
    const idSearchedIndexerIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        // Aggregate text search — one request for all text-method indexers
        const query = stripDiacritics(year ? `${title} ${year}` : title);
        console.log(`🔍 Prowlarr movie text search for ${indexerIds.length} indexer(s): "${query}"`);
        searches.push(
          this.doAggregateSearch(indexerIds, 'search', query, ['2000']).then(results => {
            const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
            console.log(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
            if (results.length !== filtered.length) {
              results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
                .forEach(r => console.log(`      ✂️  ${r.title}`));
            }
            return filtered;
          }),
        );
      } else {
        // ID-based search — per-indexer Newznab endpoint
        for (const indexerId of indexerIds) {
          const indexer = this.indexers.find(i => i.id === indexerId);
          const indexerName = indexer?.name || 'Unknown';
          const params: NewznabParams = { t: 'movie', cat: '2000' };

          if (method === 'imdb') {
            params.imdbid = imdbId.replace('tt', '');
          } else if (method === 'tmdb' && resolvedIds?.get('tmdb')) {
            params.tmdbid = parseInt(resolvedIds.get('tmdb')!.idValue, 10);
          } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
            params.tvdbid = parseInt(resolvedIds.get('tvdb')!.idValue, 10);
          } else {
            // ID resolution failed — defer to text fallback
            console.log(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}), deferring to text fallback`);
            textFallbackIds.push(indexerId);
            continue;
          }

          console.log(`🔍 Prowlarr movie ${method} search for "${indexerName}" (id=${indexerId})`);
          searches.push(this.doNewznabSearch(indexerId, indexerName, params));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    // Text fallback for indexers whose external ID could not be resolved
    if (textFallbackIds.length > 0 && title) {
      const query = stripDiacritics(year ? `${title} ${year}` : title);
      console.log(`🔄 ID resolution failed — text fallback for ${textFallbackIds.length} indexer(s): "${query}"`);
      searches.push(
        this.doAggregateSearch(textFallbackIds, 'search', query, ['2000']).then(results => {
          const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
          if (results.length !== filtered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          return filtered;
        }),
      );
    }

    const resultSets = await Promise.all(searches);
    let allResults = resultSets.flat();

    // Zero-result text fallback: if ID-based searches returned nothing, retry with text
    if (allResults.length === 0 && idSearchedIndexerIds.length > 0 && title) {
      const query = stripDiacritics(year ? `${title} ${year}` : title);
      console.log(`🔄 ID search returned 0 — falling back to text for ${idSearchedIndexerIds.length} indexer(s): "${query}"`);
      const fallbackResults = await this.doAggregateSearch(idSearchedIndexerIds, 'search', query, ['2000']);
      const filtered = fallbackResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
      console.log(`   🎯 Text fallback filter: ${fallbackResults.length} → ${filtered.length}`);
      if (fallbackResults.length !== filtered.length) {
        fallbackResults.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }
      allResults = filtered;
    }

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length) {
      const allIndexerIds = [...new Set([...idSearchedIndexerIds, ...textFallbackIds])];
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          const altQuery = stripDiacritics(year ? `${altTitle} ${year}` : altTitle);
          console.log(`🔄 Retrying with alternative title for ${allIndexerIds.length} indexer(s): "${altQuery}"`);
          const altResults = await this.doAggregateSearch(allIndexerIds, 'search', altQuery, ['2000']);
          const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          console.log(`   🎯 Alt-title filter: ${altResults.length} → ${altFiltered.length}`);
          if (altResults.length !== altFiltered.length) {
            altResults.filter(r => !isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
              .forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (altFiltered.length > 0) {
            allResults = altFiltered;
            break;
          }
        }
      }
    }

    return allResults;
  }

  async searchTVShow(
    imdbId: string,
    title: string,
    season: number,
    episode: number,
    episodesInSeason?: number,
    year?: string,
    country?: string,
    resolvedIds?: Map<string, { idParam: string; idValue: string } | null>,
    additionalTitles?: string[],
    titleYear?: string,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('tv');
    const searches: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    // Track which indexer IDs used ID-based search (for zero-result text fallback)
    const idSearchedIndexerIds: string[] = [];
    const textFallbackIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        // Aggregate text search with SxxExx format
        const query = stripDiacritics(`${title} S${s}E${e}`);
        console.log(`🔍 Prowlarr TV text search for ${indexerIds.length} indexer(s): "${query}"`);
        searches.push(
          this.doAggregateSearch(indexerIds, 'search', query, ['5000']).then(async results => {
            const episodeFiltered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
            console.log(`   🎯 Title filter: ${results.length} → ${episodeFiltered.length}`);
            if (results.length !== episodeFiltered.length) {
              results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
                .forEach(r => console.log(`      ✂️  ${r.title}`));
            }

            // Check for season packs if configured
            if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
              const spPagination = config.searchConfig?.seasonPackPagination !== false;
              const spPages = config.searchConfig?.seasonPackAdditionalPages;
              const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
              const packQuery = stripDiacritics(`${title} S${s}`);
              const packResults = await this.doAggregateSearch(indexerIds, 'search', packQuery, ['5000'], spOverride);
              const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
              const packs = packResults
                .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
                .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
              if (packResults.length !== packs.length) {
                const removedPacks = packResults.filter(r =>
                  !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear)
                );
                console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
                removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
              }
              if (packs.length > 0) {
                console.log(`   📦 Found ${packs.length} season packs`);
              }
              episodeFiltered.push(...packs);
            }

            return episodeFiltered;
          }),
        );
      } else {
        // ID-based search — per-indexer Newznab endpoint
        for (const indexerId of indexerIds) {
          const indexer = this.indexers.find(i => i.id === indexerId);
          const indexerName = indexer?.name || 'Unknown';
          const params: NewznabParams = {
            t: 'tvsearch',
            cat: '5000',
            season,
            ep: episode.toString(),
          };

          if (method === 'imdb') {
            params.imdbid = imdbId.replace('tt', '');
          } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
            params.tvdbid = parseInt(resolvedIds.get('tvdb')!.idValue, 10);
          } else if (method === 'tvmaze' && resolvedIds?.get('tvmaze')) {
            params.tvmazeid = parseInt(resolvedIds.get('tvmaze')!.idValue, 10);
          } else {
            // ID resolution failed — defer to text fallback
            console.log(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}), deferring to text fallback`);
            textFallbackIds.push(indexerId);
            continue;
          }

          console.log(`🔍 Prowlarr TV ${method} search S${season}E${episode} for "${indexerName}" (id=${indexerId})`);
          searches.push(this.doNewznabSearch(indexerId, indexerName, params));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    // Text fallback for indexers whose external ID could not be resolved
    if (textFallbackIds.length > 0 && title) {
      const query = stripDiacritics(`${title} S${s}E${e}`);
      console.log(`🔄 ID resolution failed — text fallback for ${textFallbackIds.length} indexer(s): "${query}"`);
      searches.push(
        this.doAggregateSearch(textFallbackIds, 'search', query, ['5000']).then(async results => {
          const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
          if (results.length !== filtered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
            const spPagination = config.searchConfig?.seasonPackPagination !== false;
            const spPages = config.searchConfig?.seasonPackAdditionalPages;
            const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
            const packQuery = stripDiacritics(`${title} S${s}`);
            const packResults = await this.doAggregateSearch(textFallbackIds, 'search', packQuery, ['5000'], spOverride);
            const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
            const packs = packResults
              .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
            if (packResults.length !== packs.length) {
              const removedPacks = packResults.filter(r =>
                !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear)
              );
              console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
              removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
            }
            if (packs.length > 0) console.log(`   📦 Found ${packs.length} season packs (text fallback)`);
            filtered.push(...packs);
          }
          return filtered;
        }),
      );
    }

    const resultSets = await Promise.all(searches);
    let allResults = resultSets.flat();

    // Season packs for ID-based indexers (text-search indexers already include packs inline)
    if (config.searchConfig?.includeSeasonPacks && episodesInSeason && idSearchedIndexerIds.length > 0 && title) {
      const spPagination = config.searchConfig?.seasonPackPagination !== false;
      const spPages = config.searchConfig?.seasonPackAdditionalPages;
      const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
      const packQuery = stripDiacritics(`${title} S${s}`);
      console.log(`📦 Prowlarr season pack search for ${idSearchedIndexerIds.length} ID-based indexer(s): "${packQuery}"`);
      const packResults = await this.doAggregateSearch(idSearchedIndexerIds, 'search', packQuery, ['5000'], spOverride);
      const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
      const packs = packResults
        .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
        .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
      if (packResults.length !== packs.length) {
        const removedPacks = packResults.filter(r =>
          !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear)
        );
        console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
        removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
      }
      if (packs.length > 0) {
        console.log(`   📦 Found ${packs.length} season packs (ID-based indexers)`);
      }
      allResults.push(...packs);
    }

    // Text fallback: if ID-based searches returned 0 results, retry those indexers with text
    if (allResults.length === 0 && idSearchedIndexerIds.length > 0 && title) {
      const query = stripDiacritics(`${title} S${s}E${e}`);
      console.log(`🔄 ID search returned 0 — falling back to text for ${idSearchedIndexerIds.length} indexer(s): "${query}"`);
      const fallbackResults = await this.doAggregateSearch(idSearchedIndexerIds, 'search', query, ['5000']);
      const filtered = fallbackResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
      console.log(`   🎯 Text fallback filter: ${fallbackResults.length} → ${filtered.length}`);
      if (fallbackResults.length !== filtered.length) {
        fallbackResults.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }

      // Also check for season packs on text fallback
      if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
        const spPagination = config.searchConfig?.seasonPackPagination !== false;
        const spPages = config.searchConfig?.seasonPackAdditionalPages;
        const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
        const packQuery = stripDiacritics(`${title} S${s}`);
        const packResults = await this.doAggregateSearch(idSearchedIndexerIds, 'search', packQuery, ['5000'], spOverride);
        const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
        const packs = packResults
          .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
          .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
        if (packResults.length !== packs.length) {
          const removedPacks = packResults.filter(r =>
            !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear)
          );
          console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
          removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        if (packs.length > 0) {
          console.log(`   📦 Found ${packs.length} season packs (fallback)`);
        }
        filtered.push(...packs);
      }

      allResults = filtered;
    }

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length) {
      const allIndexerIds = [...new Set([...idSearchedIndexerIds, ...textFallbackIds])];
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          const altQuery = stripDiacritics(`${altTitle} S${s}E${e}`);
          console.log(`🔄 Retrying with alternative title for ${allIndexerIds.length} indexer(s): "${altQuery}"`);
          const altResults = await this.doAggregateSearch(allIndexerIds, 'search', altQuery, ['5000']);
          const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          console.log(`   🎯 Alt-title filter: ${altResults.length} → ${altFiltered.length}`);
          if (altResults.length !== altFiltered.length) {
            altResults.filter(r => !isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
              .forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (altFiltered.length > 0) {
            // Also check for season packs with the alternative title
            if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
              const spPagination = config.searchConfig?.seasonPackPagination !== false;
              const spPages = config.searchConfig?.seasonPackAdditionalPages;
              const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
              const packQuery = stripDiacritics(`${altTitle} S${s}`);
              const packResults = await this.doAggregateSearch(allIndexerIds, 'search', packQuery, ['5000'], spOverride);
              const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
              const packs = packResults
                .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
                .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
              if (packs.length > 0) {
                console.log(`   📦 Found ${packs.length} season packs (alt-title)`);
              }
              altFiltered.push(...packs);
            }
            allResults = altFiltered;
            break;
          }
        }
      }
    }

    return allResults;
  }

  /**
   * Aggregate text search via /api/v1/search — returns JSON.
   * One request covers multiple indexers.
   */
  private async doAggregateSearch(
    indexerIds: string[],
    type: string,
    query: string,
    categories: string[],
    paginationOverride?: { enabled: boolean; additionalPages: number },
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    try {
      const params = new URLSearchParams();
      for (const id of indexerIds) params.append('indexerIds', id);
      for (const cat of categories) params.append('categories', cat);
      params.set('type', type);
      params.set('query', query);
      params.set('limit', '1000');
      params.set('offset', '0');

      const searchUrl = `${this.url}/api/v1/search?${params.toString()}`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      console.log(`📤 Prowlarr aggregate: /api/v1/search`);
      console.log(`   type=${type} query="${query}" indexerIds=[${indexerIds.join(',')}] categories=[${categories.join(',')}]`);

      const response = await axios.get(searchUrl, {
        headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
        timeout: 30000,
      });

      if (!Array.isArray(response.data)) {
        console.log(`   ⚠️  Non-array response:`, typeof response.data === 'string' ? response.data.substring(0, 200) : typeof response.data);
        return [];
      }

      const results: (NZBSearchResult & { indexerName: string })[] = response.data.map((item: ProwlarrSearchResult) => ({
        title: item.title || '',
        link: item.downloadUrl || '',
        size: item.size || 0,
        pubDate: item.publishDate || '',
        category: item.categories?.[0]?.name || '',
        attributes: {},
        indexerName: item.indexer || 'Unknown',
      }));

      console.log(`   📦 Returned ${results.length} results`);
      if (results.length > 0) {
        console.log(`   📋 First: "${results[0].title}" from ${results[0].indexerName}`);
      }

      // Pagination: fetch additional pages if enabled
      const paginationEnabled = paginationOverride?.enabled ?? this.getGlobalPagination();
      const extraPages = paginationOverride?.additionalPages ?? this.getGlobalAdditionalPages();
      if (paginationEnabled && results.length >= 1000) {
        for (let page = 2; page <= extraPages + 1; page++) {
          const offset = (page - 1) * 1000;
          console.log(`   📄 Fetching page ${page} (offset ${offset})...`);
          try {
            const pageParams = new URLSearchParams(params);
            pageParams.set('offset', offset.toString());
            const pageUrl = `${this.url}/api/v1/search?${pageParams.toString()}`;
            const pageResp = await axios.get(pageUrl, {
              headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
              timeout: 30000,
            });
            if (!Array.isArray(pageResp.data) || pageResp.data.length === 0) break;
            const pageResults = pageResp.data.map((item: ProwlarrSearchResult) => ({
              title: item.title || '',
              link: item.downloadUrl || '',
              size: item.size || 0,
              pubDate: item.publishDate || '',
              category: item.categories?.[0]?.name || '',
              attributes: {},
              indexerName: item.indexer || 'Unknown',
            }));
            results.push(...pageResults);
            console.log(`   📄 Page ${page}: +${pageResults.length} (total so far: ${results.length})`);
            if (pageResp.data.length < 1000) break; // Last page
          } catch (pageError: any) {
            console.warn(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      console.error(`❌ Prowlarr aggregate search error:`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, typeof error.response.data === 'string' ? error.response.data.substring(0, 200) : JSON.stringify(error.response.data).substring(0, 200));
      } else {
        console.error(`   ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Per-indexer Newznab search via /api/v1/indexer/{id}/newznab — returns XML.
   * Supports imdbid (string), tmdbid (int), tvdbid (int), tvmazeid (int),
   * season (int), ep (string).
   */
  private async doNewznabSearch(
    indexerId: string,
    indexerName: string,
    params: NewznabParams,
    paginationOverride?: { enabled: boolean; additionalPages: number },
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    try {
      const searchUrl = `${this.url}/api/v1/indexer/${indexerId}/newznab`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      console.log(`📤 Prowlarr newznab: /api/v1/indexer/${indexerId}/newznab`);
      console.log(`   Params:`, JSON.stringify(params));

      const response = await axios.get(searchUrl, {
        params,
        headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
        timeout: 30000,
      });

      const rawData = typeof response.data === 'string' ? response.data : '';

      // Check for Newznab error responses (e.g. <error code="..." description="..."/>)
      if (rawData.includes('<error')) {
        const errorMatch = rawData.match(/<error\s+code="(\d+)"\s+description="([^"]+)"/);
        if (errorMatch) {
          console.error(`   ⚠️  Newznab error: code=${errorMatch[1]} "${errorMatch[2]}"`);
        } else {
          console.error(`   ⚠️  Newznab error response:`, rawData.substring(0, 300));
        }
        return [];
      }

      const { results, total } = await parseNewznabXmlWithMeta(rawData);
      console.log(`   📦 ${indexerName} returned ${results.length} results${total ? ` (total: ${total})` : ''}`);
      if (results.length > 0) {
        console.log(`   📋 First: "${results[0].title}" (${results[0].size} bytes)`);
      } else {
        // Log raw response snippet for debugging empty results
        console.log(`   📭 Raw response (first 500 chars):`, rawData.substring(0, 500));
      }

      // Pagination: fetch additional pages if enabled and more results available
      const indexer = this.indexers.find(i => i.id === indexerId);
      const paginationEnabled = paginationOverride?.enabled ?? (indexer?.pagination === true);
      const extraPages = paginationOverride?.additionalPages ?? (indexer?.additionalPages ?? 3);
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;
        for (let page = 2; page <= extraPages + 1 && currentOffset < total; page++) {
          console.log(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResp = await axios.get(searchUrl, {
              params: { ...params, offset: currentOffset },
              headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
              timeout: 30000,
            });
            const pageData = await parseNewznabXmlWithMeta(typeof pageResp.data === 'string' ? pageResp.data : '');
            if (pageData.results.length === 0) break;
            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            console.log(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            console.warn(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results.map(r => ({ ...r, indexerName }));
    } catch (error: any) {
      console.error(`❌ Prowlarr newznab search error (${indexerName}):`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, typeof error.response.data === 'string' ? error.response.data.substring(0, 200) : JSON.stringify(error.response.data).substring(0, 200));
      } else {
        console.error(`   ${error.message}`);
      }
      return [];
    }
  }

  /** Check if any synced indexer has pagination enabled (used for aggregate searches) */
  private getGlobalPagination(): boolean {
    return this.indexers.some(i => i.enabledForSearch && i.pagination === true);
  }

  /** Get the max additional pages across all enabled synced indexers */
  private getGlobalAdditionalPages(): number {
    const pages = this.indexers
      .filter(i => i.enabledForSearch && i.pagination === true)
      .map(i => i.additionalPages ?? 3);
    return pages.length > 0 ? Math.max(...pages) : 3;
  }

  private groupByMethod(type: 'movie' | 'tv'): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const indexer of this.indexers.filter(i => i.enabledForSearch)) {
      const methods = type === 'movie' ? indexer.movieSearchMethod : indexer.tvSearchMethod;
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const method of methodArr) {
        if (!groups.has(method)) groups.set(method, []);
        if (!groups.get(method)!.includes(indexer.id)) groups.get(method)!.push(indexer.id);
      }
    }
    return groups;
  }
}


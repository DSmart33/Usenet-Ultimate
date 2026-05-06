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
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';
import { parseNewznabXmlWithMeta } from '../parsers/newznabClient.js';
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, buildSeriesPackPaginationAdditionalPages } from '../parsers/titleMatching.js';
import { slog, withSubBuffer } from '../parsers/searchLogger.js';
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
  private timedOut = false;

  constructor(
    private url: string,
    private apiKey: string,
    private indexers: SyncedIndexer[],
    private timeoutEnabled: boolean = true,
    private timeoutSeconds: number = DEFAULT_INDEXER_TIMEOUT_SECONDS,
  ) {}

  private getTimeoutMs(): number | undefined {
    if (!this.timeoutEnabled) return undefined;
    return this.timeoutSeconds * 1000;
  }

  private timeoutLabel(): string {
    return `[timeout=${this.timeoutEnabled ? `${this.timeoutSeconds}s` : 'disabled'}]`;
  }

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
    const idSearchedIndexerIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        const query = stripDiacritics(year ? `${title} ${year}` : title);
        searches.push(withSubBuffer(`movie text search × ${indexerIds.length} indexer(s)`, async () => {
          slog(`🔍 Query: "${query}"`);
          const results = await this.doAggregateSearch(indexerIds, 'search', query, ['2000']);
          const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          slog(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
          if (results.length !== filtered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          return filtered;
        }));
      } else {
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
            slog(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}) — skipping`);
            continue;
          }

          searches.push(withSubBuffer(`movie ${method} search "${indexerName}"`, () => this.doNewznabSearch(indexerId, indexerName, params, undefined, method)));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    const resultSets = await Promise.all(searches);
    let allResults = resultSets.flat();

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  Prowlarr: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut) {
      const allIndexerIds = [...new Set(idSearchedIndexerIds)];
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          const altQuery = stripDiacritics(year ? `${altTitle} ${year}` : altTitle);
          slog(`🔄 Retrying with alternative title for ${allIndexerIds.length} indexer(s): "${altQuery}"`);
          const altResults = await this.doAggregateSearch(allIndexerIds, 'search', altQuery, ['2000']);
          const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          slog(`   🎯 Alt-title filter: ${altResults.length} → ${altFiltered.length}`);
          if (altResults.length !== altFiltered.length) {
            altResults.filter(r => !isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
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

    const idSearchedIndexerIds: string[] = [];
    const textMethodIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        textMethodIds.push(...indexerIds);
        const query = stripDiacritics(`${title} S${s}E${e}`);
        searches.push(withSubBuffer(`TV text search × ${indexerIds.length} indexer(s)`, async () => {
          slog(`🔍 Query: "${query}"`);
          const results = await this.doAggregateSearch(indexerIds, 'search', query, ['5000']);
          const episodeFiltered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          slog(`   🎯 Title filter: ${results.length} → ${episodeFiltered.length}`);
          if (results.length !== episodeFiltered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          return episodeFiltered;
        }));
      } else {
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
            slog(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}) — skipping`);
            continue;
          }

          searches.push(withSubBuffer(`TV ${method} search S${season}E${episode} "${indexerName}"`, () => this.doNewznabSearch(indexerId, indexerName, params, undefined, method)));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    const packIndexerIds = [...new Set([...textMethodIds, ...idSearchedIndexerIds])];
    if (packIndexerIds.length > 0 && title) {
      if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
        const spPagination = config.searchConfig?.seasonPackPagination !== false;
        const spPages = config.searchConfig?.seasonPackAdditionalPages;
        const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
        const packQuery = stripDiacritics(`${title} S${s}`);
        searches.push(withSubBuffer(`Season pack: ${packQuery}`, async () => {
          const packResults = await this.doAggregateSearch(packIndexerIds, 'search', packQuery, ['5000'], spOverride);
          const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const packs = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (packResults.length !== packs.length) {
            const keptLinks = new Set(packs.map(p => p.link));
            const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
            slog(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
            removedPacks.forEach(r => slog(`      ✂️  ${r.title}`));
          }
          if (packs.length > 0) slog(`   📦 Found ${packs.length} season packs`);
          return packs;
        }));
      }

      const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
      if (season > 1 && includeMultiSeasonPacks) {
        const fanoutOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
        const fanoutQuery = stripDiacritics(`${title} S01`);
        searches.push(withSubBuffer(`Multi-season fanout: ${fanoutQuery}`, async () => {
          const fanoutResults = await this.doAggregateSearch(packIndexerIds, 'search', fanoutQuery, ['5000'], fanoutOverride);
          const fanoutMatched = fanoutResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
          if (fanoutResults.length !== fanoutPacks.length) {
            slog(`   📦 Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
          }
          if (fanoutPacks.length > 0) slog(`   📦 Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
          return fanoutPacks;
        }));
      }

      const seriesOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
      searches.push(withSubBuffer(`Series-pack keyword queries`, () => runSeriesPackQueries({
        searchFn: (q) => this.doAggregateSearch(packIndexerIds, 'search', q, ['5000'], seriesOverride),
        title, season, episodesInSeason,
        isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
        searchConfig: config.searchConfig,
        logPrefix: 'Prowlarr',
      })));
    }

    const resultSets = await Promise.all(searches);
    let allResults = resultSets.flat();

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  Prowlarr: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut) {
      const allIndexerIds = [...new Set(idSearchedIndexerIds)];
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          const altQuery = stripDiacritics(`${altTitle} S${s}E${e}`);
          slog(`🔄 Retrying with alternative title for ${allIndexerIds.length} indexer(s): "${altQuery}"`);
          const altResults = await this.doAggregateSearch(allIndexerIds, 'search', altQuery, ['5000']);
          const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          slog(`   🎯 Alt-title filter: ${altResults.length} → ${altFiltered.length}`);
          if (altResults.length !== altFiltered.length) {
            altResults.filter(r => !isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          if (altFiltered.length > 0) {
            // Also check for season packs with the alternative title
            if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
              const spPagination = config.searchConfig?.seasonPackPagination !== false;
              const spPages = config.searchConfig?.seasonPackAdditionalPages;
              const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
              const packQuery = stripDiacritics(`${altTitle} S${s}`);
              const packResults = await this.doAggregateSearch(allIndexerIds, 'search', packQuery, ['5000'], spOverride);
              const titleMatched = packResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
              const packs = tagSeasonPack(titleMatched, season, episodesInSeason);
              if (packs.length > 0) {
                slog(`   📦 Found ${packs.length} season packs (alt-title)`);
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
      params.set('limit', '100');
      params.set('offset', '0');

      const searchUrl = `${this.url}/api/v1/search?${params.toString()}`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      slog(`📤 Prowlarr aggregate: /api/v1/search`);
      slog(`   type=${type} query="${query}" indexerIds=[${indexerIds.join(',')}] categories=[${categories.join(',')}]`);

      const response = await axios.get(searchUrl, {
        headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
        timeout: this.getTimeoutMs(),
      });

      if (!Array.isArray(response.data)) {
        slog(`   ⚠️  Non-array response: ${typeof response.data === 'string' ? response.data.substring(0, 200) : typeof response.data}`);
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

      slog(`   📥 Returned ${results.length} results`);

      // Pagination: fetch additional pages if enabled
      const paginationEnabled = paginationOverride?.enabled ?? this.getGlobalPagination();
      const extraPages = paginationOverride?.additionalPages ?? this.getGlobalAdditionalPages();
      if (paginationEnabled && results.length >= 100) {
        for (let page = 2; page <= extraPages + 1; page++) {
          const offset = (page - 1) * 100;
          slog(`   📄 Fetching page ${page} (offset ${offset})...`);
          try {
            const pageParams = new URLSearchParams(params);
            pageParams.set('offset', offset.toString());
            const pageUrl = `${this.url}/api/v1/search?${pageParams.toString()}`;
            const pageResp = await axios.get(pageUrl, {
              headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
              timeout: this.getTimeoutMs(),
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
            slog(`   📄 Page ${page}: +${pageResults.length} (total so far: ${results.length})`);
            if (pageResp.data.length < 100) break; // Last page
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  Prowlarr pagination page ${page} timed out after ${this.timeoutSeconds}s`);
            } else {
              slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            }
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        slog(`⏱️  Prowlarr request timed out after ${this.timeoutSeconds}s`);
      }
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
    method?: string,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    try {
      const searchUrl = `${this.url}/api/v1/indexer/${indexerId}/newznab`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      slog(`📤 Prowlarr newznab: /api/v1/indexer/${indexerId}/newznab`);
      slog(`   Params: ${JSON.stringify(params)}`);

      const response = await axios.get(searchUrl, {
        params,
        headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
        timeout: this.getTimeoutMs(),
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
      const methodLabel = method ? `[${method}] ` : '';
      slog(`   📥 ${methodLabel}${indexerName} returned ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Pagination: fetch additional pages if enabled and more results available
      const indexer = this.indexers.find(i => i.id === indexerId);
      const paginationEnabled = paginationOverride?.enabled ?? (indexer?.pagination === true);
      const extraPages = paginationOverride?.additionalPages ?? (indexer?.additionalPages ?? 3);
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;
        for (let page = 2; page <= extraPages + 1 && currentOffset < total; page++) {
          slog(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResp = await axios.get(searchUrl, {
              params: { ...params, offset: currentOffset },
              headers: { 'X-Api-Key': this.apiKey, 'User-Agent': userAgent },
              timeout: this.getTimeoutMs(),
            });
            const pageData = await parseNewznabXmlWithMeta(typeof pageResp.data === 'string' ? pageResp.data : '');
            if (pageData.results.length === 0) break;
            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            slog(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  Prowlarr pagination page ${page} timed out after ${this.timeoutSeconds}s (${indexerName})`);
            } else {
              slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            }
            break;
          }
        }
      }

      return results.map(r => ({ ...r, indexerName }));
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        slog(`⏱️  Prowlarr request for ${indexerName} timed out after ${this.timeoutSeconds}s`);
      }
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


/**
 * NZBHydra Searcher
 *
 * Searches via NZBHydra2's Newznab-compatible /api endpoint.
 * NZBHydra aggregates internally — we send one request with optional
 * indexer name filters and get back standard Newznab RSS XML.
 *
 * Groups enabled synced indexers by their preferred search method,
 * makes one NZBHydra API call per unique method, and merges results.
 */

import axios from 'axios';
import type { SyncedIndexer, NZBSearchResult } from '../types.js';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';
import { parseNewznabXmlWithMeta } from '../parsers/newznabClient.js';
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, buildSeriesPackPaginationAdditionalPages } from '../parsers/titleMatching.js';
import { slog, withSubBuffer } from '../parsers/searchLogger.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';

export class NzbhydraSearcher {
  private authHeader?: string;
  private timedOut = false;

  constructor(
    private url: string,
    private apiKey: string,
    private indexers: SyncedIndexer[],
    username?: string,
    password?: string,
    private timeoutEnabled: boolean = true,
    private timeoutSeconds: number = DEFAULT_INDEXER_TIMEOUT_SECONDS,
  ) {
    if (username && password) {
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
  }

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
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const idSearchedNames: string[] = [];

    const tasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];

    for (const [method, indexerNames] of groups) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
      };

      params.indexers = indexerNames.join(',');

      if (method === 'text') {
        params.t = 'search';
        params.q = stripDiacritics(year ? `${title} ${year}` : title);
        params.cat = '2000';
      } else if (method === 'imdb') {
        params.t = 'movie';
        params.imdbid = imdbId.replace('tt', '');
        idSearchedNames.push(...indexerNames);
      } else if (method === 'tmdb' && resolvedIds?.get('tmdb')) {
        params.t = 'movie';
        params.tmdbid = resolvedIds.get('tmdb')!.idValue;
        idSearchedNames.push(...indexerNames);
      } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
        params.t = 'movie';
        params.tvdbid = resolvedIds.get('tvdb')!.idValue;
        idSearchedNames.push(...indexerNames);
      } else {
        slog(`⚠️  ${method} ID unavailable for ${indexerNames.length} indexer(s) — skipping`);
        continue;
      }

      const isText = method === 'text';
      tasks.push(withSubBuffer(`movie ${method} search × ${indexerNames.length} indexer(s)`, async () => {
        const results = await this.doSearch(params);
        if (isText) {
          const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          slog(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
          if (results.length !== filtered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          return filtered;
        }
        return results;
      }));
    }

    const settled = await Promise.all(tasks);
    for (const arr of settled) allResults.push(...arr);

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  NZBHydra: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut) {
      const allNames = [...new Set(idSearchedNames)];
      if (allNames.length > 0) {
        for (const altTitle of additionalTitles) {
          const altParams: Record<string, string> = {
            apikey: this.apiKey,
            extended: '1',
            t: 'search',
            q: stripDiacritics(year ? `${altTitle} ${year}` : altTitle),
            cat: '2000',
            indexers: allNames.join(','),
          };
          slog(`🔄 Retrying with alternative title for ${allNames.length} indexer(s): "${altParams.q}"`);
          const altResults = await this.doSearch(altParams);
          const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          slog(`   🎯 Alt-title filter: ${altResults.length} → ${altFiltered.length}`);
          if (altResults.length !== altFiltered.length) {
            altResults.filter(r => !isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          if (altFiltered.length > 0) {
            allResults.push(...altFiltered);
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
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const idSearchedNames: string[] = [];
    const textMethodNames: string[] = [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    const tasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];

    for (const [method, indexerNames] of groups) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
      };

      params.indexers = indexerNames.join(',');

      if (method === 'text') {
        params.t = 'search';
        params.q = stripDiacritics(`${title} S${s}E${e}`);
        params.cat = '5000';
        textMethodNames.push(...indexerNames);
      } else if (method === 'imdb') {
        params.t = 'tvsearch';
        params.imdbid = imdbId.replace('tt', '');
        params.season = season.toString();
        params.ep = episode.toString();
        idSearchedNames.push(...indexerNames);
      } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
        params.t = 'tvsearch';
        params.tvdbid = resolvedIds.get('tvdb')!.idValue;
        params.season = season.toString();
        params.ep = episode.toString();
        idSearchedNames.push(...indexerNames);
      } else if (method === 'tvmaze' && resolvedIds?.get('tvmaze')) {
        params.t = 'tvsearch';
        params.tvmazeid = resolvedIds.get('tvmaze')!.idValue;
        params.season = season.toString();
        params.ep = episode.toString();
        idSearchedNames.push(...indexerNames);
      } else {
        slog(`⚠️  ${method} ID unavailable for ${indexerNames.length} indexer(s) — skipping`);
        continue;
      }

      const isText = method === 'text';
      tasks.push(withSubBuffer(`TV ${method} search S${season}E${episode} × ${indexerNames.length} indexer(s)`, async () => {
        const results = await this.doSearch(params);
        if (isText) {
          const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          slog(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
          if (results.length !== filtered.length) {
            results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
              .forEach(r => slog(`      ✂️  ${r.title}`));
          }
          return filtered;
        }
        return results;
      }));
    }

    const packIndexerNames = [...new Set([...textMethodNames, ...idSearchedNames])];
    if (packIndexerNames.length > 0 && title) {
      const packIndexersCsv = packIndexerNames.join(',');

      if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
        const spPagination = config.searchConfig?.seasonPackPagination !== false;
        const spPages = config.searchConfig?.seasonPackAdditionalPages;
        const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
        const packParams: Record<string, string> = {
          apikey: this.apiKey,
          extended: '1',
          t: 'search',
          q: stripDiacritics(`${title} S${s}`),
          cat: '5000',
          indexers: packIndexersCsv,
        };
        tasks.push(withSubBuffer(`Season pack: ${packParams.q}`, async () => {
          const packResults = await this.doSearch(packParams, spOverride);
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
        const fanoutParams: Record<string, string> = {
          apikey: this.apiKey,
          extended: '1',
          t: 'search',
          q: stripDiacritics(`${title} S01`),
          cat: '5000',
          indexers: packIndexersCsv,
        };
        tasks.push(withSubBuffer(`Multi-season fanout: ${fanoutParams.q}`, async () => {
          const fanoutResults = await this.doSearch(fanoutParams, fanoutOverride);
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
      tasks.push(withSubBuffer(`Series-pack keyword queries`, () => runSeriesPackQueries({
        searchFn: async (q) => {
          const seriesParams: Record<string, string> = {
            apikey: this.apiKey,
            extended: '1',
            t: 'search',
            q,
            cat: '5000',
            indexers: packIndexersCsv,
          };
          return this.doSearch(seriesParams, seriesOverride);
        },
        title, season, episodesInSeason,
        isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
        searchConfig: config.searchConfig,
        logPrefix: 'NZBHydra',
      })));
    }

    const settled = await Promise.all(tasks);
    for (const arr of settled) allResults.push(...arr);

    // Alternative-title retry: if still 0 results and alternative titles exist, retry with each
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  NZBHydra: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut) {
      const allNames = [...new Set(idSearchedNames)];
      if (allNames.length > 0) {
        for (const altTitle of additionalTitles) {
          const altParams: Record<string, string> = {
            apikey: this.apiKey,
            extended: '1',
            t: 'search',
            q: stripDiacritics(`${altTitle} S${s}E${e}`),
            cat: '5000',
            indexers: allNames.join(','),
          };
          slog(`🔄 Retrying with alternative title for ${allNames.length} indexer(s): "${altParams.q}"`);
          const altResults = await this.doSearch(altParams);
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
              const packParams: Record<string, string> = { ...altParams, q: stripDiacritics(`${altTitle} S${s}`) };
              const packResults = await this.doSearch(packParams, spOverride);
              const titleMatched = packResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
              const packs = tagSeasonPack(titleMatched, season, episodesInSeason);
              if (packs.length > 0) {
                slog(`   📦 Found ${packs.length} season packs (alt-title)`);
              }
              altFiltered.push(...packs);
            }
            allResults.push(...altFiltered);
            break;
          }
        }
      }
    }

    return allResults;
  }

  private async doSearch(params: Record<string, string>, paginationOverride?: { enabled: boolean; additionalPages: number }): Promise<(NZBSearchResult & { indexerName: string })[]> {
    try {
      const url = `${this.url}/api`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      // Log full request details (mask API key)
      const logParams = { ...params, apikey: '***' };
      slog(`📤 NZBHydra request: ${url}`);
      slog(`   Params: ${JSON.stringify(logParams)}`);

      const headers: Record<string, string> = { 'User-Agent': userAgent };
      if (this.authHeader) headers['Authorization'] = this.authHeader;

      const response = await axios.get(url, {
        params,
        timeout: this.getTimeoutMs(),
        headers,
      });

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      slog(`   📥 NZBHydra returned ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = paginationOverride?.enabled ?? this.getGlobalPagination();
      const extraPages = paginationOverride?.additionalPages ?? this.getGlobalAdditionalPages();
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;
        for (let page = 2; page <= extraPages + 1 && currentOffset < total; page++) {
          slog(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResp = await axios.get(url, {
              params: { ...params, offset: currentOffset },
              timeout: this.getTimeoutMs(),
              headers,
            });
            const pageData = await parseNewznabXmlWithMeta(pageResp.data);
            if (pageData.results.length === 0) break;
            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            slog(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  NZBHydra pagination page ${page} timed out after ${this.timeoutSeconds}s`);
            } else {
              slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            }
            break;
          }
        }
      }

      // Resolve indexer name from NZBHydra2 response attributes.
      // NZBHydra2 may use different attribute keys depending on version.
      return results.map(r => ({
        ...r,
        indexerName: NzbhydraSearcher.resolveIndexerName(r.attributes) || 'NZBHydra',
      }));
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        slog(`⏱️  NZBHydra request timed out after ${this.timeoutSeconds ?? DEFAULT_INDEXER_TIMEOUT_SECONDS}s`);
      }
      console.error(`❌ NZBHydra search error:`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, typeof error.response.data === 'string' ? error.response.data.substring(0, 200) : '');
      } else {
        console.error(`   ${error.message}`);
      }
      return [];
    }
  }

  /** Check if any synced indexer has pagination enabled */
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
      // For NZBHydra, we use indexer names (not numeric IDs) as the identifier
      const methodArr = Array.isArray(methods) ? methods : [methods];
      for (const method of methodArr) {
        if (!groups.has(method)) groups.set(method, []);
        if (!groups.get(method)!.includes(indexer.name)) groups.get(method)!.push(indexer.name);
      }
    }
    return groups;
  }

  /**
   * Resolve the indexer name from NZBHydra2 result attributes.
   * NZBHydra2 uses different attribute keys depending on version/config.
   */
  private static resolveIndexerName(attrs: any): string | undefined {
    if (!attrs) return undefined;
    // Check all known attribute keys NZBHydra2 may use (keys are lowercased by parser)
    return attrs.indexername
      || attrs.indexer
      || attrs.hydraindexername
      || attrs.hydraindexer
      || undefined;
  }
}

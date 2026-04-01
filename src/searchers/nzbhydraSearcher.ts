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
import { parseNewznabXmlWithMeta } from '../parsers/newznabClient.js';
import { isTextSearchMatch, stripDiacritics } from '../parsers/titleMatching.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';

export class NzbhydraSearcher {
  private authHeader?: string;

  constructor(
    private url: string,
    private apiKey: string,
    private indexers: SyncedIndexer[],
    username?: string,
    password?: string,
  ) {
    if (username && password) {
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
  }

  async searchMovie(
    imdbId: string,
    title: string,
    year?: string,
    country?: string,
    resolvedIds?: Map<string, { idParam: string; idValue: string } | null>,
    additionalTitles?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('movie');
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const textFallbackNames: string[] = [];
    const idSearchedNames: string[] = [];

    for (const [method, indexerNames] of groups) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
      };

      // Filter by specific indexers (comma-separated names)
      // Always send to ensure NZBHydra only searches enabled synced indexers
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
        // ID resolution failed — defer to text fallback
        console.log(`⚠️  ${method} ID unavailable, deferring ${indexerNames.length} indexer(s) to text fallback`);
        textFallbackNames.push(...indexerNames);
        continue;
      }

      console.log(`🔍 NZBHydra movie search (${method}) for ${indexerNames.length} indexer(s)`);
      const results = await this.doSearch(params);

      if (method === 'text') {
        const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
        console.log(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
        if (results.length !== filtered.length) {
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
            .forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        allResults.push(...filtered);
      } else {
        allResults.push(...results);
      }
    }

    // Text fallback for indexers whose external ID could not be resolved
    if (textFallbackNames.length > 0 && title) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        t: 'search',
        q: stripDiacritics(year ? `${title} ${year}` : title),
        cat: '2000',
      };
      params.indexers = textFallbackNames.join(',');
      console.log(`🔄 ID resolution failed — text fallback for ${textFallbackNames.length} indexer(s)`);
      const results = await this.doSearch(params);
      const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
      console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
      if (results.length !== filtered.length) {
        results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }
      allResults.push(...filtered);
    }

    // Zero-result text fallback: if ID-based searches returned nothing, retry with text
    if (allResults.length === 0 && idSearchedNames.length > 0 && title) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        t: 'search',
        q: stripDiacritics(year ? `${title} ${year}` : title),
        cat: '2000',
        indexers: idSearchedNames.join(','),
      };
      console.log(`🔄 ID search returned 0 — text fallback for ${idSearchedNames.length} indexer(s)`);
      const results = await this.doSearch(params);
      const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
      console.log(`   🎯 Zero-result text fallback filter: ${results.length} → ${filtered.length}`);
      if (results.length !== filtered.length) {
        results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }
      allResults.push(...filtered);
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
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('tv');
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const textFallbackNames: string[] = [];
    const idSearchedNames: string[] = [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

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
        // ID resolution failed — defer to text fallback
        console.log(`⚠️  ${method} ID unavailable, deferring ${indexerNames.length} indexer(s) to text fallback`);
        textFallbackNames.push(...indexerNames);
        continue;
      }

      console.log(`🔍 NZBHydra TV search (${method}) S${season}E${episode} for ${indexerNames.length} indexer(s)`);
      const results = await this.doSearch(params);

      if (method === 'text') {
        const episodeFiltered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
        console.log(`   🎯 Title filter: ${results.length} → ${episodeFiltered.length}`);
        if (results.length !== episodeFiltered.length) {
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
            .forEach(r => console.log(`      ✂️  ${r.title}`));
        }

        // Check for season packs if configured
        if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
          const spPagination = config.searchConfig?.seasonPackPagination !== false;
          const spPages = config.searchConfig?.seasonPackAdditionalPages;
          const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
          const packParams: Record<string, string> = { ...params, q: stripDiacritics(`${title} S${s}`) };

          const packResults = await this.doSearch(packParams, spOverride);
          const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
          const packs = packResults
            .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles))
            .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
          if (packResults.length !== packs.length) {
            const removedPacks = packResults.filter(r =>
              !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles)
            );
            console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
            removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (packs.length > 0) {
            console.log(`   📦 Found ${packs.length} season packs`);
          }
          episodeFiltered.push(...packs);
        }

        allResults.push(...episodeFiltered);
      } else {
        allResults.push(...results);
      }
    }

    // Season packs for ID-based indexers (text-search indexers already include packs inline)
    if (config.searchConfig?.includeSeasonPacks && episodesInSeason && idSearchedNames.length > 0 && title) {
      const spPagination = config.searchConfig?.seasonPackPagination !== false;
      const spPages = config.searchConfig?.seasonPackAdditionalPages;
      const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
      const packParams: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        t: 'search',
        q: stripDiacritics(`${title} S${s}`),
        cat: '5000',
        indexers: idSearchedNames.join(','),
      };
      console.log(`📦 NZBHydra season pack search for ${idSearchedNames.length} ID-based indexer(s)`);
      const packResults = await this.doSearch(packParams, spOverride);
      const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
      const packs = packResults
        .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles))
        .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
      if (packResults.length !== packs.length) {
        const removedPacks = packResults.filter(r =>
          !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles)
        );
        console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
        removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
      }
      if (packs.length > 0) {
        console.log(`   📦 Found ${packs.length} season packs (ID-based indexers)`);
      }
      allResults.push(...packs);
    }

    // Text fallback for indexers whose external ID could not be resolved
    if (textFallbackNames.length > 0 && title) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        t: 'search',
        q: stripDiacritics(`${title} S${s}E${e}`),
        cat: '5000',
      };
      params.indexers = textFallbackNames.join(',');
      console.log(`🔄 ID resolution failed — text fallback for ${textFallbackNames.length} indexer(s)`);
      const results = await this.doSearch(params);
      const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
      console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
      if (results.length !== filtered.length) {
        results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }

      if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
        const spPagination = config.searchConfig?.seasonPackPagination !== false;
        const spPages = config.searchConfig?.seasonPackAdditionalPages;
        const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
        const packParams: Record<string, string> = { ...params, q: stripDiacritics(`${title} S${s}`) };
        const packResults = await this.doSearch(packParams, spOverride);
        const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
        const packs = packResults
          .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
        if (packResults.length !== packs.length) {
          const removedPacks = packResults.filter(r =>
            !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles)
          );
          console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
          removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        if (packs.length > 0) console.log(`   📦 Found ${packs.length} season packs (text fallback)`);
        filtered.push(...packs);
      }

      allResults.push(...filtered);
    }

    // Zero-result text fallback: if ID-based searches returned nothing, retry with text
    if (allResults.length === 0 && idSearchedNames.length > 0 && title) {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        t: 'search',
        q: stripDiacritics(`${title} S${s}E${e}`),
        cat: '5000',
        indexers: idSearchedNames.join(','),
      };
      console.log(`🔄 ID search returned 0 — text fallback for ${idSearchedNames.length} indexer(s)`);
      const results = await this.doSearch(params);
      const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
      console.log(`   🎯 Zero-result text fallback filter: ${results.length} → ${filtered.length}`);
      if (results.length !== filtered.length) {
        results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .forEach(r => console.log(`      ✂️  ${r.title}`));
      }

      if (config.searchConfig?.includeSeasonPacks && episodesInSeason) {
        const spPagination = config.searchConfig?.seasonPackPagination !== false;
        const spPages = config.searchConfig?.seasonPackAdditionalPages;
        const spOverride = spPagination && spPages ? { enabled: true, additionalPages: spPages } : undefined;
        const packParams: Record<string, string> = { ...params, q: stripDiacritics(`${title} S${s}`) };
        const packResults = await this.doSearch(packParams, spOverride);
        const seasonPackPattern = new RegExp(`S${s}(?![._\\s-]?E\\d)`, 'i');
        const packs = packResults
          .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles))
          .map(r => ({ ...r, isSeasonPack: true, estimatedEpisodeSize: Math.round(r.size / episodesInSeason!) }));
        if (packResults.length !== packs.length) {
          const removedPacks = packResults.filter(r =>
            !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles)
          );
          console.log(`   📦 Season pack filter: ${packResults.length} → ${packs.length} (removed ${removedPacks.length} mismatches)`);
          removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        if (packs.length > 0) console.log(`   📦 Found ${packs.length} season packs (zero-result fallback)`);
        filtered.push(...packs);
      }

      allResults.push(...filtered);
    }

    return allResults;
  }

  private async doSearch(params: Record<string, string>, paginationOverride?: { enabled: boolean; additionalPages: number }): Promise<(NZBSearchResult & { indexerName: string })[]> {
    try {
      const url = `${this.url}/api`;
      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      // Log full request details (mask API key)
      const logParams = { ...params, apikey: '***' };
      console.log(`📤 NZBHydra request: ${url}`);
      console.log(`   Params:`, JSON.stringify(logParams));

      const headers: Record<string, string> = { 'User-Agent': userAgent };
      if (this.authHeader) headers['Authorization'] = this.authHeader;

      const response = await axios.get(url, {
        params,
        timeout: 30000,
        headers,
      });

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      console.log(`   📦 NZBHydra returned ${results.length} results${total ? ` (total: ${total})` : ''}`);
      if (results.length > 0) {
        console.log(`   📋 First result: "${results[0].title}"`);
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = paginationOverride?.enabled ?? this.getGlobalPagination();
      const extraPages = paginationOverride?.additionalPages ?? this.getGlobalAdditionalPages();
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;
        for (let page = 2; page <= extraPages + 1 && currentOffset < total; page++) {
          console.log(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResp = await axios.get(url, {
              params: { ...params, offset: currentOffset },
              timeout: 30000,
              headers,
            });
            const pageData = await parseNewznabXmlWithMeta(pageResp.data);
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

      // Resolve indexer name from NZBHydra2 response attributes.
      // NZBHydra2 may use different attribute keys depending on version.
      return results.map(r => ({
        ...r,
        indexerName: NzbhydraSearcher.resolveIndexerName(r.attributes) || 'NZBHydra',
      }));
    } catch (error: any) {
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

/**
 * UsenetSearcher class — wraps a single Newznab indexer.
 *
 * Provides generic search, movie search (IMDB/TMDB/TVDB/text), and
 * TV show search (IMDB/TVDB/TVmaze/text) with pagination, Zyclops
 * routing, season-pack detection, and text-match filtering.
 */

import axios from 'axios';
import { UsenetIndexer, NZBSearchResult, DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { getAxiosProxyConfig, logProxyExitIp } from '../proxy.js';
import { parseNewznabXmlWithMeta } from './newznabClient.js';
import { stripDiacritics, isTextSearchMatch, tagSeasonPack } from './titleMatching.js';

export class UsenetSearcher {
  public timedOut = false;

  constructor(private indexer: UsenetIndexer) {}

  // Resolved timeout in ms, or undefined when timeouts are disabled.
  private getTimeoutMs(): number | undefined {
    if (this.indexer.timeoutEnabled === false) return undefined;
    return (this.indexer.timeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS) * 1000;
  }

  // Effective timeout in seconds (for log lines); undefined when disabled.
  private getTimeoutSeconds(): number | undefined {
    if (this.indexer.timeoutEnabled === false) return undefined;
    return this.indexer.timeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS;
  }

  // Formatted `[timeout=Ns]` or `[timeout=disabled]` label for inline log lines.
  private timeoutLabel(): string {
    const s = this.getTimeoutSeconds();
    return `[timeout=${s === undefined ? 'disabled' : `${s}s`}]`;
  }

  /**
   * Compute the effective URL and extra params for this indexer.
   * When Zyclops is enabled, ALL requests go through the Zyclops endpoint.
   * The original indexer URL becomes the `target` parameter.
   * SAFETY: The indexer URL must NEVER be used directly when Zyclops is enabled.
   */
  private getEffectiveEndpoint(): {
    url: string;
    extraParams: Record<string, string>;
    isZyclops: boolean;
  } {
    const zyclops = this.indexer.zyclops;
    if (!zyclops?.enabled) {
      return { url: this.indexer.url, extraParams: {}, isZyclops: false };
    }

    const zyclopsEndpoint = config.zyclopsEndpoint || 'https://zyclops.elfhosted.com';
    const zyclopsUrl = `${zyclopsEndpoint.replace(/\/$/, '')}/api`;

    const extraParams: Record<string, string> = {
      target: this.indexer.url,
    };

    if (zyclops.backbone?.length) {
      extraParams.backbone = zyclops.backbone.join(',');
    }
    if (zyclops.providerHosts) {
      extraParams.provider_host = zyclops.providerHosts;
    }

    if (zyclops.showUnknown === true) {
      extraParams.show_unknown = 'true';
    }
    if (zyclops.singleIp === false) {
      extraParams.single_ip = 'false';
    }

    console.log(`🤖 Zyclops routing ${this.indexer.name}: ${this.indexer.url} → ${zyclopsUrl}`, extraParams);

    return { url: zyclopsUrl, extraParams, isZyclops: true };
  }

  async search(query: string, category?: string, paginationOverride?: { enabled: boolean; maxPages: number }): Promise<NZBSearchResult[]> {
    try {
      const { url: effectiveUrl, extraParams, isZyclops } = this.getEffectiveEndpoint();

      const params: any = {
        t: 'search',
        apikey: this.indexer.apiKey,
        q: query,
        extended: 1,
        ...extraParams,
      };

      if (category) {
        params.cat = category;
      }

      console.log(`🔍 Searching ${this.indexer.name}: ${effectiveUrl}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      console.log(`   Query: "${query}", Category: ${category || 'all'}`);

      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      // SAFETY: Skip proxy when Zyclops is enabled — Zyclops IS the proxy
      if (!isZyclops) {
        await logProxyExitIp(this.indexer.url, 'search');
      }
      const response = await axios.get(effectiveUrl, {
        params,
        timeout: this.getTimeoutMs(),
        headers: { 'User-Agent': userAgent },
        ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
      });

      console.log(`✅ Response received (${response.status}), parsing...`);

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      console.log(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Tag results from Zyclops as pre-verified healthy
      if (isZyclops) {
        for (const result of results) {
          result.zyclopsVerified = true;
        }
        console.log(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = paginationOverride?.enabled ?? (this.indexer.pagination === true);
      const maxExtraPages = paginationOverride?.maxPages ?? (this.indexer.maxPages ?? 3);
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;

        for (let page = 2; page <= maxExtraPages + 1 && currentOffset < total; page++) {
          console.log(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResponse = await axios.get(effectiveUrl, {
              params: { ...params, offset: currentOffset },
              timeout: this.getTimeoutMs(),
              headers: { 'User-Agent': userAgent },
              ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
            });

            const pageData = await parseNewznabXmlWithMeta(pageResponse.data);
            if (pageData.results.length === 0) break;

            // Tag paginated results from Zyclops
            if (isZyclops) {
              for (const result of pageData.results) {
                result.zyclopsVerified = true;
              }
            }

            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            console.log(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              console.warn(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            console.warn(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        console.warn(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
      } else {
        console.error(`❌ Search error for ${this.indexer.name}:`);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Data:`, error.response.data?.substring?.(0, 200));
        } else {
          console.error(`   ${error.message}`);
        }
      }
      return [];
    }
  }

  async searchMovie(imdbId: string, title: string, year?: string, country?: string, externalId?: { idParam: string; idValue: string }, searchMethod?: string, additionalTitles?: string[], titleYear?: string): Promise<NZBSearchResult[]> {
    try {
      const methods = this.indexer.movieSearchMethod;
      const method = searchMethod || (Array.isArray(methods) ? methods[0] : methods) || 'imdb';

      // Text-based search
      if (method === 'text') {
        console.log(`🎬 Movie text search for: ${title} ${year || ''}`);
        const query = stripDiacritics(year ? `${title} ${year}` : title);
        const results = await this.search(query, '2000'); // Category 2000 = Movies
        const before = results.length;
        const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        if (before !== filtered.length) {
          const removed = results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          console.log(`   🎯 Title filter: ${before} → ${filtered.length} (removed ${removed.length} mismatches)`);
          removed.forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        return filtered;
      }

      // If method requires an external ID that wasn't resolved, fall back to text search
      if (method !== 'imdb' && method !== 'text' && !externalId) {
        console.warn(`⚠️  ${method} ID unavailable for ${this.indexer.name}, falling back to text search`);
        if (!title) {
          console.warn(`⚠️  No title available for text fallback — skipping`);
          return [];
        }
        const query = stripDiacritics(year ? `${title} ${year}` : title);
        const results = await this.search(query, '2000');
        const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
        if (results.length !== filtered.length) {
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        return filtered;
      }

      // ID-based search (IMDB, TMDB, TVDB)
      const { url: effectiveUrl, extraParams, isZyclops } = this.getEffectiveEndpoint();

      const params: any = {
        t: 'movie',  // movie-search function
        apikey: this.indexer.apiKey,
        extended: 1,
        ...extraParams,
      };

      if (externalId) {
        params[externalId.idParam] = externalId.idValue;
        console.log(`🎬 Movie search for ${externalId.idParam}: ${externalId.idValue}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      } else {
        params.imdbid = imdbId.replace('tt', '');  // Remove 'tt' prefix
        console.log(`🎬 Movie search for IMDB: ${imdbId}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      }

      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      // SAFETY: Skip proxy when Zyclops is enabled — Zyclops IS the proxy
      if (!isZyclops) {
        await logProxyExitIp(this.indexer.url, 'movie-search');
      }
      const response = await axios.get(effectiveUrl, {
        params,
        timeout: this.getTimeoutMs(),
        headers: { 'User-Agent': userAgent },
        ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
      });

      console.log(`✅ Response received (${response.status}), parsing...`);

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      console.log(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Tag results from Zyclops as pre-verified healthy
      if (isZyclops) {
        for (const result of results) {
          result.zyclopsVerified = true;
        }
        console.log(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = this.indexer.pagination === true;
      const maxExtraPages = this.indexer.maxPages ?? 3;
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;

        for (let page = 2; page <= maxExtraPages + 1 && currentOffset < total; page++) {
          console.log(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResponse = await axios.get(effectiveUrl, {
              params: { ...params, offset: currentOffset },
              timeout: this.getTimeoutMs(),
              headers: { 'User-Agent': userAgent },
              ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
            });

            const pageData = await parseNewznabXmlWithMeta(pageResponse.data);
            if (pageData.results.length === 0) break;

            if (isZyclops) {
              for (const result of pageData.results) {
                result.zyclopsVerified = true;
              }
            }

            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            console.log(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              console.warn(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            console.warn(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        console.warn(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
      } else {
        console.error(`❌ Movie search error for ${this.indexer.name}:`);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
        } else {
          console.error(`   ${error.message}`);
        }
      }
      return [];
    }
  }

  async searchTVShow(
    imdbId: string,
    title: string,
    season: number,
    episode: number,
    episodesInSeason?: number,
    year?: string,
    country?: string,
    externalId?: { idParam: string; idValue: string },
    searchMethod?: string,
    additionalTitles?: string[],
    titleYear?: string,
    options?: { numberingScheme?: 'seasonal' | 'absolute'; absoluteEp?: number },
  ): Promise<NZBSearchResult[]> {
    try {
      const tvMethods = this.indexer.tvSearchMethod;
      const method = searchMethod || (Array.isArray(tvMethods) ? tvMethods[0] : tvMethods) || 'imdb';

      // Text-based search
      if (method === 'text') {
        const s = season.toString().padStart(2, '0');
        const e = episode.toString().padStart(2, '0');
        const isAbsolute = options?.numberingScheme === 'absolute' && options.absoluteEp !== undefined;
        const query = isAbsolute
          ? stripDiacritics(`${title} E${options!.absoluteEp!.toString().padStart(2, '0')}`)
          : stripDiacritics(`${title} S${s}E${e}`);
        console.log(`📺 TV text search for: ${query}`);
        const results = await this.search(query, '5000'); // Category 5000 = TV
        const before = results.length;
        // On absolute-numbering retries, strip the bare E\d token before
        // matching: extractTitleFromRelease only anchors on SxxExx, so a release
        // like "Lady Of Law E23 1080p..." would extract as "Lady Of Law E23"
        // and fail equality. The \b boundary leaves "S03E23" untouched.
        const matchTitle = isAbsolute
          ? (s: string) => s.replace(/\bE\d{1,3}\b/i, ' ').replace(/\s+/g, ' ')
          : (s: string) => s;
        const filtered = results.filter(r => isTextSearchMatch(title, matchTitle(r.title), year, country, additionalTitles, titleYear));
        if (before !== filtered.length) {
          const removed = results.filter(r => !isTextSearchMatch(title, matchTitle(r.title), year, country, additionalTitles, titleYear));
          console.log(`   🎯 Title filter: ${before} → ${filtered.length} (removed ${removed.length} mismatches)`);
          removed.forEach(r => console.log(`      ✂️  ${r.title}`));
        }

        // Skip season-pack search on absolute-numbering retries — pack queries
        // use the seasonal `Title S03` format which doesn't apply when we're
        // probing absolute episode numbers.
        const includeSeasonPacks = !isAbsolute && (config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks);
        if (includeSeasonPacks) {
          const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
          const spAdditionalPages = config.searchConfig?.seasonPackAdditionalPages;
          const seasonPackPagination = spPaginationEnabled && spAdditionalPages ? { enabled: true, maxPages: spAdditionalPages } : undefined;
          const packQuery = stripDiacritics(`${title} S${s}`);
          console.log(`📦 Season pack search for: ${packQuery}`);
          const packResults = await this.search(packQuery, '5000', seasonPackPagination);
          const packBefore = packResults.length;
          // Must match title AND be a season pack (S## direct, or Sxx-Syy / Sxx.Syy range covering it)
          const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (packBefore !== filteredPacks.length) {
            const keptLinks = new Set(filteredPacks.map(p => p.link));
            const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
            console.log(`   📦 Season pack filter: ${packBefore} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
            removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (filteredPacks.length > 0) {
            console.log(`   📦 Found ${filteredPacks.length} season packs${episodesInSeason ? ` (${episodesInSeason} eps/season, est. size per ep)` : ' (full pack size, episode count unknown)'}`);
          }
          filtered.push(...filteredPacks);
        }

        return filtered;
      }

      // If method requires an external ID that wasn't resolved, fall back to text search
      if (method !== 'imdb' && method !== 'text' && !externalId) {
        console.warn(`⚠️  ${method} ID unavailable for ${this.indexer.name}, falling back to text search`);
        if (!title) {
          console.warn(`⚠️  No title available for text fallback — skipping`);
          return [];
        }
        const s2 = season.toString().padStart(2, '0');
        const e2 = episode.toString().padStart(2, '0');
        const query = stripDiacritics(`${title} S${s2}E${e2}`);
        const results = await this.search(query, '5000');
        const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        console.log(`   🎯 Text fallback filter: ${results.length} → ${filtered.length}`);
        if (results.length !== filtered.length) {
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .forEach(r => console.log(`      ✂️  ${r.title}`));
        }

        const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
        if (includeSeasonPacks && episodesInSeason) {
          const spPaginationEnabled2 = config.searchConfig?.seasonPackPagination !== false;
          const spAdditionalPages2 = config.searchConfig?.seasonPackAdditionalPages;
          const seasonPackPagination2 = spPaginationEnabled2 && spAdditionalPages2 ? { enabled: true, maxPages: spAdditionalPages2 } : undefined;
          const packQuery = stripDiacritics(`${title} S${s2}`);
          const packResults = await this.search(packQuery, '5000', seasonPackPagination2);
          const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (packResults.length !== filteredPacks.length) {
            const keptLinks = new Set(filteredPacks.map(p => p.link));
            const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
            console.log(`   📦 Season pack filter: ${packResults.length} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
            removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
          }
          if (filteredPacks.length > 0) console.log(`   📦 Found ${filteredPacks.length} season packs (text fallback)`);
          filtered.push(...filteredPacks);
        }

        return filtered;
      }

      // ID-based search (IMDB, TVDB, TVmaze)
      const { url: effectiveUrl, extraParams, isZyclops } = this.getEffectiveEndpoint();

      const params: any = {
        t: 'tvsearch',  // TV search function
        apikey: this.indexer.apiKey,
        season: season,
        ep: episode,
        extended: 1,
        ...extraParams,
      };

      if (externalId) {
        params[externalId.idParam] = externalId.idValue;
        console.log(`📺 TV search for ${externalId.idParam}: ${externalId.idValue} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      } else {
        params.imdbid = imdbId.replace('tt', '');  // Remove 'tt' prefix
        console.log(`📺 TV search for IMDB: ${imdbId} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      }

      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

      // SAFETY: Skip proxy when Zyclops is enabled — Zyclops IS the proxy
      if (!isZyclops) {
        await logProxyExitIp(this.indexer.url, 'tv-search');
      }

      // Absorb timeout on the main request so the outer flow still reaches the
      // season-pack block below. A season-pack query is semantically a different
      // search (`S01` vs `S01E01`), not a retry — it deserves its own attempt
      // even when the episode search timed out.
      let results: NZBSearchResult[] = [];
      let total: number | undefined;
      try {
        const response = await axios.get(effectiveUrl, {
          params,
          timeout: this.getTimeoutMs(),
          headers: { 'User-Agent': userAgent },
          ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
        });

        console.log(`✅ Response received (${response.status}), parsing...`);

        const parsed = await parseNewznabXmlWithMeta(response.data);
        results = parsed.results;
        total = parsed.total;
        console.log(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

        // Tag results from Zyclops as pre-verified healthy
        if (isZyclops) {
          for (const result of results) {
            result.zyclopsVerified = true;
          }
          console.log(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
        }
      } catch (error: any) {
        if (error.code === 'ECONNABORTED') {
          this.timedOut = true;
          console.warn(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
          // results stays []; outer flow continues to pagination + season-pack
        } else {
          throw error; // bubble non-timeout errors to the outer catch
        }
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = this.indexer.pagination === true;
      const maxExtraPages = this.indexer.maxPages ?? 3;
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;

        for (let page = 2; page <= maxExtraPages + 1 && currentOffset < total; page++) {
          console.log(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
          try {
            const pageResponse = await axios.get(effectiveUrl, {
              params: { ...params, offset: currentOffset },
              timeout: this.getTimeoutMs(),
              headers: { 'User-Agent': userAgent },
              ...(isZyclops ? {} : getAxiosProxyConfig(this.indexer.url, this.indexer.name)),
            });

            const pageData = await parseNewznabXmlWithMeta(pageResponse.data);
            if (pageData.results.length === 0) break;

            if (isZyclops) {
              for (const result of pageData.results) {
                result.zyclopsVerified = true;
              }
            }

            results.push(...pageData.results);
            currentOffset += pageData.results.length;
            console.log(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              console.warn(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            console.warn(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      // Season pack search for ID-based TV searches (text search handles this inline above)
      const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
      if (includeSeasonPacks && episodesInSeason && title) {
        const spPaginationEnabled3 = config.searchConfig?.seasonPackPagination !== false;
        const spAdditionalPages3 = config.searchConfig?.seasonPackAdditionalPages;
        const seasonPackPagination3 = spPaginationEnabled3 && spAdditionalPages3 ? { enabled: true, maxPages: spAdditionalPages3 } : undefined;
        const sp = season.toString().padStart(2, '0');
        const packQuery = stripDiacritics(`${title} S${sp}`);
        console.log(`📦 Season pack search for: ${packQuery}`);
        const packResults = await this.search(packQuery, '5000', seasonPackPagination3);
        const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (packResults.length !== filteredPacks.length) {
          const keptLinks = new Set(filteredPacks.map(p => p.link));
          const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
          console.log(`   📦 Season pack filter: ${packResults.length} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
          removedPacks.forEach(r => console.log(`      ✂️  ${r.title}`));
        }
        if (filteredPacks.length > 0) console.log(`   📦 Found ${filteredPacks.length} season packs`);
        results.push(...filteredPacks);
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        console.warn(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
      } else {
        console.error(`❌ TV search error for ${this.indexer.name}:`);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
        } else {
          console.error(`   ${error.message}`);
        }
      }
      return [];
    }
  }
}

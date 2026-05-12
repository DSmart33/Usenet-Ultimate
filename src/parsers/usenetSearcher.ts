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
import { stripDiacritics, isTextSearchMatch, tagSeasonPack, normalizeTitle, extractTitleFromRelease, runSeriesPackQueries, buildSeriesPackPaginationMaxPages, buildSeasonPackPaginationMaxPages, extractSeasonTokens } from './titleMatching.js';
import { slog, withSubBuffer } from './searchLogger.js';

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

    slog(`🤖 Zyclops routing ${this.indexer.name}: ${this.indexer.url} → ${zyclopsUrl} ${JSON.stringify(extraParams)}`);

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

      slog(`🔍 Searching ${this.indexer.name}: ${effectiveUrl}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      slog(`   Query: "${query}", Category: ${category || 'all'}`);

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

      slog(`✅ Response received (${response.status}), parsing...`);

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      slog(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Tag results from Zyclops as pre-verified healthy
      if (isZyclops) {
        for (const result of results) {
          result.zyclopsVerified = true;
        }
        slog(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = paginationOverride?.enabled ?? (this.indexer.pagination === true);
      const maxExtraPages = paginationOverride?.maxPages ?? (this.indexer.maxPages ?? 3);
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;

        for (let page = 2; page <= maxExtraPages + 1 && currentOffset < total; page++) {
          slog(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
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
            slog(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        slog(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
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
        slog(`🔍 Movie text search for: ${title} ${year || ''}`);
        const query = stripDiacritics(year ? `${title} ${year}` : title);
        const results = await this.search(query, '2000'); // Category 2000 = Movies
        const before = results.length;
        const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        if (before !== filtered.length) {
          const removed = results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          slog(`   🎯 Title filter: ${before} → ${filtered.length} (removed ${removed.length} mismatches)`);
          removed.forEach(r => slog(`      ✂️  ${r.title}`));
        }
        return filtered;
      }

      if (method !== 'imdb' && method !== 'text' && !externalId) {
        slog(`⚠️  ${method} ID unavailable for ${this.indexer.name} — skipping`);
        return [];
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
        slog(`🔍 Movie search for ${externalId.idParam}: ${externalId.idValue}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      } else {
        params.imdbid = imdbId.replace('tt', '');  // Remove 'tt' prefix
        slog(`🔍 Movie search for IMDB: ${imdbId}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      }
      slog(`🔍 Searching ${this.indexer.name}: ${effectiveUrl}`);

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

      slog(`✅ Response received (${response.status}), parsing...`);

      const { results, total } = await parseNewznabXmlWithMeta(response.data);
      slog(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

      // Tag results from Zyclops as pre-verified healthy
      if (isZyclops) {
        for (const result of results) {
          result.zyclopsVerified = true;
        }
        slog(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
      }

      // Pagination: fetch additional pages if enabled and more results available
      const paginationEnabled = this.indexer.pagination === true;
      const maxExtraPages = this.indexer.maxPages ?? 3;
      if (paginationEnabled && total && results.length < total) {
        let currentOffset = results.length;

        for (let page = 2; page <= maxExtraPages + 1 && currentOffset < total; page++) {
          slog(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
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
            slog(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        slog(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
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
    options?: { numberingScheme?: 'seasonal' | 'absolute' | 'date'; absoluteEp?: number; airedDate?: string; includePacks?: boolean },
  ): Promise<NZBSearchResult[]> {
    try {
      const tvMethods = this.indexer.tvSearchMethod;
      const method = searchMethod || (Array.isArray(tvMethods) ? tvMethods[0] : tvMethods) || 'imdb';

      // Text-based search
      if (method === 'text') {
        const s = season.toString().padStart(2, '0');
        const e = episode.toString().padStart(2, '0');
        const isAbsolute = options?.numberingScheme === 'absolute' && options.absoluteEp !== undefined;
        // Date-numbered query: substitute YYYY.MM.DD for SxxExx. Used by the
        // alias fallback when TVDB has an aired date and releases are dated
        // rather than season/episode-numbered (e.g. daily talk shows).
        const isDate = options?.numberingScheme === 'date' && typeof options.airedDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(options.airedDate);
        const dateDotted = isDate ? options!.airedDate!.slice(0, 10).replace(/-/g, '.') : '';
        const query = isAbsolute
          ? stripDiacritics(`${title} E${options!.absoluteEp!.toString().padStart(2, '0')}`)
          : isDate
            ? stripDiacritics(`${title} ${dateDotted}`)
            : stripDiacritics(`${title} S${s}E${e}`);
        // On absolute-numbering retries, strip the bare E\d token before
        // matching: extractTitleFromRelease only anchors on SxxExx, so a release
        // like "Lady Of Law E23 1080p..." would extract as "Lady Of Law E23"
        // and fail equality. The \b boundary leaves "S03E23" untouched.
        // On date-numbered retries the same problem exists for embedded dates
        // (`Show.2024.05.21` extracts as `Show 2024 05 21`), so strip
        // `YYYY[.\s_-]MM[.\s_-]DD` runs from the candidate before matching.
        const datePattern = /\b(?:19|20)\d{2}[.\s_-]?(?:0[1-9]|1[0-2])[.\s_-]?(?:0[1-9]|[12]\d|3[01])\b/g;
        const matchTitle = isAbsolute
          ? (s: string) => s.replace(/\bE\d{1,3}\b/i, ' ').replace(/\s+/g, ' ')
          : isDate
            ? (s: string) => s.replace(datePattern, ' ').replace(/\s+/g, ' ')
            : (s: string) => s;

        const wantPacks = options?.includePacks !== false;
        const includeSeasonPacks = wantPacks && !isAbsolute && !isDate && (config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks);
        const includeMultiSeasonPacks = wantPacks && !isAbsolute && !isDate && (config.searchConfig?.includeMultiSeasonPacks ?? true);

        const tasks: Promise<NZBSearchResult[]>[] = [];

        // Primary episode fetch + filter, run as a parallel task alongside
        // pack queries. Wrapped in withSubBuffer so its filter logs render in
        // a contiguous block even though pack-task logs are interleaved.
        tasks.push(withSubBuffer(`TV text search [${this.indexer.name}] "${query}"`, async () => {
          slog(`🔍 [${this.indexer.name}] TV text search for: ${query}`);
          const results = await this.search(query, '5000'); // Category 5000 = TV
          const before = results.length;
          let filtered: NZBSearchResult[];
          let removed: NZBSearchResult[];
          if (isDate) {
            // Date-numbered match runs in two passes so each rejection cause
            // shows up in its own log block, matching the convention used by
            // the title / remake / multi-episode / disabled-encodes filters.
            //
            // Pass 1: date filter. The indexer treats the date tokens as fuzzy
            // keywords and returns releases dated any day that share the title
            // (e.g. a query for `Stephen Colbert 2025.09.02` brings back hits
            // dated 2025.09.16, 2025.12.09, etc). Re-verify the requested air
            // date is present in the release title.
            const [y, mo, d] = options!.airedDate!.slice(0, 10).split('-');
            const requestedDate = new RegExp(`\\b${y}[.\\s_-]?${mo}[.\\s_-]?${d}\\b`);
            const dateOk = (r: NZBSearchResult) => requestedDate.test(r.title);
            const dateFiltered = results.filter(dateOk);
            if (before !== dateFiltered.length) {
              const wrongDate = results.filter(r => !dateOk(r));
              slog(`   🎯 [${this.indexer.name}] Date filter: ${before} → ${dateFiltered.length} (removed ${wrongDate.length} wrong date${wrongDate.length === 1 ? '' : 's'})`);
              wrongDate.forEach(r => slog(`      ✂️  ${r.title}`));
            }

            // Pass 2: title filter. Daily/talk-show releases append the guest
            // name after the air date, so the extracted title for
            // `Show.<date>.Guest...` is `Show Guest` rather than `Show`.
            // Standard exact-title equality fails; require the alias to be a
            // prefix of the extracted release title instead.
            const normExpected = normalizeTitle(title);
            const titleOk = (r: NZBSearchResult): boolean => {
              const cleaned = matchTitle(r.title);
              const extractedNorm = normalizeTitle(extractTitleFromRelease(cleaned));
              return normExpected.length > 0 && extractedNorm.startsWith(normExpected);
            };
            filtered = dateFiltered.filter(titleOk);
            removed = dateFiltered.filter(r => !titleOk(r));
            if (dateFiltered.length !== filtered.length) {
              slog(`   🎯 [${this.indexer.name}] Title filter: ${dateFiltered.length} → ${filtered.length} (removed ${removed.length} mismatches)`);
              removed.forEach(r => slog(`      ✂️  ${r.title}`));
            }
          } else {
            // On absolute-numbering retries, also reject results whose title carries
            // an Sxx token that doesn't match the requested season. Catches
            // non-absolute shows whose absolute query accidentally surfaced
            // wrong-season episodes. Releases without any Sxx token (anime
            // "Show E150" form) still pass.
            const seasonOk = (resultTitle: string): boolean => {
              if (!isAbsolute) return true;
              const seasonTokens = extractSeasonTokens(resultTitle);
              return seasonTokens.length === 0 || seasonTokens.includes(season);
            };
            const matches = (r: NZBSearchResult) =>
              isTextSearchMatch(title, matchTitle(r.title), year, country, additionalTitles, titleYear)
              && seasonOk(r.title);
            filtered = results.filter(matches);
            removed = results.filter(r => !matches(r));
            if (before !== filtered.length) {
              slog(`   🎯 [${this.indexer.name}] Title filter: ${before} → ${filtered.length} (removed ${removed.length} mismatches)`);
              removed.forEach(r => slog(`      ✂️  ${r.title}`));
            }
          }
          return filtered;
        }));

        if (includeSeasonPacks) {
          const seasonPackPagination = buildSeasonPackPaginationMaxPages(config.searchConfig);
          const packQuery = stripDiacritics(`${title} S${s}`);
          tasks.push(withSubBuffer(`Season pack [${this.indexer.name}]: ${packQuery}`, async () => {
            slog(`🔍 [${this.indexer.name}] Season pack search for: ${packQuery}`);
            const packResults = await this.search(packQuery, '5000', seasonPackPagination);
            const packBefore = packResults.length;
            const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
            const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
            if (packBefore !== filteredPacks.length) {
              const keptLinks = new Set(filteredPacks.map(p => p.link));
              const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
              slog(`   📦 [${this.indexer.name}] Season pack filter: ${packBefore} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
              removedPacks.forEach(r => slog(`      ✂️  ${r.title}`));
            }
            if (filteredPacks.length > 0) {
              slog(`   📦 [${this.indexer.name}] Found ${filteredPacks.length} season packs${episodesInSeason ? ` (${episodesInSeason} eps/season, est. size per ep)` : ' (full pack size, episode count unknown)'}`);
            }
            return filteredPacks;
          }));
        }

        if (season > 1 && includeMultiSeasonPacks) {
          const fanoutPagination = buildSeriesPackPaginationMaxPages(config.searchConfig);
          const fanoutQuery = stripDiacritics(`${title} S01`);
          tasks.push(withSubBuffer(`Multi-season fanout [${this.indexer.name}]: ${fanoutQuery}`, async () => {
            slog(`🔍 [${this.indexer.name}] Multi-season fanout query: ${fanoutQuery}`);
            const fanoutResults = await this.search(fanoutQuery, '5000', fanoutPagination);
            const fanoutMatched = fanoutResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
            const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
            if (fanoutResults.length !== fanoutPacks.length) {
              slog(`   📦 [${this.indexer.name}] Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
            }
            if (fanoutPacks.length > 0) {
              slog(`   📦 [${this.indexer.name}] Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
            }
            return fanoutPacks;
          }));
        }

        if (includeMultiSeasonPacks) {
          const seriesPagination = buildSeriesPackPaginationMaxPages(config.searchConfig);
          tasks.push(withSubBuffer(`Series-pack keyword queries [${this.indexer.name}]`, () => runSeriesPackQueries({
            searchFn: (q) => this.search(q, '5000', seriesPagination),
            title, season, episodesInSeason,
            isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
            searchConfig: config.searchConfig,
            logPrefix: this.indexer.name,
          })));
        }

        const allArrays = await Promise.all(tasks);
        return allArrays.flat();
      }

      if (method !== 'imdb' && method !== 'text' && !externalId) {
        slog(`⚠️  ${method} ID unavailable for ${this.indexer.name} — skipping`);
        return [];
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
        slog(`🔍 TV search for ${externalId.idParam}: ${externalId.idValue} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      } else {
        params.imdbid = imdbId.replace('tt', '');  // Remove 'tt' prefix
        slog(`🔍 TV search for IMDB: ${imdbId} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}${isZyclops ? ' (via Zyclops, ' : ' '}${this.timeoutLabel()}${isZyclops ? ')' : ''}`);
      }
      slog(`🔍 Searching ${this.indexer.name}: ${effectiveUrl}`);

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

        slog(`✅ Response received (${response.status}), parsing...`);

        const parsed = await parseNewznabXmlWithMeta(response.data);
        results = parsed.results;
        total = parsed.total;
        slog(`   📦 Found ${results.length} results${total ? ` (total: ${total})` : ''}`);

        // Tag results from Zyclops as pre-verified healthy
        if (isZyclops) {
          for (const result of results) {
            result.zyclopsVerified = true;
          }
          slog(`🤖 Tagged ${results.length} result(s) as Zyclops-verified for ${this.indexer.name}`);
        }
      } catch (error: any) {
        if (error.code === 'ECONNABORTED') {
          this.timedOut = true;
          slog(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
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
          slog(`   📄 Fetching page ${page} (offset ${currentOffset})...`);
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
            slog(`   📄 Page ${page}: +${pageData.results.length} (total so far: ${results.length})`);
          } catch (pageError: any) {
            if (pageError.code === 'ECONNABORTED') {
              this.timedOut = true;
              slog(`⏱️  ${this.indexer.name} pagination page ${page} timed out after ${this.getTimeoutSeconds()}s`);
            }
            slog(`   ⚠️  Pagination page ${page} failed: ${pageError.message}`);
            break;
          }
        }
      }

      const packTasks: Promise<NZBSearchResult[]>[] = [];
      const wantPacks = options?.includePacks !== false;

      const includeSeasonPacks = wantPacks && (config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks);
      if (includeSeasonPacks && episodesInSeason && title) {
        const seasonPackPagination = buildSeasonPackPaginationMaxPages(config.searchConfig);
        const sp = season.toString().padStart(2, '0');
        const packQuery = stripDiacritics(`${title} S${sp}`);
        slog(`🔍 [${this.indexer.name}] Season pack search for: ${packQuery}`);
        packTasks.push((async () => {
          const packResults = await this.search(packQuery, '5000', seasonPackPagination);
          const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (packResults.length !== filteredPacks.length) {
            const keptLinks = new Set(filteredPacks.map(p => p.link));
            const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
            slog(`   📦 [${this.indexer.name}] Season pack filter: ${packResults.length} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
            removedPacks.forEach(r => slog(`      ✂️  ${r.title}`));
          }
          if (filteredPacks.length > 0) slog(`   📦 [${this.indexer.name}] Found ${filteredPacks.length} season packs`);
          return filteredPacks;
        })());
      }

      const includeMultiSeasonPacks = wantPacks && (config.searchConfig?.includeMultiSeasonPacks ?? true);
      if (season > 1 && includeMultiSeasonPacks && title) {
        const fanoutPagination = buildSeriesPackPaginationMaxPages(config.searchConfig);
        const fanoutQuery = stripDiacritics(`${title} S01`);
        slog(`🔍 [${this.indexer.name}] Multi-season fanout query: ${fanoutQuery}`);
        packTasks.push((async () => {
          const fanoutResults = await this.search(fanoutQuery, '5000', fanoutPagination);
          const fanoutMatched = fanoutResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
          const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
          if (fanoutResults.length !== fanoutPacks.length) {
            slog(`   📦 [${this.indexer.name}] Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
          }
          if (fanoutPacks.length > 0) slog(`   📦 [${this.indexer.name}] Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
          return fanoutPacks;
        })());
      }

      if (wantPacks && title && episodesInSeason) {
        packTasks.push(runSeriesPackQueries({
          searchFn: (q) => this.search(q, '5000', buildSeriesPackPaginationMaxPages(config.searchConfig)),
          title, season, episodesInSeason,
          isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
          searchConfig: config.searchConfig,
          logPrefix: this.indexer.name,
        }));
      }

      const packResultsArrays = await Promise.all(packTasks);
      for (const arr of packResultsArrays) results.push(...arr);

      return results;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        this.timedOut = true;
        slog(`⏱️  ${this.indexer.name} timed out after ${this.getTimeoutSeconds()}s`);
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

  /**
   * Standalone pack-query runner (season pack + multi-season fanout +
   * series-pack keyword queries). Used by callers that want pack queries to
   * fire concurrently with episode-method searches rather than inline. Returns
   * the union of all matching packs across the three pack-query types.
   */
  async searchTVShowPacks(
    title: string,
    season: number,
    episodesInSeason: number | undefined,
    year: string | undefined,
    country: string | undefined,
    additionalTitles: string[] | undefined,
    titleYear: string | undefined,
    options?: { numberingScheme?: 'seasonal' | 'absolute' | 'date' },
  ): Promise<NZBSearchResult[]> {
    if (!title) return [];
    const isAbsolute = options?.numberingScheme === 'absolute';
    const isDate = options?.numberingScheme === 'date';
    if (isAbsolute || isDate) return [];

    const s = season.toString().padStart(2, '0');
    const packTasks: Promise<NZBSearchResult[]>[] = [];

    const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
    if (includeSeasonPacks && episodesInSeason) {
      const seasonPackPagination = buildSeasonPackPaginationMaxPages(config.searchConfig);
      const packQuery = stripDiacritics(`${title} S${s}`);
      packTasks.push(withSubBuffer(`Season pack: ${packQuery}`, async () => {
        const packResults = await this.search(packQuery, '5000', seasonPackPagination);
        const titleMatched = packResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        const filteredPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (packResults.length !== filteredPacks.length) {
          const keptLinks = new Set(filteredPacks.map(p => p.link));
          const removedPacks = packResults.filter(r => !keptLinks.has(r.link));
          slog(`   📦 [${this.indexer.name}] Season pack filter: ${packResults.length} → ${filteredPacks.length} (removed ${removedPacks.length} mismatches)`);
          removedPacks.forEach(r => slog(`      ✂️  ${r.title}`));
        }
        if (filteredPacks.length > 0) slog(`   📦 [${this.indexer.name}] Found ${filteredPacks.length} season packs`);
        return filteredPacks;
      }));
    }

    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    if (season > 1 && includeMultiSeasonPacks) {
      const fanoutPagination = buildSeriesPackPaginationMaxPages(config.searchConfig);
      const fanoutQuery = stripDiacritics(`${title} S01`);
      packTasks.push(withSubBuffer(`Multi-season fanout: ${fanoutQuery}`, async () => {
        const fanoutResults = await this.search(fanoutQuery, '5000', fanoutPagination);
        const fanoutMatched = fanoutResults.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
        if (fanoutResults.length !== fanoutPacks.length) {
          slog(`   📦 [${this.indexer.name}] Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
        }
        if (fanoutPacks.length > 0) slog(`   📦 [${this.indexer.name}] Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
        return fanoutPacks;
      }));
    }

    if (episodesInSeason && includeMultiSeasonPacks) {
      packTasks.push(withSubBuffer(`Series-pack keyword queries`, () => runSeriesPackQueries({
        searchFn: (q) => this.search(q, '5000', buildSeriesPackPaginationMaxPages(config.searchConfig)),
        title, season, episodesInSeason,
        isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
        searchConfig: config.searchConfig,
        logPrefix: this.indexer.name,
      })));
    }

    const arrays = await Promise.all(packTasks);
    return arrays.flat();
  }
}

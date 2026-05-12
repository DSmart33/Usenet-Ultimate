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
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, buildSeriesPackPaginationAdditionalPages, buildSeasonPackPaginationAdditionalPages, extractSeasonTokens, normalizeTitle, extractTitleFromRelease } from '../parsers/titleMatching.js';
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
    isAnime?: boolean,
    searchAliases?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('movie');
    const idTasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const idSearchedNames: string[] = [];
    const textMethodNames: string[] = [];

    for (const [method, indexerNames] of groups) {
      if (method === 'text') {
        textMethodNames.push(...indexerNames);
        continue;
      }
      const params: Record<string, string> = {
        apikey: this.apiKey, extended: '1', indexers: indexerNames.join(','),
      };
      if (method === 'imdb') {
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
      idTasks.push(withSubBuffer(`movie ${method} search × ${indexerNames.length} indexer(s)`, () => this.doSearch(params)));
    }

    // Movie text queries only run against indexers that opted into 'text' via movieSearchMethod.
    // ID-method indexers stay on their ID endpoints; pack queries below keep the union intentionally.
    const allTextNames = [...new Set(textMethodNames)];
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    const animeFanoutEnabled = !!isAnime && !!additionalTitles?.length && !parallelAltEnabled;

    const canonicalTextPromise = allTextNames.length > 0 && title
      ? this.runTitleSearchMovie(title, title, year, country, additionalTitles, titleYear, allTextNames)
      : Promise.resolve([] as (NZBSearchResult & { indexerName: string })[]);

    const altPromises: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    if ((parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length && allTextNames.length > 0) {
      slog(parallelAltEnabled
        ? `🔀 NZBHydra parallel alt-title movie search: querying primary + ${additionalTitles.length} alt(s) concurrently`
        : `🎌 NZBHydra anime dual-title fan-out: querying primary + ${additionalTitles.length} alt(s)`);
      for (const alt of additionalTitles) {
        altPromises.push(this.runTitleSearchMovie(alt, alt, year, country, undefined, titleYear, allTextNames));
      }
    }

    const [idResults, canonicalResults, ...altResults] = await Promise.all([
      Promise.all(idTasks).then(sets => sets.flat()),
      canonicalTextPromise,
      ...altPromises,
    ]);
    let allResults: (NZBSearchResult & { indexerName: string })[] = [...idResults, ...canonicalResults, ...altResults.flat()];

    const skipSequentialAlt = parallelAltEnabled || animeFanoutEnabled;
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  NZBHydra: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut && !skipSequentialAlt) {
      const allNames = allTextNames;
      if (allNames.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alt-title retry`);
      }
      if (allNames.length > 0) {
        for (const altTitle of additionalTitles) {
          slog(`🔄 NZBHydra alt-title retry: "${altTitle}"`);
          const altFiltered = await this.runTitleSearchMovie(altTitle, altTitle, year, country, undefined, titleYear, allNames);
          if (altFiltered.length > 0) {
            allResults = altFiltered;
            break;
          }
        }
      }
    }

    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      const allNames = allTextNames;
      if (allNames.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alias-title fallback`);
      }
      if (allNames.length > 0) {
        const aliasPromises = searchAliases.map((alias) => {
          const q = stripDiacritics(year ? `${alias} ${year}` : alias);
          return withSubBuffer(`Alias fallback: "${q}"`, async () => {
            slog(`🔍 Query: "${q}"`);
            const params: Record<string, string> = {
              apikey: this.apiKey, extended: '1', t: 'search', q, cat: '2000', indexers: allNames.join(','),
            };
            const r = await this.doSearch(params);
            const f = r.filter(x => isTextSearchMatch(alias, x.title, year, country, undefined, titleYear));
            if (r.length !== f.length) slog(`   🎯 Alias "${alias}" filter: ${r.length} → ${f.length}`);
            return f;
          });
        });
        const aliasResults = (await Promise.all(aliasPromises)).flat();
        allResults = aliasResults;
      }
    }

    return allResults;
  }

  /**
   * Run a movie text-search query for one title against the given indexers.
   */
  private async runTitleSearchMovie(
    filterTitle: string,
    queryTitle: string,
    year: string | undefined,
    country: string | undefined,
    additionalFilterTitles: string[] | undefined,
    titleYear: string | undefined,
    indexerNames: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (indexerNames.length === 0) return [];
    const q = stripDiacritics(year ? `${queryTitle} ${year}` : queryTitle);
    return withSubBuffer(`movie text search "${queryTitle}"`, async () => {
      slog(`🔍 Query: "${q}"`);
      const params: Record<string, string> = {
        apikey: this.apiKey, extended: '1', t: 'search', q, cat: '2000', indexers: indexerNames.join(','),
      };
      const results = await this.doSearch(params);
      const filtered = results.filter(r => isTextSearchMatch(filterTitle, r.title, year, country, additionalFilterTitles, titleYear));
      if (results.length !== filtered.length) {
        slog(`   🎯 Title filter: ${results.length} → ${filtered.length}`);
        results.filter(r => !isTextSearchMatch(filterTitle, r.title, year, country, additionalFilterTitles, titleYear))
          .forEach(r => slog(`      ✂️  ${r.title}`));
      }
      return filtered;
    });
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
    isAnime?: boolean,
    searchAliases?: string[],
    episodeAired?: string,
    priorSeasonsEpisodeCount?: number,
    absoluteEpisodeNumber?: number,
    tvdbPriorSeasonsCount?: number,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('tv');
    const idTasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const idSearchedNames: string[] = [];
    const textMethodNames: string[] = [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    for (const [method, indexerNames] of groups) {
      if (method === 'text') {
        textMethodNames.push(...indexerNames);
        continue;
      }
      const params: Record<string, string> = {
        apikey: this.apiKey,
        extended: '1',
        indexers: indexerNames.join(','),
      };
      if (method === 'imdb') {
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
      idTasks.push(withSubBuffer(`TV ${method} search S${season}E${episode} × ${indexerNames.length} indexer(s)`, () => this.doSearch(params)));
    }

    const packIndexerNames = [...new Set([...textMethodNames, ...idSearchedNames])];
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    const animeFanoutEnabled = !!isAnime && !!additionalTitles?.length && !parallelAltEnabled;
    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    // Mirrors the gates inside runTitleSearchTV: SxxExx text query needs a text-method indexer,
    // pack work needs at least one pack feature enabled (and episodesInSeason for season packs).
    const hasAnyTextWork = textMethodNames.length > 0
      || (packIndexerNames.length > 0 && (
        includeMultiSeasonPacks
        || (!!config.searchConfig?.includeSeasonPacks && !!episodesInSeason)
      ));

    // epIndexerNames = text-method only (canonical SxxExx text query);
    // packIndexerNames = text + ID-method (pack queries are text-by-nature
    // regardless of an indexer's primary method).
    const canonicalTextPromise = hasAnyTextWork && title
      ? this.runTitleSearchTV(title, title, season, episode, episodesInSeason, year, country, additionalTitles, titleYear, textMethodNames, packIndexerNames)
      : Promise.resolve([] as (NZBSearchResult & { indexerName: string })[]);

    const altPromises: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    if ((parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length && hasAnyTextWork) {
      slog(parallelAltEnabled
        ? `🔀 NZBHydra parallel alt-title search: querying primary + ${additionalTitles.length} alt(s) concurrently`
        : `🎌 NZBHydra anime dual-title fan-out: querying primary + ${additionalTitles.length} alt(s)`);
      for (const alt of additionalTitles) {
        altPromises.push(this.runTitleSearchTV(alt, alt, season, episode, episodesInSeason, year, country, undefined, titleYear, textMethodNames, packIndexerNames));
      }
    }

    const [idResults, canonicalResults, ...altResults] = await Promise.all([
      Promise.all(idTasks).then(sets => sets.flat()),
      canonicalTextPromise,
      ...altPromises,
    ]);
    let allResults: (NZBSearchResult & { indexerName: string })[] = [...idResults, ...canonicalResults, ...altResults.flat()];

    const skipSequentialAlt = parallelAltEnabled || animeFanoutEnabled;
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  NZBHydra: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut && !skipSequentialAlt && hasAnyTextWork) {
      const allNames = packIndexerNames;
      if (allNames.length > 0) {
        for (const altTitle of additionalTitles) {
          slog(`🔄 NZBHydra alt-title retry: "${altTitle}"`);
          const altPackResults = await this.runTitleSearchTV(altTitle, altTitle, season, episode, episodesInSeason, year, country, undefined, titleYear, textMethodNames, allNames);
          if (altPackResults.length > 0) {
            allResults = altPackResults;
            break;
          }
          if (config.searchConfig?.absoluteEpisodeFallback !== false && textMethodNames.length > 0) {
            const absResults = await this.runAbsoluteSearchTV(altTitle, altTitle, season, episode, year, country, titleYear, textMethodNames, priorSeasonsEpisodeCount, absoluteEpisodeNumber, tvdbPriorSeasonsCount);
            if (absResults.length > 0) {
              allResults = absResults;
              break;
            }
          }
        }
      }
    }

    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.absoluteEpisodeFallback !== false) {
      // Absolute-episode is a text-shaped query; restrict to text-method indexers (mirrors movie-path alias fallback).
      const allNames = textMethodNames;
      if (allNames.length === 0) {
        slog(`⚠️  No text-method indexers, skipping absolute-episode fallback`);
      }
      if (allNames.length > 0) {
        const titlesToRetry = (parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length
          ? [title, ...additionalTitles]
          : [title];
        const absPromises = titlesToRetry.map(t => this.runAbsoluteSearchTV(t, t, season, episode, year, country, titleYear, allNames, priorSeasonsEpisodeCount, absoluteEpisodeNumber, tvdbPriorSeasonsCount));
        const absResults = (await Promise.all(absPromises)).flat();
        allResults.push(...absResults);
      }
    }

    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      // Alias query is text-shaped; restrict to text-method indexers.
      const allNames = textMethodNames;
      if (allNames.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alias-title fallback`);
      }
      if (allNames.length > 0) {
        const useDateScheme = typeof episodeAired === 'string' && /^\d{4}-\d{2}-\d{2}/.test(episodeAired);
        let dateOk: ((s: string) => boolean) | null = null;
        let stripDate: (s: string) => string = (s) => s;
        if (useDateScheme) {
          const [y, mo, d] = episodeAired!.slice(0, 10).split('-');
          const requestedDate = new RegExp(`\\b${y}[.\\s_-]?${mo}[.\\s_-]?${d}\\b`);
          dateOk = (t: string) => requestedDate.test(t);
          const datePattern = /\b(?:19|20)\d{2}[.\s_-]?(?:0[1-9]|1[0-2])[.\s_-]?(?:0[1-9]|[12]\d|3[01])\b/g;
          stripDate = (s: string) => s.replace(datePattern, ' ').replace(/\s+/g, ' ');
        }
        const aliasPromises = searchAliases.map((alias) => {
          const q = useDateScheme
            ? stripDiacritics(`${alias} ${episodeAired!.slice(0, 10).replace(/-/g, '.')}`)
            : stripDiacritics(`${alias} S${s}E${e}`);
          return withSubBuffer(`Alias fallback: "${q}"`, async () => {
            slog(`🔍 Query: "${q}"`);
            const params: Record<string, string> = {
              apikey: this.apiKey, extended: '1', t: 'search', q, cat: '5000', indexers: allNames.join(','),
            };
            const r = await this.doSearch(params);
            const dateFiltered = dateOk ? r.filter(x => dateOk!(x.title)) : r;
            if (dateOk && r.length !== dateFiltered.length) {
              slog(`   📅 Date filter: ${r.length} → ${dateFiltered.length}`);
            }
            // Daily/talk-show releases (date-scheme) carry the guest name
            // after the air date, so the extracted title is "Show Guest"
            // rather than "Show". Equality fails; require the alias to be a
            // prefix of the extracted release title instead. Mirrors the
            // Newznab path at usenetSearcher.ts:386-393.
            let f: typeof dateFiltered;
            if (useDateScheme) {
              const normExpected = normalizeTitle(alias);
              f = dateFiltered.filter(x => {
                const extractedNorm = normalizeTitle(extractTitleFromRelease(stripDate(x.title)));
                return normExpected.length > 0 && extractedNorm.startsWith(normExpected);
              });
            } else {
              f = dateFiltered.filter(x => isTextSearchMatch(alias, x.title, year, country, undefined, titleYear));
            }
            if (dateFiltered.length !== f.length) slog(`   🎯 Alias "${alias}" filter: ${dateFiltered.length} → ${f.length}`);
            return f;
          });
        });
        const aliasResults = (await Promise.all(aliasPromises)).flat();
        allResults = aliasResults;
      }
    }

    return allResults;
  }

  /**
   * Run the full text-mode flow (episode + season pack + multi-season fanout +
   * series-pack keywords) for one title against the given indexers.
   */
  /**
   * Two indexer-name lists:
   * - epIndexerNames: indexers with `text` configured. Receives the canonical
   *   SxxExx episode text query. Skipped when empty.
   * - packIndexerNames: text + ID-method indexers. Receives pack queries
   *   (S{nn}, S01 fanout, series-pack keywords) since pack queries are
   *   inherently text-based regardless of an indexer's primary method.
   */
  private async runTitleSearchTV(
    filterTitle: string,
    queryTitle: string,
    season: number,
    episode: number,
    episodesInSeason: number | undefined,
    year: string | undefined,
    country: string | undefined,
    additionalFilterTitles: string[] | undefined,
    titleYear: string | undefined,
    epIndexerNames: string[],
    packIndexerNames: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (epIndexerNames.length === 0 && packIndexerNames.length === 0) return [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');
    const epIndexersCsv = epIndexerNames.join(',');
    const packIndexersCsv = packIndexerNames.join(',');
    const tasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];

    if (epIndexerNames.length > 0) {
      const epQuery = stripDiacritics(`${queryTitle} S${s}E${e}`);
      tasks.push(withSubBuffer(`TV text search "${queryTitle}"`, async () => {
        slog(`🔍 [NZBHydra] Query: "${epQuery}"`);
        const params: Record<string, string> = {
          apikey: this.apiKey, extended: '1', t: 'search', q: epQuery, cat: '5000', indexers: epIndexersCsv,
        };
        const r = await this.doSearch(params);
        const f = r.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        if (r.length !== f.length) {
          slog(`   🎯 [NZBHydra] Title filter: ${r.length} → ${f.length}`);
          r.filter(x => !isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear))
            .forEach(x => slog(`      ✂️  ${x.title}`));
        }
        return f;
      }));
    }

    if (packIndexerNames.length > 0 && config.searchConfig?.includeSeasonPacks && episodesInSeason) {
      const spOverride = buildSeasonPackPaginationAdditionalPages(config.searchConfig);
      const packQuery = stripDiacritics(`${queryTitle} S${s}`);
      tasks.push(withSubBuffer(`Season pack: ${packQuery}`, async () => {
        const params: Record<string, string> = {
          apikey: this.apiKey, extended: '1', t: 'search', q: packQuery, cat: '5000', indexers: packIndexersCsv,
        };
        const packResults = await this.doSearch(params, spOverride);
        const titleMatched = packResults.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        const packs = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (packResults.length !== packs.length) {
          slog(`   📦 [NZBHydra] Season pack filter: ${packResults.length} → ${packs.length}`);
        }
        if (packs.length > 0) slog(`   📦 [NZBHydra] Found ${packs.length} season pack(s) for "${queryTitle}"`);
        return packs;
      }));
    }

    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    if (packIndexerNames.length > 0 && season > 1 && includeMultiSeasonPacks) {
      const fanoutOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
      const fanoutQuery = stripDiacritics(`${queryTitle} S01`);
      tasks.push(withSubBuffer(`Multi-season fanout: ${fanoutQuery}`, async () => {
        const params: Record<string, string> = {
          apikey: this.apiKey, extended: '1', t: 'search', q: fanoutQuery, cat: '5000', indexers: packIndexersCsv,
        };
        const fanoutResults = await this.doSearch(params, fanoutOverride);
        const fanoutMatched = fanoutResults.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
        if (fanoutResults.length !== fanoutPacks.length) {
          slog(`   📦 [NZBHydra] Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
        }
        if (fanoutPacks.length > 0) slog(`   📦 [NZBHydra] Found ${fanoutPacks.length} multi-season pack(s) covering S${season} for "${queryTitle}"`);
        return fanoutPacks;
      }));
    }

    if (packIndexerNames.length > 0 && includeMultiSeasonPacks) {
      const seriesOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
      tasks.push(withSubBuffer(`Series-pack keyword queries (${queryTitle})`, () => runSeriesPackQueries({
        searchFn: async (q) => {
          const params: Record<string, string> = {
            apikey: this.apiKey, extended: '1', t: 'search', q, cat: '5000', indexers: packIndexersCsv,
          };
          return this.doSearch(params, seriesOverride);
        },
        title: queryTitle, season, episodesInSeason,
        isTitleMatch: (rt) => isTextSearchMatch(filterTitle, rt, year, country, additionalFilterTitles, titleYear),
        searchConfig: config.searchConfig,
        logPrefix: 'NZBHydra',
      })));
    }

    const sets = await Promise.all(tasks);
    return sets.flat();
  }

  /**
   * Run an absolute-episode fallback query (`Title E{absoluteEp}`) for one title.
   * Strips bare `\bE\d{1,3}\b` from result titles before title matching, and
   * rejects results whose Sxx token doesn't match the requested season.
   */
  private async runAbsoluteSearchTV(
    filterTitle: string,
    queryTitle: string,
    season: number,
    episode: number,
    year: string | undefined,
    country: string | undefined,
    titleYear: string | undefined,
    indexerNames: string[],
    priorSeasonsEpisodeCount: number | undefined,
    absoluteEpisodeNumber: number | undefined,
    tvdbPriorSeasonsCount: number | undefined,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (indexerNames.length === 0) return [];
    let absoluteEp: number;
    if (typeof absoluteEpisodeNumber === 'number') absoluteEp = absoluteEpisodeNumber;
    else if (typeof tvdbPriorSeasonsCount === 'number') absoluteEp = tvdbPriorSeasonsCount + episode;
    else if (priorSeasonsEpisodeCount !== undefined) absoluteEp = priorSeasonsEpisodeCount + episode;
    else absoluteEp = episode;

    const query = stripDiacritics(`${queryTitle} E${absoluteEp.toString().padStart(2, '0')}`);
    return withSubBuffer(`Absolute fallback: "${query}"`, async () => {
      slog(`🔍 Query: "${query}"`);
      const params: Record<string, string> = {
        apikey: this.apiKey, extended: '1', t: 'search', q: query, cat: '5000', indexers: indexerNames.join(','),
      };
      const results = await this.doSearch(params);

      const stripAbsEp = (str: string) => str.replace(/\bE\d{1,3}\b/i, ' ').replace(/\s+/g, ' ');
      const seasonOk = (resultTitle: string): boolean => {
        const seasonTokens = extractSeasonTokens(resultTitle);
        return seasonTokens.length === 0 || seasonTokens.includes(season);
      };
      const filtered = results.filter(r =>
        isTextSearchMatch(filterTitle, stripAbsEp(r.title), year, country, undefined, titleYear)
        && seasonOk(r.title)
      );
      if (results.length !== filtered.length) {
        slog(`   🎯 Absolute filter: ${results.length} → ${filtered.length}`);
      }
      return filtered;
    });
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

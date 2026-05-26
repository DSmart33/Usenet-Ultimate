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
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, buildSeriesPackPaginationAdditionalPages, buildSeasonPackPaginationAdditionalPages, extractSeasonTokens, normalizeTitle, extractTitleFromRelease } from '../parsers/titleMatching.js';
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
    isAnime?: boolean,
    searchAliases?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const groups = this.groupByMethod('movie');
    const idSearches: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const idSearchedIndexerIds: string[] = [];
    const textMethodIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        textMethodIds.push(...indexerIds);
      } else {
        for (const indexerId of indexerIds) {
          const indexer = this.indexers.find(i => i.id === indexerId);
          const indexerName = indexer?.name || 'Unknown';
          const params: NewznabParams = { t: 'movie', cat: '2000' };

          if (method === 'imdb' && imdbId.startsWith('tt')) {
            params.imdbid = imdbId.replace('tt', '');
          } else if (method === 'tmdb' && resolvedIds?.get('tmdb')) {
            params.tmdbid = parseInt(resolvedIds.get('tmdb')!.idValue, 10);
          } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
            params.tvdbid = parseInt(resolvedIds.get('tvdb')!.idValue, 10);
          } else {
            slog(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}) — skipping`);
            continue;
          }

          idSearches.push(withSubBuffer(`movie ${method} search "${indexerName}"`, () => this.doNewznabSearch(indexerId, indexerName, params, undefined, method)));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    // Movie text queries only run against indexers that opted into 'text' via movieSearchMethod.
    // ID-method indexers stay on their ID endpoints; pack queries below keep the union intentionally.
    const allTextIndexerIds = [...new Set(textMethodIds)];
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    const animeFanoutEnabled = !!isAnime && !!additionalTitles?.length && !parallelAltEnabled;

    // Canonical text query
    const canonicalTextPromise = allTextIndexerIds.length > 0 && title
      ? this.runTitleSearchMovie(title, title, year, country, additionalTitles, titleYear, allTextIndexerIds)
      : Promise.resolve([] as (NZBSearchResult & { indexerName: string })[]);

    // Parallel-alt or anime fan-out
    const altPromises: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    if ((parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length && allTextIndexerIds.length > 0) {
      slog(parallelAltEnabled
        ? `🔀 Prowlarr parallel alt-title movie search: querying primary + ${additionalTitles.length} alt(s) concurrently`
        : `🎌 Prowlarr anime dual-title fan-out: querying primary + ${additionalTitles.length} alt(s)`);
      for (const alt of additionalTitles) {
        altPromises.push(this.runTitleSearchMovie(alt, alt, year, country, undefined, titleYear, allTextIndexerIds));
      }
    }

    const [idResults, canonicalResults, ...altResults] = await Promise.all([
      Promise.all(idSearches).then(sets => sets.flat()),
      canonicalTextPromise,
      ...altPromises,
    ]);
    let allResults = [...idResults, ...canonicalResults, ...altResults.flat()];

    // Sequential alt-title retry: skipped when parallel/anime fan-out fired.
    const skipSequentialAlt = parallelAltEnabled || animeFanoutEnabled;
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  Prowlarr: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut && !skipSequentialAlt) {
      const allIndexerIds = allTextIndexerIds;
      if (allIndexerIds.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alt-title retry`);
      }
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          slog(`🔄 Prowlarr alt-title retry: "${altTitle}"`);
          const altFiltered = await this.runTitleSearchMovie(altTitle, altTitle, year, country, undefined, titleYear, allIndexerIds);
          if (altFiltered.length > 0) {
            allResults = altFiltered;
            break;
          }
        }
      }
    }

    // Alias-title fallback: TVDB substring shortcuts.
    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      const allIndexerIds = allTextIndexerIds;
      if (allIndexerIds.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alias-title fallback`);
      }
      if (allIndexerIds.length > 0) {
        const aliasPromises = searchAliases.map((alias) => {
          const query = stripDiacritics(year ? `${alias} ${year}` : alias);
          return withSubBuffer(`Alias fallback: "${query}"`, async () => {
            slog(`🔍 Query: "${query}"`);
            const r = await this.doAggregateSearch(allIndexerIds, 'search', query, ['2000']);
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
   * Used by the canonical pass and by per-alt-title branches.
   */
  private async runTitleSearchMovie(
    filterTitle: string,
    queryTitle: string,
    year: string | undefined,
    country: string | undefined,
    additionalFilterTitles: string[] | undefined,
    titleYear: string | undefined,
    indexerIds: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (indexerIds.length === 0) return [];
    const query = stripDiacritics(year ? `${queryTitle} ${year}` : queryTitle);
    return withSubBuffer(`movie text search "${queryTitle}"`, async () => {
      slog(`🔍 Query: "${query}"`);
      const results = await this.doAggregateSearch(indexerIds, 'search', query, ['2000']);
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
    const idSearches: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    const idSearchedIndexerIds: string[] = [];
    const textMethodIds: string[] = [];

    for (const [method, indexerIds] of groups) {
      if (method === 'text') {
        textMethodIds.push(...indexerIds);
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

          if (method === 'imdb' && imdbId.startsWith('tt')) {
            params.imdbid = imdbId.replace('tt', '');
          } else if (method === 'tvdb' && resolvedIds?.get('tvdb')) {
            params.tvdbid = parseInt(resolvedIds.get('tvdb')!.idValue, 10);
          } else if (method === 'tvmaze' && resolvedIds?.get('tvmaze')) {
            params.tvmazeid = parseInt(resolvedIds.get('tvmaze')!.idValue, 10);
          } else {
            slog(`⚠️  ${method} ID unavailable for "${indexerName}" (id=${indexerId}) — skipping`);
            continue;
          }

          idSearches.push(withSubBuffer(`TV ${method} search S${season}E${episode} "${indexerName}"`, () => this.doNewznabSearch(indexerId, indexerName, params, undefined, method)));
          idSearchedIndexerIds.push(indexerId);
        }
      }
    }

    const packIndexerIds = [...new Set([...textMethodIds, ...idSearchedIndexerIds])];
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    const animeFanoutEnabled = !!isAnime && !!additionalTitles?.length && !parallelAltEnabled;
    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    // Mirrors the gates inside runTitleSearchTV: SxxExx text query needs a text-method indexer,
    // pack work needs at least one pack feature enabled (and episodesInSeason for season packs).
    const hasAnyTextWork = textMethodIds.length > 0
      || (packIndexerIds.length > 0 && (
        includeMultiSeasonPacks
        || (!!config.searchConfig?.includeSeasonPacks && !!episodesInSeason)
      ));

    // Canonical text + packs flow. epIndexerIds = text-method only (canonical
    // SxxExx text query); packIndexerIds = text + ID-method (pack queries are
    // text-by-nature regardless of an indexer's primary method).
    const canonicalTextPromise = hasAnyTextWork && title
      ? this.runTitleSearchTV(title, title, season, episode, episodesInSeason, year, country, additionalTitles, titleYear, textMethodIds, packIndexerIds)
      : Promise.resolve([]);

    // Parallel-alt or anime fan-out: per-alt text+packs concurrent with canonical
    const altPromises: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];
    if ((parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length && hasAnyTextWork) {
      slog(parallelAltEnabled
        ? `🔀 Prowlarr parallel alt-title search: querying primary + ${additionalTitles.length} alt(s) concurrently`
        : `🎌 Prowlarr anime dual-title fan-out: querying primary + ${additionalTitles.length} alt(s)`);
      for (const alt of additionalTitles) {
        altPromises.push(this.runTitleSearchTV(alt, alt, season, episode, episodesInSeason, year, country, undefined, titleYear, textMethodIds, packIndexerIds));
      }
    }

    const [idResults, canonicalResults, ...altResults] = await Promise.all([
      Promise.all(idSearches).then(sets => sets.flat()),
      canonicalTextPromise,
      ...altPromises,
    ]);
    let allResults = [...idResults, ...canonicalResults, ...altResults.flat()];

    // Sequential alt-title retry: skipped when parallel/anime fan-out fired.
    const skipSequentialAlt = parallelAltEnabled || animeFanoutEnabled;
    if (allResults.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  Prowlarr: skipping alt-title retry (prior timeout)`);
    }
    if (allResults.length === 0 && additionalTitles?.length && !this.timedOut && !skipSequentialAlt && hasAnyTextWork) {
      const allIndexerIds = packIndexerIds;
      if (allIndexerIds.length > 0) {
        for (const altTitle of additionalTitles) {
          slog(`🔄 Prowlarr alt-title retry: "${altTitle}"`);
          const altPackResults = await this.runTitleSearchTV(altTitle, altTitle, season, episode, episodesInSeason, year, country, undefined, titleYear, textMethodIds, allIndexerIds);
          if (altPackResults.length > 0) {
            allResults = altPackResults;
            break;
          }
          // Per-alt absolute fallback: try absolute for this alt before moving to the next.
          if (config.searchConfig?.absoluteEpisodeFallback !== false && textMethodIds.length > 0) {
            const absResults = await this.runAbsoluteSearchTV(altTitle, altTitle, season, episode, year, country, titleYear, textMethodIds, priorSeasonsEpisodeCount, absoluteEpisodeNumber, tvdbPriorSeasonsCount);
            if (absResults.length > 0) {
              allResults = absResults;
              break;
            }
          }
        }
      }
    }

    // Canonical absolute-episode fallback (and per-title in parallel/anime mode).
    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.absoluteEpisodeFallback !== false) {
      // Absolute-episode is a text-shaped query; restrict to text-method indexers (mirrors movie-path alias fallback).
      const allIndexerIds = textMethodIds;
      if (allIndexerIds.length === 0) {
        slog(`⚠️  No text-method indexers, skipping absolute-episode fallback`);
      }
      if (allIndexerIds.length > 0) {
        const titlesToRetry = (parallelAltEnabled || animeFanoutEnabled) && additionalTitles?.length
          ? [title, ...additionalTitles]
          : [title];
        const absPromises = titlesToRetry.map(t => this.runAbsoluteSearchTV(t, t, season, episode, year, country, titleYear, allIndexerIds, priorSeasonsEpisodeCount, absoluteEpisodeNumber, tvdbPriorSeasonsCount));
        const absResults = (await Promise.all(absPromises)).flat();
        allResults.push(...absResults);
      }
    }

    // Alias-title fallback: TVDB substring shortcuts (with date-numbered variant for daily/talk shows).
    if (allResults.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      // Alias query is text-shaped; restrict to text-method indexers.
      const allIndexerIds = textMethodIds;
      if (allIndexerIds.length === 0) {
        slog(`⚠️  No text-method indexers, skipping alias-title fallback`);
      }
      if (allIndexerIds.length > 0) {
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
          const query = useDateScheme
            ? stripDiacritics(`${alias} ${episodeAired!.slice(0, 10).replace(/-/g, '.')}`)
            : stripDiacritics(`${alias} S${s}E${e}`);
          return withSubBuffer(`Alias fallback: "${query}"`, async () => {
            slog(`🔍 Query: "${query}"`);
            const r = await this.doAggregateSearch(allIndexerIds, 'search', query, ['5000']);
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
   * series-pack keywords) for one title. Used by the canonical pass and by
   * per-alt-title branches (parallel-alt, anime fan-out, sequential alt retry).
   *
   * Two indexer-ID lists:
   * - epIndexerIds: indexers with `text` configured. Receives the canonical
   *   SxxExx episode text query. Skipped when empty.
   * - packIndexerIds: text + ID-method indexers. Receives pack queries
   *   (S{nn}, S01 fanout, series-pack keywords) since pack queries are
   *   inherently text-based regardless of an indexer's primary method.
   *   Matches Newznab's per-indexer behavior in searchOrchestrator where
   *   searchTVShowPacks fires text-based pack queries against every indexer.
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
    epIndexerIds: string[],
    packIndexerIds: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (epIndexerIds.length === 0 && packIndexerIds.length === 0) return [];
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');
    const tasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];

    if (epIndexerIds.length > 0) {
      const epQuery = stripDiacritics(`${queryTitle} S${s}E${e}`);
      tasks.push(withSubBuffer(`TV text search "${queryTitle}"`, async () => {
        slog(`🔍 [Prowlarr] Query: "${epQuery}"`);
        const r = await this.doAggregateSearch(epIndexerIds, 'search', epQuery, ['5000']);
        const f = r.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        if (r.length !== f.length) {
          slog(`   🎯 [Prowlarr] Title filter: ${r.length} → ${f.length}`);
          r.filter(x => !isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear))
            .forEach(x => slog(`      ✂️  ${x.title}`));
        }
        return f;
      }));
    }

    if (packIndexerIds.length > 0 && config.searchConfig?.includeSeasonPacks && episodesInSeason) {
      const spOverride = buildSeasonPackPaginationAdditionalPages(config.searchConfig);
      const packQuery = stripDiacritics(`${queryTitle} S${s}`);
      tasks.push(withSubBuffer(`Season pack: ${packQuery}`, async () => {
        const packResults = await this.doAggregateSearch(packIndexerIds, 'search', packQuery, ['5000'], spOverride);
        const titleMatched = packResults.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        const packs = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (packResults.length !== packs.length) {
          slog(`   📦 [Prowlarr] Season pack filter: ${packResults.length} → ${packs.length}`);
        }
        if (packs.length > 0) slog(`   📦 [Prowlarr] Found ${packs.length} season pack(s) for "${queryTitle}"`);
        return packs;
      }));
    }

    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    if (packIndexerIds.length > 0 && season > 1 && includeMultiSeasonPacks) {
      const fanoutOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
      const fanoutQuery = stripDiacritics(`${queryTitle} S01`);
      tasks.push(withSubBuffer(`Multi-season fanout: ${fanoutQuery}`, async () => {
        const fanoutResults = await this.doAggregateSearch(packIndexerIds, 'search', fanoutQuery, ['5000'], fanoutOverride);
        const fanoutMatched = fanoutResults.filter(x => isTextSearchMatch(filterTitle, x.title, year, country, additionalFilterTitles, titleYear));
        const fanoutPacks = tagSeasonPack(fanoutMatched, season, episodesInSeason);
        if (fanoutResults.length !== fanoutPacks.length) {
          slog(`   📦 [Prowlarr] Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
        }
        if (fanoutPacks.length > 0) slog(`   📦 [Prowlarr] Found ${fanoutPacks.length} multi-season pack(s) covering S${season} for "${queryTitle}"`);
        return fanoutPacks;
      }));
    }

    if (packIndexerIds.length > 0 && includeMultiSeasonPacks) {
      const seriesOverride = buildSeriesPackPaginationAdditionalPages(config.searchConfig);
      tasks.push(withSubBuffer(`Series-pack keyword queries (${queryTitle})`, () => runSeriesPackQueries({
        searchFn: (q) => this.doAggregateSearch(packIndexerIds, 'search', q, ['5000'], seriesOverride),
        title: queryTitle, season, episodesInSeason,
        isTitleMatch: (rt) => isTextSearchMatch(filterTitle, rt, year, country, additionalFilterTitles, titleYear),
        searchConfig: config.searchConfig,
        logPrefix: 'Prowlarr',
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
    indexerIds: string[],
    priorSeasonsEpisodeCount: number | undefined,
    absoluteEpisodeNumber: number | undefined,
    tvdbPriorSeasonsCount: number | undefined,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    if (indexerIds.length === 0) return [];
    let absoluteEp: number;
    if (typeof absoluteEpisodeNumber === 'number') absoluteEp = absoluteEpisodeNumber;
    else if (typeof tvdbPriorSeasonsCount === 'number') absoluteEp = tvdbPriorSeasonsCount + episode;
    else if (priorSeasonsEpisodeCount !== undefined) absoluteEp = priorSeasonsEpisodeCount + episode;
    else absoluteEp = episode;

    const query = stripDiacritics(`${queryTitle} E${absoluteEp.toString().padStart(2, '0')}`);
    return withSubBuffer(`Absolute fallback: "${query}"`, async () => {
      slog(`🔍 Query: "${query}"`);
      const results = await this.doAggregateSearch(indexerIds, 'search', query, ['5000']);

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


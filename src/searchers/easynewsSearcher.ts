/**
 * EasyNews Search Integration
 *
 * Searches EasyNews's Solr-based API for video files.
 * Results are normalized to NZBSearchResult for compatibility with the
 * existing sorting/filtering pipeline, but use direct download URLs
 * instead of NZB files.
 *
 * API: https://members.easynews.com/2.0/search/solr-search/
 * Auth: HTTP Basic Auth (username:password)
 */

import axios from 'axios';
import type { NZBSearchResult } from '../types.js';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, getSeriesPackAdditionalPages, getSeasonPackAdditionalPages, extractSeasonTokens, normalizeTitle, extractTitleFromRelease } from '../parsers/titleMatching.js';
import { slog, withSubBuffer } from '../parsers/searchLogger.js';

const EASYNEWS_SEARCH_URL = 'https://members.easynews.com/2.0/search/solr-search/';

// Non-video extensions to skip
const SKIP_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'txt', 'nfo', 'srt', 'sub', 'idx',
  'rar', 'zip', 'par2', 'exe', 'bat', 'r00', 'r01', 'sfv', 'nzb',
]);

// Video extensions to allow (whitelist approach for extra safety)
const VIDEO_EXTENSIONS = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg',
  'm4v', 'ts', 'vob', 'divx', 'ogm', 'ogv', '3gp', 'asf', 'rm',
  'rmvb', 'f4v', 'iso', 'img',
]);

// Minimum video duration in seconds (filter out samples)
const MIN_DURATION_SECONDS = 60;

interface EasynewsSearchResponse {
  data: any[];
  results?: number;
  numPages?: number;
  dlFarm?: string;
  dlPort?: string | number;
  downURL?: string;
}

export class EasynewsSearcher {
  private authHeader: string;
  private timedOut = false;

  constructor(
    private username: string,
    private password: string,
    private maxPages: number = 1,
    private timeoutEnabled: boolean = true,
    private timeoutSeconds: number = DEFAULT_INDEXER_TIMEOUT_SECONDS,
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  private getTimeoutMs(): number | undefined {
    if (!this.timeoutEnabled) return undefined;
    return this.timeoutSeconds * 1000;
  }

  private timeoutLabel(): string {
    return `[timeout=${this.timeoutEnabled ? `${this.timeoutSeconds}s` : 'disabled'}]`;
  }

  async searchMovie(
    title: string,
    year?: string,
    country?: string,
    additionalTitles?: string[],
    titleYear?: string,
    searchAliases?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    // Parallel alt-title mode: when the toggle is on and we have alts, fire
    // primary + each alt query concurrently and union filtered results. Skips
    // the standard zero-result alt-title retry below since alts already ran.
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    let filtered: (NZBSearchResult & { indexerName: string })[] = [];
    if (parallelAltEnabled) {
      slog(`🔀 EasyNews parallel alt-title search enabled — querying primary + ${additionalTitles!.length} alt(s) concurrently`);
      const titles = [title, ...additionalTitles!];
      const perTitle = await Promise.all(titles.map((t) => {
        const q = year ? `${t} ${year}` : t;
        return withSubBuffer(`Movie text search "${t}"`, async () => {
          slog(`🔍 Query ${this.timeoutLabel()}: "${q}"`);
          const r = await this.search(q);
          const f = r.filter(x => isTextSearchMatch(t, x.title, year, country, undefined, titleYear));
          if (r.length !== f.length) {
            const kept = new Set(f);
            const removed = r.filter(x => !kept.has(x));
            slog(`   📦 Title filter: ${r.length} → ${f.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return f;
        });
      }));
      filtered = perTitle.flat();
    } else {
      const query = year ? `${title} ${year}` : title;
      filtered = await withSubBuffer(`Movie text search "${title}"`, async () => {
        slog(`🔍 Query ${this.timeoutLabel()}: "${query}"`);
        const results = await this.search(query);
        const before = results.length;
        const f = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        if (before !== f.length) {
          slog(`   📦 Title filter: ${before} → ${f.length}`);
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .forEach(r => slog(`      ✂️  ${r.title}`));
        }
        return f;
      });
    }

    // Alternative-title retry: if 0 results and alternative titles exist, retry with each
    if (filtered.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  EasyNews: skipping alt-title retry (prior timeout)`);
    }
    if (filtered.length === 0 && additionalTitles?.length && !this.timedOut && !parallelAltEnabled) {
      for (const altTitle of additionalTitles) {
        const altQuery = year ? `${altTitle} ${year}` : altTitle;
        const altFiltered = await withSubBuffer(`Movie alt-title retry: "${altQuery}"`, async () => {
          slog(`🔄 Query: "${altQuery}"`);
          const altResults = await this.search(altQuery);
          const f = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          if (altResults.length !== f.length) {
            const kept = new Set(f);
            const removed = altResults.filter(x => !kept.has(x));
            slog(`   📦 Alt-title filter: ${altResults.length} → ${f.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return f;
        });
        if (altFiltered.length > 0) {
          filtered.push(...altFiltered);
          break;
        }
      }
    }

    // Alias-title fallback: TVDB substring shortcuts on zero-result.
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      const aliasPromises = searchAliases.map((alias) => {
        const q = year ? `${alias} ${year}` : alias;
        return withSubBuffer(`Alias fallback: "${q}"`, async () => {
          slog(`🔍 Query: "${q}"`);
          const r = await this.search(q);
          const f = r.filter(x => isTextSearchMatch(alias, x.title, year, country, undefined, titleYear));
          if (r.length !== f.length) {
            const kept = new Set(f);
            const removed = r.filter(x => !kept.has(x));
            slog(`   📦 Alias "${alias}" filter: ${r.length} → ${f.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return f;
        });
      });
      const aliasResults = (await Promise.all(aliasPromises)).flat();
      filtered.push(...aliasResults);
    }

    return filtered;
  }

  async searchTVShow(
    title: string,
    season: number,
    episode: number,
    episodesInSeason?: number,
    year?: string,
    country?: string,
    additionalTitles?: string[],
    titleYear?: string,
    priorSeasonsEpisodeCount?: number,
    absoluteEpisodeNumber?: number,
    tvdbPriorSeasonsCount?: number,
    searchAliases?: string[],
    episodeAired?: string,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    // Unified parallel batch: primary SxxExx + (when parallel-alt enabled)
    // alt SxxExx queries + (when packs enabled) primary S{nn} + alt S{nn} +
    // multi-season fanout (primary title only) + series-pack keyword queries
    // (primary title only) all in one Promise.all. Post-batch dedup by hash
    // preserves "episodes beat packs" ordering.
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    const spAdditionalPages = getSeasonPackAdditionalPages(config.searchConfig);
    const seriesPackPages = getSeriesPackAdditionalPages(config.searchConfig);

    if (parallelAltEnabled) {
      slog(`🔀 [EasyNews] Parallel alt-title search enabled, querying primary + ${additionalTitles!.length} alt(s) concurrently`);
    }

    type Kind = 'episode' | 'pack' | 'fanout' | 'seriesKw';
    type Job = { kind: Kind; jobTitle: string; results: (NZBSearchResult & { indexerName: string })[] };
    const tasks: Promise<Job>[] = [];

    const titlesForEpisode = parallelAltEnabled ? [title, ...additionalTitles!] : [title];
    for (const t of titlesForEpisode) {
      const epQuery = `${t} S${s}E${e}`;
      tasks.push(withSubBuffer(`TV text search [EasyNews] "${epQuery}"`, async () => {
        slog(`🔍 [EasyNews] Query ${this.timeoutLabel()}: "${epQuery}"`);
        const r = await this.search(epQuery);
        const f = r.filter(x => isTextSearchMatch(t, x.title, year, country, parallelAltEnabled ? undefined : additionalTitles, titleYear));
        if (r.length !== f.length) {
          const kept = new Set(f);
          const removed = r.filter(x => !kept.has(x));
          slog(`   📦 [EasyNews] Title filter: ${r.length} → ${f.length} (removed ${removed.length} mismatches)`);
          removed.forEach(x => slog(`      ✂️  ${x.title}`));
        }
        return { kind: 'episode' as const, jobTitle: t, results: f };
      }));
    }

    if (includeSeasonPacks && episodesInSeason) {
      const titlesForPack = parallelAltEnabled ? [title, ...additionalTitles!] : [title];
      for (const t of titlesForPack) {
        const packQuery = `${t} S${s}`;
        tasks.push(withSubBuffer(`Season pack [EasyNews]: ${packQuery}`, async () => {
          slog(`🔍 [EasyNews] Query: "${packQuery}"`);
          const r = await this.search(packQuery, spAdditionalPages);
          const matched = r.filter(x => isTextSearchMatch(t, x.title, year, country, parallelAltEnabled ? undefined : additionalTitles, titleYear));
          const tagged = tagSeasonPack(matched, season, episodesInSeason);
          if (r.length !== tagged.length) {
            const keptHashes = new Set(tagged.map(p => p.easynewsMeta!.hash));
            const removed = r.filter(x => !keptHashes.has(x.easynewsMeta!.hash));
            slog(`   📦 [EasyNews] Pack filter: ${r.length} → ${tagged.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return { kind: 'pack' as const, jobTitle: t, results: tagged };
        }));
      }
    }

    if (season > 1 && includeMultiSeasonPacks) {
      const fanoutQuery = `${title} S01`;
      tasks.push(withSubBuffer(`Multi-season fanout [EasyNews]: ${fanoutQuery}`, async () => {
        slog(`🔍 [EasyNews] Query: "${fanoutQuery}"`);
        const r = await this.search(fanoutQuery, seriesPackPages);
        const titleMatched = r.filter(x => isTextSearchMatch(title, x.title, year, country, additionalTitles, titleYear));
        const fanoutPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (r.length !== fanoutPacks.length) {
          const keptHashes = new Set(fanoutPacks.map(p => p.easynewsMeta!.hash));
          const removed = r.filter(x => !keptHashes.has(x.easynewsMeta!.hash));
          slog(`   📦 [EasyNews] Multi-season fanout filter: ${r.length} → ${fanoutPacks.length} (removed ${removed.length} mismatches)`);
          removed.forEach(x => slog(`      ✂️  ${x.title}`));
        }
        if (fanoutPacks.length > 0) {
          slog(`   📦 [EasyNews] Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
        }
        return { kind: 'fanout' as const, jobTitle: title, results: fanoutPacks };
      }));
    }

    if (includeMultiSeasonPacks) {
      tasks.push(withSubBuffer(`Series-pack keyword queries [EasyNews]`, async () => {
        const r = await runSeriesPackQueries({
          searchFn: (q) => this.search(q, seriesPackPages),
          title, season, episodesInSeason,
          isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
          searchConfig: config.searchConfig,
          logPrefix: 'EasyNews',
        });
        return { kind: 'seriesKw' as const, jobTitle: title, results: r };
      }));
    }

    const jobResults = await Promise.all(tasks);

    // Cross-task hash dedup. Each task already did its own per-job filtering
    // and tagging inside its sub-buffer; this loop only enforces "episodes
    // beat packs" ordering and drops duplicates by easynewsMeta.hash. Silent
    // (no slog) because everything that needed logging happened inside each
    // task's sub-buffer.
    let filtered: (NZBSearchResult & { indexerName: string })[] = [];
    const seen = new Set<string>();
    for (const j of jobResults) {
      if (j.kind !== 'episode') continue;
      for (const r of j.results) {
        const h = r.easynewsMeta!.hash;
        if (!seen.has(h)) { seen.add(h); filtered.push(r); }
      }
    }
    for (const j of jobResults) {
      if (j.kind === 'episode') continue;
      for (const r of j.results) {
        const h = r.easynewsMeta!.hash;
        if (!seen.has(h)) { seen.add(h); filtered.push(r); }
      }
    }

    // Sequential alt-title retry: zero-result fallback. Only fires in
    // non-parallel-alt mode (parallel mode already covers alt titles in the
    // batch above). Stays sequential by design.
    if (filtered.length === 0 && additionalTitles?.length && !parallelAltEnabled && this.timedOut) {
      slog(`   ⏱️  [EasyNews] Skipping alt-title retry (prior timeout)`);
    }
    if (filtered.length === 0 && additionalTitles?.length && !parallelAltEnabled && !this.timedOut) {
      for (const altTitle of additionalTitles) {
        const altQuery = `${altTitle} S${s}E${e}`;
        const altFiltered = await withSubBuffer(`Alt-title retry [EasyNews]: "${altQuery}"`, async () => {
          slog(`🔄 [EasyNews] Query: "${altQuery}"`);
          const altResults = await this.search(altQuery);
          const f = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          if (altResults.length !== f.length) {
            const kept = new Set(f);
            const removed = altResults.filter(x => !kept.has(x));
            slog(`   📦 [EasyNews] Alt-title filter: ${altResults.length} → ${f.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return f;
        });
        if (altFiltered.length > 0) {
          if (includeSeasonPacks && episodesInSeason) {
            const altPackQuery = `${altTitle} S${s}`;
            const altPacks = await withSubBuffer(`Alt-title season pack [EasyNews]: ${altPackQuery}`, async () => {
              slog(`🔍 [EasyNews] Query: "${altPackQuery}"`);
              const altPackResults = await this.search(altPackQuery, spAdditionalPages);
              const existingHashes = new Set(altFiltered.map(r => r.easynewsMeta!.hash));
              const titleMatched = altPackResults
                .filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
                .filter(r => !existingHashes.has(r.easynewsMeta!.hash));
              const tagged = tagSeasonPack(titleMatched, season, episodesInSeason);
              if (altPackResults.length !== tagged.length) {
                const keptHashes = new Set(tagged.map(p => p.easynewsMeta!.hash));
                const removed = altPackResults.filter(x => !keptHashes.has(x.easynewsMeta!.hash));
                slog(`   📦 [EasyNews] Alt-title pack filter: ${altPackResults.length} → ${tagged.length} (removed ${removed.length} mismatches)`);
                removed.forEach(x => slog(`      ✂️  ${x.title}`));
              }
              if (tagged.length > 0) slog(`   📦 [EasyNews] Found ${tagged.length} season pack(s) (alt-title)`);
              return tagged;
            });
            altFiltered.push(...altPacks);
          }
          filtered.push(...altFiltered);
          break;
        }
      }
    }

    // Absolute-episode fallback. Three-tier chain (TVDB canonical → TVDB
    // cumulative → Cinemeta cumulative → per-season). In parallel mode, retry
    // all titles concurrently; otherwise sequentially break-on-first-hit.
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.absoluteEpisodeFallback !== false) {
      let absoluteEp: number;
      if (typeof absoluteEpisodeNumber === 'number') {
        absoluteEp = absoluteEpisodeNumber;
      } else if (typeof tvdbPriorSeasonsCount === 'number') {
        absoluteEp = tvdbPriorSeasonsCount + episode;
      } else if (priorSeasonsEpisodeCount !== undefined) {
        absoluteEp = priorSeasonsEpisodeCount + episode;
      } else {
        slog(`⚠️  EasyNews absolute fallback: no prior-season count available, using per-season E${episode}`);
        absoluteEp = episode;
      }
      const stripAbsEp = (str: string) => str.replace(/\bE\d{1,3}\b/i, ' ').replace(/\s+/g, ' ');
      const seasonOk = (resultTitle: string): boolean => {
        const seasonTokens = extractSeasonTokens(resultTitle);
        return seasonTokens.length === 0 || seasonTokens.includes(season);
      };

      if (parallelAltEnabled && additionalTitles?.length) {
        const titles = [title, ...additionalTitles];
        const absPerTitle = await Promise.all(titles.map(t => {
          if (this.timedOut) return Promise.resolve([] as (NZBSearchResult & { indexerName: string })[]);
          const absQuery = `${t} E${absoluteEp.toString().padStart(2, '0')}`;
          return withSubBuffer(`Absolute fallback: "${absQuery}"`, async () => {
            slog(`🔍 Query: "${absQuery}"`);
            const r = await this.search(absQuery);
            const f = r.filter(x => isTextSearchMatch(t, stripAbsEp(x.title), year, country, undefined, titleYear) && seasonOk(x.title));
            if (r.length !== f.length) {
              const kept = new Set(f);
              const removed = r.filter(x => !kept.has(x));
              slog(`   🔢 Absolute filter: ${r.length} → ${f.length} (removed ${removed.length} mismatches)`);
              removed.forEach(x => slog(`      ✂️  ${x.title}`));
            }
            return f;
          });
        }));
        filtered.push(...absPerTitle.flat());
      } else {
        const candidates = [title, ...(additionalTitles ?? [])];
        for (const candTitle of candidates) {
          if (this.timedOut) break;
          const absQuery = `${candTitle} E${absoluteEp.toString().padStart(2, '0')}`;
          const absFiltered = await withSubBuffer(`Absolute fallback: "${absQuery}"`, async () => {
            slog(`🔍 Query: "${absQuery}"`);
            const absResults = await this.search(absQuery);
            const f = absResults.filter(r => isTextSearchMatch(candTitle, stripAbsEp(r.title), year, country, undefined, titleYear) && seasonOk(r.title));
            if (absResults.length !== f.length) {
              const kept = new Set(f);
              const removed = absResults.filter(x => !kept.has(x));
              slog(`   🔢 Absolute filter: ${absResults.length} → ${f.length} (removed ${removed.length} mismatches)`);
              removed.forEach(x => slog(`      ✂️  ${x.title}`));
            }
            return f;
          });
          if (absFiltered.length > 0) {
            filtered.push(...absFiltered);
            break;
          }
        }
      }
    }

    // Alias-title fallback: TVDB substring shortcuts on zero-result.
    // Date-numbered variant when episodeAired is set (daily/talk shows).
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
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
          ? `${alias} ${episodeAired!.slice(0, 10).replace(/-/g, '.')}`
          : `${alias} S${s}E${e}`;
        return withSubBuffer(`Alias fallback: "${q}"`, async () => {
          slog(`🔍 Query: "${q}"`);
          const r = await this.search(q);
          const dateFiltered = dateOk ? r.filter(x => dateOk!(x.title)) : r;
          if (dateOk && r.length !== dateFiltered.length) {
            const keptDate = new Set(dateFiltered);
            const removedDate = r.filter(x => !keptDate.has(x));
            slog(`   📅 Date filter: ${r.length} → ${dateFiltered.length} (removed ${removedDate.length} wrong date${removedDate.length === 1 ? '' : 's'})`);
            removedDate.forEach(x => slog(`      ✂️  ${x.title}`));
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
          if (dateFiltered.length !== f.length) {
            const kept = new Set(f);
            const removed = dateFiltered.filter(x => !kept.has(x));
            slog(`   📦 Alias "${alias}" filter: ${dateFiltered.length} → ${f.length} (removed ${removed.length} mismatches)`);
            removed.forEach(x => slog(`      ✂️  ${x.title}`));
          }
          return f;
        });
      });
      const aliasResults = (await Promise.all(aliasPromises)).flat();
      filtered.push(...aliasResults);
    }

    return filtered;
  }

  private async search(query: string, maxPagesOverride?: number): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const seenHashes = new Set<string>();
    const effectiveMaxPages = maxPagesOverride ?? this.maxPages;
    const userAgent = config.userAgents?.general || getLatestVersions().chrome;

    for (let page = 1; page <= effectiveMaxPages; page++) {
      const params = new URLSearchParams({
        fly: '2',
        sb: '1',
        pno: page.toString(),
        pby: '250',
        u: '1',
        chxu: '1',
        chxgx: '1',
        st: 'basic',
        gps: stripDiacritics(query),
        vv: '1',
        safeO: '0',
        s1: 'relevance',
        s1d: '-',
      });
      params.append('fty[]', 'VIDEO');

      slog(`   📄 EasyNews page ${page}/${effectiveMaxPages}...`);

      try {
        const response = await axios.get(EASYNEWS_SEARCH_URL, {
          params,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json, text/javascript, */*; q=0.9',
            'User-Agent': userAgent,
          },
          timeout: this.getTimeoutMs(),
        });

        const data = (typeof response.data === 'object' ? response.data : (() => { try { return JSON.parse(response.data); } catch { return {}; } })()) as EasynewsSearchResponse;
        if (!data.data || data.data.length === 0) break;

        const dlFarm = data.dlFarm || '';
        const dlPort = String(data.dlPort || '');
        const downURL = data.downURL || '';

        let pageCount = 0;
        const rejectReasons: Record<string, number> = {};
        for (const item of data.data) {
          const parsed = this.parseItem(item, dlFarm, dlPort, downURL, rejectReasons);
          if (!parsed) continue;
          if (seenHashes.has(parsed.easynewsMeta!.hash)) continue;
          seenHashes.add(parsed.easynewsMeta!.hash);
          allResults.push({ ...parsed, indexerName: 'EasyNews' });
          pageCount++;
        }

        if (pageCount === 0 && data.data.length > 0) {
          // Log rejection breakdown when all items are filtered — helps diagnose parsing issues
          const sample = data.data[0];
          const sampleExt = Array.isArray(sample) ? sample[11] : (sample?.extension || sample?.ext || '');
          const sampleFn = Array.isArray(sample) ? sample[10] : (sample?.fn || sample?.filename || '');
          slog(`   ⚠️  EasyNews page ${page}: all ${data.data.length} items rejected — ${JSON.stringify(rejectReasons)} (sample: fn="${sampleFn}" ext="${sampleExt}")`);
        } else {
          slog(`   📄 EasyNews page ${page}: ${pageCount} results (${allResults.length} total)`);
        }

        // Stop if we've fetched all pages
        const numPages = data.numPages || 1;
        if (page >= numPages) break;
      } catch (error: any) {
        if (error.code === 'ECONNABORTED') {
          this.timedOut = true;
          slog(`⏱️  EasyNews timed out after ${this.timeoutSeconds}s`);
        } else if (error.response?.status === 401) {
          console.error('❌ EasyNews authentication failed');
        } else {
          console.error(`❌ EasyNews search error (page ${page}):`, error.message);
        }
        break;
      }
    }

    slog(`   📦 EasyNews total: ${allResults.length} results`);
    return allResults;
  }

  private parseItem(
    item: any,
    dlFarm: string,
    dlPort: string,
    downURL: string,
    rejectReasons?: Record<string, number>,
  ): NZBSearchResult | null {
    const reject = (reason: string) => { if (rejectReasons) rejectReasons[reason] = (rejectReasons[reason] || 0) + 1; return null; };

    let hash: string, subject: string, filename: string, ext: string;
    let size: number | string, duration: string | number | null;
    let posted: string | number | null = null;
    let sig: string | null = null;

    if (Array.isArray(item)) {
      hash = item[0] || '';
      size = item[4] || 0;
      subject = item[6] || '';
      posted = item[8] ?? null;
      filename = item[10] || '';
      ext = item[11] || '';
      duration = item[14] || null;
      sig = (item as any).sig || null;
    } else if (item && typeof item === 'object') {
      hash = String(item.hash || item['0'] || item.id || '');
      subject = String(item.subject || item['6'] || '');
      filename = String(item.fn || item.filename || item['10'] || '');
      ext = String(item.extension || item.ext || item['11'] || '');
      size = item.size || item.rawSize || item.Length || item['4'] || 0;
      duration = item.runtime || item.duration || item['14'] || null;
      posted = (item.ts ?? item.timestamp ?? item['5'] ?? item['8'] ?? null) as string | number | null;
      sig = item.sig ? String(item.sig) : null;
    } else {
      return reject('bad-format');
    }

    // Filter: must have hash
    if (!hash) return reject('no-hash');

    // Normalize extension: strip leading dot if present
    ext = ext.replace(/^\./, '');

    // Filter: skip non-video extensions
    const extLower = ext.toLowerCase();
    if (SKIP_EXTENSIONS.has(extLower)) return reject('skip-ext');
    if (ext && !VIDEO_EXTENSIONS.has(extLower)) return reject('not-video-ext');

    // Filter: skip samples (check second half of filename to avoid false positives)
    const filenameLower = filename.toLowerCase();
    const halfLen = Math.floor(filenameLower.length / 2);
    if (filenameLower.substring(halfLen).includes('sample')) return reject('sample');

    // Filter: skip short videos (samples)
    const durationSec = this.parseDuration(duration);
    if (durationSec > 0 && durationSec < MIN_DURATION_SECONDS) return reject('short-duration');

    // Parse size
    const sizeBytes = typeof size === 'string' ? this.parseSize(size) : (size || 0);

    // Use filename.ext as the title — EasyNews filenames are clean release names
    // (e.g. "Show.Name.S05E08.1080p.WEBRip.DD5.1.x264-GRP.mkv")
    // Subject lines contain noisy Usenet headers (yEnc, part numbers, etc.) that
    // break both title matching and quality parsing
    const title = filename ? `${filename}.${ext}` : subject;

    // Parse posted date for age display
    let pubDate = '';
    if (posted != null) {
      const date = typeof posted === 'number' ? new Date(posted * 1000) : new Date(String(posted));
      if (!isNaN(date.getTime()) && date.getTime() <= Date.now()) {
        pubDate = date.toISOString();
      }
    }

    return {
      title,
      link: `easynews://${hash}`,
      size: sizeBytes,
      pubDate,
      duration: durationSec > 0 ? durationSec : undefined,
      category: 'EasyNews',
      attributes: {},
      easynewsMeta: { hash, filename, ext, dlFarm, dlPort, downURL, sig: sig || undefined },
    };
  }

  private parseDuration(d: string | number | null): number {
    if (d === null || d === undefined) return 0;
    if (typeof d === 'number') return d;
    if (!d) return 0;
    // "HH:MM:SS" or "MM:SS"
    const parts = d.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parseInt(d, 10) || 0;
  }

  private parseSize(s: string): number {
    if (!s) return 0;
    // Handle numeric strings directly
    const num = parseInt(s, 10);
    if (!isNaN(num) && String(num) === s.trim()) return num;
    // Handle "1.5 GB" style strings
    const match = s.match(/([\d.]+)\s*(KB|MB|GB|TB)/i);
    if (!match) return num || 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(value * (multipliers[unit] || 1));
  }
}

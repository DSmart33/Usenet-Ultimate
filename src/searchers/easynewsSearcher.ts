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
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { isTextSearchMatch, stripDiacritics } from '../parsers/titleMatching.js';

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

  constructor(
    private username: string,
    private password: string,
    private maxPages: number = 1,
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  async searchMovie(
    title: string,
    year?: string,
    country?: string,
    additionalTitles?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const query = year ? `${title} ${year}` : title;
    console.log(`🔍 EasyNews movie search: "${query}"`);
    const results = await this.search(query);
    const before = results.length;
    const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
    if (before !== filtered.length) {
      console.log(`   🎯 EasyNews title filter: ${before} → ${filtered.length}`);
      results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
        .forEach(r => console.log(`      ✂️  ${r.title}`));
    }

    // Alternative-title retry: if 0 results and alternative titles exist, retry with each
    if (filtered.length === 0 && additionalTitles?.length) {
      for (const altTitle of additionalTitles) {
        const altQuery = year ? `${altTitle} ${year}` : altTitle;
        console.log(`🔄 EasyNews retrying with alternative title: "${altQuery}"`);
        const altResults = await this.search(altQuery);
        const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country));
        console.log(`   🎯 EasyNews alt-title filter: ${altResults.length} → ${altFiltered.length}`);
        if (altFiltered.length > 0) {
          filtered.push(...altFiltered);
          break;
        }
      }
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
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');
    const query = `${title} S${s}E${e}`;
    console.log(`🔍 EasyNews TV search: "${query}"`);
    const results = await this.search(query);
    const before = results.length;
    const filtered = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles));
    if (before !== filtered.length) {
      console.log(`   🎯 EasyNews title filter: ${before} → ${filtered.length}`);
      results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles))
        .forEach(r => console.log(`      ✂️  ${r.title}`));
    }

    // Season pack search if enabled
    const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
    if (includeSeasonPacks && episodesInSeason) {
      const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
      const spAdditionalPages = spPaginationEnabled ? config.searchConfig?.seasonPackAdditionalPages : undefined;
      const packQuery = `${title} S${s}`;
      console.log(`🔍 EasyNews season pack search: "${packQuery}"`);
      const packResults = await this.search(packQuery, spAdditionalPages);
      const seasonPackPattern = new RegExp(`S0?${season}(?![._\\s-]?E\\d)`, 'i');
      const existingHashes = new Set(filtered.map(r => r.easynewsMeta!.hash));
      const packs = packResults
        .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(title, r.title, year, country, additionalTitles))
        .filter(r => !existingHashes.has(r.easynewsMeta!.hash))
        .map(r => ({
          ...r,
          isSeasonPack: true,
          estimatedEpisodeSize: episodesInSeason > 0 ? Math.round(r.size / episodesInSeason) : undefined,
        }));
      if (packResults.length !== packs.length) {
        const removed = packResults.filter(r =>
          !seasonPackPattern.test(r.title) || !isTextSearchMatch(title, r.title, year, country, additionalTitles)
        );
        if (removed.length > 0) {
          console.log(`   📦 EasyNews season pack filter: ${packResults.length} → ${packs.length}`);
          removed.forEach(r => console.log(`      ✂️  ${r.title}${!seasonPackPattern.test(r.title) ? ' (no season match)' : ' (title mismatch)'}`));
        }
      }
      if (packs.length > 0) {
        console.log(`   📦 EasyNews: ${packs.length} season packs`);
        filtered.push(...packs);
      }
    }

    // Alternative-title retry: if 0 results and alternative titles exist, retry with each
    if (filtered.length === 0 && additionalTitles?.length) {
      for (const altTitle of additionalTitles) {
        const altQuery = `${altTitle} S${s}E${e}`;
        console.log(`🔄 EasyNews retrying with alternative title: "${altQuery}"`);
        const altResults = await this.search(altQuery);
        const altFiltered = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country));
        console.log(`   🎯 EasyNews alt-title filter: ${altResults.length} → ${altFiltered.length}`);
        if (altFiltered.length > 0) {
          // Also check for season packs with the alternative title
          if (includeSeasonPacks && episodesInSeason) {
            const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
            const spAdditionalPages = spPaginationEnabled ? config.searchConfig?.seasonPackAdditionalPages : undefined;
            const altPackQuery = `${altTitle} S${s}`;
            console.log(`🔍 EasyNews alt-title season pack search: "${altPackQuery}"`);
            const altPackResults = await this.search(altPackQuery, spAdditionalPages);
            const seasonPackPattern = new RegExp(`S0?${season}(?![._\\s-]?E\\d)`, 'i');
            const existingHashes = new Set(altFiltered.map(r => r.easynewsMeta!.hash));
            const altPacks = altPackResults
              .filter(r => seasonPackPattern.test(r.title) && isTextSearchMatch(altTitle, r.title, year, country))
              .filter(r => !existingHashes.has(r.easynewsMeta!.hash))
              .map(r => ({
                ...r,
                isSeasonPack: true,
                estimatedEpisodeSize: episodesInSeason > 0 ? Math.round(r.size / episodesInSeason) : undefined,
              }));
            if (altPackResults.length !== altPacks.length) {
              const removed = altPackResults.filter(r =>
                !seasonPackPattern.test(r.title) || !isTextSearchMatch(altTitle, r.title, year, country)
              );
              if (removed.length > 0) {
                console.log(`   📦 EasyNews alt-title season pack filter: ${altPackResults.length} → ${altPacks.length}`);
                removed.forEach(r => console.log(`      ✂️  ${r.title}${!seasonPackPattern.test(r.title) ? ' (no season match)' : ' (title mismatch)'}`));
              }
            }
            if (altPacks.length > 0) {
              console.log(`   📦 EasyNews: ${altPacks.length} season packs (alt-title)`);
              altFiltered.push(...altPacks);
            }
          }
          filtered.push(...altFiltered);
          break;
        }
      }
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

      console.log(`   📄 EasyNews page ${page}/${effectiveMaxPages}...`);

      try {
        const response = await axios.get(EASYNEWS_SEARCH_URL, {
          params,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json, text/javascript, */*; q=0.9',
            'User-Agent': userAgent,
          },
          timeout: 30000,
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
          console.log(`   ⚠️  EasyNews page ${page}: all ${data.data.length} items rejected — ${JSON.stringify(rejectReasons)} (sample: fn="${sampleFn}" ext="${sampleExt}")`);
        } else {
          console.log(`   📄 EasyNews page ${page}: ${pageCount} results (${allResults.length} total)`);
        }

        // Stop if we've fetched all pages
        const numPages = data.numPages || 1;
        if (page >= numPages) break;
      } catch (error: any) {
        if (error.response?.status === 401) {
          console.error('❌ EasyNews authentication failed');
        } else {
          console.error(`❌ EasyNews search error (page ${page}):`, error.message);
        }
        break;
      }
    }

    console.log(`   📦 EasyNews total: ${allResults.length} results`);
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

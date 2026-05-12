/**
 * NZBDav Shared Utilities
 * Common helpers used across the NZBDav module.
 */

import { config as globalConfig } from '../config/index.js';
import { hasSeriesPackKeyword, extractSeasonTokens } from '../parsers/titleMatching.js';
import type { NZBDavConfig } from './types.js';

/**
 * Build an episode pattern regex for matching season/episode in filenames.
 * Used by stream resolution and auto-resolve to locate the correct episode
 * within a season pack or multi-episode release.
 */
export function buildEpisodePattern(season: number, episode: number, allowMultiEpisodeFiles: boolean): string {
  const s = season.toString().padStart(2, '0');
  const e = episode.toString().padStart(2, '0');
  return allowMultiEpisodeFiles
    ? `S${s}(?:[. _-]?E\\d+|-\\d{1,2})*(?:[. _-]?E${e}|-${e})(?!\\d)`
    : `S${s}[. _-]?E${e}(?!\\d|[. _-]?E\\d|-\\d)`;
}

/**
 * Build a date-pattern regex for daily/talk-show episode releases. Mirrors
 * the search-side date convention (separators `[. _-]?`, fixed digits derived
 * from the input). Returns undefined when the input is missing or doesn't
 * match `YYYY-MM-DD` form so callers can short the date pass without an
 * explicit guard. Word boundaries prevent partial-token matches.
 *
 * Used as a Pass-2 fallback when SxxExx-based library matching returns nothing
 * AND the search context has both an aired date and TVDB aliases (the same
 * gate the alias-fallback search uses).
 */
export function buildDateEpisodePattern(episodeAired: string | undefined): string | undefined {
  if (!episodeAired || !/^\d{4}-\d{2}-\d{2}/.test(episodeAired)) return undefined;
  const [y, m, d] = episodeAired.slice(0, 10).split('-');
  return `\\b${y}[. _-]?${m}[. _-]?${d}\\b`;
}

/**
 * Folder-name season filter. A folder is only worth scanning if its name
 * doesn't carry a season marker that contradicts the requested season.
 * Conservative: if the name has no season hint at all, or carries a range
 * / "complete" indicator, allow scanning. Reject only when the name
 * specifies a definite season (Sxx or SxxExx) that doesn't include the target.
 *
 * Used at the top level by the library scan (rejects whole pack folders that
 * can't contain the season) and recursively by findVideoFile (rejects
 * per-season subdirectories inside a multi-season pack).
 */
export function folderCouldContainSeason(basename: string, season: number): boolean {
  // Multi-season indicators — assume the folder could span the target.
  // Shared with the indexer-result filter via hasSeriesPackKeyword.
  if (hasSeriesPackKeyword(basename)) return true;

  // Collect every Sxx (with or without an Exx suffix) marker in the name.
  const seasonsFound = extractSeasonTokens(basename);
  if (seasonsFound.length === 0) return true;        // No marker, allow
  if (seasonsFound.includes(season)) return true;    // Direct match

  // Range form: S01-S04, S01-04, S01_S04. Hyphen or underscore allow the
  // second S to be omitted.
  for (const m of basename.matchAll(/S(\d{1,2})[-_]S?(\d{1,2})/gi)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Math.min(a, b) <= season && season <= Math.max(a, b)) return true;
  }
  // Range form: S01.S04, S01 S04. Dot or whitespace allowed only when both
  // endpoints start with S, so quality markers like "S02.1080p" cannot read
  // as a bogus range S02 to S10 (1080 has no leading S).
  for (const m of basename.matchAll(/S(\d{1,2})[._\s]+S(\d{1,2})/gi)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Math.min(a, b) <= season && season <= Math.max(a, b)) return true;
  }

  return false;
}

/**
 * Build an NZBDavConfig from the global config.
 * Centralizes the config → NZBDavConfig mapping used by routes and auto-resolve.
 */
export function buildNzbdavConfig(): NZBDavConfig {
  return {
    url: globalConfig.nzbdavUrl || 'http://localhost:3000',
    apiKey: globalConfig.nzbdavApiKey || '',
    webdavUrl: globalConfig.nzbdavWebdavUrl || globalConfig.nzbdavUrl || 'http://localhost:3000',
    webdavUser: globalConfig.nzbdavWebdavUser || '',
    webdavPassword: globalConfig.nzbdavWebdavPassword || '',
    moviesCategory: globalConfig.nzbdavMoviesCategory || 'Usenet-Ultimate-Movies',
    tvCategory: globalConfig.nzbdavTvCategory || 'Usenet-Ultimate-TV',
    scanUncategorized: globalConfig.searchConfig?.librarySearchScanUncategorized ?? true,
  };
}

/**
 * Check whether NZBDav library infrastructure is configured for use.
 * Encodes streamingMode + WebDAV URL + WebDAV user — does NOT include any
 * feature toggles. Each caller applies its own toggle (e.g.
 * `healthChecks.libraryPreCheck` or `searchConfig.displayLibraryInResults`).
 */
export function isNzbdavLibraryConfigured(): boolean {
  return globalConfig.streamingMode === 'nzbdav'
    && !!globalConfig.nzbdavWebdavUrl
    && !!globalConfig.nzbdavWebdavUser;
}

/**
 * Encode a raw WebDAV file path for use in URLs.
 * Splits on '/', filters out empty segments and traversal components,
 * and encodes each segment individually.
 */
export function encodeWebdavPath(rawPath: string): string {
  return '/' + rawPath
    .split('/')
    .filter(s => s && s !== '.' && s !== '..')
    .map(s => encodeURIComponent(s))
    .join('/');
}

/**
 * Create an Error with the `isNzbdavFailure` flag set.
 * The stream cache uses this flag to distinguish permanent failures
 * (cached as 'failed') from transient errors (deleted, allowing retry).
 */
// ── Delivery log ──────────────────────────────────────────────────────
// Tracks last logged delivery mode per video path to avoid repeating
// the same log line on every range request during active playback.
// Lives here (rather than streamHandler) to avoid a circular dependency
// between streamCache and streamHandler.

const lastDeliveryLog = new Map<string, { mode: 'pipe' | 'proxy' | 'direct'; at: number }>();

/** Get the delivery log map (used by streamHandler for dedup + TTL eviction) */
export function getDeliveryLog(): Map<string, { mode: 'pipe' | 'proxy' | 'direct'; at: number }> {
  return lastDeliveryLog;
}

/** Clear all delivery log entries (called from clearStreamCache) */
export function clearDeliveryLog(): void {
  lastDeliveryLog.clear();
}

/** Error message stored when an episode is only found in a combined multi-episode file */
export const MULTI_EPISODE_BLOCKED_ERROR = 'Episode only found in combined multi-episode file';

export function nzbdavError(message: string, isTimeout = false, isEpisodeSpecific = false): Error & { isNzbdavFailure: boolean; isTimeout: boolean; isEpisodeSpecific: boolean } {
  const err = new Error(message) as Error & { isNzbdavFailure: boolean; isTimeout: boolean; isEpisodeSpecific: boolean };
  err.isNzbdavFailure = true;
  err.isTimeout = isTimeout;
  err.isEpisodeSpecific = isEpisodeSpecific;
  return err;
}

/**
 * Transport-layer error thrown when WebDAV returns an error status (404, 410, etc.)
 * for a video file. Carries the videoPath so callers can evict the stale cache entry.
 */
export class WebDav404Error extends Error {
  readonly videoPath: string;
  readonly statusCode: number;
  constructor(videoPath: string, statusCode: number = 404) {
    super(`WebDAV upstream returned ${statusCode} for video path`);
    this.name = 'WebDav404Error';
    this.videoPath = videoPath;
    this.statusCode = statusCode;
  }
}

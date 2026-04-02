/**
 * NZBDav Shared Utilities
 * Common helpers used across the NZBDav module.
 */

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

const lastDeliveryLog = new Map<string, { mode: 'proxy' | 'direct'; at: number }>();

/** Get the delivery log map (used by streamHandler for dedup + TTL eviction) */
export function getDeliveryLog(): Map<string, { mode: 'proxy' | 'direct'; at: number }> {
  return lastDeliveryLog;
}

/** Clear all delivery log entries (called from clearStreamCache) */
export function clearDeliveryLog(): void {
  lastDeliveryLog.clear();
}

/** Error message stored when an episode is only found in a combined multi-episode file */
export const MULTI_EPISODE_BLOCKED_ERROR = 'Episode only found in combined multi-episode file';

export function nzbdavError(message: string, isTimeout = false): Error & { isNzbdavFailure: boolean; isTimeout: boolean } {
  const err = new Error(message) as Error & { isNzbdavFailure: boolean; isTimeout: boolean };
  err.isNzbdavFailure = true;
  err.isTimeout = isTimeout;
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

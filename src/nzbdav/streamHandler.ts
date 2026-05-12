/**
 * Stream Handler
 * Main stream preparation pipeline with 302 redirect to WebDAV proxy.
 * Handles NZB submission -> job polling -> video discovery -> redirect,
 * with automatic fallback on failure and self-redirect to reset Stremio's timer.
 */

import { Request, Response as ExpressResponse } from 'express';
import { config as globalConfig, getTvAllowMultiEpisode } from '../config/index.js';
import { pipeline } from 'stream';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { submitNzb, waitForJobCompletion } from './nzbdavApi.js';
import { waitForVideoFile, checkNzbLibrary, videoPathExists } from './videoDiscovery.js';
import { searchLibrary } from './librarySearch.js';
import { getOrCreateStream, getCacheKey, getDeadCacheKey, getStreamCache, isDeadNzb, isDeadNzbByUrl, evictReadyByVideoPath, setPrepareFn, cleanupExpiredCache, isVideoPathBroken, markVideoPathBroken, clearVideoPathBroken } from './streamCache.js';
import { getFallbackGroup } from './fallbackManager.js';
import { encodeWebdavPath, nzbdavError, getDeliveryLog, WebDav404Error, buildEpisodePattern, buildDateEpisodePattern, buildNzbdavConfig } from './utils.js';
import { getSessionPromise, getSessionBackups, ultimateFallbackFromCandidates, type UfBackupStream } from './ultimateFallback.js';
import { encodeTileEnvelope, incrementRedirectCounter, parseTilePayload } from './redirectHelpers.js';
import { formatBytes } from '../parsers/metadataParsers.js';
import { resolveBaseUrl } from '../utils/urlHelpers.js';
import { getCachedTitleByImdb } from '../idResolver.js';
import type { NZBDavConfig, StreamData, FallbackCandidate } from './types.js';

const pipelineAsync = promisify(pipeline);

// Register prepareStream into the cache to break the circular import
// (streamCache needs to call prepareStream, but importing it directly would create a cycle)
setPrepareFn(
  (nzbUrl, title, config, episodePattern, contentType, episodesInSeason, isSeasonPack, logPrefix) =>
    prepareStream(nzbUrl, title, config, episodePattern, contentType, episodesInSeason, isSeasonPack, logPrefix)
);

// ============================================================================
// Streaming Log Throttle
// ============================================================================
// During fallback processing, the same stream title may trigger multiple
// self-redirects and fallback attempts. Track request counts per stream
// and emit a compact summary every STREAM_LOG_INTERVAL_MS to avoid
// flooding the console with repetitive log lines.

const STREAM_LOG_INTERVAL_MS = 30_000;   // 30 seconds
const STREAM_LOG_STATE_TTL_MS = 3_600_000; // 1 hour — evict stale entries to prevent unbounded growth
const STREMIO_TIMEOUT_MS = 60_000;       // Stremio's built-in HTTP timeout
const STREMIO_SAFETY_MARGIN_MS = 5_000;  // Safety buffer when deciding whether to self-redirect
const MAX_SELF_REDIRECTS = Number(process.env.NZBDAV_MAX_SELF_REDIRECTS) || 500; // Safety cap on self-redirects — supports large fallback chains without infinite loops
const EXO_PLAYER_BUDGET_MS = 8_000;      // Max blocking time per post-redirect request (keeps ExoPlayer alive on Android)
const DEDUP_CACHE_TTL_MS = 600_000;      // 10 min — covers a typical play session's seeks/probes without library-check overhead; eviction mid-session self-heals via the broken-path marker + live videoPathExists gate
const LOBBY_CACHED_LOG_THROTTLE_MS = 15_000; // Suppress repeat "cached resolve served" lines within this window (matches /stream hit throttle)
// Self-redirect query params (internal, appended to stream URL during 302 redirects):
//   _rc — redirect count: how many self-redirects have occurred (prevents infinite loops)
//   _ci — candidate index: which fallback candidate to resume at (avoids restarting from 0)

interface StreamLogState {
  requests: number;
  disconnects: number;
  lastLogAt: number;
  /** True once the first request for this title has been logged in full */
  seenFirst: boolean;
}

const streamLogState = new Map<string, StreamLogState>();
const deadSkipLoggedGroups = new Map<string, number>(); // key → timestamp for TTL cleanup

// Delivery log lives in utils.ts to avoid circular dep between streamCache and streamHandler.
const lastDeliveryLog = getDeliveryLog();

/**
 * Returns true if this request should be logged in detail.
 * Otherwise increments counters and periodically emits a summary line.
 */
function shouldLogStreamRequest(title: string, event: 'request' | 'disconnect'): boolean {
  const now = Date.now();
  let state = streamLogState.get(title);

  if (!state) {
    state = { requests: 0, disconnects: 0, lastLogAt: now, seenFirst: false };
    streamLogState.set(title, state);
  }

  if (event === 'request') state.requests++;
  if (event === 'disconnect') state.disconnects++;

  // Always log the first request in full
  if (!state.seenFirst) {
    state.seenFirst = true;
    state.lastLogAt = now;
    state.requests = 0;
    state.disconnects = 0;
    return true;
  }

  // Emit a summary line every interval
  if (now - state.lastLogAt >= STREAM_LOG_INTERVAL_MS) {
    const reqs = state.requests;
    const discs = state.disconnects;
    state.requests = 0;
    state.disconnects = 0;
    state.lastLogAt = now;
    if (reqs > 0 || discs > 0) {
      console.log(`  \u{1F4CA} Streaming ${title}: ${reqs} request${reqs !== 1 ? 's' : ''}, ${discs} disconnect${discs !== 1 ? 's' : ''} in last ${STREAM_LOG_INTERVAL_MS / 1000}s`);
    }
    // Evict stale entries to prevent unbounded map growth
    for (const [key, s] of streamLogState) {
      if (now - s.lastLogAt > STREAM_LOG_STATE_TTL_MS) streamLogState.delete(key);
    }
    for (const [key, entry] of lastDeliveryLog) {
      if (now - entry.at > STREAM_LOG_STATE_TTL_MS) lastDeliveryLog.delete(key);
    }
    for (const [key, ts] of deadSkipLoggedGroups) {
      if (now - ts > STREAM_LOG_STATE_TTL_MS) deadSkipLoggedGroups.delete(key);
    }
    return false;
  }

  return false;
}

/**
 * Check if an error represents a client disconnect (seek, stop, navigation).
 * These are normal during video playback and should not be treated as failures.
 */
function isClientDisconnect(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { code?: string; message?: string };
  const code = err?.code || '';
  const message = err?.message || '';
  return code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'ECONNABORTED'
    || code === 'ERR_CANCELED'
    || code === 'ECONNRESET'
    || message === 'aborted'
    || message.includes('aborted');
}

// ── Stremio request dedup ────────────────────────────────────────────
// Caches successful deliveries for 10 min to deduplicate Stremio's rapid
// sequential requests (catalog browse → detail → play → range) and to
// short-circuit seeks in inline-proxy mode so they skip library check.
// Completely outside the cache pipeline — doesn't interfere with library checks.

interface CachedDelivery { streamData: StreamData; streamingMethod: 'pipe' | 'proxy' | 'direct'; timestamp: number }
const recentDeliveries = new Map<string, CachedDelivery>();

function cleanupRecentDeliveries(): void {
  const now = Date.now();
  for (const [key, entry] of recentDeliveries) {
    if (now - entry.timestamp > DEDUP_CACHE_TTL_MS) recentDeliveries.delete(key);
  }
}

/** Per-attempt budget in ms. Returns 0 (no limit) — UF uses its own per-mode timeouts. */
function getAttemptBudgetMs(_contentType?: string, _isSeasonPack?: boolean): number {
  return 0;
}

// ============================================================================
// Stream Preparation Pipeline
// ============================================================================

/**
 * Complete stream preparation pipeline:
 * 0. Check NZB library for existing video (skip grab if found)
 * 1. Submit NZB to NZBDav
 * 2. Poll history for completion/failure
 * 3. Find video file in WebDAV
 */
export async function prepareStream(
  nzbUrl: string,
  title: string,
  config: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
  isSeasonPack?: boolean,
  logPrefix = '',
): Promise<StreamData> {
  const totalBudgetMs = getAttemptBudgetMs(contentType, isSeasonPack);
  const unlimited = totalBudgetMs === 0;
  const budgetStart = Date.now();
  const remaining = () => unlimited ? '∞' : Math.max(0, Math.round((totalBudgetMs - (Date.now() - budgetStart)) / 1000));

  console.log(`\n${logPrefix}\u{1F3AC} Preparing stream: ${title}${episodePattern ? ` (selecting ${episodePattern})` : ''} [${contentType || 'unknown'}] \u23F1\uFE0F ${unlimited ? 'no limit' : `${Math.round(totalBudgetMs / 1000)}s budget`}`);

  // Step 0: Check NZB library first — authoritative freshness signal for
  // already-downloaded content. Runs unconditionally: it's the primary defense
  // against re-submitting an NZB whose video already exists on WebDAV, and
  // against serving stale in-memory cache paths (readyCache) after nzbdav
  // evicts content.
  const libraryResult = await checkNzbLibrary(title, config, episodePattern, contentType, episodesInSeason, logPrefix);
  if (libraryResult) {
    if (isVideoPathBroken(libraryResult.videoPath)) {
      console.log(`${logPrefix}\u{1F6AB} Library hit skipped (video path broken): ${libraryResult.videoPath}`);
    } else {
      console.log(`${logPrefix}\u2705 Stream ready (from library): ${title}\n`);
      return libraryResult;
    }
  }

  // Step 1: Submit NZB
  console.log(`${logPrefix}  \u23F1\uFE0F Submitting NZB... (${remaining()}s remaining)`);
  const nzoId = await submitNzb(nzbUrl, title, config, contentType, unlimited ? undefined : totalBudgetMs - (Date.now() - budgetStart), logPrefix);
  console.log(`${logPrefix}  \u23F1\uFE0F NZB submitted → ${remaining()}s remaining`);

  // Step 2: Wait for job to complete (or fail) — remaining budget
  await waitForJobCompletion(nzoId, config, unlimited ? 0 : totalBudgetMs - (Date.now() - budgetStart), undefined, contentType, logPrefix);
  console.log(`${logPrefix}  \u23F1\uFE0F Job done → ${remaining()}s remaining`);

  // Step 3: Find the video file — remaining budget
  const video = await waitForVideoFile(nzoId, title, config, episodePattern, contentType, episodesInSeason, logPrefix);

  // Step 4: Verify the video is actually servable via WebDAV (GET first byte).
  // HEAD isn't reliable — NZBDav returns 200 for HEAD even when content is gone.
  // Retry with exponential backoff using remaining budget — large files may take
  // time to become servable after NZBDav reports the job complete.
  const webdavBase = (config.webdavUrl || config.url).replace(/\/+$/, '');
  const probeUrl = `${webdavBase}${encodeWebdavPath(video.path)}`;
  const probeHeaders: Record<string, string> = { 'Range': 'bytes=0-0' };
  if (config.webdavUser && config.webdavPassword) {
    probeHeaders['Authorization'] = 'Basic ' + Buffer.from(`${config.webdavUser}:${config.webdavPassword}`).toString('base64');
  }
  const PROBE_TIMEOUT_MS = 10_000;
  const PROBE_RETRY_BASE_MS = 2_000;
  const PROBE_MAX_RETRIES = 2;
  let probeAttempt = 0;
  let probeSuccess = false;
  while (probeAttempt < PROBE_MAX_RETRIES) {
    const elapsed = Date.now() - budgetStart;
    if (!unlimited && elapsed >= totalBudgetMs) break; // out of budget
    try {
      const timeoutMs = unlimited ? PROBE_TIMEOUT_MS : Math.min(PROBE_TIMEOUT_MS, totalBudgetMs - elapsed);
      const probeResp = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(timeoutMs) });
      if (probeResp.status === 404 || probeResp.status === 410) {
        await probeResp.body?.cancel().catch(() => {});
        markVideoPathBroken(video.path);
        throw nzbdavError(`Video file not servable (${probeResp.status}): ${video.path}`, false, true);
      }
      if (probeResp.status === 206 || probeResp.status === 200) {
        probeSuccess = true;
        await probeResp.body?.cancel().catch(() => {});
        break;
      }
      await probeResp.body?.cancel().catch(() => {});
      // Unexpected status — count as an attempt and delay before retry
      probeAttempt++;
      console.warn(`${logPrefix}  ⚠️ Probe returned ${probeResp.status} — retrying (${probeAttempt}/${PROBE_MAX_RETRIES})...`);
      if (probeAttempt < PROBE_MAX_RETRIES) {
        const delay = Math.min(PROBE_RETRY_BASE_MS * Math.pow(2, probeAttempt - 1), 10_000);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      if ((err as any).isNzbdavFailure) throw err;
      probeAttempt++;
      if (probeAttempt >= PROBE_MAX_RETRIES || (!unlimited && (Date.now() - budgetStart) >= totalBudgetMs)) {
        console.warn(`${logPrefix}  ⚠️ Probe failed after ${probeAttempt} attempts: ${(err as Error).message}`);
        break;
      }
      const delay = Math.min(PROBE_RETRY_BASE_MS * Math.pow(2, probeAttempt - 1), 10_000);
      console.warn(`${logPrefix}  ⚠️ Probe attempt ${probeAttempt}/${PROBE_MAX_RETRIES} failed (${(err as Error).message}) — retrying in ${Math.round(delay / 1000)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (!probeSuccess) {
    markVideoPathBroken(video.path);
    throw nzbdavError(`Video file not servable (probe failed after ${probeAttempt} attempts): ${video.path}`, false, true);
  }

  const totalElapsed = Math.round((Date.now() - budgetStart) / 1000);
  console.log(`${logPrefix}\u2705 Stream ready: ${title} (${totalElapsed}s total)\n`);

  clearVideoPathBroken(video.path);
  return {
    nzoId,
    videoPath: video.path,
    videoSize: video.size,
  };
}

// ============================================================================
// Failure Video
// ============================================================================

const FAILURE_VIDEO_PATH = path.resolve(
  fs.existsSync(path.resolve('ui/dist/nzb_failure_video.mp4'))
    ? 'ui/dist/nzb_failure_video.mp4'
    : 'ui/public/nzb_failure_video.mp4'
);

const LIBRARY_BYPASS_VIDEO_PATH = path.resolve(
  fs.existsSync(path.resolve('ui/dist/library_bypass_armed_video.mp4'))
    ? 'ui/dist/library_bypass_armed_video.mp4'
    : 'ui/public/library_bypass_armed_video.mp4'
);

// Library-delete success placeholders. Each falls back to the bypass-armed
// MP4 when the dedicated asset isn't on disk yet so the route keeps working
// until the new assets are produced. Drop the new MP4s into ui/public/ with
// the matching filenames and the asset is picked up on next start.
function resolveDeleteVideoPath(filename: string): string {
  const distPath = path.resolve(`ui/dist/${filename}`);
  if (fs.existsSync(distPath)) return distPath;
  const publicPath = path.resolve(`ui/public/${filename}`);
  if (fs.existsSync(publicPath)) return publicPath;
  return LIBRARY_BYPASS_VIDEO_PATH;
}
const DELETE_ALL_VIDEO_PATH = resolveDeleteVideoPath('library_delete_all_video.mp4');
const DELETE_FILE_VIDEO_PATH = resolveDeleteVideoPath('library_delete_file_video.mp4');
const DELETE_PACK_VIDEO_PATH = resolveDeleteVideoPath('library_delete_pack_video.mp4');

/**
 * Serve the failure video (a 3-hour static "Stream Unavailable" screen).
 * The extreme duration ensures Stremio never considers the episode "completed"
 * so it won't mark it as watched or auto-advance to the next episode.
 */
async function sendFailureVideo(req: Request, res: ExpressResponse): Promise<void> {
  try {
    const stat = fs.statSync(FAILURE_VIDEO_PATH);
    const fileSize = stat.size;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.headers.range) {
      const match = req.headers.range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        // Clients (ExoPlayer especially) probe ahead with ranges past EOF.
        // Out-of-range starts must answer 416, not throw on a negative
        // Content-Length. Clamp end when the requested upper bound exceeds
        // the file so 0-N requests with N >= fileSize still serve cleanly.
        if (start >= fileSize) {
          res.status(416);
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          res.end();
          return;
        }
        const end = match[2] ? Math.min(parseInt(match[2]), fileSize - 1) : fileSize - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        const readStream = fs.createReadStream(FAILURE_VIDEO_PATH, { start, end });
        try {
          await pipelineAsync(readStream, res);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('\u274C Failure video stream error:', err);
          }
        }
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', fileSize);
    const readStream = fs.createReadStream(FAILURE_VIDEO_PATH);
    try {
      await pipelineAsync(readStream, res);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('\u274C Failure video stream error:', err);
      }
    }
  } catch (fileErr) {
    console.error('\u274C Failed to serve failure video:', fileErr);
    if (!res.headersSent) res.status(500).end();
  }
}

/**
 * Serve the library-bypass-armed video. Played when the user clicks the
 * "Query indexers on next search" tile after Ultimate Library short-circuits.
 * Conveys "bypass is armed; back out and search again to see indexer results."
 * Mirrors sendFailureVideo's Range handling so external players stream cleanly.
 */
export async function sendLibraryBypassArmedVideo(req: Request, res: ExpressResponse): Promise<void> {
  try {
    const stat = fs.statSync(LIBRARY_BYPASS_VIDEO_PATH);
    const fileSize = stat.size;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.headers.range) {
      const match = req.headers.range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        if (start >= fileSize) {
          res.status(416);
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          res.end();
          return;
        }
        const end = match[2] ? Math.min(parseInt(match[2]), fileSize - 1) : fileSize - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        const readStream = fs.createReadStream(LIBRARY_BYPASS_VIDEO_PATH, { start, end });
        try {
          await pipelineAsync(readStream, res);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('\u274C Library bypass video stream error:', err);
          }
        }
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', fileSize);
    const readStream = fs.createReadStream(LIBRARY_BYPASS_VIDEO_PATH);
    try {
      await pipelineAsync(readStream, res);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('\u274C Library bypass video stream error:', err);
      }
    }
  } catch (fileErr) {
    console.error('\u274C Failed to serve library bypass video:', fileErr);
    if (!res.headersSent) res.status(500).end();
  }
}

/**
 * Serve a placeholder MP4 for the library-delete tile flow. Range-aware so
 * Stremio can scrub. No-cache headers stop Stremio from serving a cached
 * body across repeat clicks.
 */
async function sendDeletePlaceholderVideo(req: Request, res: ExpressResponse, videoPath: string, errLabel: string): Promise<void> {
  try {
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    if (req.headers.range) {
      const match = req.headers.range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        if (start >= fileSize) {
          res.status(416);
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          res.end();
          return;
        }
        const end = match[2] ? Math.min(parseInt(match[2]), fileSize - 1) : fileSize - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        const readStream = fs.createReadStream(videoPath, { start, end });
        try {
          await pipelineAsync(readStream, res);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error(`\u274C Delete ${errLabel} video stream error:`, err);
          }
        }
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', fileSize);
    const readStream = fs.createReadStream(videoPath);
    try {
      await pipelineAsync(readStream, res);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`\u274C Delete ${errLabel} video stream error:`, err);
      }
    }
  } catch (fileErr) {
    console.error(`\u274C Failed to serve delete ${errLabel} video:`, fileErr);
    if (!res.headersSent) res.status(500).end();
  }
}

export async function sendDeleteAllSuccessVideo(req: Request, res: ExpressResponse): Promise<void> {
  return sendDeletePlaceholderVideo(req, res, DELETE_ALL_VIDEO_PATH, 'all-success');
}

export async function sendDeleteFileSuccessVideo(req: Request, res: ExpressResponse): Promise<void> {
  return sendDeletePlaceholderVideo(req, res, DELETE_FILE_VIDEO_PATH, 'file-success');
}

export async function sendDeletePackSuccessVideo(req: Request, res: ExpressResponse): Promise<void> {
  return sendDeletePlaceholderVideo(req, res, DELETE_PACK_VIDEO_PATH, 'pack-success');
}

export async function sendDeleteFailedVideo(req: Request, res: ExpressResponse): Promise<void> {
  // Failures reuse the existing nzb_failure_video.mp4 (already a "something
  // went wrong" asset) so we don't need a fourth dedicated file.
  return sendDeletePlaceholderVideo(req, res, FAILURE_VIDEO_PATH, 'failed');
}

// ============================================================================
// Express Handler
// ============================================================================

// Per-path log dedupe for Ultimate Library streams. The player (libmpv etc.)
// fires multiple range requests against /stream during a single playback;
// each hits the library-origin fast path and would otherwise emit the same
// log line repeatedly. Track recently-logged paths and suppress duplicates
// within a 30s window. Entries auto-prune via setTimeout (unref'd so timers
// don't block process exit).
const recentLoggedUltimateLibraryStreams = new Set<string>();
function logUltimateLibraryStream(decoded: string): void {
  if (recentLoggedUltimateLibraryStreams.has(decoded)) return;
  console.log(`📚 Ultimate Library stream: ${decoded}`);
  recentLoggedUltimateLibraryStreams.add(decoded);
  setTimeout(() => recentLoggedUltimateLibraryStreams.delete(decoded), 30_000).unref?.();
}

/**
 * Express handler for /nzbdav/stream endpoint
 * Supports automatic fallback: if the chosen NZB fails, tries the next candidates
 * from the fallback group until one succeeds or all are exhausted.
 */
export async function handleStream(
  req: Request,
  res: ExpressResponse,
  config: NZBDavConfig,
  trackGrabFn?: (indexerName: string, title: string) => void,
  proxyFn?: (req: Request, res: ExpressResponse, videoPath: string, usePipe: boolean) => Promise<void>
): Promise<void> {
  // Express returns string[] for repeated query keys (`?t=a&t=b`). Take the
  // most recent so the decoder treats it as a single string. Catches
  // accidental client double-set; not expected on the happy path.
  if (Array.isArray(req.query.t)) {
    const arr = req.query.t as unknown[];
    req.query.t = arr[arr.length - 1] as any;
  }

  // Library-origin fast path: search-time library scan emitted a tile pointing
  // at a pre-extracted file on WebDAV. Skip the whole NZB grab cycle (submit,
  // wait, find video) and dispatch directly via the existing /v proxy/direct/pipe
  // logic. Tile URL uses libraryVideoPath as the sole query param so it survives
  // Infuse's iOS handoff (which strips everything after the first '&'). The
  // /content/ prefix check below is the security boundary; only library tiles
  // emit this query param so no other source can spoof it.
  const libraryVideoPathParam = req.query.libraryVideoPath as string | undefined;
  if (libraryVideoPathParam) {
    const decoded = decodeURIComponent(libraryVideoPathParam);
    if (!decoded.startsWith('/content/')) {
      console.warn(`⚠️ Rejected library stream — path not under /content/: ${libraryVideoPathParam}`);
      res.status(400).end();
      return;
    }
    logUltimateLibraryStream(decoded);
    const lobbyFallbackOn = globalConfig.ultimateFallback?.enabled === true;
    let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'proxy';
    if (!lobbyFallbackOn) mode = 'proxy';
    if (mode === 'direct') {
      const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
      const directUrl = new URL(`${webdavBase}${encodeWebdavPath(decoded)}`);
      if (config.webdavUser) { directUrl.username = config.webdavUser; directUrl.password = config.webdavPassword || ''; }
      res.redirect(302, directUrl.href);
    } else if (proxyFn && !lobbyFallbackOn) {
      await proxyFn(req, res, decoded, mode !== 'proxy');
    } else {
      const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
      proxyUrl.searchParams.set('path', decoded);
      res.redirect(302, proxyUrl.href);
    }
    return;
  }

  // Tile URL is a single base64url-JSON envelope under `?t=`. iOS / Infuse
  // handoff truncates URLs at the first `&`, so all tile state is packed
  // into one query param. The envelope schema differs per tile type
  // (regular result tile vs UF lobby tile) but the encoding mechanism is
  // uniform; `parseTilePayload` runs all per-field type guards in one place
  // and returns a typed object the handler destructures cleanly.
  let nzbUrl: string;
  let title: string;
  let indexerName: string;
  let fallbackGroupId: string | undefined;
  let contentType: string | undefined;
  let seasonParam: string | undefined;
  let episodeParam: string | undefined;
  let tPackSessionKey: string | undefined;
  let tPackSp: string | undefined;
  let tPackEpcount: string | undefined;
  let tPackUserPick = false;
  let tPackRc: number | undefined;
  let tPackCi: number | undefined;
  const isUfTilePath = req.params.filename === 'ultimate-fallback';
  const payload = parseTilePayload(typeof req.query.t === 'string' ? req.query.t : undefined);
  fallbackGroupId = payload.fbg;
  tPackSessionKey = payload.sk;
  tPackRc = payload.rc;
  tPackCi = payload.ci;
  if (isUfTilePath) {
    // UF tile carries only sk + fbg (+ rc/ci on redirect). The lobby block
    // below uses sessionKey to find an existing UF session promise.
    nzbUrl = '';
    title = '';
    indexerName = '';
  } else {
    // Regular result tile. fbg+idx points into the in-memory fallback group;
    // url/title/indexer ride along as fallbacks for when the group has been
    // evicted (TTL elapsed) so a single-shot resolution is still possible.
    const group = fallbackGroupId ? getFallbackGroup(fallbackGroupId) : undefined;
    const cand = payload.idx !== undefined && group ? group.candidates[payload.idx] : undefined;
    nzbUrl = cand?.nzbUrl ?? payload.url ?? '';
    title = cand?.title ?? payload.title ?? '';
    indexerName = cand?.indexerName ?? payload.indexer ?? '';
    contentType = group?.type;
    seasonParam = payload.season !== undefined ? String(payload.season) : undefined;
    episodeParam = payload.episode !== undefined ? String(payload.episode) : undefined;
    tPackSp = payload.seasonpack === 1 ? '1' : undefined;
    tPackEpcount = payload.epcount !== undefined ? String(payload.epcount) : undefined;
    tPackUserPick = true;
  }
  const userPick = tPackUserPick;
  const sessionKey = tPackSessionKey;

  // UF tile clicks send only `sk` (no nzb/title) and rely on the lobby block below.
  // Regular requests must still provide nzb+title.
  const isUfTileRequest = !userPick && !!sessionKey && !nzbUrl && globalConfig.ultimateFallback?.enabled === true;
  if (!isUfTileRequest && (!nzbUrl || !title)) {
    res.status(400).send('Missing required parameters: nzb, title');
    return;
  }

  const streamStartTime = Date.now();

  // Build episode pattern for season pack file selection (e.g. "S02E05").
  // When the tile envelope carries an aired-date (daily/talk shows), append
  // a date-pattern alternation so the file picker matches either SxxExx or
  // YYYY.MM.DD-named files inside the pack. Restricted to a single show's
  // pack so the cross-show false-positive risk that gates the library scan's
  // two-pass approach doesn't apply here.
  let cachePattern: string | undefined;
  let filePattern: string | undefined;
  const epcountParam = tPackEpcount ?? (req.query.epcount as string | undefined);
  const episodesInSeason = epcountParam ? parseInt(epcountParam, 10) : undefined;
  const isSeasonPackRequest = (tPackSp ?? req.query.sp) === '1';
  if (seasonParam && episodeParam) {
    cachePattern = buildEpisodePattern(
      parseInt(seasonParam, 10),
      parseInt(episodeParam, 10),
      getTvAllowMultiEpisode(globalConfig),
    );
    const datePattern = buildDateEpisodePattern(payload.aired);
    filePattern = datePattern ? `(?:${cachePattern}|${datePattern})` : cachePattern;
  }

  // Build the list of candidates to try (primary first, then fallbacks).
  // Skip the initial candidate when nzbUrl/title are empty (UF tile request case):
  // a sentinel with empty fields would cause prepareStream to scan the library root
  // if it survived past the fbg-expansion block (e.g. when fbg is set but the group
  // has expired).
  const candidates: FallbackCandidate[] = [];
  if (nzbUrl && title) {
    candidates.push({ nzbUrl, title, indexerName, isSeasonPack: isSeasonPackRequest });
  }

  const fallbackEnabled = globalConfig.ultimateFallback?.enabled === true;
  const maxFallbacksSetting = globalConfig.ultimateFallback?.maxAttempts ?? 0; // 0 = unlimited (try all)

  // Check whether this request should produce detailed logs.
  // During fallback processing, a single stream title may generate multiple
  // self-redirect requests. shouldLogStreamRequest returns true for the
  // first request and then emits a compact summary every 30 s.
  const verbose = shouldLogStreamRequest(title, 'request');

  if (fallbackGroupId && fallbackEnabled) {
    const group = getFallbackGroup(fallbackGroupId);
    if (group) {
      // Walk from clicked index through end of group, then wrap to top through
      // clicked-1 — every untried candidate gets a turn. Same wrap-from-clicked
      // walk for both userPickFallback='fallback-chain' and 'uf-lobby' modes.
      candidates.length = 0;
      const clickedIdx = group.candidates.findIndex(
        c => c.nzbUrl === nzbUrl && c.title === title
      );
      if (clickedIdx >= 0) {
        candidates.push(...group.candidates.slice(clickedIdx));
        candidates.push(...group.candidates.slice(0, clickedIdx));
      } else {
        // Clicked NZB not found in group — push sentinel (skip empty for UF tile
        // requests) + all group candidates so the chain still has something to walk.
        if (nzbUrl && title) candidates.push({ nzbUrl, title, indexerName, isSeasonPack: isSeasonPackRequest });
        candidates.push(...group.candidates);
      }
      if (verbose) {
        const totalToTry = maxFallbacksSetting === 0
          ? candidates.length
          : Math.min(candidates.length, 1 + maxFallbacksSetting);
        console.log(`🔄 Fallback group loaded: ${candidates.length} candidates (trying up to ${totalToTry})`);
      }

      // If episode info wasn't in the request URL (individual episode stream),
      // use the group's stored episode so season pack fallbacks select the right file.
      if (!cachePattern && group.season && group.episode) {
        const s = parseInt(group.season, 10).toString().padStart(2, '0');
        const e = parseInt(group.episode, 10).toString().padStart(2, '0');
        const allowMultiEp = getTvAllowMultiEpisode(globalConfig);
        cachePattern = allowMultiEp
          ? `S${s}(?:[. _-]?E\\d+|-\\d{1,2})*(?:[. _-]?E${e}|-${e})(?!\\d)`
          : `S${s}[. _-]?E${e}(?!\\d|[. _-]?E\\d|-\\d)`;
        // Group envelope does not carry aired, so file pattern matches cache pattern here.
        filePattern = cachePattern;
      }
    }
  }

  const maxCandidates = !fallbackEnabled ? 1
    : maxFallbacksSetting === 0 ? candidates.length
    : Math.min(candidates.length, 1 + maxFallbacksSetting);
  const streamCacheMap = getStreamCache();
  // rc/ci are read first from the in-`t` envelope (so they survive iOS handoff
  // truncation). safeNum guards against NaN leaking from a malformed in-`t`
  // value (parseTilePayload drops non-numbers, but defense-in-depth here).
  const safeNum = (n: number | undefined): number | undefined =>
    typeof n === 'number' && !Number.isNaN(n) && n >= 0 ? n : undefined;
  const redirectCount = safeNum(tPackRc) ?? 0;
  const candidateStart = maxCandidates > 0
    ? Math.min(Math.max(0, safeNum(tPackCi) ?? 0), maxCandidates - 1)
    : 0;
  if (redirectCount > 0 || candidateStart > 0) {
    console.log(`📦 Decoded rc=${redirectCount} ci=${candidateStart} from t-envelope`);
  }
  // Evict expired entries once before the loop so isDeadNzb() trusts existence
  cleanupExpiredCache();
  cleanupRecentDeliveries();

  // Stremio dedup: return cached delivery for subsequent requests on the same stream (within 10 min).
  // Catches seeks, probes, and dupes without re-running library check or re-submitting NZBs.
  // Only for fresh initial requests; self-redirects (ci > 0) bypass dedup to allow fallback retry.
  // Cache stores the *resolved* delivery (which may differ from the clicked NZB when fallback-chain
  // walked past the click), so we don't gate on the clicked NZB's dead state; the cache hit is
  // already a known-good resolution.
  const isFreshRequest = candidateStart === 0;
  if (isFreshRequest && candidates.length > 0 && !isUfTileRequest) {
    {
      const dedupKey = getCacheKey(candidates[0].nzbUrl, candidates[0].title) + (cachePattern ? `:${cachePattern}` : '');
      const cached = recentDeliveries.get(dedupKey);
      if (cached
        && Date.now() - cached.timestamp < DEDUP_CACHE_TTL_MS
        && !isVideoPathBroken(cached.streamData.videoPath)
        && await videoPathExists(cached.streamData.videoPath, config)) {
        // Serve dupes / seeks / probes using the cached videoPath — no re-prep,
        // no library check, no submission. If the file is gone we fall through
        // to a fresh candidate loop via the live videoPathExists gate above.
        if (verbose) console.log(`📦 Stream dedup hit (delivered ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`);
        const fallbackOn = globalConfig.ultimateFallback?.enabled === true;
        const sizeSuffix = cached.streamData.videoSize ? ` (${formatBytes(cached.streamData.videoSize)})` : '';
        // Dedup the per-mode delivery log on this videoPath so repeat probes
        // don't spam the same line. lastDeliveryLog is shared with primary delivery.
        const lastCached = lastDeliveryLog.get(cached.streamData.videoPath);
        const shouldLogCachedDelivery = !lastCached || lastCached.mode !== cached.streamingMethod;
        lastDeliveryLog.set(cached.streamData.videoPath, { mode: cached.streamingMethod, at: Date.now() });
        if (cached.streamingMethod === 'direct') {
          const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
          const safePath = encodeWebdavPath(cached.streamData.videoPath);
          const directUrl = new URL(`${webdavBase}${safePath}`);
          if (config.webdavUser) {
            directUrl.username = config.webdavUser;
            directUrl.password = config.webdavPassword || '';
          }
          if (shouldLogCachedDelivery) console.log(`  ⇗️ Direct passthrough: → ${directUrl.hostname}${safePath}${sizeSuffix}`);
          res.redirect(302, directUrl.href);
        } else if (!fallbackOn && proxyFn) {
          // Inline proxy — no redirect, matches primary delivery path. Runs
          // another proxyVideoStream for this request; req.on('close') ensures
          // cleanup if the client aborts.
          const label = cached.streamingMethod === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
          if (shouldLogCachedDelivery) console.log(`  ${label} streaming: ${cached.streamData.videoPath}${sizeSuffix}`);
          await proxyFn(req, res, cached.streamData.videoPath, cached.streamingMethod !== 'proxy');
        } else {
          const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
          proxyUrl.searchParams.set('path', cached.streamData.videoPath);
          proxyUrl.searchParams.set('_fb', req.originalUrl);
          if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
          const label = cached.streamingMethod === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
          if (shouldLogCachedDelivery) console.log(`  ${label} 302 streaming: ${cached.streamData.videoPath}${sizeSuffix}`);
          res.redirect(302, proxyUrl.href);
        }
        return;
      }
    }
  }

  // ── Ultimate-Fallback Lobby ─────────────────────────────────────────
  // When Ultimate-Fallback is active and the user didn't explicitly pick a
  // stream tile (user_pick=1), await its session promise instead of starting
  // our own nzbdav submission. Self-redirect keeps ExoPlayer alive.
  if (!userPick && globalConfig.ultimateFallback?.enabled && sessionKey) {
    // On-tile-selection mode: UF didn't fire on search; trigger it here so
    // the existing await-flow below picks up the new session promise.
    if (
      globalConfig.ultimateFallback.whenToResolve === 'on-tile-selection'
      && globalConfig.streamingMode === 'nzbdav'
      && !getSessionPromise(sessionKey)
    ) {
      const group = fallbackGroupId ? getFallbackGroup(fallbackGroupId) : undefined;
      if (!group?.candidates?.length) {
        console.log(`👑 UF tile click but no fallback group (sk=${sessionKey}, fbg=${fallbackGroupId}) — falling through`);
      } else {
        console.log(`👑 UF fired on tile click [${sessionKey}]`);
        const ur = globalConfig.ultimateFallback;
        const onTileCachePattern = (group.type === 'series' && group.season && group.episode)
          ? buildEpisodePattern(parseInt(group.season, 10), parseInt(group.episode, 10), getTvAllowMultiEpisode(globalConfig))
          : undefined;
        // Group envelope does not carry aired, so file pattern matches cache pattern here.
        const onTileFilePattern = onTileCachePattern;
        ultimateFallbackFromCandidates(
          sessionKey, group.candidates, buildNzbdavConfig(),
          { candidateCount: ur.candidateCount, preferenceMode: ur.preferenceMode, archiveInspection: ur.archiveInspection, sampleCount: ur.sampleCount, maxAttempts: ur.maxAttempts, desiredBackups: ur.desiredBackups, backupProcessingLimit: ur.backupProcessingLimit, priorityMoviesTimeoutSeconds: ur.priorityMoviesTimeoutSeconds, priorityTvTimeoutSeconds: ur.priorityTvTimeoutSeconds, prioritySeasonPackTimeoutSeconds: ur.prioritySeasonPackTimeoutSeconds, speedMoviesTimeoutSeconds: ur.speedMoviesTimeoutSeconds, speedTvTimeoutSeconds: ur.speedTvTimeoutSeconds, speedSeasonPackTimeoutSeconds: ur.speedSeasonPackTimeoutSeconds, healthCheckIndexers: ur.healthCheckIndexers },
          onTileCachePattern, onTileFilePattern, group.type, group.episodesInSeason,
        ).catch(err => console.error('❌ Ultimate-Fallback error (on-tile-selection):', err));
      }
    }
    const sessionPromise = getSessionPromise(sessionKey);
    if (sessionPromise) {
      const elapsed = Date.now() - streamStartTime;
      const remainingMs = STREMIO_TIMEOUT_MS - elapsed - STREMIO_SAFETY_MARGIN_MS;
      if (remainingMs > 0 && redirectCount < MAX_SELF_REDIRECTS) {
        try {
          let stremioTimer: ReturnType<typeof setTimeout>;
          const streamData = await Promise.race([
            sessionPromise,
            new Promise<never>((_, reject) => {
              stremioTimer = setTimeout(
                () => reject(Object.assign(new Error('lobby timeout'), { isLobbyTimeout: true })),
                remainingMs,
              );
            }),
          ]).finally(() => clearTimeout(stremioTimer!));

          // Library is the source of truth — verify the cached primary still
          // exists in NZBDav before serving. The broken-path marker short-circuits
          // when /v has just observed a 4xx/5xx (PROPFIND lies for evicted content
          // whose directory entry persists). Falls through to UF backups / fresh
          // resolution if either signal says the file is gone.
          if (isVideoPathBroken(streamData.videoPath) || !await videoPathExists(streamData.videoPath, config)) {
            throw new Error('Primary path no longer available');
          }

          // Ultimate-Fallback resolved — deliver the stream
          const lobbyFallbackOn = globalConfig.ultimateFallback?.enabled === true;
          let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'proxy';
          if (!lobbyFallbackOn) mode = 'proxy';
          const lastLobby = lastDeliveryLog.get(streamData.videoPath);
          const shouldLogLobby = !lastLobby || lastLobby.mode !== mode;
          const nowTs = Date.now();
          // Throttle the cached-resolve log so range probes and seek bursts
          // don't emit one line per request; only relog after the window elapses.
          const shouldLogCached = !shouldLogLobby
            && (!lastLobby || (nowTs - lastLobby.at) >= LOBBY_CACHED_LOG_THROTTLE_MS);
          if (shouldLogLobby || shouldLogCached) {
            lastDeliveryLog.set(streamData.videoPath, { mode, at: nowTs });
          } else {
            // Keep mode current but don't push the throttle window forward
            lastDeliveryLog.set(streamData.videoPath, { mode, at: lastLobby!.at });
          }
          if (shouldLogLobby) console.log(`👑 Lobby: serving Ultimate-Fallback result for ${sessionKey}`);
          else if (shouldLogCached) console.log(`👑 Lobby: cached resolve served (sk=${sessionKey})`);
          const lobbySizeSuffix = streamData.videoSize ? ` (${formatBytes(streamData.videoSize)})` : '';
          if (mode !== 'direct') {
            const inline = proxyFn && !lobbyFallbackOn;
            const label = mode === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
            if (shouldLogLobby) console.log(`  ${label}${inline ? '' : ' 302'} streaming: ${streamData.videoPath}${lobbySizeSuffix}`);
            if (inline) {
              await proxyFn!(req, res, streamData.videoPath, mode !== 'proxy');
            } else {
              const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
              proxyUrl.searchParams.set('path', streamData.videoPath);
              proxyUrl.searchParams.set('_fb', req.originalUrl);
              if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
              res.redirect(302, proxyUrl.href);
            }
          } else {
            const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
            const directUrl = new URL(`${webdavBase}${encodeWebdavPath(streamData.videoPath)}`);
            if (config.webdavUser) { directUrl.username = config.webdavUser; directUrl.password = config.webdavPassword || ''; }
            res.redirect(302, directUrl.href);
          }
          return;
        } catch (err) {
          if ((err as any).isLobbyTimeout) {
            // Stremio timeout approaching — self-redirect to keep ExoPlayer alive.
            // Site 1 of 6: rc carried inside the `t` envelope so it survives iOS handoff.
            const redirectUrl = incrementRedirectCounter(req);
            console.log(`👑 Lobby: self-redirect (${Math.round((Date.now() - streamStartTime) / 1000)}s elapsed, redirect ${redirectCount + 1})`);
            res.redirect(302, redirectUrl.href);
            return;
          }
          // Two reasons we land here:
          //   1. Primary path went dead mid-session — the UF tile block below
          //      iterates the session's vetted backups and serves the next one.
          //   2. Session promise rejected (all candidates exhausted) — no
          //      backups to fall back to; the single-attempt path below kicks in.
          // The "primary path no longer available" message already logged the
          // first case; only log here for the second.
          if ((err as Error).message !== 'Primary path no longer available') {
            console.log(`👑 Lobby: session ended without resolution — falling through to single attempt`);
          }
        }
      }
    }
  }

  // UF tile request (no nzb/title in URL). If the Lobby's primary is unavailable,
  // iterate the session's UF-vetted backup streams and serve the first whose
  // videoPath still exists in NZBDav — no candidate loop, no re-submit, no TTL
  // coupling. /v's _fb param bounces back to this tile URL on mid-stream break,
  // which re-enters here and picks the next backup (previous now missing).
  if (isUfTileRequest) {
    const ufBackups = sessionKey ? getSessionBackups(sessionKey) : null;
    let usable: UfBackupStream | undefined;
    for (const b of ufBackups?.backupStreams ?? []) {
      if (isVideoPathBroken(b.videoPath)) continue;
      if (await videoPathExists(b.videoPath, config)) { usable = b; break; }
    }
    if (usable) {
      const idxTag = usable.candidateIndex !== undefined ? `#${usable.candidateIndex} ` : '';
      console.log(`👑 Ultimate-Fallback [${sessionKey}] Primary path no longer available — falling back to backup: ${idxTag}${usable.title} [${usable.indexerName}]`);
      const lobbyFallbackOn = globalConfig.ultimateFallback?.enabled === true;
      let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'proxy';
      if (!lobbyFallbackOn) mode = 'proxy';
      if (mode === 'direct') {
        const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
        const directUrl = new URL(`${webdavBase}${encodeWebdavPath(usable.videoPath)}`);
        if (config.webdavUser) { directUrl.username = config.webdavUser; directUrl.password = config.webdavPassword || ''; }
        res.redirect(302, directUrl.href);
      } else if (proxyFn && !lobbyFallbackOn) {
        await proxyFn(req, res, usable.videoPath, mode !== 'proxy');
      } else {
        const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
        proxyUrl.searchParams.set('path', usable.videoPath);
        proxyUrl.searchParams.set('_fb', req.originalUrl);
        if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
        res.redirect(302, proxyUrl.href);
      }
      return;
    }
    // Fall-through: after UF-vetted backups exhausted, redirect to the first
    // untried fallback-group candidate. Encoded as the canonical tile
    // envelope so the handler's user-pick path takes over (presence of
    // url/title/indexer in the payload implies user-pick); sequential
    // iteration walks the rest of the chain in one handleStream invocation,
    // skipping broken candidates via prepareStream's library-pre-check + dedup.
    const groupForFallthrough = fallbackGroupId ? getFallbackGroup(fallbackGroupId) : undefined;
    const triedUrls = ufBackups?.backupUrls ?? new Set<string>();
    const nextCandidate = (groupForFallthrough?.candidates ?? []).find(c => !triedUrls.has(c.nzbUrl));
    if (nextCandidate && groupForFallthrough) {
      const remaining = groupForFallthrough.candidates.filter(c => !triedUrls.has(c.nzbUrl)).length;
      const filename = encodeURIComponent(nextCandidate.title || 'stream');
      const seasonNum = groupForFallthrough.season ? parseInt(groupForFallthrough.season, 10) : undefined;
      const episodeNum = groupForFallthrough.episode ? parseInt(groupForFallthrough.episode, 10) : undefined;
      const includeSeasonPack = nextCandidate.isSeasonPack && seasonNum != null && episodeNum != null && !Number.isNaN(seasonNum) && !Number.isNaN(episodeNum);
      const fallthroughT = encodeTileEnvelope({
        url: nextCandidate.nzbUrl,
        title: nextCandidate.title,
        indexer: nextCandidate.indexerName,
        ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
        ...(sessionKey ? { sk: sessionKey } : {}),
        ...(includeSeasonPack ? {
          season: seasonNum,
          episode: episodeNum,
          seasonpack: 1 as const,
          ...(groupForFallthrough.episodesInSeason != null ? { epcount: groupForFallthrough.episodesInSeason } : {}),
        } : {}),
      });
      const fallthroughUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/stream/${filename}?t=${fallthroughT}`);
      console.log(`👑 UF tile: ${ufBackups?.backupStreams?.length ?? 0} UF backup(s) exhausted — falling through to fallback group (${remaining} candidate(s) remaining)`);
      res.redirect(302, fallthroughUrl.href);
      return;
    }

    const backupCount = ufBackups?.backupStreams?.length ?? 0;
    const sessionExists = sessionKey ? getSessionPromise(sessionKey) !== null : false;
    // Library check ONLY when session is gone (the post-clearSearchCache
    // state). clearSearchCache wipes session/group memory but the resolved
    // file is still on the WebDAV mount; do one check before giving up.
    // Other UF failure modes (backups all broken, session active but no
    // backups) keep current behavior since UF actively decided there's no
    // usable file.
    if (!sessionExists) {
      const parts = (sessionKey ?? '').split(':');
      // sk format: <manifestKey>:<type>:<imdbId>:<season>:<episode>
      // Parsing from the tail handles anime IDs (kitsu:12345, mal:67890)
      // which contain colons. Episode is always last; season second-to-last.
      if (parts.length >= 5) {
        const skType = parts[1];
        const imdbId = parts.slice(2, -2).join(':');
        const seasonStr = parts[parts.length - 2];
        const episodeStr = parts[parts.length - 1];
        const title = getCachedTitleByImdb(imdbId);
        const isSupportedType = skType === 'movie' || skType === 'series';
        const libraryTypeAllowed = skType === 'movie'
          ? globalConfig.searchConfig?.libraryApplyToMovies !== false
          : globalConfig.searchConfig?.libraryApplyToSeries !== false;
        if (title && isSupportedType && libraryTypeAllowed) {
          const season = seasonStr && !Number.isNaN(+seasonStr) ? +seasonStr : undefined;
          const episode = episodeStr && !Number.isNaN(+episodeStr) ? +episodeStr : undefined;
          try {
            const hits = await searchLibrary({
              type: skType,
              imdbId,
              title,
              season,
              episode,
              isAnime: false,
            }, buildNzbdavConfig());
            const hitPath = hits[0]?.libraryVideoPath;
            if (hitPath) {
              console.log(`📚 UF tile: library check hit (sk=${sessionKey}) — serving ${hitPath}`);
              const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
              proxyUrl.searchParams.set('path', hitPath);
              proxyUrl.searchParams.set('_fb', req.originalUrl);
              if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
              res.redirect(302, proxyUrl.href);
              return;
            }
          } catch (err) {
            console.warn(`⚠️ UF tile library check failed: ${(err as Error).message}`);
          }
        }
      }
    }
    if (backupCount > 0) {
      console.log(`👑 UF tile: ${backupCount} backup(s) checked but all broken — serving failure video`);
    } else if (sessionExists) {
      console.log(`👑 UF tile: session active but no backups produced (sk=${sessionKey}) — serving failure video`);
    } else {
      console.log(`👑 UF tile: no session for sk=${sessionKey} (expired or never triggered) — serving failure video`);
    }
    await sendFailureVideo(req, res);
    return;
  }

  const deadSkipKey = fallbackGroupId || nzbUrl;
  const logDeadSkips = !deadSkipLoggedGroups.has(deadSkipKey);

  // Build candidate order.
  // user_pick + UF enabled: honor the click, try only that NZB, fall into UF lobby on failure.
  // Otherwise (UF tile click / lobby fall-through): prefer UF's pre-vetted backups, then
  // resume sequential from after the last vetted URL.
  const ufLobbyAvailable = globalConfig.ultimateFallback?.enabled === true;
  const sessionBackups = sessionKey ? getSessionBackups(sessionKey) : null;
  if (userPick && redirectCount === 0) {
    console.log(`🎯 User-pick attempt: userPickFallback=${globalConfig.ultimateFallback?.userPickFallback ?? 'failure-video'}, sk=${sessionKey || 'none'}, fbg=${fallbackGroupId || 'none'}`);
  }
  const candidateOrder: number[] = [];
  const userPickMode = globalConfig.ultimateFallback?.userPickFallback ?? 'failure-video';
  if (userPick && ufLobbyAvailable && userPickMode !== 'fallback-chain') {
    candidateOrder.push(candidateStart);
  } else if (userPick && userPickMode === 'fallback-chain') {
    // Walk results from clicked through end. Skip the vetted-backup-priority
    // branch — sequential order is what the user opted into.
    for (let i = candidateStart; i < maxCandidates; i++) candidateOrder.push(i);
  } else if (sessionBackups?.backupUrls?.size && candidates.length > 0) {
    for (let i = candidateStart; i < maxCandidates; i++) {
      if (sessionBackups.backupUrls.has(candidates[i].nzbUrl)) candidateOrder.push(i);
    }
    const lastVettedIdx = sessionBackups.lastVettedUrl
      ? candidates.findIndex(c => c.nzbUrl === sessionBackups.lastVettedUrl)
      : -1;
    for (let i = Math.max(candidateStart, lastVettedIdx + 1); i < maxCandidates; i++) {
      if (!sessionBackups.backupUrls.has(candidates[i].nzbUrl)) candidateOrder.push(i);
    }
  } else {
    for (let i = candidateStart; i < maxCandidates; i++) candidateOrder.push(i);
  }

  for (const i of candidateOrder) {
    // Stop processing if the client disconnected (user backed out)
    if (req.socket.destroyed) {
      console.log(`🔌 Client disconnected — stopping fallback loop at [${i + 1}/${maxCandidates}]`);
      return;
    }

    const candidate = candidates[i];
    const attemptBudgetMs = getAttemptBudgetMs(contentType, candidate.isSeasonPack);

    // Skip candidates already known to be dead.
    const deadKey = getDeadCacheKey(candidate.nzbUrl, cachePattern);
    if (isDeadNzb(deadKey) || isDeadNzbByUrl(candidate.nzbUrl)) {
      if (logDeadSkips) console.log(`\u23ED\uFE0F NZB Database (skipping dead) [${i + 1}/${maxCandidates}]: ${candidate.title}`);
      continue;
    }

    // Mark dead-skip logs as shown for this group so subsequent requests don't repeat
    if (logDeadSkips) deadSkipLoggedGroups.set(deadSkipKey, Date.now());

    // Self-redirect to reset Stremio's 60s timer before it expires.
    // Pre-start the candidate so it's warming in cache during redirect round-trip.
    if (i > 0 && !req.socket.destroyed && redirectCount < MAX_SELF_REDIRECTS) {
      const elapsed = Date.now() - streamStartTime;
      if (elapsed + attemptBudgetMs + STREMIO_SAFETY_MARGIN_MS > STREMIO_TIMEOUT_MS) {
        const pendingKey = getCacheKey(candidate.nzbUrl, candidate.title) + (cachePattern ? `:${cachePattern}` : '');
        if (!streamCacheMap.has(pendingKey) && !isDeadNzb(deadKey)) {
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, cachePattern, filePattern, contentType, episodesInSeason, candidate.indexerName, candidate.size, verbose, candidate.isSeasonPack).catch(() => {});
        }
        // Site 2 of 6: rc and ci carried inside `t` so iOS handoff doesn't
        // truncate them. Without ci, the next request would restart at
        // candidate 0 instead of resuming at i.
        const redirectUrl = incrementRedirectCounter(req, i);
        if (verbose) {
          console.log(`⏰ Self-redirect to reset Stremio timer (${Math.round(elapsed / 1000)}s elapsed, redirect ${redirectCount + 1}/${MAX_SELF_REDIRECTS}, resuming at candidate ${i + 1}/${maxCandidates})`);
        }
        res.redirect(302, redirectUrl.href);
        return;
      }
    }

    try {
      if (i > 0) {
        console.log(`🔄 Trying backup [${i + 1}/${maxCandidates}]: ${candidate.title} [${candidate.indexerName}]`);
        if (trackGrabFn && candidate.indexerName) {
          trackGrabFn(candidate.indexerName, candidate.title);
        }
      }

      // On post-redirect requests, cap blocking time to the ExoPlayer budget so
      // Stremio doesn't disconnect on Android while the candidate is processing.
      let streamData: StreamData;
      if (redirectCount > 0) {
        const requestElapsed = Date.now() - streamStartTime;
        const waitMs = Math.max(1000, EXO_PLAYER_BUDGET_MS - requestElapsed);
        let exoTimerId: ReturnType<typeof setTimeout>;
        streamData = await Promise.race([
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, cachePattern, filePattern, contentType, episodesInSeason, candidate.indexerName, candidate.size, verbose, candidate.isSeasonPack)
            .finally(() => clearTimeout(exoTimerId)),
          new Promise<never>((_, reject) => {
            exoTimerId = setTimeout(() => reject(Object.assign(new Error('ExoPlayer safety timeout'), { isExoTimeout: true })), waitMs);
          })
        ]);
      } else {
        // On the initial request, race against the remaining Stremio window when
        // the attempt budget would exceed it. If the stream isn't ready in time,
        // self-redirect so the post-redirect ExoPlayer race takes over.
        const elapsed = Date.now() - streamStartTime;
        const stremioRemainingMs = STREMIO_TIMEOUT_MS - elapsed - STREMIO_SAFETY_MARGIN_MS;
        if (attemptBudgetMs > stremioRemainingMs && stremioRemainingMs > 0 && !req.socket.destroyed) {
          let stremioTimerId: ReturnType<typeof setTimeout>;
          streamData = await Promise.race([
            getOrCreateStream(candidate.nzbUrl, candidate.title, config, cachePattern, filePattern, contentType, episodesInSeason, candidate.indexerName, candidate.size, verbose, candidate.isSeasonPack)
              .finally(() => clearTimeout(stremioTimerId)),
            new Promise<never>((_, reject) => {
              stremioTimerId = setTimeout(() => reject(Object.assign(new Error('Stremio timeout redirect'), { isExoTimeout: true })), stremioRemainingMs);
            })
          ]);
        } else {
          streamData = await getOrCreateStream(
            candidate.nzbUrl, candidate.title, config, cachePattern, filePattern, contentType, episodesInSeason, candidate.indexerName, candidate.size, verbose, candidate.isSeasonPack
          );
        }
      }

      if (i > 0) {
        console.log(`👑 Backup stream loaded [${i + 1}/${maxCandidates}]: ${candidate.title} [${candidate.indexerName}]`);
      }

      // Check again after await — client may have disconnected while waiting
      if (req.socket.destroyed) {
        console.log(`🔌 Client disconnected — aborting redirect for: ${candidate.title}`);
        return;
      }

      // Auto-queue: only pre-cache the stream, don't proxy the video
      if (req.query.auto === 'true') {
        if (verbose) console.log(`  ✅ Auto-queue cached: ${candidate.title}`);
        res.json({ cached: true, videoPath: streamData.videoPath });
        return;
      }

      // Decide delivery method: pipe/proxy (buffered) or direct redirect.
      // When fallback is off, the initial-delivery mode still forces proxy for
      // logging/dedup consistency; /v's proxyVideoStream independently reads
      // config on each range request, so seeks honor the user's current method.
      const fallbackOn = globalConfig.ultimateFallback?.enabled === true;
      let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'proxy';
      if (!fallbackOn) mode = 'proxy';
      const last = lastDeliveryLog.get(streamData.videoPath);
      const shouldLogDelivery = !last || last.mode !== mode;
      lastDeliveryLog.set(streamData.videoPath, { mode, at: Date.now() });

      // Cache delivery for Stremio request dedup (10 min TTL) — populated BEFORE
      // delivery so concurrent probes from Stremio land on the dedup path instead
      // of triggering another prep.
      // Key on candidates[0] (the URL the client requested) so subsequent client
      // requests for the same click hit dedup, even when fallback-chain walked
      // past the click and resolved a later candidate.
      const dedupCandidate = candidates[0] ?? candidate;
      const dedupKey = getCacheKey(dedupCandidate.nzbUrl, dedupCandidate.title) + (cachePattern ? `:${cachePattern}` : '');
      recentDeliveries.set(dedupKey, { streamData, streamingMethod: mode, timestamp: Date.now() });
      // Also key on the resolved candidate's URL so direct second-clicks of the
      // resolved tile (different click URL) also dedup.
      if (candidate !== dedupCandidate) {
        const resolvedKey = getCacheKey(candidate.nzbUrl, candidate.title) + (cachePattern ? `:${cachePattern}` : '');
        recentDeliveries.set(resolvedKey, { streamData, streamingMethod: mode, timestamp: Date.now() });
      }

      const deliverySizeSuffix = streamData.videoSize ? ` (${formatBytes(streamData.videoSize)})` : '';
      if (mode !== 'direct') {
        const inline = !fallbackOn && proxyFn;
        const label = mode === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
        if (shouldLogDelivery) console.log(`  ${label}${inline ? '' : ' 302'} streaming: ${streamData.videoPath}${deliverySizeSuffix}`);
        if (inline) {
          // Inline proxy — no 302, broadest player compatibility. Subsequent seeks
          // come back to handleStream but hit recentDeliveries (10 min TTL) and
          // skip library check + submission.
          await proxyFn!(req, res, streamData.videoPath, mode !== 'proxy');
        } else {
          // Redirect to /v endpoint which adds auth + buffering + transparent reconnect
          const proxyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/v`);
          proxyUrl.searchParams.set('path', streamData.videoPath);
          proxyUrl.searchParams.set('_fb', req.originalUrl);
          if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
          res.redirect(302, proxyUrl.href);
        }
      } else {
        // Direct: redirect to WebDAV URL with embedded credentials (desktop players)
        const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
        const safePath = encodeWebdavPath(streamData.videoPath);

        const directUrl = new URL(`${webdavBase}${safePath}`);
        if (config.webdavUser) {
          directUrl.username = config.webdavUser;
          directUrl.password = config.webdavPassword || '';
        }
        if (shouldLogDelivery) console.log(`  ⇗️ Direct passthrough: → ${directUrl.hostname}${safePath}${deliverySizeSuffix}`);
        res.redirect(302, directUrl.href);
      }
      return;

    } catch (error) {
      // Stremio / ExoPlayer timeout — candidate is still processing in cache,
      // self-redirect to keep the player alive while we wait
      if ((error as any).isExoTimeout && redirectCount < MAX_SELF_REDIRECTS && !req.socket.destroyed) {
        // Site 3 of 6: rc and ci carried inside `t` for iOS-safe redirect.
        const redirectUrl = incrementRedirectCounter(req, i);
        if (verbose) {
          console.log(`\u23F1\uFE0F Timeout redirect (candidate still processing, rc=${redirectCount + 1}/${MAX_SELF_REDIRECTS}, resuming at ${i + 1}/${maxCandidates})`);
        }
        res.redirect(302, redirectUrl.href);
        return;
      }

      if (isClientDisconnect(error)) {
        shouldLogStreamRequest(candidate.title, 'disconnect');
        return;
      }

      // WebDAV 404 during inline proxy — evict stale cache, loop continues to next candidate
      if (error instanceof WebDav404Error) {
        evictReadyByVideoPath((error as WebDav404Error).videoPath);
      }

      const err = error as Error & { isNzbdavFailure?: boolean };
      console.error(`\u274C Stream failed [${i + 1}/${maxCandidates}] ${candidate.title}: ${err.message}`);

      // User-pick failure: fall straight into the UF lobby instead of walking the candidate chain.
      // The user explicitly chose this NZB; when it fails, UF's pre-vetted pool is the fallback.
      // userPickFallback='failure-video' skips the redirect and lets the natural fall-through
      // serve the failure video.
      if (
        userPick
        && sessionKey
        && globalConfig.ultimateFallback?.enabled
        && globalConfig.ultimateFallback?.userPickFallback === 'uf-lobby'
        && redirectCount < MAX_SELF_REDIRECTS
        && !res.headersSent
      ) {
        // Site 4 of 6: build a fresh UF envelope so sk + fbg + rc all survive
        // iOS handoff (single `t` query param, no `&` after the path).
        const lobbyT = encodeTileEnvelope({
          sk: sessionKey,
          ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
          rc: redirectCount + 1,
        });
        const lobbyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/stream/ultimate-fallback?t=${lobbyT}`);
        console.log(`👑 User-pick failed — redirecting to UF lobby (rc=${redirectCount + 1})`);
        res.redirect(302, lobbyUrl.href);
        return;
      }
      if (
        userPick
        && globalConfig.ultimateFallback?.enabled
        && globalConfig.ultimateFallback?.userPickFallback === 'failure-video'
        && !res.headersSent
      ) {
        console.log(`👑 User-pick failed — userPickFallback=failure-video, serving failure video`);
        // Loop's natural fall-through hits sendFailureVideo below.
      }
    }
  }

  // User-pick loop exhausted without serving (e.g. the clicked NZB was dead-cached and
  // `continue`d past the catch-block's lobby redirect). Fall into the UF lobby as the
  // final fallback before the failure video. Only fires when userPickFallback='uf-lobby'.
  if (
    userPick
    && sessionKey
    && globalConfig.ultimateFallback?.enabled
    && globalConfig.ultimateFallback?.userPickFallback === 'uf-lobby'
    && redirectCount < MAX_SELF_REDIRECTS
    && !res.headersSent
  ) {
    // Site 5 of 6: same fresh-envelope pattern as site 4.
    const lobbyT = encodeTileEnvelope({
      sk: sessionKey,
      ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
      rc: redirectCount + 1,
    });
    const lobbyUrl = new URL(`${resolveBaseUrl(req)}${req.baseUrl}/stream/ultimate-fallback?t=${lobbyT}`);
    console.log(`👑 User-pick exhausted — redirecting to UF lobby (rc=${redirectCount + 1})`);
    res.redirect(302, lobbyUrl.href);
    return;
  }

  // All candidates exhausted -- serve the 3-hour failure video. The long duration
  // ensures Stremio never considers the episode "completed", so it won't mark it
  // as watched or auto-advance to the next episode. The user sees the
  // "Stream Unavailable" message and goes back to the stream list manually.
  if (userPick && globalConfig.ultimateFallback?.userPickFallback === 'failure-video') {
    console.error(`\u274C User-pick attempt failed (userPickFallback=failure-video) — serving failure video`);
  } else {
    console.error(`\u274C All ${maxCandidates} candidate(s) exhausted, serving failure video`);
  }
  if (!res.headersSent) {
    await sendFailureVideo(req, res);
  }
}

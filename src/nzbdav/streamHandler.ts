/**
 * Stream Handler
 * Main stream preparation pipeline with 302 redirect to WebDAV.
 * Handles NZB submission -> job polling -> video discovery -> redirect,
 * with automatic fallback on failure and self-redirect to reset Stremio's timer.
 */

import { Request, Response as ExpressResponse } from 'express';
import { config as globalConfig } from '../config/index.js';
import { pipeline } from 'stream';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { submitNzb, waitForJobCompletion } from './nzbdavApi.js';
import { waitForVideoFile, checkNzbLibrary } from './videoDiscovery.js';
import { getOrCreateStream, getCacheKey, getStreamCache, setPrepareFn } from './streamCache.js';
import { getFallbackGroup } from './fallbackManager.js';
import type { NZBDavConfig, StreamData, FallbackCandidate } from './types.js';

const pipelineAsync = promisify(pipeline);

// Register prepareStream into the cache to break the circular import
// (streamCache needs to call prepareStream, but importing it directly would create a cycle)
setPrepareFn(
  (nzbUrl, title, config, episodePattern, contentType, episodesInSeason) =>
    prepareStream(nzbUrl, title, config, episodePattern, contentType, episodesInSeason)
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
const MAX_SELF_REDIRECTS = 5;            // Max self-redirects (~5 × 60s = 5 min of total trying)

interface StreamLogState {
  requests: number;
  disconnects: number;
  lastLogAt: number;
  /** True once the first request for this title has been logged in full */
  seenFirst: boolean;
}

const streamLogState = new Map<string, StreamLogState>();

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

/** Get the per-attempt budget in ms based on content type (movie vs TV) */
function getAttemptBudgetMs(contentType?: string): number {
  return (contentType === 'series'
    ? (globalConfig.nzbdavTvTimeoutSeconds ?? 15)
    : (globalConfig.nzbdavMoviesTimeoutSeconds ?? 30)) * 1000;
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
  episodesInSeason?: number
): Promise<StreamData> {
  const totalBudgetMs = getAttemptBudgetMs(contentType);
  const totalBudgetS = Math.round(totalBudgetMs / 1000);
  const budgetStart = Date.now();
  const remaining = () => Math.max(0, Math.round((totalBudgetMs - (Date.now() - budgetStart)) / 1000));

  console.log(`\n\u{1F3AC} Preparing stream: ${title}${episodePattern ? ` (selecting ${episodePattern})` : ''} [${contentType || 'unknown'}] \u23F1\uFE0F ${totalBudgetS}s budget`);

  // Step 0: Check NZB library first - avoid grabbing from indexer if already downloaded
  const libraryResult = await checkNzbLibrary(title, config, episodePattern, contentType, episodesInSeason);
  if (libraryResult) {
    console.log(`\u2705 Stream ready (from library): ${title}\n`);
    return libraryResult;
  }

  // Step 1: Submit NZB
  console.log(`  \u23F1\uFE0F Submitting NZB... (${remaining()}s remaining)`);
  const submitBudgetMs = totalBudgetMs - (Date.now() - budgetStart);
  const nzoId = await submitNzb(nzbUrl, title, config, contentType, submitBudgetMs);
  console.log(`  \u23F1\uFE0F NZB submitted → ${remaining()}s remaining`);

  // Step 2: Wait for job to complete (or fail) — remaining budget
  const jobBudgetMs = totalBudgetMs - (Date.now() - budgetStart);
  await waitForJobCompletion(nzoId, config, jobBudgetMs, undefined, contentType);
  console.log(`  \u23F1\uFE0F Job done → ${remaining()}s remaining`);

  // Step 3: Find the video file — remaining budget
  const videoBudgetMs = totalBudgetMs - (Date.now() - budgetStart);
  const video = await waitForVideoFile(nzoId, title, config, videoBudgetMs, undefined, episodePattern, contentType, episodesInSeason);

  const totalElapsed = Math.round((Date.now() - budgetStart) / 1000);
  console.log(`\u2705 Stream ready: ${title} (${totalElapsed}s total)\n`);

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
        const end = match[2] ? parseInt(match[2]) : fileSize - 1;
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

// ============================================================================
// Express Handler
// ============================================================================

/**
 * Express handler for /nzbdav/stream endpoint
 * Supports automatic fallback: if the chosen NZB fails, tries the next candidates
 * from the fallback group until one succeeds or all are exhausted.
 */
export async function handleStream(
  req: Request,
  res: ExpressResponse,
  config: NZBDavConfig,
  trackGrabFn?: (indexerName: string, title: string) => void
): Promise<void> {
  const nzbUrl = req.query.nzb as string;
  const title = req.query.title as string;
  const contentType = req.query.type as string | undefined;
  const seasonParam = req.query.season as string | undefined;
  const episodeParam = req.query.episode as string | undefined;
  const fallbackGroupId = req.query.fbg as string | undefined;

  if (!nzbUrl || !title) {
    res.status(400).send('Missing required parameters: nzb, title');
    return;
  }

  const streamStartTime = Date.now();

  // Build episode pattern for season pack file selection (e.g. "S02E05")
  let episodePattern: string | undefined;
  const epcountParam = req.query.epcount as string | undefined;
  const episodesInSeason = epcountParam ? parseInt(epcountParam, 10) : undefined;
  if (seasonParam && episodeParam) {
    const s = parseInt(seasonParam, 10).toString().padStart(2, '0');
    const e = parseInt(episodeParam, 10).toString().padStart(2, '0');
    episodePattern = `S${s}[. _-]?E${e}`;
  }

  // Build the list of candidates to try (primary first, then fallbacks)
  const candidates: FallbackCandidate[] = [
    { nzbUrl, title, indexerName: req.query.indexer as string || '' }
  ];

  const fallbackEnabled = globalConfig.nzbdavFallbackEnabled !== false;
  const maxFallbacksSetting = globalConfig.nzbdavMaxFallbacks ?? 0; // 0 = unlimited (try all)

  // Check whether this request should produce detailed logs.
  // During fallback processing, a single stream title may generate multiple
  // self-redirect requests. shouldLogStreamRequest returns true for the
  // first request and then emits a compact summary every 30 s.
  const verbose = shouldLogStreamRequest(title, 'request');

  if (fallbackGroupId && fallbackEnabled) {
    const group = getFallbackGroup(fallbackGroupId);
    if (group) {
      const fallbackOrder = globalConfig.nzbdavFallbackOrder || 'selected';
      if (fallbackOrder === 'top') {
        // Try the clicked NZB first, then continue from the top of the list (skipping it)
        candidates.length = 0;
        const clickedCandidate = group.candidates.find(
          c => c.nzbUrl === nzbUrl && c.title === title
        );
        if (clickedCandidate) {
          candidates.push(clickedCandidate);
          candidates.push(...group.candidates.filter(c => c !== clickedCandidate));
        } else {
          candidates.push({ nzbUrl, title, indexerName: req.query.indexer as string || '' });
          candidates.push(...group.candidates);
        }
      } else {
        // Default 'selected': start from clicked NZB's position, continue down, then wrap
        candidates.length = 0;
        const clickedIdx = group.candidates.findIndex(
          c => c.nzbUrl === nzbUrl && c.title === title
        );
        if (clickedIdx >= 0) {
          candidates.push(...group.candidates.slice(clickedIdx));
          candidates.push(...group.candidates.slice(0, clickedIdx));
        } else {
          // Clicked NZB not found in group — put it first, then all group candidates
          candidates.push({ nzbUrl, title, indexerName: req.query.indexer as string || '' });
          candidates.push(...group.candidates);
        }
      }
      if (verbose) {
        const totalToTry = maxFallbacksSetting === 0
          ? candidates.length
          : Math.min(candidates.length, 1 + maxFallbacksSetting);
        console.log(`🔄 Fallback group loaded (${fallbackOrder}): ${candidates.length} candidates (trying up to ${totalToTry})`);
      }
    }
  }

  const maxCandidates = !fallbackEnabled ? 1
    : maxFallbacksSetting === 0 ? candidates.length
    : Math.min(candidates.length, 1 + maxFallbacksSetting);
  const streamCacheMap = getStreamCache();
  const redirectCount = Math.max(0, parseInt(req.query._rc as string || '0', 10) || 0);
  const attemptBudgetMs = getAttemptBudgetMs(contentType);

  for (let i = 0; i < maxCandidates; i++) {
    // Stop processing if the client disconnected (user backed out)
    if (req.socket.destroyed) {
      console.log(`🔌 Client disconnected — stopping fallback loop at [${i + 1}/${maxCandidates}]`);
      return;
    }

    // Self-redirect to reset Stremio's 60s timer before it expires.
    // Failed candidates are cached, so the new request skips them instantly.
    if (i > 0 && !req.socket.destroyed && redirectCount < MAX_SELF_REDIRECTS) {
      const elapsed = Date.now() - streamStartTime;
      if (elapsed + attemptBudgetMs + STREMIO_SAFETY_MARGIN_MS > STREMIO_TIMEOUT_MS) {
        const redirectUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        redirectUrl.searchParams.set('_rc', String(redirectCount + 1));
        if (verbose) {
          console.log(`⏰ Self-redirect to reset Stremio timer (${Math.round(elapsed / 1000)}s elapsed, redirect ${redirectCount + 1}/${MAX_SELF_REDIRECTS})`);
        }
        res.redirect(302, redirectUrl.href);
        return;
      }
    }

    const candidate = candidates[i];

    // Skip candidates already known to be failed in cache
    const cacheKey = getCacheKey(candidate.nzbUrl, candidate.title)
      + (episodePattern ? `:${episodePattern}` : '');
    const cached = streamCacheMap.get(cacheKey);
    if (cached?.status === 'failed') {
      if (verbose) console.log(`\u23ED\uFE0F Skipping known-failed [${i + 1}/${maxCandidates}]: ${candidate.title}`);
      continue;
    }

    try {
      if (i > 0) {
        if (verbose) console.log(`\u{1F504} Trying fallback [${i + 1}/${maxCandidates}]: ${candidate.title}`);
        if (trackGrabFn && candidate.indexerName) {
          trackGrabFn(candidate.indexerName, candidate.title);
        }
      }

      const streamData = await getOrCreateStream(
        candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason
      );

      if (i > 0 && verbose) {
        console.log(`\u2705 Fallback succeeded on attempt ${i + 1}/${maxCandidates}`);
      }

      // Check again after await — client may have disconnected while waiting
      if (req.socket.destroyed) {
        console.log(`🔌 Client disconnected — aborting redirect for: ${candidate.title}`);
        return;
      }

      // Redirect to direct WebDAV URL with embedded credentials for player authentication
      const webdavUrl = config.webdavUrl || config.url;
      if (!webdavUrl) {
        console.error('❌ No WebDAV URL configured — falling back to failure video');
        break;
      }
      const webdavBase = webdavUrl.replace(/\/+$/, '');
      const encodedPath = '/' + streamData.videoPath
        .split('/')
        .filter(segment => segment && segment !== '.' && segment !== '..')
        .map(segment => encodeURIComponent(segment))
        .join('/');
      const redirectUrl = new URL(`${webdavBase}${encodedPath}`);
      if (config.webdavUser && config.webdavPassword) {
        redirectUrl.username = config.webdavUser;
        redirectUrl.password = config.webdavPassword;
      }
      if (verbose) {
        console.log(`  ↗️ Redirect: 302 → ${redirectUrl.protocol}//${redirectUrl.host}${redirectUrl.pathname}`);
      }
      res.redirect(302, redirectUrl.href);
      return;

    } catch (error) {
      if (isClientDisconnect(error)) {
        shouldLogStreamRequest(candidate.title, 'disconnect');
        return;
      }

      const err = error as Error & { isNzbdavFailure?: boolean };
      console.error(`\u274C Stream failed [${i + 1}/${maxCandidates}] ${candidate.title}: ${err.message}`);
    }
  }

  // All candidates exhausted -- serve the 3-hour failure video. The long duration
  // ensures Stremio never considers the episode "completed", so it won't mark it
  // as watched or auto-advance to the next episode. The user sees the
  // "Stream Unavailable" message and goes back to the stream list manually.
  console.error(`\u274C All ${maxCandidates} candidate(s) exhausted, serving failure video`);
  if (!res.headersSent) {
    await sendFailureVideo(req, res);
  }
}

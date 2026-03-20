/**
 * Stream Handler
 * Main stream preparation pipeline with 302 redirect to WebDAV proxy.
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
import { getOrCreateStream, getCacheKey, getDeadCacheKey, getStreamCache, isDeadNzb, isDeadNzbByUrl, evictReadyByVideoPath, setPrepareFn, cleanupExpiredCache } from './streamCache.js';
import { getFallbackGroup } from './fallbackManager.js';
import { encodeWebdavPath, nzbdavError, getDeliveryLog, WebDav404Error } from './utils.js';
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
const MAX_SELF_REDIRECTS = Number(process.env.NZBDAV_MAX_SELF_REDIRECTS) || 100; // Safety cap on self-redirects — supports large fallback chains without infinite loops
const EXO_PLAYER_BUDGET_MS = 8_000;      // Max blocking time per post-redirect request (keeps ExoPlayer alive on Android)
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

/** Per-attempt budget in ms. Returns 0 (no limit) when fallback is off. */
function getAttemptBudgetMs(contentType?: string): number {
  if (globalConfig.nzbdavFallbackEnabled !== true) return 0;
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
  const unlimited = totalBudgetMs === 0;
  const budgetStart = Date.now();
  const remaining = () => unlimited ? '∞' : Math.max(0, Math.round((totalBudgetMs - (Date.now() - budgetStart)) / 1000));

  console.log(`\n\u{1F3AC} Preparing stream: ${title}${episodePattern ? ` (selecting ${episodePattern})` : ''} [${contentType || 'unknown'}] \u23F1\uFE0F ${unlimited ? 'no limit' : `${Math.round(totalBudgetMs / 1000)}s budget`}`);

  // Step 0: Check NZB library first - avoid grabbing from indexer if already downloaded
  if (globalConfig.nzbdavLibraryCheckEnabled) {
    const libraryResult = await checkNzbLibrary(title, config, episodePattern, contentType, episodesInSeason);
    if (libraryResult) {
      console.log(`\u2705 Stream ready (from library): ${title}\n`);
      return libraryResult;
    }
  } else {
    console.log(`\u{1F4DA} Library check disabled — skipping`);
  }

  // Step 1: Submit NZB
  console.log(`  \u23F1\uFE0F Submitting NZB... (${remaining()}s remaining)`);
  const nzoId = await submitNzb(nzbUrl, title, config, contentType, unlimited ? undefined : totalBudgetMs - (Date.now() - budgetStart));
  console.log(`  \u23F1\uFE0F NZB submitted → ${remaining()}s remaining`);

  // Step 2: Wait for job to complete (or fail) — remaining budget
  await waitForJobCompletion(nzoId, config, unlimited ? 0 : totalBudgetMs - (Date.now() - budgetStart), undefined, contentType);
  console.log(`  \u23F1\uFE0F Job done → ${remaining()}s remaining`);

  // Step 3: Find the video file — remaining budget
  const video = await waitForVideoFile(nzoId, title, config, unlimited ? undefined : totalBudgetMs - (Date.now() - budgetStart), undefined, episodePattern, contentType, episodesInSeason);

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
        throw nzbdavError(`Video file not servable (${probeResp.status}): ${video.path}`);
      }
      if (probeResp.status === 206 || probeResp.status === 200) {
        probeSuccess = true;
        await probeResp.body?.cancel().catch(() => {});
        break;
      }
      await probeResp.body?.cancel().catch(() => {});
      // Unexpected status — count as an attempt and delay before retry
      probeAttempt++;
      console.warn(`  ⚠️ Probe returned ${probeResp.status} — retrying (${probeAttempt}/${PROBE_MAX_RETRIES})...`);
      if (probeAttempt < PROBE_MAX_RETRIES) {
        const delay = Math.min(PROBE_RETRY_BASE_MS * Math.pow(2, probeAttempt - 1), 10_000);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      if ((err as any).isNzbdavFailure) throw err;
      probeAttempt++;
      if (probeAttempt >= PROBE_MAX_RETRIES || (!unlimited && (Date.now() - budgetStart) >= totalBudgetMs)) {
        console.warn(`  ⚠️ Probe failed after ${probeAttempt} attempts: ${(err as Error).message}`);
        break;
      }
      const delay = Math.min(PROBE_RETRY_BASE_MS * Math.pow(2, probeAttempt - 1), 10_000);
      console.warn(`  ⚠️ Probe attempt ${probeAttempt}/${PROBE_MAX_RETRIES} failed (${(err as Error).message}) — retrying in ${Math.round(delay / 1000)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (!probeSuccess) {
    throw nzbdavError(`Video file not servable (probe failed after ${probeAttempt} attempts): ${video.path}`);
  }

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
  trackGrabFn?: (indexerName: string, title: string) => void,
  proxyFn?: (req: Request, res: ExpressResponse, videoPath: string) => Promise<void>
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
    episodePattern = `S${s}[. _-]?E${e}(?!\\d|[. _-]?E\\d)`;
  }

  // Build the list of candidates to try (primary first, then fallbacks)
  const candidates: FallbackCandidate[] = [
    { nzbUrl, title, indexerName: req.query.indexer as string || '' }
  ];

  const fallbackEnabled = globalConfig.nzbdavFallbackEnabled === true;
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
  const candidateStart = maxCandidates > 0
    ? Math.min(Math.max(0, parseInt(req.query._ci as string || '0', 10) || 0), maxCandidates - 1)
    : 0;
  const attemptBudgetMs = getAttemptBudgetMs(contentType);

  // Evict expired entries once before the loop so isDeadNzb() trusts existence
  cleanupExpiredCache();

  for (let i = candidateStart; i < maxCandidates; i++) {
    // Stop processing if the client disconnected (user backed out)
    if (req.socket.destroyed) {
      console.log(`🔌 Client disconnected — stopping fallback loop at [${i + 1}/${maxCandidates}]`);
      return;
    }

    const candidate = candidates[i];

    // Skip candidates already known to be dead
    const deadKey = getDeadCacheKey(candidate.nzbUrl, episodePattern);
    if (isDeadNzb(deadKey) || isDeadNzbByUrl(candidate.nzbUrl)) {
      if (verbose) console.log(`\u23ED\uFE0F NZB Database (skipping dead) [${i + 1}/${maxCandidates}]: ${candidate.title}`);
      continue;
    }

    // Self-redirect to reset Stremio's 60s timer before it expires.
    // Pre-start the candidate so it's warming in cache during redirect round-trip.
    if (i > 0 && !req.socket.destroyed && redirectCount < MAX_SELF_REDIRECTS) {
      const elapsed = Date.now() - streamStartTime;
      if (elapsed + attemptBudgetMs + STREMIO_SAFETY_MARGIN_MS > STREMIO_TIMEOUT_MS) {
        const pendingKey = getCacheKey(candidate.nzbUrl, candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        if (!streamCacheMap.has(pendingKey) && !isDeadNzb(deadKey)) {
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose).catch(() => {});
        }
        const redirectUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        redirectUrl.searchParams.set('_rc', String(redirectCount + 1));
        redirectUrl.searchParams.set('_ci', String(i));
        if (verbose) {
          console.log(`⏰ Self-redirect to reset Stremio timer (${Math.round(elapsed / 1000)}s elapsed, redirect ${redirectCount + 1}/${MAX_SELF_REDIRECTS}, resuming at candidate ${i + 1}/${maxCandidates})`);
        }
        res.redirect(302, redirectUrl.href);
        return;
      }
    }

    try {
      if (i > 0) {
        if (verbose) console.log(`\u{1F504} Trying fallback [${i + 1}/${maxCandidates}]: ${candidate.title}`);
        if (trackGrabFn && candidate.indexerName) {
          trackGrabFn(candidate.indexerName, candidate.title);
        }
      }

      // On post-redirect requests, cap blocking time to keep Android ExoPlayer
      // alive. If the candidate isn't ready within the budget, self-redirect
      // and let the stream cache continue processing in the background.
      let streamData: StreamData;
      if (redirectCount > 0) {
        const requestElapsed = Date.now() - streamStartTime;
        const waitMs = Math.max(1000, EXO_PLAYER_BUDGET_MS - requestElapsed);
        let exoTimerId: ReturnType<typeof setTimeout>;
        streamData = await Promise.race([
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose)
            .finally(() => clearTimeout(exoTimerId)),
          new Promise<never>((_, reject) => {
            exoTimerId = setTimeout(() => reject(Object.assign(new Error('ExoPlayer safety timeout'), { isExoTimeout: true })), waitMs);
          })
        ]);
      } else {
        streamData = await getOrCreateStream(
          candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose
        );
      }

      if (i > 0 && verbose) {
        console.log(`\u2705 Fallback succeeded on attempt ${i + 1}/${maxCandidates}`);
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

      // Decide delivery method: proxy (piped with buffer + reconnect) or direct redirect.
      // When fallback is off, inline proxy (no 302) for broadest player compatibility.
      const fallbackOn = globalConfig.nzbdavFallbackEnabled === true;
      const mode: 'proxy' | 'direct' = (!fallbackOn || globalConfig.nzbdavProxyEnabled) ? 'proxy' : 'direct';
      const last = lastDeliveryLog.get(streamData.videoPath);
      const shouldLogDelivery = !last || last.mode !== mode;
      lastDeliveryLog.set(streamData.videoPath, { mode, at: Date.now() });

      if (mode === 'proxy') {
        if (shouldLogDelivery) console.log(`  📡 Proxy streaming: ${streamData.videoPath}`);
        if (!fallbackOn && proxyFn) {
          // Inline proxy — no 302, broadest player compatibility
          await proxyFn(req, res, streamData.videoPath);
        } else {
          // Redirect to /v endpoint which adds auth + buffering + transparent reconnect
          const proxyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/v`);
          proxyUrl.searchParams.set('path', streamData.videoPath);
          proxyUrl.searchParams.set('_fb', req.originalUrl);
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
        if (shouldLogDelivery) console.log(`  ⇗️ Direct passthrough: → ${directUrl.hostname}${safePath}`);
        res.redirect(302, directUrl.href);
      }
      return;

    } catch (error) {
      // ExoPlayer safety timeout — candidate is still processing in cache,
      // self-redirect to keep the player alive while we wait
      if ((error as any).isExoTimeout && redirectCount < MAX_SELF_REDIRECTS && !req.socket.destroyed) {
        const redirectUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        redirectUrl.searchParams.set('_rc', String(redirectCount + 1));
        redirectUrl.searchParams.set('_ci', String(i));
        if (verbose) {
          console.log(`\u23F1\uFE0F ExoPlayer safety redirect (candidate still processing, rc=${redirectCount + 1}/${MAX_SELF_REDIRECTS}, resuming at ${i + 1}/${maxCandidates})`);
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

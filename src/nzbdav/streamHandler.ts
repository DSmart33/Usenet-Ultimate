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
import { waitForVideoFile, checkNzbLibrary } from './videoDiscovery.js';
import { getOrCreateStream, getCacheKey, getDeadCacheKey, getStreamCache, isDeadNzb, isDeadNzbByUrl, evictReadyByVideoPath, setPrepareFn, cleanupExpiredCache, isVideoPathBroken } from './streamCache.js';
import { getFallbackGroup } from './fallbackManager.js';
import { encodeWebdavPath, nzbdavError, getDeliveryLog, WebDav404Error, buildEpisodePattern } from './utils.js';
import { getSessionPromise, getSessionBackups } from './ultimateResolve.js';
import { formatBytes } from '../parsers/metadataParsers.js';
import { selectTimeoutMs, type TimeoutSet } from './timeoutDefaults.js';
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
const DEDUP_CACHE_TTL_MS = 600_000;      // 10 min — covers a typical play session's seeks/probes without library-check overhead; eviction mid-session self-heals via isVideoPathBroken
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

/** Per-attempt budget in ms. Returns 0 (no limit) when fallback is off.
 * For series, returns season pack timeout or TV timeout depending on isSeasonPack.
 * For movies, returns the movies timeout. */
function getAttemptBudgetMs(contentType?: string, isSeasonPack?: boolean): number {
  if (globalConfig.nzbdavFallbackEnabled !== true || globalConfig.ultimateResolve?.enabled) return 0;
  const set: TimeoutSet = {
    movies: globalConfig.nzbdavMoviesTimeoutSeconds ?? 30,
    tv: globalConfig.nzbdavTvTimeoutSeconds ?? 15,
    seasonPack: globalConfig.nzbdavSeasonPackTimeoutSeconds ?? 30,
  };
  return selectTimeoutMs(set, contentType, isSeasonPack ?? false);
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
    // Skip if this video path was recently marked as broken (WebDAV 5xx)
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

  // Skip immediately if this path is already known to be broken (WebDAV 5xx).
  // Avoids wasting ~6s on the probe when re-submission resolves to the same unservable file.
  // Plain Error (not nzbdavError) so the NZB isn't marked dead — the NZB is fine, only the path is broken.
  if (isVideoPathBroken(video.path)) {
    console.log(`${logPrefix}  \u{1F6AB} Video path already broken — skipping probe: ${video.path}`);
    throw new Error(`Video path broken (WebDAV 5xx): ${video.path}`);
  }

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
    throw nzbdavError(`Video file not servable (probe failed after ${probeAttempt} attempts): ${video.path}`);
  }

  const totalElapsed = Math.round((Date.now() - budgetStart) / 1000);
  console.log(`${logPrefix}\u2705 Stream ready: ${title} (${totalElapsed}s total)\n`);

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
  proxyFn?: (req: Request, res: ExpressResponse, videoPath: string, usePipe: boolean) => Promise<void>
): Promise<void> {
  // Tile URL comes in one of two shapes:
  //   (a) packed single-param: ?t=<fbg>.<idx>.<encodedSessionKey>.<season>.<episode>.<sp>.<epcount>
  //       Presence of `t` implies user_pick=1. Used for external-player
  //       compatibility (Infuse truncates after the first `&`).
  //   (b) legacy long form: ?nzb=&title=&type=&indexer=&fbg=&sk=&user_pick=...
  //       Still accepted for in-flight cached URLs and UR tile's own
  //       minimal ?sk= form.
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
  const tParam = req.query.t as string | undefined;
  if (tParam) {
    const parts = tParam.split('.');
    // Trailing url/title/indexer (b64url) are a survival fallback for when the
    // in-memory fallback group has been evicted (TTL elapsed) — keeps a
    // single-shot attempt possible instead of returning HTTP 400.
    const [fbgPart, idxPart, skPart, seasonPart, episodePart, spPart, epcountPart, urlB64, titleB64, indexerB64] = parts;
    fallbackGroupId = fbgPart || undefined;
    const idx = idxPart ? parseInt(idxPart, 10) : NaN;
    const group = fallbackGroupId ? getFallbackGroup(fallbackGroupId) : undefined;
    const cand = Number.isFinite(idx) && group ? group.candidates[idx] : undefined;
    const decodeB64 = (s: string | undefined): string => {
      if (!s) return '';
      try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; }
    };
    nzbUrl = cand?.nzbUrl ?? decodeB64(urlB64);
    title = cand?.title ?? decodeB64(titleB64);
    indexerName = cand?.indexerName ?? decodeB64(indexerB64);
    contentType = group?.type;
    tPackSessionKey = skPart ? decodeURIComponent(skPart) : undefined;
    seasonParam = seasonPart || undefined;
    episodeParam = episodePart || undefined;
    tPackSp = spPart || undefined;
    tPackEpcount = epcountPart || undefined;
    tPackUserPick = true;
  } else {
    fallbackGroupId = req.query.fbg as string | undefined;
    nzbUrl = (req.query.nzb as string | undefined) ?? '';
    title = (req.query.title as string | undefined) ?? '';
    indexerName = (req.query.indexer as string | undefined) ?? '';
    contentType = req.query.type as string | undefined;
    seasonParam = req.query.season as string | undefined;
    episodeParam = req.query.episode as string | undefined;
  }
  // Strict string equality on query params — Express can yield string[] for repeated keys.
  const userPickRaw = req.query.user_pick;
  const userPick = tPackUserPick || (typeof userPickRaw === 'string' && userPickRaw === '1');
  const sessionKey = tPackSessionKey ?? (typeof req.query.sk === 'string' ? req.query.sk : undefined);

  // UR tile clicks send only `sk` (no nzb/title) and rely on the lobby block below.
  // Regular requests must still provide nzb+title.
  const isUrTileRequest = !userPick && !!sessionKey && !nzbUrl && globalConfig.ultimateResolve?.enabled === true;
  if (!isUrTileRequest && (!nzbUrl || !title)) {
    res.status(400).send('Missing required parameters: nzb, title');
    return;
  }

  const streamStartTime = Date.now();

  // Build episode pattern for season pack file selection (e.g. "S02E05")
  let episodePattern: string | undefined;
  const epcountParam = tPackEpcount ?? (req.query.epcount as string | undefined);
  const episodesInSeason = epcountParam ? parseInt(epcountParam, 10) : undefined;
  const isSeasonPackRequest = (tPackSp ?? req.query.sp) === '1';
  if (seasonParam && episodeParam) {
    episodePattern = buildEpisodePattern(
      parseInt(seasonParam, 10),
      parseInt(episodeParam, 10),
      getTvAllowMultiEpisode(globalConfig),
    );
  }

  // Build the list of candidates to try (primary first, then fallbacks).
  // Skip the initial candidate when nzbUrl/title are empty (UR tile request case):
  // a sentinel with empty fields would cause prepareStream to scan the library root
  // if it survived past the fbg-expansion block (e.g. when fbg is set but the group
  // has expired).
  const candidates: FallbackCandidate[] = [];
  if (nzbUrl && title) {
    candidates.push({ nzbUrl, title, indexerName, isSeasonPack: isSeasonPackRequest });
  }

  const fallbackEnabled = globalConfig.nzbdavFallbackEnabled === true || globalConfig.ultimateResolve?.enabled;
  const maxFallbacksSetting = globalConfig.nzbdavMaxFallbacks ?? 0; // 0 = unlimited (try all)

  // Check whether this request should produce detailed logs.
  // During fallback processing, a single stream title may generate multiple
  // self-redirect requests. shouldLogStreamRequest returns true for the
  // first request and then emits a compact summary every 30 s.
  const verbose = shouldLogStreamRequest(title, 'request');

  if (fallbackGroupId && fallbackEnabled) {
    const group = getFallbackGroup(fallbackGroupId);
    if (group) {
      const fallbackOrder = globalConfig.nzbdavFallbackOrder || 'top';
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
          candidates.push({ nzbUrl, title, indexerName, isSeasonPack: isSeasonPackRequest });
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
          candidates.push({ nzbUrl, title, indexerName, isSeasonPack: isSeasonPackRequest });
          candidates.push(...group.candidates);
        }
      }
      if (verbose) {
        const totalToTry = maxFallbacksSetting === 0
          ? candidates.length
          : Math.min(candidates.length, 1 + maxFallbacksSetting);
        console.log(`🔄 Fallback group loaded (${fallbackOrder}): ${candidates.length} candidates (trying up to ${totalToTry})`);
      }

      // If episode info wasn't in the request URL (individual episode stream),
      // use the group's stored episode so season pack fallbacks select the right file.
      if (!episodePattern && group.season && group.episode) {
        const s = parseInt(group.season, 10).toString().padStart(2, '0');
        const e = parseInt(group.episode, 10).toString().padStart(2, '0');
        const allowMultiEp = getTvAllowMultiEpisode(globalConfig);
        episodePattern = allowMultiEp
          ? `S${s}(?:[. _-]?E\\d+|-\\d{1,2})*(?:[. _-]?E${e}|-${e})(?!\\d)`
          : `S${s}[. _-]?E${e}(?!\\d|[. _-]?E\\d|-\\d)`;
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
  // Evict expired entries once before the loop so isDeadNzb() trusts existence
  cleanupExpiredCache();
  cleanupRecentDeliveries();

  // Stremio dedup: return cached delivery for subsequent requests on the same stream (within 10 min).
  // Catches seeks, probes, and dupes without re-running library check or re-submitting NZBs.
  // Only for fresh initial requests — self-redirects (_ci set) bypass dedup to allow fallback retry.
  const isFreshRequest = candidateStart === 0 && !req.query._ci;
  if (isFreshRequest && candidates.length > 0) {
    const firstDeadKey = getDeadCacheKey(candidates[0].nzbUrl, episodePattern);
    if (!isDeadNzb(firstDeadKey) && !isDeadNzbByUrl(candidates[0].nzbUrl)) {
      const dedupKey = getCacheKey(candidates[0].nzbUrl, candidates[0].title) + (episodePattern ? `:${episodePattern}` : '');
      const cached = recentDeliveries.get(dedupKey);
      if (cached && Date.now() - cached.timestamp < DEDUP_CACHE_TTL_MS && !isVideoPathBroken(cached.streamData.videoPath)) {
        // Serve dupes / seeks / probes using the cached videoPath — no re-prep,
        // no library check, no submission. If the path becomes broken mid-session
        // (WebDAV eviction) we fall through to a fresh candidate loop via the
        // isVideoPathBroken gate above.
        if (verbose) console.log(`📦 Stream dedup hit (delivered ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`);
        const fallbackOn = globalConfig.nzbdavFallbackEnabled === true || globalConfig.ultimateResolve?.enabled;
        const sizeSuffix = cached.streamData.videoSize ? ` (${formatBytes(cached.streamData.videoSize)})` : '';
        if (cached.streamingMethod === 'direct') {
          const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
          const safePath = encodeWebdavPath(cached.streamData.videoPath);
          const directUrl = new URL(`${webdavBase}${safePath}`);
          if (config.webdavUser) {
            directUrl.username = config.webdavUser;
            directUrl.password = config.webdavPassword || '';
          }
          console.log(`  ⇗️ Direct passthrough: → ${directUrl.hostname}${safePath}${sizeSuffix}`);
          res.redirect(302, directUrl.href);
        } else if (!fallbackOn && proxyFn) {
          // Inline proxy — no redirect, matches primary delivery path. Runs
          // another proxyVideoStream for this request; req.on('close') ensures
          // cleanup if the client aborts.
          const label = cached.streamingMethod === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
          console.log(`  ${label} streaming: ${cached.streamData.videoPath}${sizeSuffix}`);
          await proxyFn(req, res, cached.streamData.videoPath, cached.streamingMethod !== 'proxy');
        } else {
          const proxyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/v`);
          proxyUrl.searchParams.set('path', cached.streamData.videoPath);
          proxyUrl.searchParams.set('_fb', req.originalUrl);
          if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
          const label = cached.streamingMethod === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
          console.log(`  ${label} 302 streaming: ${cached.streamData.videoPath}${sizeSuffix}`);
          res.redirect(302, proxyUrl.href);
        }
        return;
      }
    }
  }

  // ── Ultimate-Resolve Lobby ─────────────────────────────────────────
  // When Ultimate-Resolve is active and the user didn't explicitly pick a
  // stream tile (user_pick=1), await its session promise instead of starting
  // our own nzbdav submission. Self-redirect keeps ExoPlayer alive.
  if (!userPick && globalConfig.ultimateResolve?.enabled && sessionKey) {
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

          // Check if the resolved videoPath was evicted (404/5xx) — fall through to fallback loop
          if (isVideoPathBroken(streamData.videoPath)) {
            console.log(`👑 Lobby: primary path no longer available — falling through to fallback`);
            throw new Error('Primary path no longer available');
          }

          // Ultimate-Resolve resolved — deliver the stream
          const lobbyFallbackOn = globalConfig.nzbdavFallbackEnabled === true || globalConfig.ultimateResolve?.enabled;
          let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'pipe';
          if (!lobbyFallbackOn) mode = 'pipe';
          const lastLobby = lastDeliveryLog.get(streamData.videoPath);
          const shouldLogLobby = !lastLobby || lastLobby.mode !== mode;
          lastDeliveryLog.set(streamData.videoPath, { mode, at: Date.now() });
          if (shouldLogLobby) console.log(`👑 Lobby: serving Ultimate-Resolve result for ${sessionKey}`);
          const lobbySizeSuffix = streamData.videoSize ? ` (${formatBytes(streamData.videoSize)})` : '';
          if (mode !== 'direct') {
            const inline = proxyFn && !lobbyFallbackOn;
            const label = mode === 'pipe' ? '🔗 Pipe' : '📡 Dual-Stage Proxy';
            if (shouldLogLobby) console.log(`  ${label}${inline ? '' : ' 302'} streaming: ${streamData.videoPath}${lobbySizeSuffix}`);
            if (inline) {
              await proxyFn!(req, res, streamData.videoPath, mode !== 'proxy');
            } else {
              const proxyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/v`);
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
            // Stremio timeout approaching — self-redirect to keep ExoPlayer alive
            const redirectUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
            redirectUrl.searchParams.set('_rc', String(redirectCount + 1));
            console.log(`👑 Lobby: self-redirect (${Math.round((Date.now() - streamStartTime) / 1000)}s elapsed, redirect ${redirectCount + 1})`);
            res.redirect(302, redirectUrl.href);
            return;
          }
          // Session promise rejected (all candidates exhausted) — fall through to single attempt
          console.log(`👑 Lobby: session ended without resolution — falling through to single attempt`);
        }
      }
    }
  }

  // UR tile request (no nzb/title in URL). If the Lobby's primary is unavailable,
  // iterate the session's UR-vetted backup streams and serve the first with an
  // unbroken videoPath directly — no candidate loop, no re-submit, no TTL
  // coupling. /v's _fb param bounces back to this tile URL on mid-stream break,
  // which re-enters here and picks the next backup (previous now isVideoPathBroken).
  if (isUrTileRequest) {
    const urBackups = sessionKey ? getSessionBackups(sessionKey) : null;
    const usable = (urBackups?.backupStreams ?? []).find(b => !isVideoPathBroken(b.videoPath));
    if (usable) {
      console.log(`👑 UR tile: primary path no longer available — falling back to UR backup: ${usable.title} [${usable.indexerName}]`);
      const lobbyFallbackOn = globalConfig.nzbdavFallbackEnabled === true || globalConfig.ultimateResolve?.enabled;
      let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'pipe';
      if (!lobbyFallbackOn) mode = 'pipe';
      if (mode === 'direct') {
        const webdavBase = (config.webdavUrl || config.url || '').replace(/\/+$/, '');
        const directUrl = new URL(`${webdavBase}${encodeWebdavPath(usable.videoPath)}`);
        if (config.webdavUser) { directUrl.username = config.webdavUser; directUrl.password = config.webdavPassword || ''; }
        res.redirect(302, directUrl.href);
      } else if (proxyFn && !lobbyFallbackOn) {
        await proxyFn(req, res, usable.videoPath, mode !== 'proxy');
      } else {
        const proxyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/v`);
        proxyUrl.searchParams.set('path', usable.videoPath);
        proxyUrl.searchParams.set('_fb', req.originalUrl);
        if (req.query._norange === '1') proxyUrl.searchParams.set('_norange', '1');
        res.redirect(302, proxyUrl.href);
      }
      return;
    }
    const backupCount = urBackups?.backupStreams?.length ?? 0;
    const sessionExists = sessionKey ? getSessionPromise(sessionKey) !== null : false;
    if (backupCount > 0) {
      console.log(`👑 UR tile: ${backupCount} backup(s) checked but all broken — serving failure video`);
    } else if (sessionExists) {
      console.log(`👑 UR tile: session active but no backups produced (sk=${sessionKey}) — serving failure video`);
    } else {
      console.log(`👑 UR tile: no session for sk=${sessionKey} (expired or never triggered) — serving failure video`);
    }
    await sendFailureVideo(req, res);
    return;
  }

  const deadSkipKey = fallbackGroupId || nzbUrl;
  const logDeadSkips = !deadSkipLoggedGroups.has(deadSkipKey);

  // Build candidate order.
  // user_pick + UR enabled: honor the click, try only that NZB, fall into UR lobby on failure.
  // user_pick + UR disabled: classic NZB Fallback — walk the candidate chain starting from the click.
  // Otherwise (UR tile click / lobby fall-through): prefer UR's pre-vetted backups, then
  // resume sequential from after the last vetted URL.
  const urLobbyAvailable = globalConfig.ultimateResolve?.enabled === true;
  const sessionBackups = sessionKey ? getSessionBackups(sessionKey) : null;
  const candidateOrder: number[] = [];
  if (userPick && urLobbyAvailable) {
    candidateOrder.push(candidateStart);
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

    // Skip candidates already known to be dead
    const deadKey = getDeadCacheKey(candidate.nzbUrl, episodePattern);
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
        const pendingKey = getCacheKey(candidate.nzbUrl, candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        if (!streamCacheMap.has(pendingKey) && !isDeadNzb(deadKey)) {
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose, candidate.isSeasonPack).catch(() => {});
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
          getOrCreateStream(candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose, candidate.isSeasonPack, true)
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
            getOrCreateStream(candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose, candidate.isSeasonPack, true)
              .finally(() => clearTimeout(stremioTimerId)),
            new Promise<never>((_, reject) => {
              stremioTimerId = setTimeout(() => reject(Object.assign(new Error('Stremio timeout redirect'), { isExoTimeout: true })), stremioRemainingMs);
            })
          ]);
        } else {
          streamData = await getOrCreateStream(
            candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason, candidate.indexerName, verbose, candidate.isSeasonPack, true
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
      // When fallback is off, the initial-delivery mode still forces pipe for
      // logging/dedup consistency; /v's proxyVideoStream independently reads
      // config on each range request, so seeks honor the user's current method.
      const fallbackOn = globalConfig.nzbdavFallbackEnabled === true || globalConfig.ultimateResolve?.enabled;
      let mode: 'pipe' | 'proxy' | 'direct' = globalConfig.nzbdavStreamingMethod ?? 'pipe';
      if (!fallbackOn) mode = 'pipe';
      const last = lastDeliveryLog.get(streamData.videoPath);
      const shouldLogDelivery = !last || last.mode !== mode;
      lastDeliveryLog.set(streamData.videoPath, { mode, at: Date.now() });

      // Cache delivery for Stremio request dedup (10 min TTL) — populated BEFORE
      // delivery so concurrent probes from Stremio land on the dedup path instead
      // of triggering another prep.
      const dedupKey = getCacheKey(candidate.nzbUrl, candidate.title) + (episodePattern ? `:${episodePattern}` : '');
      recentDeliveries.set(dedupKey, { streamData, streamingMethod: mode, timestamp: Date.now() });

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
          const proxyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/v`);
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
        const redirectUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        redirectUrl.searchParams.set('_rc', String(redirectCount + 1));
        redirectUrl.searchParams.set('_ci', String(i));
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

      // User-pick failure: fall straight into the UR lobby instead of walking the candidate chain.
      // The user explicitly chose this NZB; when it fails, UR's pre-vetted pool is the fallback.
      // Redirect only if we still have self-redirect budget and haven't already sent headers.
      if (
        userPick
        && sessionKey
        && globalConfig.ultimateResolve?.enabled
        && redirectCount < MAX_SELF_REDIRECTS
        && !res.headersSent
      ) {
        const lobbyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/stream/ultimate-resolve`);
        lobbyUrl.searchParams.set('sk', sessionKey);
        lobbyUrl.searchParams.set('_rc', String(redirectCount + 1));
        console.log(`👑 User-pick failed — redirecting to UR lobby (rc=${redirectCount + 1})`);
        res.redirect(302, lobbyUrl.href);
        return;
      }
    }
  }

  // User-pick loop exhausted without serving (e.g. the clicked NZB was dead-cached and
  // `continue`d past the catch-block's lobby redirect). Fall into the UR lobby as the
  // final fallback before the failure video.
  if (
    userPick
    && sessionKey
    && globalConfig.ultimateResolve?.enabled
    && redirectCount < MAX_SELF_REDIRECTS
    && !res.headersSent
  ) {
    const lobbyUrl = new URL(`${req.protocol}://${req.get('host')}${req.baseUrl}/stream/ultimate-resolve`);
    lobbyUrl.searchParams.set('sk', sessionKey);
    lobbyUrl.searchParams.set('_rc', String(redirectCount + 1));
    console.log(`👑 User-pick exhausted — redirecting to UR lobby (rc=${redirectCount + 1})`);
    res.redirect(302, lobbyUrl.href);
    return;
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

/**
 * Stream Handler
 * Main stream preparation pipeline and HTTP streaming proxy.
 * Handles NZB submission -> job polling -> video discovery -> HTTP proxy with
 * backpressure, range requests, and automatic fallback on failure.
 */

import { Request, Response as ExpressResponse } from 'express';
import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { pipeline, PassThrough, Readable } from 'stream';
import { promisify } from 'util';
import axios from 'axios';
import http from 'http';
import https from 'https';
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
// HTTP Streaming Constants
// ============================================================================

const NZBDAV_STREAM_TIMEOUT_MS = 240000; // 4 minutes

// Upstream reconnect settings: when the NZBDav WebDAV connection drops mid-stream,
// transparently reconnect from the last byte sent instead of forcing the client to retry.
const UPSTREAM_MAX_RECONNECTS = Number(process.env.STREAM_MAX_RECONNECTS) || 30;
const UPSTREAM_RECONNECT_BASE_DELAY_MS = 1000;   // 1s initial delay
const UPSTREAM_RECONNECT_MAX_DELAY_MS = 8000;     // 8s cap
const UPSTREAM_RECONNECT_TIMEOUT_MS = 30000;       // 30s timeout for reconnect requests

// Keep-alive agents so successive range requests from the video player reuse
// existing TCP/TLS connections instead of paying the full handshake cost each time.
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// ============================================================================
// Streaming Log Throttle
// ============================================================================
// Video players (especially Stremio's internal player) make dozens of rapid
// HTTP range requests per second during normal playback. Logging every single
// one floods the console with noise. Instead, track request counts per stream
// and emit a compact summary every STREAM_LOG_INTERVAL_MS.

const STREAM_LOG_INTERVAL_MS = 30_000; // 30 seconds

interface StreamLogState {
  requests: number;
  disconnects: number;
  upstreamReconnects: number;
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
    state = { requests: 0, disconnects: 0, upstreamReconnects: 0, lastLogAt: now, seenFirst: false };
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
    const upReconns = state.upstreamReconnects;
    state.requests = 0;
    state.disconnects = 0;
    state.upstreamReconnects = 0;
    state.lastLogAt = now;
    if (reqs > 0 || discs > 0 || upReconns > 0) {
      const parts = [`${reqs} range request${reqs !== 1 ? 's' : ''}`, `${discs} reconnect${discs !== 1 ? 's' : ''}`];
      if (upReconns > 0) parts.push(`${upReconns} upstream reconnect${upReconns !== 1 ? 's' : ''}`);
      console.log(`  \u{1F4CA} Streaming ${title}: ${parts.join(', ')} in last ${STREAM_LOG_INTERVAL_MS / 1000}s`);
    }
    return false;
  }

  return false;
}

/**
 * Resolve the stream buffer size in bytes.
 * Priority: STREAM_BUFFER_MB env var > config UI setting > 64 MB default.
 */
function getStreamBufferBytes(): number {
  const envMB = Number(process.env.STREAM_BUFFER_MB);
  if (Number.isFinite(envMB) && envMB > 0) return envMB * 1024 * 1024;
  const configMB = globalConfig.nzbdavStreamBufferMB;
  if (configMB != null && configMB > 0) return configMB * 1024 * 1024;
  return 64 * 1024 * 1024; // 64MB default
}

const MIME_TYPES: Record<string, string> = {
  'mkv': 'video/x-matroska',
  'mp4': 'video/mp4',
  'avi': 'video/x-msvideo',
  'm4v': 'video/mp4',
  'mov': 'video/quicktime',
  'ts': 'video/mp2t',
  'm2ts': 'video/mp2t',
};

function inferMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'video/mp4';
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
    || message.includes('aborted')
    || axios.isCancel(error);
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
  console.log(`\n\u{1F3AC} Preparing stream: ${title}${episodePattern ? ` (selecting ${episodePattern})` : ''} [${contentType || 'unknown'}]`);

  // Step 0: Check NZB library first - avoid grabbing from indexer if already downloaded
  const libraryResult = await checkNzbLibrary(title, config, episodePattern, contentType, episodesInSeason);
  if (libraryResult) {
    console.log(`\u2705 Stream ready (from library): ${title}\n`);
    return libraryResult;
  }

  // Step 1: Submit NZB
  const nzoId = await submitNzb(nzbUrl, title, config, contentType);

  // Step 2: Wait for job to complete (or fail)
  await waitForJobCompletion(nzoId, config, undefined, undefined, contentType);

  // Step 3: Find the video file
  const video = await waitForVideoFile(nzoId, title, config, undefined, undefined, episodePattern, contentType, episodesInSeason);

  console.log(`\u2705 Stream ready: ${title}\n`);

  return {
    nzoId,
    videoPath: video.path,
    videoSize: video.size,
  };
}

// ============================================================================
// HTTP Streaming Proxy — Helpers
// ============================================================================

interface ContentRangeInfo {
  start: number;
  end: number;
  total: number | null; // null when total is '*'
}

function parseContentRange(header: string | undefined): ContentRangeInfo | null {
  if (!header) return null;
  const match = header.match(/bytes\s+(\d+)-(\d+)\s*\/\s*(\d+|\*)/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

/**
 * Make a streaming GET request to the upstream NZBDav WebDAV server.
 * Extracted so it can be reused for both initial requests and reconnects.
 */
async function makeUpstreamRequest(
  targetUrl: string,
  config: NZBDavConfig,
  userAgent: string,
  rangeHeader: string,
  signal: AbortSignal,
  timeoutMs: number = NZBDAV_STREAM_TIMEOUT_MS,
): Promise<import('axios').AxiosResponse> {
  return axios.request({
    url: targetUrl,
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      'Accept-Encoding': 'identity',
      'Range': rangeHeader,
    },
    responseType: 'stream',
    timeout: timeoutMs,
    signal,
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent,
    auth: config.webdavUser && config.webdavPassword ? {
      username: config.webdavUser,
      password: config.webdavPassword,
    } : undefined,
    validateStatus: (status: number) => status < 500,
  });
}

/**
 * Manually pipe an upstream stream through a buffered PassThrough to the Express response.
 * Tracks bytes written to `res` via the `onChunk` callback.
 * Handles backpressure: pauses the buffer when `res.write()` signals pressure.
 * Can skip leading bytes on reconnect (when upstream returns overlapping data).
 */
function consumeUpstream(
  upstream: Readable,
  res: ExpressResponse,
  req: Request,
  onChunk: (byteLength: number) => void,
  skipBytes: number = 0,
): Promise<void> {
  const buffer = new PassThrough({ highWaterMark: getStreamBufferBytes() });
  upstream.pipe(buffer);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let skipped = 0;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      buffer.removeListener('data', onData);
      buffer.removeListener('end', onEnd);
      buffer.removeListener('error', onBufferError);
      upstream.removeListener('error', onUpstreamError);
      res.removeListener('drain', onDrain);
      req.removeListener('close', onClientGone);
      if (err) reject(err); else resolve();
    };

    const onData = (chunk: Buffer) => {
      // Skip leading bytes on reconnect (overlap from upstream)
      if (skipBytes > 0 && skipped < skipBytes) {
        const remaining = skipBytes - skipped;
        if (chunk.length <= remaining) {
          skipped += chunk.length;
          return;
        }
        chunk = chunk.subarray(remaining);
        skipped = skipBytes;
      }

      onChunk(chunk.length);
      const ok = res.write(chunk);
      if (!ok) buffer.pause();
    };

    const onDrain = () => {
      if (!settled) buffer.resume();
    };

    const onEnd = () => finish();

    const onBufferError = (err: Error) => finish(err);

    const onUpstreamError = (err: Error) => {
      // Upstream died — destroy the buffer (discards any buffered-but-unsent data)
      // so we can reconnect from the accurate bytesSent offset.
      buffer.destroy();
      finish(err);
    };

    const onClientGone = () => {
      if (res.writableFinished) return; // Normal completion race
      upstream.destroy();
      buffer.destroy();
      const err = new Error('Client disconnected') as NodeJS.ErrnoException;
      err.code = 'ERR_STREAM_PREMATURE_CLOSE';
      finish(err);
    };

    buffer.on('data', onData);
    buffer.on('end', onEnd);
    buffer.on('error', onBufferError);
    upstream.on('error', onUpstreamError);
    res.on('drain', onDrain);
    req.on('close', onClientGone);
  });
}

/**
 * Stream data from upstream to the client with transparent upstream reconnect.
 * When the NZBDav WebDAV connection drops mid-stream, reconnects from the last
 * byte delivered to the client using a new Range request. The client never knows
 * the upstream connection was lost — it just keeps receiving bytes.
 */
async function pipeWithReconnect(
  initialUpstream: Readable,
  res: ExpressResponse,
  req: Request,
  rangeStart: number,
  rangeEnd: number,
  totalSize: number | null,
  targetUrl: string,
  config: NZBDavConfig,
  userAgent: string,
  abortController: AbortController,
  title: string,
): Promise<void> {
  let bytesSent = 0;
  let reconnectCount = 0;

  // First consume attempt with the initial upstream
  try {
    await consumeUpstream(initialUpstream, res, req, (len) => { bytesSent += len; });
    return; // Stream completed cleanly
  } catch (firstError) {
    if (req.destroyed || res.writableEnded || res.destroyed) {
      throw firstError; // Client disconnected — let handleStream handle it
    }
  }

  // Upstream failed while client is still alive — enter reconnect loop
  while (reconnectCount < UPSTREAM_MAX_RECONNECTS) {
    reconnectCount++;

    const resumeByte = rangeStart + bytesSent;
    const delay = Math.min(
      UPSTREAM_RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(reconnectCount - 1, 3)),
      UPSTREAM_RECONNECT_MAX_DELAY_MS,
    );

    console.log(
      `  \u{1F504} Upstream reconnect [${reconnectCount}/${UPSTREAM_MAX_RECONNECTS}]: ` +
      `resuming from byte ${resumeByte} (${Math.round(bytesSent / 1024 / 1024)}MB sent), delay ${delay}ms`
    );

    // Update throttled log state
    const logState = streamLogState.get(title);
    if (logState) logState.upstreamReconnects++;

    await new Promise(r => setTimeout(r, delay));

    // Client may have left during the backoff
    if (req.destroyed || res.writableEnded || res.destroyed) return;

    // Attempt to establish a new upstream connection
    let newResponse: import('axios').AxiosResponse;
    try {
      newResponse = await makeUpstreamRequest(
        targetUrl, config, userAgent,
        `bytes=${resumeByte}-${rangeEnd}`,
        abortController.signal,
        UPSTREAM_RECONNECT_TIMEOUT_MS,
      );
    } catch {
      // Connection attempt failed — try again next iteration
      continue;
    }

    // Validate Content-Range on the reconnected response
    const newRange = parseContentRange(newResponse.headers['content-range']);

    // Check file hasn't been replaced/modified
    if (newRange && totalSize != null && newRange.total != null && newRange.total !== totalSize) {
      console.warn(`  \u26A0\uFE0F File size changed on reconnect: ${totalSize} \u2192 ${newRange.total}. Ending stream.`);
      newResponse.data.destroy();
      if (!res.writableEnded) res.end();
      return;
    }

    // Handle byte overlap or gap
    let skipBytes = 0;
    if (newRange) {
      if (newRange.start < resumeByte) {
        skipBytes = resumeByte - newRange.start;
      } else if (newRange.start > resumeByte) {
        // Gap in data — can't fix without corrupting the stream
        console.warn(`  \u26A0\uFE0F Upstream returned byte ${newRange.start}, expected ${resumeByte}. Ending stream.`);
        newResponse.data.destroy();
        if (!res.writableEnded) res.end();
        return;
      }
    }

    // Consume the reconnected stream
    try {
      await consumeUpstream(newResponse.data, res, req, (len) => { bytesSent += len; }, skipBytes);
      return; // Stream completed cleanly
    } catch (err) {
      if (req.destroyed || res.writableEnded || res.destroyed) {
        throw err; // Client disconnected
      }
      // Upstream failed again — continue reconnect loop
    }
  }

  // All reconnect attempts exhausted
  console.error(`  \u26D4 Exhausted ${UPSTREAM_MAX_RECONNECTS} upstream reconnect attempts for ${title}`);
  if (!res.writableEnded) res.end();
}

// ============================================================================
// HTTP Streaming Proxy
// ============================================================================

/**
 * Proxy a WebDAV file stream directly via HTTP using axios.
 * Avoids the webdav library's createReadStream which buffers entire files in memory.
 * Uses transparent upstream reconnect for resilience on large files.
 * Cancels the upstream request when the client disconnects to prevent memory leaks.
 */
async function proxyNzbdavStream(
  req: Request,
  res: ExpressResponse,
  videoPath: string,
  config: NZBDavConfig,
  knownFileSize?: number,
  verbose = true,
  title = '',
): Promise<void> {
  const webdavBase = (config.webdavUrl || config.url).replace(/\/+$/, '');
  const encodedPath = videoPath
    .split('/')
    .map(segment => segment ? encodeURIComponent(segment) : '')
    .join('/');
  const targetUrl = `${webdavBase}${encodedPath}`;

  const isHead = req.method?.toUpperCase() === 'HEAD';
  const userAgent = globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome;

  // For HEAD requests, respond immediately with cached size -- no round-trip to nzbdav
  if (isHead && knownFileSize) {
    if (verbose) console.log(`  \u{1F504} HEAD ${videoPath} (cached size: ${knownFileSize})`);
    res.status(200);
    res.setHeader('Content-Length', knownFileSize);
    res.setHeader('Content-Type', inferMimeType(videoPath));
    res.setHeader('Accept-Ranges', 'bytes');
    res.end();
    return;
  }

  // AbortController to cancel the upstream request when the client disconnects
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on('close', onClientClose);

  try {
    // Build headers to forward
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept-Encoding': 'identity',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'] as string;

    // Use cached file size, or fall back to a HEAD request for full GETs
    let totalFileSize: number | null = knownFileSize || null;
    if (!totalFileSize && !req.headers.range && !isHead) {
      try {
        const headResponse = await axios.request({
          url: targetUrl,
          method: 'HEAD',
          headers: { 'User-Agent': userAgent },
          timeout: 30000,
          signal: abortController.signal,
          httpAgent: keepAliveHttpAgent,
          httpsAgent: keepAliveHttpsAgent,
          auth: config.webdavUser && config.webdavPassword ? {
            username: config.webdavUser,
            password: config.webdavPassword,
          } : undefined,
          validateStatus: (status) => status < 500,
        });
        const cl = headResponse.headers['content-length'];
        if (cl) {
          totalFileSize = Number(cl);
          console.log(`  \u{1F4CF} HEAD reported total size ${totalFileSize} bytes`);
        }
      } catch (headErr) {
        if (isClientDisconnect(headErr)) throw headErr;
        console.warn(`  \u26A0\uFE0F HEAD request failed, continuing without pre-fetched size: ${(headErr as Error).message}`);
      }

      // Synthesize a full Range header so the upstream always returns Content-Range
      if (totalFileSize && totalFileSize > 0) {
        headers['Range'] = `bytes=0-${totalFileSize - 1}`;
        console.log(`  \u{1F4D0} Synthesized Range: bytes=0-${totalFileSize - 1}`);
      }
    }

    // For HEAD requests without cached size, use a range trick to avoid downloading the body
    if (isHead) {
      headers['Range'] = 'bytes=0-0';
    }

    const requestConfig = {
      url: targetUrl,
      method: 'GET' as const,
      headers,
      responseType: 'stream' as const,
      timeout: NZBDAV_STREAM_TIMEOUT_MS,
      signal: abortController.signal,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
      auth: config.webdavUser && config.webdavPassword ? {
        username: config.webdavUser,
        password: config.webdavPassword,
      } : undefined,
      validateStatus: (status: number) => status < 500,
    };

    if (verbose) console.log(`  \u{1F504} Proxying ${isHead ? 'HEAD' : 'GET'} ${videoPath}`);

    const nzbdavResponse = await axios.request(requestConfig);

    let responseStatus = nzbdavResponse.status;
    const contentRange = nzbdavResponse.headers['content-range'];

    // If we got a 200 with Content-Range, it's actually a 206
    if (contentRange && responseStatus === 200) {
      responseStatus = 206;
    }

    // For HEAD requests, extract total size from Content-Range and respond
    if (isHead) {
      if (nzbdavResponse.data && typeof nzbdavResponse.data.destroy === 'function') {
        nzbdavResponse.data.destroy();
      }

      // Parse total size from Content-Range: bytes 0-0/TOTAL
      let headSize: number | null = null;
      if (contentRange) {
        const match = contentRange.match(/bytes\s+\d+-\d+\s*\/\s*(\d+)/i);
        if (match) headSize = Number(match[1]);
      }

      res.status(200);
      if (headSize != null) res.setHeader('Content-Length', headSize);
      res.setHeader('Content-Type', inferMimeType(videoPath));
      res.setHeader('Accept-Ranges', 'bytes');
      res.end();
      return;
    }

    // Set response status
    res.status(responseStatus);

    // Forward relevant headers from WebDAV response
    const headerBlocklist = new Set(['transfer-encoding', 'www-authenticate', 'set-cookie', 'cookie', 'authorization']);
    for (const [key, value] of Object.entries(nzbdavResponse.headers || {})) {
      if (!headerBlocklist.has(key.toLowerCase()) && value !== undefined) {
        res.setHeader(key, value as string);
      }
    }

    // Set Content-Type based on file extension
    res.setHeader('Content-Type', inferMimeType(videoPath));
    res.setHeader('Accept-Ranges', 'bytes');

    // Fix Content-Length from Content-Range if present
    if (contentRange) {
      const match = contentRange.match(/bytes\s+(\d+)-(\d+)\s*\/\s*(\d+|\*)/i);
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        const chunkLength = end - start + 1;
        if (Number.isFinite(chunkLength) && chunkLength > 0) {
          res.setHeader('Content-Length', String(chunkLength));
        }
      }
    } else if (totalFileSize != null && Number.isFinite(totalFileSize)) {
      // Use the pre-fetched HEAD size for full GET requests
      res.setHeader('Content-Length', String(totalFileSize));
    }

    // Flush headers immediately so the client sees the 206 response right away,
    // even before the first data chunk arrives from the upstream WebDAV server.
    // Without this, Express waits until the first res.write() to send headers,
    // which can cause impatient clients (e.g. Stremio) to disconnect and retry
    // in a tight loop if there's any upstream latency.
    res.flushHeaders();

    // Parse the byte range we're serving so pipeWithReconnect can resume from the right offset
    const range = parseContentRange(contentRange);
    const effectiveStart = range?.start ?? 0;
    const effectiveEnd = range?.end ?? (totalFileSize ? totalFileSize - 1 : Number.MAX_SAFE_INTEGER);
    const effectiveTotal = range?.total ?? totalFileSize ?? null;

    // Stream with transparent upstream reconnect (replaces single pipelineAsync)
    await pipeWithReconnect(
      nzbdavResponse.data,
      res,
      req,
      effectiveStart,
      effectiveEnd,
      effectiveTotal,
      targetUrl,
      config,
      userAgent,
      abortController,
      title || videoPath.split('/').pop() || videoPath,
    );
  } catch (error) {
    if (isClientDisconnect(error)) {
      // Normal: client seeked, stopped, or navigated away
      throw error; // Re-throw so handleStream can log it quietly
    }
    throw error;
  } finally {
    req.removeListener('close', onClientClose);
  }
}

// ============================================================================
// Failure Video
// ============================================================================

const FAILURE_VIDEO_PATH = path.resolve('ui/public/nzb_failure_video.mp4');

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

  const maxFallbacks = globalConfig.nzbdavMaxFallbacks ?? 9;

  // Check whether this request should produce detailed logs.
  // During active playback, the video player fires dozens of range requests per
  // second — logging each one floods the console. shouldLogStreamRequest returns
  // true for the first request and then emits a compact summary every 30 s.
  const verbose = shouldLogStreamRequest(title, 'request');

  if (fallbackGroupId && maxFallbacks > 0) {
    const group = getFallbackGroup(fallbackGroupId);
    if (group) {
      for (const candidate of group.candidates) {
        if (candidate.nzbUrl === nzbUrl && candidate.title === title) continue;
        candidates.push(candidate);
      }
      if (verbose) {
        const totalToTry = Math.min(candidates.length, 1 + maxFallbacks);
        console.log(`\u{1F504} Fallback group loaded: ${candidates.length} candidates available (will try up to ${totalToTry})`);
      }
    }
  }

  const maxCandidates = maxFallbacks === 0 ? 1 : Math.min(candidates.length, 1 + maxFallbacks);
  const streamCacheMap = getStreamCache();

  for (let i = 0; i < maxCandidates; i++) {
    const candidate = candidates[i];

    // Skip candidates already known to be failed in cache
    const cacheKey = getCacheKey(candidate.nzbUrl, candidate.title)
      + (episodePattern ? `:${episodePattern}` : '');
    const cached = streamCacheMap.get(cacheKey);
    if (cached?.status === 'failed') {
      console.log(`\u23ED\uFE0F Skipping known-failed [${i + 1}/${maxCandidates}]: ${candidate.title}`);
      continue;
    }

    try {
      if (i > 0) {
        console.log(`\u{1F504} Trying fallback [${i + 1}/${maxCandidates}]: ${candidate.title}`);
        if (trackGrabFn && candidate.indexerName) {
          trackGrabFn(candidate.indexerName, candidate.title);
        }
      }

      const streamData = await getOrCreateStream(
        candidate.nzbUrl, candidate.title, config, episodePattern, contentType, episodesInSeason
      );

      if (i > 0) {
        console.log(`\u2705 Fallback succeeded on attempt ${i + 1}/${maxCandidates}`);
      }

      await proxyNzbdavStream(req, res, streamData.videoPath, config, streamData.videoSize, verbose, candidate.title);
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

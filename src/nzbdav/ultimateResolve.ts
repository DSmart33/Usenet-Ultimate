/**
 * Ultimate-Resolve
 *
 * Combines NZB Fallback with Health Checking for the fastest possible
 * NZB resolution. Runs four parallel layers simultaneously:
 *   1. Library pre-check (WebDAV lookup — no NZB download needed)
 *   2. Grab chain (NZB download from indexers)
 *   3. Health checks (NNTP article verification, streams per-candidate as grabs complete)
 *   4. nzbdav submission (one active job at a time, direct API calls for cancellation control)
 */

import * as path from 'path';
import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { performHealthCheck } from '../health/healthCheckPipeline.js';
import { NntpConnectionPool } from '../health/nntpConnection.js';
import type { HealthCheckResult } from '../health/types.js';
import { isDeadNzbByUrl, getCacheKey, setReadyCacheEntry, setDeadNzbEntry, addDeadNzbByUrl, saveCacheToDisk } from './streamCache.js';
import { submitNzb, waitForJobCompletion, cancelJob, prefetchNzb } from './nzbdavApi.js';
import { checkNzbLibrary, waitForVideoFile } from './videoDiscovery.js';
import { encodeWebdavPath, nzbdavError } from './utils.js';
import { selectTimeoutMs, type TimeoutSet } from './timeoutDefaults.js';
import type { FallbackCandidate, NZBDavConfig, StreamData } from './types.js';
import { formatBytes } from '../parsers/metadataParsers.js';

// ── Types ────────────────────────────────────────────────────────────

interface CandidateState {
  candidate: FallbackCandidate;
  poolIndex: number;
  healthStatus: 'pending' | 'checking' | 'healthy' | 'dead' | 'error';
  grabStatus: 'pending' | 'grabbing' | 'done' | 'failed';
  healthPromise?: Promise<{ cs: CandidateState; result: HealthCheckResult }>;
  grabPromise?: Promise<{ cs: CandidateState; ok: boolean }>;
  nzbdavStatus: 'idle' | 'submitted' | 'completed' | 'failed' | 'skipped';
  nzoId?: string;
  cancelled?: boolean;
  containerType?: string;     // Video container (e.g. 'MKV') — from health check or library hit
  videoSize?: number;         // File size in bytes — known once primary/backup is resolved
  containerFallbackViaNzbdav?: boolean; // submitted without pre-resolved container; derive from videoPath post-resolve
  duplicate?: boolean;         // Resolved to same videoPath as another candidate
  duplicateOf?: number;        // poolIndex of the original candidate this duplicates
  replaced?: boolean;          // Replacement already pulled for this dead candidate
  nzbdavDeadWritten?: boolean; // setDeadNzbEntry already wrote a specific nzbdav-failure entry — don't shadow it with a generic URL-only one at end-of-pipeline
  grabFailed?: boolean;        // Grab never produced an NZB (indexer/network/VPN transient) — don't persist to dead NZB DB
}

interface UltimateResolveOptions {
  candidateCount: number;
  preferenceMode: 'priority' | 'speed';
  archiveInspection: boolean;
  sampleCount: 3 | 7;
  desiredBackups: number;
  backupProcessingLimit: number;
  priorityMoviesTimeoutSeconds: number;
  priorityTvTimeoutSeconds: number;
  prioritySeasonPackTimeoutSeconds: number;
  speedMoviesTimeoutSeconds: number;
  speedTvTimeoutSeconds: number;
  speedSeasonPackTimeoutSeconds: number;
  healthCheckIndexers?: Record<string, boolean>;
}

// ── Active session tracking ─────────────────────────────────────────

const activeSessions = new Map<string, AbortController>();

// UR-vetted backup metadata for in-session serving (no TTL coupling with fallback groups).
export interface UrBackupStream {
  nzbUrl: string;
  videoPath: string;
  title: string;
  indexerName: string;
}

// Session promises — lobby awaits these to get the resolved stream
interface DeferredStream {
  promise: Promise<StreamData>;
  resolve: (data: StreamData) => void;
  reject: (err: Error) => void;
  backupUrls?: Set<string>;   // NZB URLs of verified backups (for fallback loop prioritization)
  backupStreams?: UrBackupStream[]; // Parallel array with videoPaths — UR tile serves these directly when primary breaks
  lastVettedUrl?: string;      // Last NZB URL pulled into pool (for sequential resume point)
}
const sessionPromises = new Map<string, DeferredStream>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Get the session promise for a session key (used by stream handler lobby). */
export function getSessionPromise(sessionKey: string): Promise<StreamData> | null {
  return sessionPromises.get(sessionKey)?.promise ?? null;
}

/** Get backup URLs, vetted streams, and last vetted URL for a session key. Used by the
 *  fallback loop (backupUrls prioritization) and the UR tile gate (backupStreams direct serve). */
export function getSessionBackups(sessionKey: string): { backupUrls: Set<string>; backupStreams: UrBackupStream[]; lastVettedUrl?: string } | null {
  const deferred = sessionPromises.get(sessionKey);
  if (!deferred?.backupUrls?.size && !deferred?.backupStreams?.length) return null;
  return {
    backupUrls: deferred.backupUrls ?? new Set<string>(),
    backupStreams: deferred.backupStreams ?? [],
    lastVettedUrl: deferred.lastVettedUrl,
  };
}

/** Check if any Ultimate-Resolve sessions are active. */
export function hasAnySessions(): boolean {
  return activeSessions.size > 0;
}

/** Cancel all running Ultimate-Resolve sessions (called on settings change). */
export function cancelAllUltimateResolves(): void {
  const activeCount = activeSessions.size;
  if (activeCount > 0) {
    console.warn(`👑 Cancelling ${activeCount} active Ultimate-Resolve session(s)`);
  }
  for (const [, controller] of activeSessions) {
    controller.abort();
  }
  activeSessions.clear();
  for (const [, timer] of cleanupTimers) {
    clearTimeout(timer);
  }
  cleanupTimers.clear();
  // Reject pending deferreds so awaiting lobbies wake. DO NOT delete from
  // sessionPromises — resolved entries are cached primary streams; deleting
  // them severs in-flight playback for clients still polling the lobby URL.
  // The per-session cleanup setTimeout in ultimateResolveFromCandidates is
  // the sole deletion path. Rejecting an already-resolved promise is a no-op.
  for (const [, deferred] of sessionPromises) {
    deferred.reject(new Error('Ultimate-Resolve cancelled'));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isHealthy(result: HealthCheckResult): boolean {
  return result.status === 'verified' || result.status === 'verified_stored' || result.status === 'verified_archive';
}

/** Limit concurrency for a batch of async tasks. */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  const running = new Set<Promise<void>>();
  for (const task of tasks) {
    const p = task().then(r => { results.push(r); });
    running.add(p);
    p.finally(() => running.delete(p));
    if (running.size >= limit) await Promise.race(running);
  }
  await Promise.all(running);
  return results;
}

/** Probe a video file via WebDAV to verify it's servable. */
async function probeVideo(config: NZBDavConfig, videoPath: string, logPrefix: string): Promise<boolean> {
  const webdavBase = (config.webdavUrl || config.url).replace(/\/+$/, '');
  const probeUrl = `${webdavBase}${encodeWebdavPath(videoPath)}`;
  const probeHeaders: Record<string, string> = { 'Range': 'bytes=0-0' };
  if (config.webdavUser && config.webdavPassword) {
    probeHeaders['Authorization'] = 'Basic ' + Buffer.from(`${config.webdavUser}:${config.webdavPassword}`).toString('base64');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(10_000) });
      await resp.body?.cancel().catch(() => {});
      if (resp.status === 206 || resp.status === 200) return true;
      if (resp.status === 404 || resp.status === 410) return false;
    } catch { /* retry */ }
    if (attempt < 1) await new Promise(r => setTimeout(r, 2000));
  }
  console.warn(`${logPrefix}  ⚠️ Probe failed after 2 attempts`);
  return false;
}

// ── Main pipeline ────────────────────────────────────────────────────

export async function ultimateResolveFromCandidates(
  sessionKey: string,
  candidates: FallbackCandidate[],
  nzbdavConfig: NZBDavConfig,
  options: UltimateResolveOptions,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
): Promise<void> {
  if (activeSessions.has(sessionKey)) return;

  const controller = new AbortController();
  activeSessions.set(sessionKey, controller);

  // Create deferred promise — lobby awaits this to get the resolved stream
  let sessionResolve!: (data: StreamData) => void;
  let sessionReject!: (err: Error) => void;
  const sessionPromise = new Promise<StreamData>((res, rej) => { sessionResolve = res; sessionReject = rej; });
  sessionPromise.catch(() => {});
  const deferred: DeferredStream = { promise: sessionPromise, resolve: sessionResolve, reject: sessionReject, backupUrls: new Set(), backupStreams: [] };
  sessionPromises.set(sessionKey, deferred);

  const tag = `👑 Ultimate-Resolve [${sessionKey}]`;
  const providers = (globalConfig.healthChecks?.providers ?? []).filter(p => p.enabled);
  const userAgent = globalConfig.userAgents?.nzbDownload || getLatestVersions().chrome;
  const hasProviders = providers.length > 0;
  const pool = hasProviders ? new NntpConnectionPool() : undefined;

  try {
    // Filter out opted-out indexers
    let eligible = candidates;
    if (options.healthCheckIndexers) {
      const indexerMap = options.healthCheckIndexers;
      eligible = candidates.filter(c => indexerMap[c.indexerName] !== false);
    }

    const allCandidates = eligible;

    if (allCandidates.length === 0) {
      console.log(`${tag} No eligible candidates`);
      return;
    }

    const pipelineStart = Date.now();
    const activeSet: TimeoutSet = options.preferenceMode === 'priority'
      ? { movies: options.priorityMoviesTimeoutSeconds, tv: options.priorityTvTimeoutSeconds, seasonPack: options.prioritySeasonPackTimeoutSeconds }
      : { movies: options.speedMoviesTimeoutSeconds, tv: options.speedTvTimeoutSeconds, seasonPack: options.speedSeasonPackTimeoutSeconds };
    console.log(`${tag} Starting — ${allCandidates.length} candidate(s), pool size ${options.candidateCount}, mode: ${options.preferenceMode} (movies=${activeSet.movies}s, tv=${activeSet.tv}s, pack=${activeSet.seasonPack}s)`);

    // ── Stage 1: Library pre-check on ALL candidates ────────────
    const libraryTasks = allCandidates
      .filter(c => !isDeadNzbByUrl(c.nzbUrl))
      .map((candidate, i) => () =>
        checkNzbLibrary(candidate.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, `${tag} [lib #${i + 1}] `, true)
          .then(data => ({ candidate, index: i, data }))
          .catch(() => ({ candidate, index: i, data: null as StreamData | null }))
      );

    const libraryResults = await runWithConcurrency(libraryTasks, 4);

    if (controller.signal.aborted) return;

    // Hoisted state — set by either library hit or event loop resolution
    let primaryResolved = false;
    let resolvedStreamData = null as StreamData | null;
    const resolvedVideoPaths = new Set<string>();
    const videoPathOwner = new Map<string, number>(); // videoPath → poolIndex of first resolver
    const resolvedTitles = new Set<string>(); // titles already resolved — prevents cross-indexer duplicate submissions
    let primaryPoolIndex = -1;
    let primaryFromLibrary = false;
    let requiredContainerType: string | undefined;
    let backupCount = 0;
    let libraryBackupCount = 0;
    const libraryResolvedUrls = new Set<string>(); // NZB URLs already resolved as library hits
    let evaluatedAfterPrimary = 0;
    let skippedMismatch = 0;
    let skippedUnknown = 0;
    let duplicateCount = 0;
    let failedBackupCount = 0;
    let backupLimitReached = false;

    type LibraryHit = { candidate: FallbackCandidate; index: number; data: StreamData };
    const hits: LibraryHit[] = libraryResults
      .filter((r): r is LibraryHit => r.data !== null)
      .sort((a, b) => a.index - b.index);
    const hitUrls = new Set(hits.map(h => h.candidate.nzbUrl));

    // Promote a library-matched pool member to primary (if no primary yet) or backup.
    // Caller decides whether to start a grab — promoted candidates never need one.
    const promoteLibraryCandidate = (cs: CandidateState): 'primary' | 'backup' | 'duplicate' | 'mismatch' | 'already-promoted' | null => {
      const hit = hits.find(h => h.candidate.nzbUrl === cs.candidate.nzbUrl);
      if (!hit) return null;
      if (libraryResolvedUrls.has(cs.candidate.nzbUrl)) return 'already-promoted';
      const hitExt = path.extname(hit.data.videoPath).slice(1).toUpperCase();
      if (!primaryResolved) {
        const libElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
        console.log(`${tag} 📚 Library hit — ${hit.candidate.title} [${hit.candidate.indexerName}]`);
        const cacheKey = getCacheKey(hit.candidate.nzbUrl, hit.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        setReadyCacheEntry(cacheKey, hit.data, hit.candidate.indexerName);
        // Assign resolvedStreamData BEFORE sessionResolve so any awaiter observing
        // primaryResolved=true also sees resolvedStreamData populated.
        resolvedStreamData = hit.data;
        primaryResolved = true;
        primaryPoolIndex = cs.poolIndex;
        primaryFromLibrary = true;
        resolvedVideoPaths.add(hit.data.videoPath);
        videoPathOwner.set(hit.data.videoPath, cs.poolIndex);
        libraryResolvedUrls.add(hit.candidate.nzbUrl);
        resolvedTitles.add(hit.candidate.title);
        requiredContainerType = hitExt;
        cs.nzbdavStatus = 'skipped';
        cs.containerType = hitExt || undefined;
        cs.videoSize = hit.data.videoSize;
        sessionResolve(hit.data);
        console.log(`${tag} 📦 Container locked: ${requiredContainerType || 'unknown'} (from library hit #${cs.poolIndex + 1}, videoPath: ${hit.data.videoPath})`);
        console.log(`${tag} ✅ Resolved via library in ${libElapsed}s`);
        return 'primary';
      }
      if (resolvedVideoPaths.has(hit.data.videoPath)) {
        cs.nzbdavStatus = 'skipped';
        cs.duplicate = true;
        cs.duplicateOf = videoPathOwner.get(hit.data.videoPath);
        if (hitExt) cs.containerType = hitExt;
        duplicateCount++;
        console.log(`${tag}   📦 #${cs.poolIndex + 1} Skipping (duplicate videoPath: ${hit.data.videoPath}) — ${cs.candidate.title.substring(0, 60)} [${cs.candidate.indexerName}]`);
        return 'duplicate';
      }
      if (requiredContainerType && hitExt && hitExt !== requiredContainerType) {
        cs.nzbdavStatus = 'skipped';
        cs.containerType = hitExt;
        skippedMismatch++;
        console.log(`${tag}   📦 #${cs.poolIndex + 1} Library hit skipped (${hitExt} ≠ ${requiredContainerType}) — ${cs.candidate.title.substring(0, 60)} [${cs.candidate.indexerName}]`);
        return 'mismatch';
      }
      resolvedVideoPaths.add(hit.data.videoPath);
      videoPathOwner.set(hit.data.videoPath, cs.poolIndex);
      libraryResolvedUrls.add(cs.candidate.nzbUrl);
      resolvedTitles.add(hit.candidate.title);
      deferred.backupUrls!.add(cs.candidate.nzbUrl);
      deferred.backupStreams!.push({ nzbUrl: cs.candidate.nzbUrl, videoPath: hit.data.videoPath, title: cs.candidate.title, indexerName: cs.candidate.indexerName });
      const cacheKey = getCacheKey(hit.candidate.nzbUrl, hit.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
      setReadyCacheEntry(cacheKey, hit.data, hit.candidate.indexerName);
      cs.nzbdavStatus = 'skipped';
      cs.containerType = hitExt || undefined;
      cs.videoSize = hit.data.videoSize;
      backupCount++;
      libraryBackupCount++;
      console.log(`${tag}   📦 #${cs.poolIndex + 1} Backup ready (library hit, ${hitExt || 'unknown'}, videoPath: ${hit.data.videoPath}) — ${cs.candidate.title.substring(0, 60)} [${cs.candidate.indexerName}]`);
      return 'backup';
    };

    // ── Stage 2: Stream processing pipeline ─────────────────────
    const poolSize = Math.min(options.candidateCount, allCandidates.length);
    const activePool: CandidateState[] = [];
    let nextCandidateIdx = 0;

    const addToPool = (candidate: FallbackCandidate, idx: number): CandidateState => {
      const cs: CandidateState = {
        candidate,
        poolIndex: idx,
        healthStatus: 'pending',
        grabStatus: 'pending',
        nzbdavStatus: 'idle',
      };
      activePool.push(cs);
      return cs;
    };

    for (let i = 0; i < poolSize && nextCandidateIdx < allCandidates.length; i++) {
      const c = allCandidates[nextCandidateIdx];
      if (isDeadNzbByUrl(c.nzbUrl)) { nextCandidateIdx++; i--; continue; }
      const cs = addToPool(c, nextCandidateIdx);
      deferred.lastVettedUrl = c.nzbUrl;
      if (hitUrls.has(c.nzbUrl)) promoteLibraryCandidate(cs);
      nextCandidateIdx++;
    }

    if (activePool.length === 0) {
      console.log(`${tag} All candidates are dead NZBs`);
      return;
    }

    if (primaryResolved) {
      console.log(`${tag} Continuing pipeline for backup candidates after library hit`);
    } else {
      console.log(`${tag} No library hits in pool — launching grab chain + health checks + nzbdav`);
      if (hits.length > 0) {
        console.log(`${tag} ⚠️ Found ${hits.length} library hit(s), none in initial pool — pool may snake toward them or post-drain sweep will pick up the rest`);
      }
    }

    const startGrab = (cs: CandidateState) => {
      cs.grabStatus = 'grabbing';
      cs.grabPromise = prefetchNzb(cs.candidate.nzbUrl, `${tag} [grab #${cs.poolIndex + 1}] `, true)
        .then(ok => { cs.grabStatus = ok ? 'done' : 'failed'; return { cs, ok }; })
        .catch(() => { cs.grabStatus = 'failed'; return { cs, ok: false }; });
    };

    const startHealthCheck = (cs: CandidateState) => {
      if (!hasProviders) { cs.healthStatus = 'healthy'; return; }
      cs.healthStatus = 'checking';
      cs.healthPromise = performHealthCheck(
        cs.candidate.nzbUrl, providers, userAgent,
        { archiveInspection: options.archiveInspection, sampleCount: options.sampleCount },
        pool,
      ).then(result => {
        cs.healthStatus = isHealthy(result) ? 'healthy' : 'dead';
        cs.containerType = result.containerType;
        return { cs, result };
      }).catch(err => {
        cs.healthStatus = 'error';
        return { cs, result: { status: 'error' as const, message: (err as Error).message, playable: false } };
      });
    };

    // Direct nzbdav pipeline — we own the lifecycle for cancellation control
    const startNzbdav = async (cs: CandidateState): Promise<StreamData | null> => {
      cs.nzbdavStatus = 'submitted';
      const logPrefix = `${tag} [nzbdav #${cs.poolIndex + 1}] `;
      try {
        // Cancel checkpoint: before HTTP starts
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 1: Submit NZB (uses cached XML from grab chain)
        const nzoId = await submitNzb(cs.candidate.nzbUrl, cs.candidate.title, nzbdavConfig, contentType, undefined, logPrefix);
        cs.nzoId = nzoId;

        // Cancel checkpoint: health check may have failed while submitNzb was in-flight
        if (cs.cancelled) {
          cancelJob(nzoId, nzbdavConfig, 'health check failed (late cancel)').catch(() => {});
          cs.nzbdavStatus = 'failed';
          return null;
        }

        // Step 2: Wait for job completion (per-mode, per-content-type budget)
        const jobTimeoutMs = selectTimeoutMs(activeSet, contentType, cs.candidate.isSeasonPack === true);
        await waitForJobCompletion(nzoId, nzbdavConfig, jobTimeoutMs, 250, contentType, logPrefix);

        // Cancel checkpoint: health check may have failed during polling
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 3: Find video file (waitForVideoFile logs the result)
        const video = await waitForVideoFile(nzoId, cs.candidate.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, logPrefix);

        // Cancel checkpoint: health check may have failed during video discovery
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 4: Probe video is servable
        const servable = await probeVideo(nzbdavConfig, video.path, logPrefix);
        if (!servable) {
          throw nzbdavError(`Video file not servable (probe failed): ${video.path}`);
        }

        // Step 5: Write to readyCache so stream handler can deliver
        const cacheKey = getCacheKey(cs.candidate.nzbUrl, cs.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        const streamData: StreamData = { nzoId, videoPath: video.path, videoSize: video.size };
        setReadyCacheEntry(cacheKey, streamData, cs.candidate.indexerName);

        cs.nzbdavStatus = 'completed';
        console.log(`${logPrefix}✅ Stream ready: ${cs.candidate.title}`);
        return streamData;
      } catch (err) {
        // Skip logging/cancelling if the event loop already cancelled this candidate
        if (cs.cancelled) return null;
        if (cs.nzoId) cancelJob(cs.nzoId, nzbdavConfig, 'pipeline failure').catch(() => {});
        if ((err as any)?.isNzbdavFailure) {
          setDeadNzbEntry(cs.candidate.nzbUrl, cs.candidate.title, err as Error, episodePattern);
          cs.nzbdavDeadWritten = true;
        }
        cs.nzbdavStatus = 'failed';
        console.log(`${logPrefix}❌ Failed: ${(err as Error).message}`);
        return null;
      }
    };

    const pullReplacement = (): CandidateState | null => {
      if (backupLimitReached) return null;
      // Also check live counts. The flag flips top-of-loop but pullReplacement
      // is called inline from the completion handlers — without this, a fresh
      // candidate gets grabbed between backupCount incrementing and the next
      // iteration's drain signal.
      if (primaryResolved) {
        // No backups wanted — block any post-primary grab. Catches the
        // inline-call race where `backupLimitReached` hasn't been set yet
        // by the top of the loop. Already-grabbed candidates still flow
        // through nzbdav submission (free backups); we just refuse to
        // start *new* work. Free library hits are picked up by the
        // post-drain sweep below regardless.
        if (options.desiredBackups === 0) return null;
        if (options.desiredBackups > 0 && backupCount >= options.desiredBackups) return null;
        // Cap total backup NZBs attempted via NNTP. Library-hit pool members
        // never grab segments (promoted at pool entry) so they don't count
        // against the grab budget. Dead, duplicate, and mismatch DO count —
        // they each cost a grab + health check.
        if (options.backupProcessingLimit > 0) {
          const attempted = activePool.filter(cs =>
            cs.poolIndex !== primaryPoolIndex
            && !libraryResolvedUrls.has(cs.candidate.nzbUrl)
          ).length;
          if (attempted >= options.backupProcessingLimit) return null;
        }
      }
      while (nextCandidateIdx < allCandidates.length) {
        const c = allCandidates[nextCandidateIdx];
        nextCandidateIdx++;
        if (isDeadNzbByUrl(c.nzbUrl)) continue;
        const cs = addToPool(c, nextCandidateIdx - 1);
        deferred.lastVettedUrl = c.nzbUrl;
        if (hitUrls.has(c.nzbUrl)) {
          promoteLibraryCandidate(cs);
        } else {
          startGrab(cs);
        }
        return cs;
      }
      return null;
    };

    const selectNext = (): CandidateState | null => {
      // Speed mode only for primary selection — after primary, always use priority order
      if (options.preferenceMode === 'speed' && !primaryResolved) {
        const healthy = activePool.find(cs => cs.healthStatus === 'healthy' && cs.nzbdavStatus === 'idle');
        if (healthy) return healthy;
        return activePool.find(cs => cs.grabStatus === 'done' && cs.healthStatus !== 'dead' && cs.healthStatus !== 'error' && cs.nzbdavStatus === 'idle') ?? null;
      }
      // Priority: iterate in order — if a higher-priority candidate is still grabbing/checking, wait
      for (const cs of activePool) {
        if (cs.nzbdavStatus !== 'idle') continue;
        if (cs.healthStatus === 'dead' || cs.healthStatus === 'error') continue;
        if (cs.grabStatus === 'grabbing') return null;
        // After primary: wait for health check so containerType is available for matching
        if (primaryResolved && cs.healthStatus !== 'healthy') return null;
        if (cs.grabStatus === 'done') return cs;
      }
      return null;
    };

    for (const cs of activePool) { if (cs.nzbdavStatus === 'idle') startGrab(cs); }

    // ── Event loop (continues after primary for backup pre-caching) ──
    let activeNzbdavCs: CandidateState | null = null;
    let nzbdavPromise: Promise<StreamData | null> | null = null;
    const skipContainerMatching = !hasProviders;

    while (!controller.signal.aborted) {
      // Backup limit checks
      if (primaryResolved) {
        if (options.desiredBackups === 0 && !backupLimitReached) {
          backupLimitReached = true;
          console.log(`${tag} 📦 No replacement grabs (desiredBackups=0) — draining; free library hits still captured`);
        } else if (options.desiredBackups > 0 && backupCount >= options.desiredBackups && !backupLimitReached) {
          backupLimitReached = true;
          console.log(`${tag} 📦 Desired backups reached (${backupCount}/${options.desiredBackups}) — draining pool`);
        }
        if (options.backupProcessingLimit > 0 && !backupLimitReached) {
          const attempted = activePool.filter(cs =>
            cs.poolIndex !== primaryPoolIndex
            && !libraryResolvedUrls.has(cs.candidate.nzbUrl)
          ).length;
          if (attempted >= options.backupProcessingLimit) {
            backupLimitReached = true;
            console.log(`${tag} 📦 Backup processing limit reached (${attempted}/${options.backupProcessingLimit}) — draining pool`);
          }
        }
      }

      const pending: Promise<unknown>[] = [];
      for (const cs of activePool) {
        if (cs.grabPromise && cs.grabStatus === 'grabbing') pending.push(cs.grabPromise);
        if (cs.healthPromise && cs.healthStatus === 'checking') pending.push(cs.healthPromise);
      }
      if (nzbdavPromise) pending.push(nzbdavPromise);
      if (pending.length === 0 && !selectNext()) break;

      if (pending.length > 0) await Promise.race(pending);
      if (controller.signal.aborted) break;

      // Process grab completions → start health checks
      for (const cs of activePool) {
        if (cs.grabStatus === 'done' && cs.healthStatus === 'pending') startHealthCheck(cs);
        if (cs.grabStatus === 'failed' && cs.healthStatus === 'pending') {
          cs.healthStatus = 'dead';
          cs.grabFailed = true;
          console.log(`${tag} ❌ Grab failed for #${cs.poolIndex + 1} ${cs.candidate.title}`);
          pullReplacement();
        }
      }

      // Process health check completions — cancel active nzbdav job if its candidate is dead, pull replacements for idle dead candidates
      for (const cs of activePool) {
        if (cs.healthStatus !== 'dead' && cs.healthStatus !== 'error') continue;
        if (cs === activeNzbdavCs && cs.nzbdavStatus === 'submitted') {
          console.log(`${tag} 🗑️ Health check failed for active nzbdav candidate #${cs.poolIndex + 1} — cancelling job`);
          cs.cancelled = true;
          if (cs.nzoId) cancelJob(cs.nzoId, nzbdavConfig, 'health check failed').catch(() => {});
          nzbdavPromise?.catch(() => {});
          activeNzbdavCs = null;
          nzbdavPromise = null;
          pullReplacement();
        } else if (cs.nzbdavStatus === 'idle' && !cs.replaced) {
          cs.replaced = true;
          pullReplacement();
        }
      }

      // Check nzbdav completion — primary vs backup
      if (activeNzbdavCs?.nzbdavStatus === 'completed' && resolvedStreamData) {
        if (!primaryResolved) {
          // ── Primary resolution ──
          primaryResolved = true;
          primaryPoolIndex = activeNzbdavCs.poolIndex;
          requiredContainerType = path.extname(resolvedStreamData.videoPath).slice(1).toUpperCase();
          resolvedVideoPaths.add(resolvedStreamData.videoPath);
          videoPathOwner.set(resolvedStreamData.videoPath, activeNzbdavCs.poolIndex);
          resolvedTitles.add(activeNzbdavCs.candidate.title);
          activeNzbdavCs.videoSize = resolvedStreamData.videoSize;
          const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
          console.log(`${tag} ✅ Resolved in ${elapsed}s — ${activeNzbdavCs.candidate.title} [${activeNzbdavCs.candidate.indexerName}]`);
          sessionResolve(resolvedStreamData);
          if (requiredContainerType) {
            console.log(`${tag} 📦 Container locked: ${requiredContainerType} (from primary #${activeNzbdavCs.poolIndex + 1}, videoPath: ${resolvedStreamData.videoPath})`);
          } else {
            console.log(`${tag} 📦 Primary videoPath has no file extension (${resolvedStreamData.videoPath}) — submitting all healthy backups without container filtering`);
          }
          if (skipContainerMatching) {
            console.log(`${tag} 📦 No NNTP providers configured — skipping container matching, submitting all healthy backups`);
          }
        } else {
          // ── Backup completion ──
          const videoPath = resolvedStreamData.videoPath;
          const resolvedExt = path.extname(videoPath).slice(1).toUpperCase();
          if (resolvedVideoPaths.has(videoPath)) {
            duplicateCount++;
            activeNzbdavCs.duplicate = true;
            activeNzbdavCs.duplicateOf = videoPathOwner.get(videoPath);
            console.log(`${tag}   📦 #${activeNzbdavCs.poolIndex + 1} Skipping (duplicate videoPath: ${videoPath}) — ${activeNzbdavCs.candidate.title.substring(0, 60)} [${activeNzbdavCs.candidate.indexerName}]`);
          } else if (activeNzbdavCs.containerFallbackViaNzbdav && requiredContainerType && (!resolvedExt || resolvedExt !== requiredContainerType)) {
            // Fallback-resolved backup has wrong (or empty) container vs primary. Discard.
            activeNzbdavCs.nzbdavStatus = 'skipped';
            skippedMismatch++;
            console.log(`${tag}   📦 #${activeNzbdavCs.poolIndex + 1} Fallback container mismatch (${resolvedExt || 'no ext'} ≠ ${requiredContainerType}) — ${activeNzbdavCs.candidate.title.substring(0, 60)} [${activeNzbdavCs.candidate.indexerName}]`);
          } else {
            resolvedVideoPaths.add(videoPath);
            videoPathOwner.set(videoPath, activeNzbdavCs.poolIndex);
            resolvedTitles.add(activeNzbdavCs.candidate.title);
            deferred.backupUrls!.add(activeNzbdavCs.candidate.nzbUrl);
            deferred.backupStreams!.push({ nzbUrl: activeNzbdavCs.candidate.nzbUrl, videoPath, title: activeNzbdavCs.candidate.title, indexerName: activeNzbdavCs.candidate.indexerName });
            backupCount++;
            if (!activeNzbdavCs.containerType) activeNzbdavCs.containerType = resolvedExt || undefined;
            activeNzbdavCs.videoSize = resolvedStreamData.videoSize;
            const via = activeNzbdavCs.containerFallbackViaNzbdav ? 'via fallback, ' : '';
            const ct = activeNzbdavCs.containerType || 'unknown';
            console.log(`${tag}   📦 #${activeNzbdavCs.poolIndex + 1} Backup submitted (${via}${ct}, videoPath: ${videoPath}) — ${activeNzbdavCs.candidate.title.substring(0, 60)} [${activeNzbdavCs.candidate.indexerName}]`);
          }
        }
        pullReplacement();
        activeNzbdavCs = null;
        nzbdavPromise = null;
        resolvedStreamData = null;
      }
      if (activeNzbdavCs?.nzbdavStatus === 'failed') {
        if (primaryResolved) {
          failedBackupCount++;
          console.log(`${tag}   📦 #${activeNzbdavCs.poolIndex + 1} Backup failed — ${activeNzbdavCs.candidate.title.substring(0, 60)} [${activeNzbdavCs.candidate.indexerName}]`);
        } else {
          console.log(`${tag} ❌ nzbdav failed for #${activeNzbdavCs.poolIndex + 1} ${activeNzbdavCs.candidate.title}`);
        }
        activeNzbdavCs.healthStatus = 'dead';
        pullReplacement();
        activeNzbdavCs = null;
        nzbdavPromise = null;
      }

      // Submit to nzbdav if no active job
      if (!activeNzbdavCs || activeNzbdavCs.nzbdavStatus !== 'submitted') {
        const next = selectNext();
        if (next) {
          // Skip cross-indexer duplicates (same release title already resolved)
          if (primaryResolved && resolvedTitles.has(next.candidate.title)) {
            next.nzbdavStatus = 'skipped';
            next.duplicate = true;
            duplicateCount++;
            console.log(`${tag}   📦 #${next.poolIndex + 1} Skipping (duplicate title) — ${next.candidate.title.substring(0, 60)} [${next.candidate.indexerName}]`);
            pullReplacement();
            continue;
          }

          // Container match gate (only for backups after primary)
          if (primaryResolved && !skipContainerMatching && requiredContainerType) {
            evaluatedAfterPrimary++;
            if (!next.containerType) {
              // Archive inspection couldn't determine the container. Health check
              // already grabbed the segments — fall through to nzbdav and derive
              // the container from the extracted videoPath post-resolve.
              next.containerFallbackViaNzbdav = true;
              console.log(`${tag}   📦 #${next.poolIndex + 1} Container fallback via nzbdav — ${next.candidate.title.substring(0, 60)} [${next.candidate.indexerName}]`);
            } else if (next.containerType !== requiredContainerType) {
              next.nzbdavStatus = 'skipped';
              skippedMismatch++;
              console.log(`${tag}   📦 #${next.poolIndex + 1} Skipping (${next.containerType} ≠ ${requiredContainerType}) — ${next.candidate.title.substring(0, 60)} [${next.candidate.indexerName}]`);
              pullReplacement();
              continue;
            } else {
              console.log(`${tag}   📦 #${next.poolIndex + 1} Backup match (${next.containerType}) — ${next.candidate.title.substring(0, 60)} [${next.candidate.indexerName}]`);
            }
          }
          console.log(`${tag} 🚀 Submitting #${next.poolIndex + 1} ${next.candidate.title} [${next.candidate.indexerName}] to nzbdav`);
          activeNzbdavCs = next;
          nzbdavPromise = startNzbdav(next).then(data => { resolvedStreamData = data; return data; });
        }
      }

      // Check if all candidates are exhausted
      const allProcessed = activePool.every(cs =>
        cs.healthStatus === 'dead' || cs.healthStatus === 'error' ||
        cs.nzbdavStatus === 'failed' || cs.nzbdavStatus === 'completed' || cs.nzbdavStatus === 'skipped'
      );
      if (allProcessed && nextCandidateIdx >= allCandidates.length) {
        if (!primaryResolved) {
          console.log(`${tag} ❌ Exhausted all ${allCandidates.length} candidates`);
        } else if (options.desiredBackups > 0) {
          const pipelineBackups = backupCount - libraryBackupCount;
          if (pipelineBackups < options.desiredBackups) {
            console.log(`${tag} 📦 Exhausted all candidates — ${pipelineBackups}/${options.desiredBackups} backups found`);
          } else {
            console.log(`${tag} 📦 Desired backups reached (${pipelineBackups}/${options.desiredBackups}) — stopping`);
          }
        }
        break;
      }
    }

    // ── Post-drain library sweep ─────────────────────────────────
    // Library hits cost no NNTP grabs, so always sweep when primary resolved —
    // free backups are honored even when desiredBackups=0. The cap moves
    // inside the loop so it only fires when desiredBackups > 0.
    if (primaryResolved) {
      for (const hit of hits) {
        if (options.desiredBackups > 0 && backupCount >= options.desiredBackups) break;
        if (libraryResolvedUrls.has(hit.candidate.nzbUrl)) continue;
        if (hit.index === primaryPoolIndex) continue;
        if (resolvedVideoPaths.has(hit.data.videoPath)) continue;
        const hitExt = path.extname(hit.data.videoPath).slice(1).toUpperCase();
        if (requiredContainerType && hitExt && hitExt !== requiredContainerType) continue;
        resolvedVideoPaths.add(hit.data.videoPath);
        videoPathOwner.set(hit.data.videoPath, hit.index);
        libraryResolvedUrls.add(hit.candidate.nzbUrl);
        resolvedTitles.add(hit.candidate.title);
        deferred.backupUrls!.add(hit.candidate.nzbUrl);
        deferred.backupStreams!.push({ nzbUrl: hit.candidate.nzbUrl, videoPath: hit.data.videoPath, title: hit.candidate.title, indexerName: hit.candidate.indexerName });
        deferred.lastVettedUrl = hit.candidate.nzbUrl;
        const cacheKey = getCacheKey(hit.candidate.nzbUrl, hit.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        setReadyCacheEntry(cacheKey, hit.data, hit.candidate.indexerName);
        backupCount++;
        libraryBackupCount++;
        console.log(`${tag}   📦 #${hit.index + 1} Backup ready (library post-drain, ${hitExt || 'unknown'}, videoPath: ${hit.data.videoPath}) — ${hit.candidate.title.substring(0, 60)} [${hit.candidate.indexerName}]`);
      }
    }

    // ── Summary ──────────────────────────────────────────────────
    const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    if (!primaryResolved) {
      console.log(`${tag} Pipeline ended without resolution (${totalElapsed}s)`);
      sessionReject(new Error('All candidates exhausted'));
    }
    const healthy = activePool.filter(cs => cs.healthStatus === 'healthy').length;
    const dead = activePool.filter(cs => cs.healthStatus === 'dead' || cs.healthStatus === 'error').length;
    const skipped = activePool.filter(cs => cs.nzbdavStatus === 'skipped').length;
    const divider = '┄'.repeat(120);
    const settingsLine = [
      `pool: ${options.candidateCount}`,
      `mode: ${options.preferenceMode}`,
      `desiredBackups: ${options.desiredBackups === 0 ? 'Off' : options.desiredBackups}`,
      `backupProcessingLimit: ${options.backupProcessingLimit === 0 ? 'all' : options.backupProcessingLimit}`,
      `sampleCount: ${options.sampleCount}`,
      `archiveInspection: ${options.archiveInspection ? 'on' : 'off'}`,
    ].join(' · ');
    console.log(`${tag} ${divider}`);
    console.log(`${tag}   ${activePool.length} checked · ${healthy} healthy · ${dead} dead · ${skipped} skipped · ${totalElapsed}s`);
    console.log(`${tag}   ⚙️  ${settingsLine}`);
    console.log(`${tag} ${divider}`);

    // Render candidates with the primary pinned on top, then remaining rows
    // in priority (poolIndex) order — matches the fallback chain below the
    // active stream.
    type SummaryRow = { poolIndex: number; isPrimary: boolean; line: string };
    const rows: SummaryRow[] = [];

    if (primaryResolved && primaryPoolIndex >= 0) {
      const primaryCs = activePool.find(cs => cs.poolIndex === primaryPoolIndex);
      if (primaryCs) {
        const primarySize = primaryCs.videoSize ? ` · ${formatBytes(primaryCs.videoSize)}` : '';
        rows.push({
          poolIndex: primaryPoolIndex,
          isPrimary: true,
          line: `${tag}   👑 #${primaryPoolIndex + 1} [${requiredContainerType || '?'}${primarySize}] ${primaryCs.candidate.title.substring(0, 60)} [${primaryCs.candidate.indexerName}] → primary${primaryFromLibrary ? ' (library)' : ''}`,
        });
      }
    }

    // Active-pool entries render first (richer status/icon). Track what's rendered
    // so library hits covering the same poolIndex aren't printed twice.
    const poolIndicesRendered = new Set<number>(rows.map(r => r.poolIndex));
    for (const cs of activePool) {
      if (cs.poolIndex === primaryPoolIndex) continue;
      if (cs.healthStatus === 'pending' && cs.nzbdavStatus === 'idle') continue;
      const isLibraryBackup = cs.nzbdavStatus === 'skipped' && libraryResolvedUrls.has(cs.candidate.nzbUrl);
      const icon = isLibraryBackup ? '📚' : cs.duplicate ? '🔁' : cs.nzbdavStatus === 'completed' ? '✅' : cs.nzbdavStatus === 'skipped' ? '⏭️' : cs.healthStatus === 'healthy' ? '💚' : cs.healthStatus === 'dead' ? '❌' : '⏳';
      const dupRef = cs.duplicate ? (cs.duplicateOf !== undefined ? ` (#${cs.duplicateOf + 1})` : '') : '';
      const sizeStr = cs.videoSize ? ` · ${formatBytes(cs.videoSize)}` : '';
      const ct = cs.containerType ? `[${cs.containerType}${sizeStr}] ` : '';
      const status = isLibraryBackup ? 'backup (library)' : cs.duplicate ? `duplicate${dupRef}` : cs.nzbdavStatus === 'completed' ? 'backup' : cs.nzbdavStatus === 'skipped' ? `skipped (${cs.containerType || 'unknown'})` : cs.nzbdavStatus === 'submitted' ? 'cancelled' : cs.grabFailed ? 'grab-failed' : cs.healthStatus === 'dead' ? 'dead' : 'standby';
      rows.push({
        poolIndex: cs.poolIndex,
        isPrimary: false,
        line: `${tag}   ${icon} #${cs.poolIndex + 1} ${ct}${cs.candidate.title.substring(0, 60)} [${cs.candidate.indexerName}] → ${status}`,
      });
      poolIndicesRendered.add(cs.poolIndex);
    }

    // Out-of-pool library hits promoted post-drain (after event loop budget exhausted)
    for (const hit of hits) {
      if (hit.index === primaryPoolIndex) continue;
      if (poolIndicesRendered.has(hit.index)) continue;
      if (!libraryResolvedUrls.has(hit.candidate.nzbUrl)) continue;
      const ext = path.extname(hit.data.videoPath).slice(1).toUpperCase();
      const hitSize = hit.data.videoSize ? ` · ${formatBytes(hit.data.videoSize)}` : '';
      rows.push({
        poolIndex: hit.index,
        isPrimary: false,
        line: `${tag}   📚 #${hit.index + 1} [${ext || '?'}${hitSize}] ${hit.candidate.title.substring(0, 60)} [${hit.candidate.indexerName}] → backup (library post-drain)`,
      });
    }

    rows.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.poolIndex - b.poolIndex;
    });
    for (const r of rows) console.log(r.line);

    // Backup summary (only if primary resolved)
    if (primaryResolved) {
      const pipelineBackups = backupCount - libraryBackupCount;
      const sourceBreakdown = libraryBackupCount > 0 && pipelineBackups > 0
        ? ` (${pipelineBackups} pipeline + ${libraryBackupCount} library)`
        : libraryBackupCount > 0 ? ' (library)' : '';
      console.log(`${tag} ${divider}`);
      console.log(`${tag}   📦 Backups: ${backupCount}${options.desiredBackups > 0 ? `/${options.desiredBackups}` : ''}${sourceBreakdown} · ${evaluatedAfterPrimary} evaluated · ${skippedMismatch} mismatch · ${skippedUnknown} unknown · ${duplicateCount} duplicate · ${failedBackupCount} failed`);
      console.log(`${tag} ${divider}`);
    }

    // Write dead candidates to the dead NZB DB so the fallback loop skips them.
    // Skip candidates whose nzbdav step already wrote a specific failure entry via setDeadNzbEntry
    // (preserves granular errors for selective clears like clearMultiEpisodeDeadEntries /
    // clearTimeoutDeadEntries). Also skip grab-failed candidates — grab failures are transient
    // indexer/network/VPN issues, not NZB-liveness signals, and should never be persisted.
    let deadWrites = 0;
    for (const cs of activePool) {
      if (cs.healthStatus === 'dead' && !cs.nzbdavDeadWritten && !cs.grabFailed) {
        addDeadNzbByUrl(cs.candidate.nzbUrl, cs.candidate.title);
        deadWrites++;
      }
    }
    if (deadWrites > 0) saveCacheToDisk();

  } catch (err) {
    if (!controller.signal.aborted) console.error(`${tag} Error:`, err);
    sessionReject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    pool?.destroyAll();
    activeSessions.delete(sessionKey);
    // Keep session promise available for 2h30s so auto-play / binge watching can find it after episodes finish
    const timer = setTimeout(() => {
      sessionPromises.delete(sessionKey);
      cleanupTimers.delete(sessionKey);
    }, 2 * 60 * 60 * 1000 + 30_000);
    cleanupTimers.set(sessionKey, timer);
  }
}

/**
 * NZBDav API Functions
 * Handles NZB submission to NZBDav, job status polling, and category resolution.
 */

import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { proxyFetch, verifyProxyCircuit } from '../proxy.js';
import { getCachedNzbContent, cacheNzbContent } from '../health/nzbContentCache.js';
import { trackGrab } from '../statsTracker.js';
import type { NZBDavConfig, HistorySlot } from './types.js';
import { nzbdavError } from './utils.js';

/**
 * Resolve the category folder based on content type
 */
export function resolveCategory(config: NZBDavConfig, contentType?: string): string {
  if (contentType === 'movie') {
    return config.moviesCategory || 'Usenet-Ultimate-Movies';
  }
  if (contentType === 'series') {
    return config.tvCategory || 'Usenet-Ultimate-TV';
  }
  return config.moviesCategory || 'Usenet-Ultimate-Movies';
}

/**
 * Submit NZB to NZBDav and return the nzo_id.
 * `searchExitIp` carries the proxy exit IP that was live when this candidate's
 * search ran. verifyProxyCircuit compares against it so a rotation+new-search
 * between the original search and this grab cannot silently pass verification.
 */
export async function submitNzb(
  nzbUrl: string,
  title: string,
  config: NZBDavConfig,
  contentType?: string,
  budgetMs?: number,
  logPrefix = '',
  indexerName?: string,
  searchExitIp?: string,
): Promise<string> {
  const budgetStart = Date.now();
  const remainingBudget = () => budgetMs ? Math.max(1000, budgetMs - (Date.now() - budgetStart)) : 30000;
  const indexerForLog = indexerName?.trim() || '(unknown)';
  // Check if NZB was already downloaded during health checks
  let nzbContent = getCachedNzbContent(nzbUrl);
  let freshlyDownloaded = false;
  if (nzbContent) {
    console.log(`${logPrefix}  \u{1F4BE} Using cached NZB from health check (${nzbContent.length} bytes)`);
  } else {
    // Download NZB from indexer with timeout
    const downloadUserAgent = globalConfig.userAgents?.nzbDownload || getLatestVersions().chrome;
    console.log(`${logPrefix}  \u{1F4E5} Downloading NZB from indexer: ${nzbUrl.substring(0, 80)}...`);
    await verifyProxyCircuit(nzbUrl, 'nzb-grab', indexerName, searchExitIp);

    const controller = new AbortController();
    const downloadTimeoutMs = remainingBudget();
    const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);

    let nzbResponse: { ok: boolean; status: number; statusText: string; text: () => Promise<string> };
    try {
      nzbResponse = await proxyFetch(nzbUrl, {
        headers: { 'User-Agent': downloadUserAgent },
        signal: controller.signal,
      }, indexerName);
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === 'AbortError') {
        throw nzbdavError(`NZB download timed out after ${Math.round(downloadTimeoutMs / 1000)}s for ${indexerForLog}`, true);
      }
      throw nzbdavError(`NZB download failed for ${indexerForLog}: ${(err as Error).message}`);
    }
    clearTimeout(timeout);

    if (!nzbResponse.ok) {
      throw nzbdavError(`Failed to download NZB from ${indexerForLog}: ${nzbResponse.status} ${nzbResponse.statusText}`);
    }

    nzbContent = await nzbResponse.text();
    console.log(`${logPrefix}  \u2705 NZB downloaded (${nzbContent.length} bytes)`);
    freshlyDownloaded = true;
  }

  // Validate NZB content - must contain <nzb element
  if (!nzbContent.includes('<nzb') || !nzbContent.includes('</nzb>')) {
    // Check if it's an error response from the indexer
    if (nzbContent.includes('<error')) {
      const errorMatch = nzbContent.match(/description="([^"]+)"/);
      const errorMsg = errorMatch ? errorMatch[1] : 'Unknown indexer error';
      throw nzbdavError(`Indexer returned error: ${errorMsg}`);
    }
    throw nzbdavError(`Invalid NZB content received (${nzbContent.length} bytes)`);
  }

  // Single grab-tracking chokepoint. Cache hits skip this; invalid NZBs throw above.
  // EasyNews is tracked one layer up in the /nzb route, because its real indexer
  // fetch happens inside that route's POST to easynews.com, not in submitNzb's
  // proxyFetch (which just loops back to the local handler).
  if (freshlyDownloaded && indexerForLog.toLowerCase() !== 'easynews') {
    trackGrab(indexerForLog, title);
  }

  // Submit to NZBDav
  const category = resolveCategory(config, contentType);
  const baseUrl = config.url.replace(/\/$/, '');
  const apiUrl = `${baseUrl}/api?mode=addfile&cat=${encodeURIComponent(category)}&nzbname=${encodeURIComponent(title)}&apikey=${config.apiKey}`;

  // Use native FormData and Blob (like server.ts test endpoint)
  const formData = new FormData();
  formData.append('nzbFile', new Blob([nzbContent], { type: 'application/x-nzb' }), `${title}.nzb`);

  const nzbdavUserAgent = globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome;
  console.log(`${logPrefix}  \u{1F4E4} Submitting NZB to NZBDav...`);
  console.log(`${logPrefix}  \u{1F4E4} API URL: ${apiUrl.replace(config.apiKey, '***')}`);

  const submitController = new AbortController();
  const submitTimeoutMs = remainingBudget();
  const submitTimeout = setTimeout(() => submitController.abort(), submitTimeoutMs);

  let nzbdavResponse: Response;
  try {
    nzbdavResponse = await fetch(apiUrl, {
      method: 'POST',
      body: formData,
      headers: { 'User-Agent': nzbdavUserAgent },
      signal: submitController.signal,
    });
  } catch (err) {
    clearTimeout(submitTimeout);
    if ((err as Error).name === 'AbortError') {
      throw nzbdavError(`NZBDav submission timed out after ${Math.round(submitTimeoutMs / 1000)}s`, true);
    }
    throw nzbdavError(`NZBDav submission failed: ${(err as Error).message}`);
  }
  clearTimeout(submitTimeout);

  console.log(`${logPrefix}  \u{1F4E4} NZBDav response status: ${nzbdavResponse.status}`);

  const responseText = await nzbdavResponse.text();
  if (!nzbdavResponse.ok) console.log(`${logPrefix}  \u{1F4E4} NZBDav response body: ${responseText.substring(0, 500)}`);

  if (!nzbdavResponse.ok) {
    throw nzbdavError(`NZBDav rejected NZB: ${nzbdavResponse.status} - ${responseText}`);
  }

  let result: { nzo_ids?: string[]; status?: boolean; error?: string };
  try {
    result = JSON.parse(responseText);
  } catch {
    throw nzbdavError(`NZBDav returned invalid JSON: ${responseText}`);
  }

  console.log(`${logPrefix}  \u{1F4E4} Parsed response:`, JSON.stringify(result));

  const nzoId = result.nzo_ids?.[0];

  if (!nzoId) {
    throw nzbdavError(`No NZO ID returned from NZBDav. Response: ${JSON.stringify(result)}`);
  }

  console.log(`${logPrefix}  \u2705 NZB submitted, nzo_id: ${nzoId}`);
  return nzoId;
}

/**
 * Pre-fetch an NZB from the indexer and cache it for later submission.
 * Best-effort, never throws. Returns true if the NZB is cached and ready.
 * `searchExitIp` carries the proxy exit IP that was live when this candidate's
 * search ran, used to gate the prefetch against an intervening IP rotation.
 */
export async function prefetchNzb(nzbUrl: string, logPrefix = '', quiet = false, title?: string, indexerName?: string, searchExitIp?: string): Promise<boolean> {
  // Already cached (from health check or earlier prefetch)
  if (getCachedNzbContent(nzbUrl)) return true;

  try {
    const downloadUserAgent = globalConfig.userAgents?.nzbDownload || getLatestVersions().chrome;
    if (!quiet) console.log(`${logPrefix}  📥 Prefetching NZB: ${nzbUrl.substring(0, 80)}...`);
    await verifyProxyCircuit(nzbUrl, 'nzb-prefetch', indexerName, searchExitIp);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let nzbResponse: { ok: boolean; status: number; statusText: string; text: () => Promise<string> };
    try {
      nzbResponse = await proxyFetch(nzbUrl, {
        headers: { 'User-Agent': downloadUserAgent },
        signal: controller.signal,
      }, indexerName);
    } catch (err) {
      clearTimeout(timeout);
      if (!quiet) console.warn(`${logPrefix}  ⚠️ Prefetch failed: ${(err as Error).message}`);
      return false;
    }
    clearTimeout(timeout);

    if (!nzbResponse.ok) {
      if (!quiet) console.warn(`${logPrefix}  ⚠️ Prefetch failed: ${nzbResponse.status} ${nzbResponse.statusText}`);
      return false;
    }

    const nzbContent = await nzbResponse.text();

    // Validate NZB XML
    if (!nzbContent.includes('<nzb') || !nzbContent.includes('</nzb>')) {
      if (nzbContent.includes('<error')) {
        const errorMatch = nzbContent.match(/description="([^"]+)"/);
        if (!quiet) console.warn(`${logPrefix}  ⚠️ Prefetch: indexer error — ${errorMatch ? errorMatch[1] : 'unknown'}`);
      } else {
        if (!quiet) console.warn(`${logPrefix}  ⚠️ Prefetch: invalid NZB content (${nzbContent.length} bytes)`);
      }
      return false;
    }

    cacheNzbContent(nzbUrl, nzbContent);
    if (!quiet) console.log(`${logPrefix}  ✅ Prefetched NZB (${nzbContent.length} bytes)`);

    // The indexer fetch just succeeded. Track here so UF-driven prefetches count
    // even when the subsequent submitNzb call hits cache. EasyNews skips for
    // the same reason as submitNzb: its real fetch happens in the /nzb route.
    if (title) {
      const tracked = indexerName?.trim() || '(unknown)';
      if (tracked.toLowerCase() !== 'easynews') {
        trackGrab(tracked, title);
      }
    }

    return true;
  } catch (err) {
    if (!quiet) console.warn(`${logPrefix}  ⚠️ Prefetch error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Cancel a job on NZBDav (fire-and-forget)
 * Uses SABnzbd-compatible queue delete API
 */
export async function cancelJob(nzoId: string, config: NZBDavConfig, reason?: string): Promise<void> {
  const baseUrl = config.url.replace(/\/$/, '');
  const cancelUrl = `${baseUrl}/api?mode=queue&name=delete&value=${encodeURIComponent(nzoId)}&apikey=${config.apiKey}`;
  const reasonSuffix = reason ? ` (${reason})` : '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(cancelUrl, {
        headers: { 'User-Agent': globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        console.log(`  🗑️ Cancelled NZBDav job: ${nzoId}${reasonSuffix}`);
        return;
      }
      if (attempt === 2) {
        console.warn(`  ⚠️ Failed to cancel NZBDav job ${nzoId}${reasonSuffix}: ${response.status}`);
      }
    } catch (err) {
      if (attempt === 2) {
        console.warn(`  ⚠️ Error cancelling NZBDav job ${nzoId}${reasonSuffix}: ${(err as Error).message}`);
      }
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * Poll NZBDav queue + history APIs for job status.
 * Queue time (job waiting to start) does NOT count against the budget —
 * the budget only ticks while the job is actively processing.
 */
export async function waitForJobCompletion(
  nzoId: string,
  config: NZBDavConfig,
  timeoutMs = 120000,  // 2 minutes
  pollIntervalMs = 250,  // 250ms polling for fast job completion detection
  contentType?: string,
  logPrefix = '',
): Promise<'completed' | 'failed'> {
  const baseUrl = config.url.replace(/\/$/, '');
  const category = resolveCategory(config, contentType);
  const userAgent = globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome;

  const unlimitedBudget = timeoutMs === 0;
  // Tracks cumulative time the job has been actively processing (not queued).
  // Undefined = job hasn't started processing yet.
  let processingElapsedMs = 0;
  let lastProcessingTickTime: number | undefined;
  let lastStatusLogTime = 0; // throttle repeating status logs to 1s intervals

  const tickProcessing = () => {
    if (lastProcessingTickTime) {
      processingElapsedMs += Date.now() - lastProcessingTickTime;
    }
    lastProcessingTickTime = Date.now();
  };
  const pauseProcessing = () => { lastProcessingTickTime = undefined; };
  const budgetRemaining = () => unlimitedBudget ? Infinity : timeoutMs - processingElapsedMs;
  const shouldLog = () => {
    const now = Date.now();
    if (now - lastStatusLogTime < 1000) return false;
    lastStatusLogTime = now;
    return true;
  };

  console.log(`${logPrefix}  \u23F3 Waiting for job completion (${unlimitedBudget ? 'no limit' : `${Math.round(timeoutMs / 1000)}s budget`})...`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Accumulate processing time and check budget
    if (lastProcessingTickTime) tickProcessing();
    if (!unlimitedBudget && processingElapsedMs >= timeoutMs) break;

    const perPollTimeoutMs = !lastProcessingTickTime || unlimitedBudget
      ? 10_000
      : Math.min(10_000, Math.max(1000, budgetRemaining()));

    try {
      // Poll queue + history in parallel
      const queueUrl = `${baseUrl}/api?mode=queue&apikey=${config.apiKey}&output=json`;
      const historyUrl = `${baseUrl}/api?mode=history&apikey=${config.apiKey}&start=0&limit=50&category=${encodeURIComponent(category)}&output=json`;

      const [queueRes, historyRes] = await Promise.all([
        fetch(queueUrl, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(perPollTimeoutMs) }).catch(() => null),
        fetch(historyUrl, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(perPollTimeoutMs) }),
      ]);

      // Check history first — job moves here when completed/failed
      if (historyRes.ok) {
        const data = await historyRes.json() as { history?: { slots?: HistorySlot[] } };
        const job = (data.history?.slots || []).find(slot => (slot.nzo_id || slot.nzoId) === nzoId);

        if (job) {
          const status = (job.status || job.Status || '').toString().toLowerCase();

          if (status === 'completed') {
            console.log(`${logPrefix}  \u2705 Job completed successfully`);
            return 'completed';
          }

          if (status === 'failed') {
            const failMessage = job.fail_message || job.failMessage || 'Unknown error';
            console.log(`${logPrefix}  \u274C Job failed: ${failMessage}`);
            throw nzbdavError(`NZBDav download failed: ${failMessage}`);
          }
        }
      } else {
        if (shouldLog()) console.warn(`${logPrefix}  \u26A0\uFE0F History API returned ${historyRes.status}, retrying...`);
      }

      // Check queue — detect queued vs actively processing
      if (queueRes?.ok) {
        const qData = await queueRes.json() as { queue?: { slots?: Array<{ nzo_id?: string; nzoId?: string; status?: string; Status?: string }> } };
        const qJob = (qData.queue?.slots || []).find(slot => (slot.nzo_id || slot.nzoId) === nzoId);

        if (qJob) {
          const qStatus = (qJob.status || qJob.Status || '').toString().toLowerCase();
          const isQueued = qStatus === 'queued' || qStatus === 'paused';

          if (isQueued) {
            pauseProcessing();
            if (shouldLog()) console.log(`${logPrefix}  \u23F3 Job queued — waiting for processing slot (budget paused)`);
          } else {
            if (!lastProcessingTickTime) {
              lastProcessingTickTime = Date.now();
              console.log(`${logPrefix}  \u23F3 Job processing — budget started (${unlimitedBudget ? 'no limit' : `${Math.round(timeoutMs / 1000)}s`})`);
            } else {
              if (shouldLog()) {
                const remaining = unlimitedBudget ? '∞' : Math.max(0, Math.round(budgetRemaining() / 1000));
                console.log(`${logPrefix}  \u23F3 Job status: ${qStatus} (${Math.round(processingElapsedMs / 1000)}s elapsed, ${remaining}s remaining)`);
              }
            }
          }
        } else if (!lastProcessingTickTime) {
          // Not in queue and not in history — likely transitioning, start budget as safety
          lastProcessingTickTime = Date.now();
        }
      } else if (!lastProcessingTickTime) {
        // Can't reach queue API — fall back to starting budget immediately
        lastProcessingTickTime = Date.now();
      }

    } catch (error) {
      if ((error as any).isNzbdavFailure) throw error;
      if (shouldLog()) console.warn(`${logPrefix}  \u26A0\uFE0F Error checking job status: ${(error as Error).message}`);
      if (!lastProcessingTickTime) lastProcessingTickTime = Date.now();
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw nzbdavError(`Timeout waiting for NZBDav job after ${timeoutMs / 1000}s`, true);
}

/**
 * NZBDav API Functions
 * Handles NZB submission to NZBDav, job status polling, and category resolution.
 */

import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { proxyFetch, logProxyExitIp, verifyProxyCircuit } from '../proxy.js';
import { getCachedNzbContent } from '../health/nzbContentCache.js';
import type { NZBDavConfig, HistorySlot } from './types.js';

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
 * Submit NZB to NZBDav and return the nzo_id
 */
export async function submitNzb(
  nzbUrl: string,
  title: string,
  config: NZBDavConfig,
  contentType?: string
): Promise<string> {
  // Check if NZB was already downloaded during health checks
  let nzbContent = getCachedNzbContent(nzbUrl);
  if (nzbContent) {
    console.log(`  \u{1F4BE} Using cached NZB from health check (${nzbContent.length} bytes)`);
  } else {
    // Download NZB from indexer with timeout
    const downloadUserAgent = globalConfig.userAgents?.nzbDownload || getLatestVersions().chrome;
    console.log(`  \u{1F4E5} Downloading NZB from indexer: ${nzbUrl.substring(0, 80)}...`);
    await verifyProxyCircuit(nzbUrl, 'nzb-grab');
    await logProxyExitIp(nzbUrl, 'nzb-grab');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    let nzbResponse: { ok: boolean; status: number; statusText: string; text: () => Promise<string> };
    try {
      nzbResponse = await proxyFetch(nzbUrl, {
        headers: { 'User-Agent': downloadUserAgent },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === 'AbortError') {
        throw new Error('NZB download timed out after 30s');
      }
      throw new Error(`NZB download failed: ${(err as Error).message}`);
    }
    clearTimeout(timeout);

    if (!nzbResponse.ok) {
      const error = new Error(`Failed to download NZB: ${nzbResponse.status} ${nzbResponse.statusText}`);
      throw error;
    }

    nzbContent = await nzbResponse.text();
    console.log(`  \u2705 NZB downloaded (${nzbContent.length} bytes)`);
  }

  // Validate NZB content - must contain <nzb element
  if (!nzbContent.includes('<nzb') || !nzbContent.includes('</nzb>')) {
    // Check if it's an error response from the indexer
    if (nzbContent.includes('<error')) {
      const errorMatch = nzbContent.match(/description="([^"]+)"/);
      const errorMsg = errorMatch ? errorMatch[1] : 'Unknown indexer error';
      throw new Error(`Indexer returned error: ${errorMsg}`);
    }
    throw new Error(`Invalid NZB content received (${nzbContent.length} bytes)`);
  }

  // Submit to NZBDav
  const category = resolveCategory(config, contentType);
  const baseUrl = config.url.replace(/\/$/, '');
  const apiUrl = `${baseUrl}/api?mode=addfile&cat=${encodeURIComponent(category)}&nzbname=${encodeURIComponent(title)}&apikey=${config.apiKey}`;

  // Use native FormData and Blob (like server.ts test endpoint)
  const formData = new FormData();
  formData.append('nzbFile', new Blob([nzbContent], { type: 'application/x-nzb' }), `${title}.nzb`);

  const nzbdavUserAgent = globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome;
  console.log(`  \u{1F4E4} Submitting NZB to NZBDav...`);
  console.log(`  \u{1F4E4} API URL: ${apiUrl.replace(config.apiKey, '***')}`);

  const nzbdavResponse = await fetch(apiUrl, {
    method: 'POST',
    body: formData,
    headers: { 'User-Agent': nzbdavUserAgent },
  });

  console.log(`  \u{1F4E4} NZBDav response status: ${nzbdavResponse.status}`);

  const responseText = await nzbdavResponse.text();
  console.log(`  \u{1F4E4} NZBDav response body: ${responseText.substring(0, 500)}`);

  if (!nzbdavResponse.ok) {
    const error = new Error(`NZBDav rejected NZB: ${nzbdavResponse.status} - ${responseText}`);
    throw error;
  }

  let result: { nzo_ids?: string[]; status?: boolean; error?: string };
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`NZBDav returned invalid JSON: ${responseText}`);
  }

  console.log(`  \u{1F4E4} Parsed response:`, JSON.stringify(result));

  const nzoId = result.nzo_ids?.[0];

  if (!nzoId) {
    throw new Error(`No NZO ID returned from NZBDav. Response: ${JSON.stringify(result)}`);
  }

  console.log(`  \u2705 NZB submitted, nzo_id: ${nzoId}`);
  return nzoId;
}

/**
 * Poll NZBDav history API for job status
 */
export async function waitForJobCompletion(
  nzoId: string,
  config: NZBDavConfig,
  timeoutMs = 120000,  // 2 minutes
  pollIntervalMs = 2000,  // 2 seconds
  contentType?: string
): Promise<'completed' | 'failed'> {
  const baseUrl = config.url.replace(/\/$/, '');
  const category = resolveCategory(config, contentType);
  const startTime = Date.now();

  console.log(`  \u23F3 Waiting for job completion (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Query history API
      const historyUrl = `${baseUrl}/api?mode=history&apikey=${config.apiKey}&start=0&limit=50&category=${encodeURIComponent(category)}&output=json`;

      const response = await fetch(historyUrl, {
        headers: { 'User-Agent': globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome },
      });

      if (!response.ok) {
        console.warn(`  \u26A0\uFE0F History API returned ${response.status}, retrying...`);
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      }

      const data = await response.json() as { history?: { slots?: HistorySlot[] } };
      const slots = data.history?.slots || [];

      // Find our job by nzo_id
      const job = slots.find(slot =>
        (slot.nzo_id || slot.nzoId) === nzoId
      );

      if (job) {
        const status = (job.status || job.Status || '').toString().toLowerCase();

        if (status === 'completed') {
          console.log(`  \u2705 Job completed successfully`);
          return 'completed';
        }

        if (status === 'failed') {
          const failMessage = job.fail_message || job.failMessage || 'Unknown error';
          console.log(`  \u274C Job failed: ${failMessage}`);

          const error = new Error(`NZBDav download failed: ${failMessage}`) as Error & { isNzbdavFailure: boolean };
          error.isNzbdavFailure = true;
          throw error;
        }

        // Job exists but still processing
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`  \u23F3 Job status: ${status} (${elapsed}s elapsed)`);
      }

    } catch (error) {
      if ((error as any).isNzbdavFailure) {
        throw error;
      }
      console.warn(`  \u26A0\uFE0F Error checking history: ${(error as Error).message}`);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  const error = new Error(`Timeout waiting for NZBDav job after ${timeoutMs / 1000}s`) as Error & { isNzbdavFailure: boolean };
  error.isNzbdavFailure = true;
  throw error;
}

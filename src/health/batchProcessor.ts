/**
 * Batch Processor
 *
 * Performs concurrent health checks on multiple NZBs with connection pooling.
 * Manages worker concurrency and shared NNTP connection pool lifecycle.
 */

import type { UsenetProvider } from '../types.js';
import type { HealthCheckResult, HealthCheckOptions } from './types.js';
import { NntpConnectionPool } from './nntpConnection.js';
import { performHealthCheck } from './healthCheckPipeline.js';

/**
 * Perform health checks on multiple NZBs concurrently.
 * `searchIpByUrl` maps each NZB URL to the proxy exit IP that was live when
 * its search ran. Threaded into performHealthCheck so circuit verification
 * compares against the original search's IP, not a later-overwritten baseline.
 *
 * Returns `{ results, circuitAborted }`. When `circuitAborted` is true, the
 * proxy circuit changed mid-batch and remaining NZBs in the queue were not
 * probed — the caller should stop scheduling further batches.
 */
export async function performBatchHealthChecks(
  nzbUrls: string[],
  providers: UsenetProvider[],
  userAgent: string,
  maxConcurrent: number = 3,
  options: HealthCheckOptions = { archiveInspection: true, sampleCount: 3 },
  indexerByUrl?: Map<string, string>,
  searchIpByUrl?: Map<string, string>
): Promise<{ results: Map<string, HealthCheckResult>; circuitAborted: boolean }> {
  const results = new Map<string, HealthCheckResult>();
  const queue = [...nzbUrls];
  const pool = new NntpConnectionPool();
  let circuitAborted = false;

  try {
    const processNext = async (): Promise<void> => {
      while (queue.length > 0 && !circuitAborted) {
        const nzbUrl = queue.shift()!;

        try {
          const result = await performHealthCheck(
            nzbUrl, providers, userAgent, options, pool,
            indexerByUrl?.get(nzbUrl), searchIpByUrl?.get(nzbUrl),
            () => { circuitAborted = true; }
          );
          results.set(nzbUrl, result);
        } catch (error) {
          results.set(nzbUrl, {
            status: 'error',
            message: `Error: ${(error as Error).message}`,
            playable: false
          });
        }
      }
    };

    // Start concurrent workers — use maxConcurrent but cap at actual NZB count
    const workers = Array(Math.min(maxConcurrent, nzbUrls.length))
      .fill(null)
      .map(() => processNext());

    await Promise.all(workers);
  } finally {
    pool.destroyAll();
  }

  return { results, circuitAborted };
}

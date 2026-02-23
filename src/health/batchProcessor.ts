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
 * Perform health checks on multiple NZBs concurrently
 */
export async function performBatchHealthChecks(
  nzbUrls: string[],
  providers: UsenetProvider[],
  userAgent: string,
  maxConcurrent: number = 3,
  options: HealthCheckOptions = { archiveInspection: true, sampleCount: 3 }
): Promise<Map<string, HealthCheckResult>> {
  const results = new Map<string, HealthCheckResult>();
  const queue = [...nzbUrls];
  const pool = new NntpConnectionPool();

  try {
    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const nzbUrl = queue.shift()!;

        try {
          const result = await performHealthCheck(nzbUrl, providers, userAgent, options, pool);
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

  return results;
}

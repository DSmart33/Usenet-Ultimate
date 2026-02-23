/**
 * Article Checker
 *
 * Verifies article existence on Usenet providers using NNTP STAT commands.
 * Supports pipelined checks, per-provider verification, and multi-provider
 * fallback (pool providers checked in parallel, then backup providers for missing).
 */

import * as net from 'net';
import * as tls from 'tls';
import type { UsenetProvider } from '../types.js';
import { connectToUsenet, NntpConnectionPool } from './nntpConnection.js';

/**
 * Check which articles exist on a Usenet connection
 * Returns lists of existing and missing message IDs
 */
export async function checkArticlesDetailed(
  socket: net.Socket | tls.TLSSocket,
  messageIds: string[],
  timeoutMs: number = 30000
): Promise<{ existing: string[]; missing: string[] }> {
  return new Promise((resolve, reject) => {
    if (messageIds.length === 0) {
      resolve({ existing: [], missing: [] });
      return;
    }

    const existing: string[] = [];
    const missing: string[] = [];
    let checked = 0;
    let buffer = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Article check timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('data', dataHandler);
      socket.removeListener('error', errorHandler);
      socket.removeListener('close', closeHandler);
      socket.removeListener('end', endHandler);
    };

    const dataHandler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        if (checked >= messageIds.length) break;
        const currentId = messageIds[checked];
        // Article exists (223)
        if (line.startsWith('223')) {
          existing.push(currentId);
          checked++;
        }
        // Article not found (430)
        else if (line.startsWith('430')) {
          missing.push(currentId);
          checked++;
        }
        // Handle any other NNTP response code as missing
        else if (/^\d{3}\s/.test(line)) {
          console.warn(`⚠️  Unexpected NNTP response during article check: ${line}`);
          missing.push(currentId);
          checked++;
        }

        // All pipelined responses received
        if (checked >= messageIds.length && !resolved) {
          resolved = true;
          cleanup();
          resolve({ existing, missing });
          return;
        }
      }
    };

    const errorHandler = (error: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(error);
      }
    };

    // Handle server-side disconnects — without these, a dropped connection
    // would hang until the 30s timeout fires (common when all articles are
    // missing and the server drops the client after repeated 430s)
    const closeHandler = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        // Treat unchecked articles as missing and resolve with what we have
        for (let i = checked; i < messageIds.length; i++) {
          missing.push(messageIds[i]);
        }
        resolve({ existing, missing });
      }
    };

    const endHandler = () => {
      // 'end' fires before 'close' — treat identically
      closeHandler();
    };

    socket.on('data', dataHandler);
    socket.on('error', errorHandler);
    socket.on('close', closeHandler);
    socket.on('end', endHandler);

    // Pipeline all STAT commands in a single write instead of one-at-a-time.
    // NNTP responses arrive in order, so we match them by index.
    const pipeline = messageIds.map(id => `STAT <${id}>`).join('\r\n') + '\r\n';
    socket.write(pipeline);
  });
}

/**
 * Check articles on a single provider
 * Uses pool if available, otherwise connects and disconnects
 */
export async function checkArticlesOnProvider(
  provider: UsenetProvider,
  messageIds: string[],
  pool?: NntpConnectionPool
): Promise<{ existing: string[]; missing: string[] }> {
  if (pool) {
    const socket = await pool.acquire(provider);
    try {
      const result = await checkArticlesDetailed(socket, messageIds);
      pool.release(provider, socket);
      return result;
    } catch (err) {
      try { socket.destroy(); } catch {}
      throw err;
    }
  }
  const socket = await connectToUsenet(provider);
  try {
    return await checkArticlesDetailed(socket, messageIds);
  } finally {
    socket.destroy();
  }
}

/**
 * Check articles across multiple providers with fallback
 * Pool providers are checked first, then backup providers for missing articles
 */
export async function checkArticlesMultiProvider(
  providers: UsenetProvider[],
  messageIds: string[],
  pool?: NntpConnectionPool
): Promise<{ totalExists: number; totalMissing: number; missingIds: string[]; providersUsed: Array<{ id: string; name: string; type: 'pool' | 'backup'; found: number; total: number }> }> {
  const poolProviders = providers.filter(p => p.enabled && p.type === 'pool');
  const backupProviders = providers.filter(p => p.enabled && p.type === 'backup');

  if (poolProviders.length === 0 && backupProviders.length === 0) {
    throw new Error('No enabled providers configured');
  }

  const foundIds = new Set<string>();
  const providersUsed: Array<{ id: string; name: string; type: 'pool' | 'backup'; found: number; total: number }> = [];
  let providersChecked = 0;

  // Check ALL pool providers in PARALLEL with the same full set of IDs
  if (poolProviders.length > 0) {
    const poolResults = await Promise.allSettled(
      poolProviders.map(async (provider) => {
        const result = await checkArticlesOnProvider(provider, messageIds, pool);
        return { provider, result };
      })
    );

    for (const outcome of poolResults) {
      if (outcome.status === 'fulfilled') {
        const { provider, result } = outcome.value;
        providersChecked++;
        if (result.existing.length > 0) {
          providersUsed.push({ id: provider.id, name: provider.name, type: provider.type, found: result.existing.length, total: messageIds.length });
        }
        for (const id of result.existing) {
          foundIds.add(id);
        }
      } else {
        console.warn(`  [provider] Pool check failed: ${outcome.reason}`);
      }
    }
  }

  // Compute remaining IDs not found by any pool provider
  let remainingIds = messageIds.filter(id => !foundIds.has(id));

  // If segments are still missing, check ALL backup providers in PARALLEL
  if (remainingIds.length > 0 && backupProviders.length > 0) {
    const backupResults = await Promise.allSettled(
      backupProviders.map(async (provider) => {
        const result = await checkArticlesOnProvider(provider, remainingIds, pool);
        return { provider, result };
      })
    );

    for (const outcome of backupResults) {
      if (outcome.status === 'fulfilled') {
        const { provider, result } = outcome.value;
        providersChecked++;
        if (result.existing.length > 0) {
          providersUsed.push({ id: provider.id, name: provider.name, type: provider.type, found: result.existing.length, total: remainingIds.length });
        }
        for (const id of result.existing) {
          foundIds.add(id);
        }
      } else {
        console.warn(`  [provider] Backup check failed: ${outcome.reason}`);
      }
    }

    remainingIds = messageIds.filter(id => !foundIds.has(id));
  }

  // If no providers were successfully checked, we can't determine availability
  if (providersChecked === 0) {
    throw new Error('All providers failed to connect');
  }

  return {
    totalExists: foundIds.size,
    totalMissing: remainingIds.length,
    missingIds: remainingIds,
    providersUsed
  };
}

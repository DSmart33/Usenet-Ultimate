/**
 * Indexer CRUD Operations
 *
 * Provides create, read, update, delete, and reorder operations
 * for both regular indexers and synced indexers.
 */

import type { UsenetIndexer, SyncedIndexer } from '../types.js';
import { configData, saveConfigFile } from './schema.js';

/**
 * Enforce Zyclops mutual exclusion for a single indexer:
 * force enabled + disable proxy and health checks.
 * Called from settingsUpdater on every save to guard against settings
 * changes that would re-enable proxy/health checks for Zyclops indexers.
 *
 * Does NOT create a preZyclopsState snapshot — that is handled by
 * updateIndexer when Zyclops is first enabled.
 */
export function enforceZyclopsEnabled(idx: UsenetIndexer, label?: string): void {
  if (!idx.zyclops?.enabled) return;
  console.log(`🤖 Zyclops mutual exclusion${label ? ` (${label})` : ''}: forcing enabled + disabling proxy/health checks for ${idx.name}`);
  idx.enabled = true;
  if (!configData.proxyIndexers) configData.proxyIndexers = {};
  configData.proxyIndexers[idx.name] = false;
  if (configData.healthChecks?.healthCheckIndexers) {
    configData.healthChecks.healthCheckIndexers[idx.name] = false;
  }
}

export function getIndexers(): UsenetIndexer[] {
  return [...configData.indexers];
}

export function getIndexer(name: string): UsenetIndexer | undefined {
  return configData.indexers.find(i => i.name === name);
}

export function addIndexer(indexer: Omit<UsenetIndexer, 'enabled'>): UsenetIndexer {
  const newIndexer: UsenetIndexer = {
    ...indexer,
    enabled: true,
  };

  // Check for duplicate names
  if (configData.indexers.some(i => i.name === newIndexer.name)) {
    throw new Error('Indexer with this name already exists');
  }

  configData.indexers.push(newIndexer);
  saveConfigFile(configData);
  return newIndexer;
}

export function updateIndexer(name: string, updates: Partial<UsenetIndexer>): UsenetIndexer {
  const index = configData.indexers.findIndex(i => i.name === name);

  if (index === -1) {
    throw new Error('Indexer not found');
  }

  // If renaming, check for duplicate and block if Zyclops is active
  if (updates.name && updates.name !== name) {
    if (configData.indexers[index].zyclops?.enabled) {
      throw new Error('Cannot rename an indexer while Zyclops is enabled — disable Zyclops first');
    }
    if (configData.indexers.some(i => i.name === updates.name)) {
      throw new Error('Indexer with this name already exists');
    }
  }

  const previous = configData.indexers[index];
  const wasZyclops = previous.zyclops?.enabled;

  configData.indexers[index] = {
    ...previous,
    ...updates,
  };

  const updated = configData.indexers[index];

  if (updated.zyclops?.enabled) {
    enforceZyclopsEnabled(updated);
  } else if (wasZyclops && !updated.zyclops?.enabled) {
    // Zyclops just turned off: restore pre-Zyclops state (or safe defaults if no snapshot)
    const snapshot = updated.zyclops?.preZyclopsState;
    const restoredEnabled = snapshot?.enabled ?? false;
    const restoredProxy = snapshot?.proxy ?? false;
    const restoredHealthCheck = snapshot?.healthCheck ?? false;
    const logFn = snapshot ? console.log : console.warn;
    logFn(`🤖 Zyclops disabled for ${updated.name}: restoring state (enabled=${restoredEnabled}, proxy=${restoredProxy}, healthCheck=${restoredHealthCheck}${snapshot ? '' : ' [defaults — no snapshot]'})`);
    updated.enabled = restoredEnabled;
    if (!configData.proxyIndexers) configData.proxyIndexers = {};
    configData.proxyIndexers[updated.name] = restoredProxy;
    if (configData.healthChecks?.healthCheckIndexers) {
      configData.healthChecks.healthCheckIndexers[updated.name] = restoredHealthCheck;
    }
    // Clear consumed snapshot so stale values can't be reused on a future disable
    if (updated.zyclops) delete updated.zyclops.preZyclopsState;
  }

  saveConfigFile(configData);
  return configData.indexers[index];
}

export function deleteIndexer(name: string): void {
  const index = configData.indexers.findIndex(i => i.name === name);

  if (index === -1) {
    throw new Error('Indexer not found');
  }

  configData.indexers.splice(index, 1);

  // Clean up orphaned proxy/healthCheck entries for the deleted indexer
  if (configData.proxyIndexers) delete configData.proxyIndexers[name];
  if (configData.healthChecks?.healthCheckIndexers) delete configData.healthChecks.healthCheckIndexers[name];

  saveConfigFile(configData);
}

export function reorderIndexers(indexers: UsenetIndexer[]): void {
  // Validate that the reordered list contains the same indexers
  if (indexers.length !== configData.indexers.length) {
    throw new Error('Indexer count mismatch');
  }

  // Update the order
  configData.indexers = indexers;
  saveConfigFile(configData);
}

export function reorderSyncedIndexers(syncedIndexers: SyncedIndexer[]): void {
  const existing = configData.syncedIndexers || [];
  if (syncedIndexers.length !== existing.length) {
    throw new Error('Synced indexer count mismatch');
  }
  configData.syncedIndexers = syncedIndexers;
  saveConfigFile(configData);
}

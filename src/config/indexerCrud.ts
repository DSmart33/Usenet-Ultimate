/**
 * Indexer CRUD Operations
 *
 * Provides create, read, update, delete, and reorder operations
 * for both regular indexers and synced indexers.
 */

import type { UsenetIndexer, SyncedIndexer } from '../types.js';
import { configData, saveConfigFile } from './schema.js';

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

  // If renaming, check for duplicate
  if (updates.name && updates.name !== name) {
    if (configData.indexers.some(i => i.name === updates.name)) {
      throw new Error('Indexer with this name already exists');
    }
  }

  configData.indexers[index] = {
    ...configData.indexers[index],
    ...updates,
  };

  // Mutual exclusion: force-disable health checks when Zyclops is enabled
  // Note: proxy is NOT force-disabled — runtime already skips proxy for Zyclops indexers,
  // and preserving the user's proxy preference allows it to restore when Zyclops is turned off.
  const updated = configData.indexers[index];
  if (updated.zyclops?.enabled) {
    console.log(`🤖 Zyclops mutual exclusion: disabling health checks for ${updated.name}`);
    if (configData.healthChecks?.healthCheckIndexers) {
      configData.healthChecks.healthCheckIndexers[updated.name] = false;
    }
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

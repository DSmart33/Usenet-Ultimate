/**
 * Provider CRUD Operations
 *
 * Provides create, read, update, delete, and reorder operations
 * for Usenet health-check providers.
 */

import crypto from 'crypto';
import type { UsenetProvider } from '../types.js';
import { configData, saveConfigFile } from './schema.js';

export function getProviders(): UsenetProvider[] {
  return [...(configData.healthChecks?.providers || [])];
}

export function addProvider(provider: Omit<UsenetProvider, 'id'>): UsenetProvider {
  if (!configData.healthChecks) {
    configData.healthChecks = {
      enabled: false,
      archiveInspection: true,
      sampleCount: 3,
      providers: [],
      nzbsToInspect: 6,
      autoQueueMode: 'all',
      hideBlocked: true
    };
  }

  const newProvider: UsenetProvider = {
    ...provider,
    id: crypto.randomUUID()
  };

  configData.healthChecks.providers.push(newProvider);
  saveConfigFile(configData);
  return newProvider;
}

export function updateProvider(id: string, updates: Partial<UsenetProvider>): UsenetProvider {
  const providers = configData.healthChecks?.providers;
  if (!providers) throw new Error('No health check providers configured');

  const index = providers.findIndex(p => p.id === id);
  if (index === -1) throw new Error('Provider not found');

  providers[index] = { ...providers[index], ...updates, id }; // Preserve id
  saveConfigFile(configData);
  return providers[index];
}

export function deleteProvider(id: string): void {
  const providers = configData.healthChecks?.providers;
  if (!providers) throw new Error('No health check providers configured');

  const index = providers.findIndex(p => p.id === id);
  if (index === -1) throw new Error('Provider not found');

  providers.splice(index, 1);
  saveConfigFile(configData);
}

export function reorderProviders(orderedIds: string[]): void {
  if (!configData.healthChecks) throw new Error('No health check config');
  const existing = configData.healthChecks.providers;

  // Validate: same IDs, just reordered
  const existingIds = new Set(existing.map(p => p.id));
  const incomingIds = new Set(orderedIds);
  if (existingIds.size !== incomingIds.size || ![...existingIds].every(id => incomingIds.has(id))) {
    throw new Error('Reorder must contain exactly the same provider IDs');
  }

  // Reorder by mapping IDs to existing provider objects
  const byId = new Map(existing.map(p => [p.id, p]));
  configData.healthChecks.providers = orderedIds.map(id => byId.get(id)!);
  saveConfigFile(configData);
}

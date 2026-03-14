/**
 * Configuration Migrations
 *
 * Runs all one-time data migrations on startup:
 *  - .env indexer migration
 *  - Legacy single-provider health check → providers array
 *  - Legacy Tor → disabled
 *  - Legacy gluetunUrl/proxyMode:'gluetun' → proxyUrl/proxyMode:'http'
 *  - Legacy search settings → searchConfig
 *  - Global search methods → per-indexer
 *  - Single-string search methods → arrays
 *  - Single-string zyclops backbone → array
 *  - Pagination defaults migration
 */

import 'dotenv/config';
import crypto from 'crypto';
import { configData, saveConfigFile } from './schema.js';

// Migrate from .env if config is empty and .env has indexers
if (configData.indexers.length === 0) {
  const indexerUrls = process.env.INDEXER_URL?.split(',').map(s => s.trim()).filter(Boolean) || [];
  const indexerKeys = process.env.INDEXER_API_KEY?.split(',').map(s => s.trim()).filter(Boolean) || [];

  if (indexerUrls.length > 0) {
    configData.indexers = indexerUrls.map((url, index) => ({
      name: `Indexer ${index + 1}`,
      url,
      apiKey: indexerKeys[index] || '',
      enabled: true,
    }));

    // Also migrate cache settings from .env
    if (process.env.CACHE_TTL) {
      configData.cacheTTL = parseInt(process.env.CACHE_TTL) || 0;
    }

    saveConfigFile(configData);
    console.log('✅ Migrated indexers from .env to config.json');
  }
}

// Migrate legacy single-provider health check config to providers array
if (configData.healthChecks?.usenetHost && !configData.healthChecks.providers?.length) {
  const hc = configData.healthChecks;
  configData.healthChecks = {
    enabled: hc.enabled,
    providers: [{
      id: crypto.randomUUID(),
      name: 'Primary Provider',
      host: hc.usenetHost!,
      port: hc.usenetPort ?? 563,
      useTLS: hc.useTLS ?? true,
      username: hc.usenetUsername ?? '',
      password: hc.usenetPassword ?? '',
      enabled: true,
      type: 'pool'
    }],
    nzbsToInspect: hc.nzbsToInspect,
    maxConnections: hc.maxConnections ?? 12,
    autoQueueMode: hc.autoQueueMode,
    hideBlocked: hc.hideBlocked
  };
  saveConfigFile(configData);
  console.log('✅ Migrated health check config to multi-provider format');
}

// Migrate legacy useTor / proxyMode='tor' to disabled (Tor support removed)
if ((configData as any).useTor !== undefined || configData.proxyMode === 'tor' as any) {
  delete (configData as any).useTor;
  if (configData.proxyMode === 'tor' as any) {
    configData.proxyMode = 'disabled';
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated legacy Tor config to disabled (Tor support removed)`);
}

// Migrate legacy gluetun proxy config to generic proxy naming
if ((configData as any).gluetunUrl !== undefined || configData.proxyMode === 'gluetun' as any) {
  if ((configData as any).gluetunUrl && !configData.proxyUrl) {
    configData.proxyUrl = (configData as any).gluetunUrl;
  }
  delete (configData as any).gluetunUrl;
  if (configData.proxyMode === 'gluetun' as any) {
    configData.proxyMode = 'http';
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated legacy Gluetun proxy config to generic proxy naming`);
}

// Migrate legacy useTextSearch / includeSeasonPacks to searchConfig
if (configData.searchConfig === undefined) {
  const method = configData.useTextSearch ? 'text' as const : 'imdb' as const;
  configData.searchConfig = {
    movieSearchMethod: method,
    tvSearchMethod: method,
    includeSeasonPacks: configData.includeSeasonPacks ?? true,
  };
  saveConfigFile(configData);
  console.log(`✅ Migrated search settings to searchConfig (method=${method})`);
}

// Migrate global search methods to per-indexer settings
if (configData.indexers.length > 0 && configData.indexers.some(i => !i.movieSearchMethod)) {
  const globalMovie = configData.searchConfig?.movieSearchMethod || 'imdb';
  const globalTv = configData.searchConfig?.tvSearchMethod || 'imdb';
  for (const indexer of configData.indexers) {
    if (!indexer.movieSearchMethod) indexer.movieSearchMethod = [globalMovie] as any;
    if (!indexer.tvSearchMethod) indexer.tvSearchMethod = [globalTv] as any;
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated global search methods (movie=${globalMovie}, tv=${globalTv}) to ${configData.indexers.length} indexer(s)`);
}

// Migrate single-string search methods to arrays
if (configData.indexers.some(i => i.movieSearchMethod && !Array.isArray(i.movieSearchMethod))) {
  for (const indexer of configData.indexers) {
    if (indexer.movieSearchMethod && !Array.isArray(indexer.movieSearchMethod)) {
      indexer.movieSearchMethod = [indexer.movieSearchMethod] as any;
    }
    if (indexer.tvSearchMethod && !Array.isArray(indexer.tvSearchMethod)) {
      indexer.tvSearchMethod = [indexer.tvSearchMethod] as any;
    }
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated single-string search methods to arrays for ${configData.indexers.length} indexer(s)`);
}

// Migrate single-string synced indexer search methods to arrays
if (configData.syncedIndexers?.some((i: any) => i.movieSearchMethod && !Array.isArray(i.movieSearchMethod))) {
  for (const indexer of configData.syncedIndexers || []) {
    if ((indexer as any).movieSearchMethod && !Array.isArray((indexer as any).movieSearchMethod)) {
      (indexer as any).movieSearchMethod = [(indexer as any).movieSearchMethod];
    }
    if ((indexer as any).tvSearchMethod && !Array.isArray((indexer as any).tvSearchMethod)) {
      (indexer as any).tvSearchMethod = [(indexer as any).tvSearchMethod];
    }
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated single-string synced indexer search methods to arrays`);
}

// Migrate single-string zyclops backbone to array
if (configData.indexers.some(i => i.zyclops?.backbone && !Array.isArray(i.zyclops.backbone))) {
  for (const indexer of configData.indexers) {
    if (indexer.zyclops?.backbone && !Array.isArray(indexer.zyclops.backbone)) {
      (indexer.zyclops as any).backbone = [indexer.zyclops.backbone];
    }
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated single-string zyclops backbone to array for ${configData.indexers.length} indexer(s)`);
}

// Migrate pagination: old default was true (pagination !== false), new default is false.
// Existing indexers with pagination undefined (old implicit true) get explicit pagination: true + maxPages: 3.
if (configData.indexers.length > 0 && configData.indexers.some(i => i.pagination === undefined && i.maxPages === undefined)) {
  for (const indexer of configData.indexers) {
    if (indexer.pagination === undefined && indexer.maxPages === undefined) {
      // Old default was enabled — preserve behavior
      indexer.pagination = true;
      indexer.maxPages = 3;
    }
  }
  saveConfigFile(configData);
  console.log(`✅ Migrated pagination defaults for ${configData.indexers.length} indexer(s) (old default true → explicit true + maxPages 3)`);
}

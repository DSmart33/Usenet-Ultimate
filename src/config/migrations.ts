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
 *  - One-time filter/sort reset (v1.3.0)
 *  - Stream display age/bitrate injection
 *  - Auto play minimum cache TTL enforcement
 *  - Global useTextSearchForAnime → per-indexer anime search methods
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

// Migrate: users upgrading from before Series Packs existed default to OFF.
// Fresh installs hit this BEFORE line-95 creates their searchConfig, so they
// have searchConfig === undefined and skip. Upgrading users have an existing
// searchConfig (carried over from v1.3.0 or earlier) but no
// includeMultiSeasonPacks field; set it false so behavior doesn't change
// silently. Fresh installs pick up the UI useState default (true) on first run.
if (configData.searchConfig !== undefined && configData.searchConfig.includeMultiSeasonPacks === undefined) {
  configData.searchConfig.includeMultiSeasonPacks = false;
  saveConfigFile(configData);
  console.log('✅ Series Packs default OFF for users upgrading from before Series Packs existed');
}

// Migrate legacy useTextSearch / includeSeasonPacks to searchConfig.
// Fresh installs land here (no prior searchConfig); seed Series Packs defaults
// (master ON, Complete keyword) so headless users get the same behavior as
// users who open the UI. Upgrading users (with existing searchConfig) hit the
// migration above instead and get Series Packs OFF.
if (configData.searchConfig === undefined) {
  const method = configData.useTextSearch ? 'text' as const : 'imdb' as const;
  configData.searchConfig = {
    movieSearchMethod: method,
    tvSearchMethod: method,
    includeSeasonPacks: configData.includeSeasonPacks ?? true,
    includeMultiSeasonPacks: true,
    seriesPackKeywords: [],
    seriesPackPagination: true,
    seriesPackAdditionalPages: 1,
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

// One-time filter reset: 540p was added in this release — its absence signals pre-update filters
{
  const needsReset = (configData.filters as any)?.resolutionPriority && !(configData.filters as any).resolutionPriority.includes('540p');
  if (needsReset) {
    delete (configData as any).filters;
    delete (configData as any).movieFilters;
    delete (configData as any).tvFilters;
    saveConfigFile(configData);
    console.log('✅ One-time reset: filter/sort configs reset to defaults');
  }
}

// Migrate streamDisplayConfig: inject age/bitrate elements if missing
if (configData.streamDisplayConfig?.elements && !configData.streamDisplayConfig.elements['age']) {
  configData.streamDisplayConfig.elements['age'] = { id: 'age', label: 'Post Age', enabled: false, prefix: '📅' };
  configData.streamDisplayConfig.elements['bitrate'] = { id: 'bitrate', label: 'Bitrate', enabled: false, prefix: '📊' };
  // Also place them into the first empty lineGroup row so they're visible in the UI
  if (configData.streamDisplayConfig.lineGroups) {
    const emptyRow = configData.streamDisplayConfig.lineGroups.find((g: any) => g.elementIds?.length === 0);
    if (emptyRow) {
      emptyRow.elementIds = ['age', 'bitrate'];
    }
  }
  saveConfigFile(configData);
  console.log('✅ Migrated streamDisplayConfig: added age/bitrate display elements');
}

// Enforce minimum cache TTL when auto play is enabled (auto play defaults to enabled)
{
  const autoPlayEnabled = (configData as any).autoPlay?.enabled !== false;
  if (autoPlayEnabled && (configData.cacheTTL ?? 0) < 9000) {
    configData.cacheTTL = 9000;
    saveConfigFile(configData);
    console.log('✅ Set search cache to 2.5 hours (minimum for auto play)');
  }
}

// Ensure all indexers have anime search method defaults
{
  const useText = (configData as any).searchConfig?.useTextSearchForAnime;
  let migrated = false;
  for (const indexer of configData.indexers) {
    if (!(indexer as any).animeMovieSearchMethod) {
      // If global useTextSearchForAnime was explicitly false, inherit from normal methods; otherwise default to text
      (indexer as any).animeMovieSearchMethod = (useText === false) ? ((indexer as any).movieSearchMethod || ['text']) : ['text'];
      (indexer as any).animeTvSearchMethod = (useText === false) ? ((indexer as any).tvSearchMethod || ['text']) : ['text'];
      migrated = true;
    }
  }
  for (const indexer of (configData as any).syncedIndexers || []) {
    if (!indexer.animeMovieSearchMethod) {
      indexer.animeMovieSearchMethod = (useText === false) ? (indexer.movieSearchMethod || ['text']) : ['text'];
      indexer.animeTvSearchMethod = (useText === false) ? (indexer.tvSearchMethod || ['text']) : ['text'];
      migrated = true;
    }
  }
  if (migrated) {
    saveConfigFile(configData);
    console.log('✅ Set anime search method defaults for indexers');
  }
}

// Migrate enableRemakeFiltering / allowMultiEpisodeFiles from searchConfig to filters
{
  const sc = configData.searchConfig as any;
  if (sc && (sc.enableRemakeFiltering !== undefined || sc.allowMultiEpisodeFiles !== undefined)) {
    if (!configData.filters) configData.filters = { sortOrder: [] };
    if (sc.enableRemakeFiltering !== undefined && configData.filters.enableRemakeFiltering === undefined) {
      configData.filters.enableRemakeFiltering = sc.enableRemakeFiltering;
    }
    if (sc.allowMultiEpisodeFiles !== undefined && configData.filters.allowMultiEpisodeFiles === undefined) {
      configData.filters.allowMultiEpisodeFiles = sc.allowMultiEpisodeFiles;
    }
    delete sc.enableRemakeFiltering;
    delete sc.allowMultiEpisodeFiles;
    saveConfigFile(configData);
    console.log('✅ Migrated enableRemakeFiltering / allowMultiEpisodeFiles from searchConfig to filters');
  }
}

// Append 'vvc' to encodePriority arrays that pre-date VVC/h.266 support.
// VVC is the MPEG successor to HEVC and ranks at the top of the canonical
// default order (highest priority). For upgrading users we append it at the
// bottom of their existing list to preserve their customized ordering rather
// than silently re-ranking codecs they already organized. New users and
// Reset to Default get VVC at the top via the default constants.
{
  const needsVvc = (arr: string[] | undefined): boolean => !!arr && arr.length > 0 && !arr.includes('vvc');
  let migrated = false;
  for (const key of ['filters', 'movieFilters', 'tvFilters'] as const) {
    const f = configData[key] as any;
    if (needsVvc(f?.encodePriority)) {
      f.encodePriority = [...f.encodePriority, 'vvc'];
      migrated = true;
    }
  }
  if (migrated) {
    saveConfigFile(configData);
    console.log('✅ Appended VVC (h.266) to encodePriority for upgrading users');
  }
}

// Append 'vc1' to encodePriority arrays that pre-date VC-1 support.
// VC-1 sits between AVC and VP8 in the canonical default order. For
// upgrading users we append it at the bottom of their existing list to
// preserve their customized ordering rather than silently re-ranking
// codecs they already organized. New users and Reset to Default get
// VC-1 at its canonical position via the default constants.
{
  const needsVc1 = (arr: string[] | undefined): boolean => !!arr && arr.length > 0 && !arr.includes('vc1');
  let migrated = false;
  for (const key of ['filters', 'movieFilters', 'tvFilters'] as const) {
    const f = configData[key] as any;
    if (needsVc1(f?.encodePriority)) {
      f.encodePriority = [...f.encodePriority, 'vc1'];
      migrated = true;
    }
  }
  if (migrated) {
    saveConfigFile(configData);
    console.log('✅ Appended VC-1 to encodePriority for upgrading users');
  }
}

// Append 'DCP' (Digital Cinema Package leaks) to videoPriority arrays that
// pre-date DCP support. DCP ranks just above WEBCap in the canonical default
// order (theatrical-master transcodes sit between standard web/BDRip sources
// and screener-grade captures). For upgrading users we append it at the
// bottom rather than re-ranking their customized list. New users and Reset
// to Default get DCP at its canonical position via the default constants.
{
  const needsDcp = (arr: string[] | undefined): boolean => !!arr && arr.length > 0 && !arr.includes('DCP');
  let migrated = false;
  for (const key of ['filters', 'movieFilters', 'tvFilters'] as const) {
    const f = configData[key] as any;
    if (needsDcp(f?.videoPriority)) {
      f.videoPriority = [...f.videoPriority, 'DCP'];
      migrated = true;
    }
  }
  if (migrated) {
    saveConfigFile(configData);
    console.log('✅ Appended DCP to videoPriority for upgrading users');
  }
}

// Migrate audioTagPriority from coarse library-style tokens ('DDP', 'DTS Lossless'
// etc.) to fine-grained canonical tokens that match community template rules
// ('DD+', 'DTS-HD MA', 'DTS:X', etc.). Parser now emits the fine-grained form.
{
  const AUDIO_RENAME: Record<string, string> = {
    'DDP': 'DD+',
    'Atmos (DDP)': 'Atmos (DD+)',
    'OPUS': 'Opus',
  };
  const NEW_TOKENS = ['DTS:X', 'DTS-HD MA', 'DTS-HD', 'DTS-ES'];

  const migrateList = (arr: string[] | undefined): { out: string[]; changed: boolean } => {
    if (!Array.isArray(arr) || arr.length === 0) return { out: arr ?? [], changed: false };
    let changed = false;
    // Rename existing tokens
    const renamed = arr.map(v => {
      if (AUDIO_RENAME[v]) { changed = true; return AUDIO_RENAME[v]; }
      return v;
    });
    // Remove obsolete tokens that no longer exist
    const kept = renamed.filter(v => {
      if (v === 'DTS Lossless' || v === 'DTS Lossy') { changed = true; return false; }
      return true;
    });
    // Append new tokens the user didn't have yet (keep them togglable)
    for (const t of NEW_TOKENS) {
      if (!kept.includes(t)) { kept.push(t); changed = true; }
    }
    return { out: kept, changed };
  };

  let migrated = false;
  for (const key of ['filters', 'movieFilters', 'tvFilters'] as const) {
    const f = configData[key] as any;
    if (!f) continue;
    const r = migrateList(f.audioTagPriority);
    if (r.changed) { f.audioTagPriority = r.out; migrated = true; }
  }
  if (migrated) {
    saveConfigFile(configData);
    console.log('✅ Migrated audioTagPriority to fine-grained audio tokens (DD+, DTS-HD MA, DTS:X, etc.)');
  }
}

// Migrate NZB Fallback → Ultimate Fallback. UF fully replaces fallback semantics;
// migrants land on the new UF default baseline (on-tile-selection + failure-video)
// rather than deriving from prior NZB Fallback toggles — fresh start.
{
  const c = configData as any;
  const hadFallback = c.nzbdavFallbackEnabled !== undefined
    || c.nzbdavMaxFallbacks !== undefined
    || c.nzbdavFallbackOrder !== undefined
    || c.autoResolveOnSearch !== undefined
    || c.autoResolveTargets !== undefined;

  if (hadFallback) {
    const fallbackWasEnabled = c.nzbdavFallbackEnabled === true;
    const userHasUR = c.ultimateFallback?.enabled !== undefined;
    if (fallbackWasEnabled && !userHasUR) {
      const ur = (c.ultimateFallback ??= {});
      ur.enabled = true;
      ur.healthCheckEnabled = false;
      ur.candidateCount = 1;
      ur.desiredBackups = 0;
      ur.preferenceMode = 'priority';
      ur.whenToResolve = 'on-tile-selection';
      // 'uf-lobby' = "Use Ultimate Fallback to Resolve From Top of List"
      // — closest 1:1 to NZB Fallback's v1.3.0 behavior (auto-iterate
      // candidates from the start of the list when a stream tile fails).
      ur.userPickFallback = 'uf-lobby';
      ur.maxAttempts = typeof c.nzbdavMaxFallbacks === 'number' ? c.nzbdavMaxFallbacks : 0;
    }
    delete c.nzbdavFallbackEnabled;
    delete c.nzbdavMaxFallbacks;
    delete c.nzbdavFallbackOrder;
    delete c.autoResolveOnSearch;
    delete c.autoResolveTargets;
    saveConfigFile(configData);
    console.log(fallbackWasEnabled && !userHasUR
      ? '✅ Migrated NZB Fallback → Ultimate Fallback (sequential, lobby-from-top on tile failure, no health checks, no backups)'
      : '✅ Removed legacy NZB Fallback config fields');
  }

  const removedEnv = ['NZBDAV_FALLBACK_ENABLED', 'NZBDAV_MAX_FALLBACKS', 'NZBDAV_FALLBACK_ORDER', 'AUTO_RESOLVE_ON_SEARCH', 'AUTO_RESOLVE_TARGETS'];
  const stillSet = removedEnv.filter(name => process.env[name] !== undefined && process.env[name] !== '');
  if (stillSet.length > 0) {
    console.warn(`⚠️  Deprecated env vars set but ignored: ${stillSet.join(', ')}. NZB Fallback was replaced by Ultimate Fallback — remove these from your environment.`);
  }
}

// Rebrand: Ultimate Fallback → Ultimate Fallback. Pure rename; feature stays
// enabled. Translates the config object key + the userPickFallback 'uf-lobby'
// value, and warns about deprecated env vars.
{
  const c = configData as any;
  const hadOldUR = c.ultimateFallback !== undefined;
  if (hadOldUR && c.ultimateFallback === undefined) {
    c.ultimateFallback = c.ultimateFallback;
    delete c.ultimateFallback;
    if (c.ultimateFallback?.userPickFallback === 'uf-lobby') {
      c.ultimateFallback.userPickFallback = 'uf-lobby';
    }
    saveConfigFile(configData);
    console.log('✅ Rebranded ultimateFallback → ultimateFallback');
  }

  if (Array.isArray(c.cardOrder)) {
    const idx = c.cardOrder.indexOf('ultimateFallback');
    if (idx !== -1) {
      c.cardOrder[idx] = 'ultimateFallback';
      saveConfigFile(configData);
    }
  }

  const stillSetUR = Object.keys(process.env).filter(k => k.startsWith('ULTIMATE_FALLBACK_'));
  if (stillSetUR.length > 0) {
    console.warn(`⚠️  Deprecated env vars set but ignored: ${stillSetUR.join(', ')}. Ultimate Fallback was renamed to Ultimate Fallback — use ULTIMATE_FALLBACK_* instead.`);
  }
}

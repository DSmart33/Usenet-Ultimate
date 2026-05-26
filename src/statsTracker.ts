/**
 * Stats Tracker
 * Tracks indexer performance statistics similar to Prowlarr
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configData, saveConfigFile } from './config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.join(__dirname, '..', 'config', 'stats.json');

export interface IndexerStats {
  indexerName: string;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  totalResults: number;
  totalGrabs: number;
  avgResponseTime: number;
  lastQueried: string | null;
  lastGrabbed: string | null;
  queryHistory: Array<{
    timestamp: string;
    success: boolean;
    responseTime: number;
    resultCount: number;
    errorMessage?: string;
  }>;
  grabHistory: Array<{
    timestamp: string;
    title: string;
  }>;
}

interface StatsData {
  indexers: { [key: string]: IndexerStats };
  globalStats: {
    totalQueries: number;
    totalResults: number;
    totalGrabs: number;
    avgResponseTime: number;
  };
}

let statsData: StatsData = {
  indexers: {},
  globalStats: {
    totalQueries: 0,
    totalResults: 0,
    totalGrabs: 0,
    avgResponseTime: 0,
  },
};

// Load stats from file
function loadStatsFile(): StatsData {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = fs.readFileSync(STATS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading stats file:', error);
  }
  
  return {
    indexers: {},
    globalStats: {
      totalQueries: 0,
      totalGrabs: 0,
      totalResults: 0,
      avgResponseTime: 0,
    },
  };
}

// Save stats to file
function saveStatsFile(): void {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(statsData, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving stats file:', error);
  }
}

// Initialize stats
statsData = loadStatsFile();

// Resolve an indexer name to its stored key, matching case-insensitively when no
// exact key exists. Prevents capitalization differences from creating two stats rows.
function findIndexerKey(indexerName: string): string {
  if (statsData.indexers[indexerName]) return indexerName;
  const lower = indexerName.toLowerCase();
  for (const key of Object.keys(statsData.indexers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return indexerName;
}

// Track a query
export function trackQuery(
  indexerName: string,
  success: boolean,
  responseTime: number,
  resultCount: number,
  errorMessage?: string
): void {
  const key = findIndexerKey(indexerName);
  if (!statsData.indexers[key]) {
    statsData.indexers[key] = {
      indexerName: key,
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      totalResults: 0,
      totalGrabs: 0,
      avgResponseTime: 0,
      lastQueried: null,
      lastGrabbed: null,
      queryHistory: [],
      grabHistory: [],
    };
  }

  const indexer = statsData.indexers[key];
  
  // Update indexer stats
  indexer.totalQueries++;
  if (success) {
    indexer.successfulQueries++;
    indexer.totalResults += resultCount;
  } else {
    indexer.failedQueries++;
  }
  
  // Calculate new average response time
  const totalTime = indexer.avgResponseTime * (indexer.totalQueries - 1) + responseTime;
  indexer.avgResponseTime = Math.round(totalTime / indexer.totalQueries);
  
  indexer.lastQueried = new Date().toISOString();
  
  // Add to history (keep last 100 queries per indexer)
  indexer.queryHistory.push({
    timestamp: new Date().toISOString(),
    success,
    responseTime,
    resultCount,
    errorMessage,
  });
  
  if (indexer.queryHistory.length > 100) {
    indexer.queryHistory.shift();
  }
  
  // Update global stats
  statsData.globalStats.totalQueries++;
  if (success) {
    statsData.globalStats.totalResults += resultCount;
  }
  
  const allResponseTimes = Object.values(statsData.indexers)
    .map(i => i.avgResponseTime * i.totalQueries)
    .reduce((a, b) => a + b, 0);
  statsData.globalStats.avgResponseTime = Math.round(
    allResponseTimes / statsData.globalStats.totalQueries
  );
  
  saveStatsFile();
}

// Get all stats
export function getAllStats(): StatsData {
  return { ...statsData };
}

// Get stats for a specific indexer
export function getIndexerStats(indexerName: string): IndexerStats | null {
  return statsData.indexers[findIndexerKey(indexerName)] || null;
}

// Reset stats for an indexer
export function resetIndexerStats(indexerName: string): void {
  const key = findIndexerKey(indexerName);
  if (statsData.indexers[key]) {
    delete statsData.indexers[key];
    saveStatsFile();
  }
}

// Reset all stats
export function resetAllStats(): void {
  statsData = {
    indexers: {},
    globalStats: {
      totalQueries: 0,
      totalGrabs: 0,
      totalResults: 0,
      avgResponseTime: 0,
    },
  };
  saveStatsFile();
}

// One-time cleanup for the stale "WebDAV Library" indexer row written by the
// pre-dfb5016 route-level grab tracker. Returns the grab count it removed (0
// if the row was already gone); caller owns logging.
export function clearStaleLibraryIndexerStats(): number {
  const entry = statsData.indexers['WebDAV Library'];
  if (!entry) return 0;
  const lostGrabs = entry.totalGrabs ?? 0;
  delete statsData.indexers['WebDAV Library'];
  if (statsData.globalStats.totalGrabs && lostGrabs > 0) {
    statsData.globalStats.totalGrabs = Math.max(0, statsData.globalStats.totalGrabs - lostGrabs);
  }
  saveStatsFile();
  return lostGrabs;
}

// Fold a duplicate row into the canonical row: sum counters, take the newest
// timestamps, weighted-average response time, merge histories sorted by time.
// All numeric reads use `?? 0` so old stats.json shapes (missing totalGrabs etc)
// match the back-compat shims trackGrab already applies on write.
function mergeIndexerStats(canonical: IndexerStats, dup: IndexerStats): void {
  const canonicalQueries = canonical.totalQueries ?? 0;
  const dupQueries = dup.totalQueries ?? 0;
  const combinedQueries = canonicalQueries + dupQueries;
  if (combinedQueries > 0) {
    const totalTime = (canonical.avgResponseTime ?? 0) * canonicalQueries + (dup.avgResponseTime ?? 0) * dupQueries;
    canonical.avgResponseTime = Math.round(totalTime / combinedQueries);
  }
  canonical.totalQueries = combinedQueries;
  canonical.successfulQueries = (canonical.successfulQueries ?? 0) + (dup.successfulQueries ?? 0);
  canonical.failedQueries = (canonical.failedQueries ?? 0) + (dup.failedQueries ?? 0);
  canonical.totalResults = (canonical.totalResults ?? 0) + (dup.totalResults ?? 0);
  canonical.totalGrabs = (canonical.totalGrabs ?? 0) + (dup.totalGrabs ?? 0);
  if (dup.lastQueried && (!canonical.lastQueried || dup.lastQueried > canonical.lastQueried)) {
    canonical.lastQueried = dup.lastQueried;
  }
  if (dup.lastGrabbed && (!canonical.lastGrabbed || dup.lastGrabbed > canonical.lastGrabbed)) {
    canonical.lastGrabbed = dup.lastGrabbed;
  }
  canonical.queryHistory = [...(canonical.queryHistory || []), ...(dup.queryHistory || [])]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-100);
  canonical.grabHistory = [...(canonical.grabHistory || []), ...(dup.grabHistory || [])]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-100);
}

// One-time cleanup that merges indexer rows whose keys differ only in case.
// Canonical = highest totalQueries + totalGrabs;
// Ties broken by most-recent activity. Returns the number of rows merged away
// (0 if no duplicates were found); caller owns logging.
export function mergeDuplicateIndexerKeys(): number {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(statsData.indexers)) {
    const lower = key.toLowerCase();
    const bucket = groups.get(lower);
    if (bucket) bucket.push(key);
    else groups.set(lower, [key]);
  }
  let mergedCount = 0;
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => {
      const aActivity = (statsData.indexers[a].totalQueries ?? 0) + (statsData.indexers[a].totalGrabs ?? 0);
      const bActivity = (statsData.indexers[b].totalQueries ?? 0) + (statsData.indexers[b].totalGrabs ?? 0);
      if (aActivity !== bActivity) return bActivity - aActivity;
      const aLatest = statsData.indexers[a].lastQueried || statsData.indexers[a].lastGrabbed || '';
      const bLatest = statsData.indexers[b].lastQueried || statsData.indexers[b].lastGrabbed || '';
      return bLatest.localeCompare(aLatest);
    });
    const canonicalKey = keys[0];
    const canonical = statsData.indexers[canonicalKey];
    for (let i = 1; i < keys.length; i++) {
      mergeIndexerStats(canonical, statsData.indexers[keys[i]]);
      delete statsData.indexers[keys[i]];
      mergedCount++;
    }
  }
  if (mergedCount > 0) saveStatsFile();
  return mergedCount;
}

// Track a grab (when NZB is actually downloaded/selected)
export function trackGrab(indexerName: string, title: string): void {
  const key = findIndexerKey(indexerName);
  if (!statsData.indexers[key]) {
    statsData.indexers[key] = {
      indexerName: key,
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      totalResults: 0,
      totalGrabs: 0,
      avgResponseTime: 0,
      lastQueried: null,
      lastGrabbed: null,
      queryHistory: [],
      grabHistory: [],
    };
  }

  const indexer = statsData.indexers[key];
  
  // Ensure new fields exist for backward compatibility
  if (!indexer.grabHistory) {
    indexer.grabHistory = [];
  }
  if (indexer.totalGrabs === undefined) {
    indexer.totalGrabs = 0;
  }
  if (!indexer.lastGrabbed) {
    indexer.lastGrabbed = null;
  }
  
  indexer.totalGrabs++;
  indexer.lastGrabbed = new Date().toISOString();
  
  // Add to grab history (keep last 100)
  indexer.grabHistory.push({
    timestamp: new Date().toISOString(),
    title,
  });
  
  if (indexer.grabHistory.length > 100) {
    indexer.grabHistory.shift();
  }
  // Update global stats
  if (!statsData.globalStats.totalGrabs) {
    statsData.globalStats.totalGrabs = 0;
  }
  statsData.globalStats.totalGrabs++;


  saveStatsFile();
}

const STALE_INDEXER_STATS_CLEANUP_VERSION = 1;

// One-time stats hygiene migration. Gated by staleIndexerStatsCleanupVersion;
// no-op on every boot after the first that succeeds. `async` for call-site
// symmetry with runStaleLibraryFolderCleanup — no actual awaits inside.
export async function runStaleIndexerStatsCleanup(): Promise<void> {
  if ((configData.staleIndexerStatsCleanupVersion ?? 0) >= STALE_INDEXER_STATS_CLEANUP_VERSION) return;

  try {
    const lostGrabs = clearStaleLibraryIndexerStats();
    if (lostGrabs > 0) {
      console.log(`\u{1F5D1}️ Stale stats cleanup: purged "WebDAV Library" indexer entry (lost ${lostGrabs} synthetic grab(s))`);
    }

    const mergedDuplicates = mergeDuplicateIndexerKeys();
    if (mergedDuplicates > 0) {
      console.log(`\u{1F5D1}️ Stale stats cleanup: merged ${mergedDuplicates} case-duplicate indexer stat row(s)`);
    }

    configData.staleIndexerStatsCleanupVersion = STALE_INDEXER_STATS_CLEANUP_VERSION;
    saveConfigFile(configData);
  } catch (err) {
    console.error('\u{1F5D1}️ Stale stats cleanup failed:', err);
  }
}

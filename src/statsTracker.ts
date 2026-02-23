/**
 * Stats Tracker
 * Tracks indexer performance statistics similar to Prowlarr
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Track a query
export function trackQuery(
  indexerName: string,
  success: boolean,
  responseTime: number,
  resultCount: number,
  errorMessage?: string
): void {
  if (!statsData.indexers[indexerName]) {
    statsData.indexers[indexerName] = {
      indexerName,
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

  const indexer = statsData.indexers[indexerName];
  
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
  return statsData.indexers[indexerName] || null;
}

// Reset stats for an indexer
export function resetIndexerStats(indexerName: string): void {
  if (statsData.indexers[indexerName]) {
    delete statsData.indexers[indexerName];
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

// Track a grab (when NZB is actually downloaded/selected)
export function trackGrab(indexerName: string, title: string): void {
  if (!statsData.indexers[indexerName]) {
    statsData.indexers[indexerName] = {
      indexerName,
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

  const indexer = statsData.indexers[indexerName];
  
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

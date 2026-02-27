/**
 * NZBDav Service Types
 * Shared interfaces, type aliases, and constants used across all NZBDav modules.
 */

// ── Shared constants ──────────────────────────────────────────────────

/** Timeout per WebDAV directory listing / file request — prevents hang if NZBDav is overwhelmed */
export const WEBDAV_REQUEST_TIMEOUT_MS = 10_000;

// ── Interfaces ────────────────────────────────────────────────────────

export interface NZBDavConfig {
  url: string;
  apiKey: string;
  webdavUrl: string;
  webdavUser: string;
  webdavPassword: string;
  moviesCategory: string;
  tvCategory: string;
}

export interface StreamData {
  nzoId: string;
  videoPath: string;
  videoSize: number;
}

export type CacheStatus = 'pending' | 'ready' | 'failed';

export interface CacheEntry {
  status: CacheStatus;
  promise?: Promise<StreamData>;
  data?: StreamData;
  error?: Error;
  expiresAt: number;
}

export interface HistorySlot {
  nzo_id?: string;
  nzoId?: string;
  status?: string;
  Status?: string;
  fail_message?: string;
  failMessage?: string;
  name?: string;
}

export interface FallbackCandidate {
  nzbUrl: string;
  title: string;
  indexerName: string;
}

export interface FallbackGroup {
  candidates: FallbackCandidate[];
  type: string;
  season?: string;
  episode?: string;
  createdAt: number;
}

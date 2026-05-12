/**
 * NZBDav History API
 * Best-effort cleanup of nzbdav history entries after a webdav delete.
 * Reads/deletes history via the SABnzbd-compatible `mode=history` API.
 */

import { posix as pathPosix } from 'path';
import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import type { NZBDavConfig, HistorySlot } from './types.js';

/**
 * Extract `name` (release folder, matches the submitted `nzbname`) and
 * `category` (first segment under /content/) from a webdav target path.
 * Assumes the caller already passed validateDeletePath; we don't re-validate.
 */
export function extractReleaseInfo(
  targetPath: string,
  scope: 'file' | 'pack',
): { name: string; category: string } | null {
  const segments = targetPath.split('/').filter(s => s.length > 0);
  if (segments.length < 2 || segments[0] !== 'content') return null;
  const category = segments[1];

  if (scope === 'pack') {
    if (segments.length < 3) return null;
    return { name: segments[2], category };
  }

  if (segments.length >= 4) {
    return { name: segments[2], category };
  }
  if (segments.length === 3) {
    return { name: pathPosix.parse(segments[2]).name, category };
  }
  return null;
}

/**
 * Look up history entries whose `name` matches (case-insensitive) the given
 * release name. Best-effort: returns [] on any error.
 *
 * Pulls the full history in a single request. nzbdav's GetHistoryRequest
 * defaults Limit = int.MaxValue when no `limit` param is sent, so we get
 * every entry in one response. Scoped scan first; falls back to unscoped
 * (no `category=`) once if scoped finds nothing (handles category drift /
 * uncategorized entries).
 */
export async function findHistoryEntriesByName(
  name: string,
  category: string,
  config: NZBDavConfig,
): Promise<string[]> {
  const baseUrl = config.url.replace(/\/$/, '');
  const userAgent = globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome;
  const target = name.toLowerCase();
  const matchSlots = (slots: HistorySlot[]): string[] =>
    slots.filter(s => (s.name || '').toLowerCase() === target)
      .map(s => s.nzo_id || '')
      .filter(id => id.length > 0);

  const fetchAll = async (withCategory: boolean): Promise<HistorySlot[] | null> => {
    const url = `${baseUrl}/api?mode=history&apikey=${config.apiKey}&output=json`
      + (withCategory ? `&category=${encodeURIComponent(category)}` : '');
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { history?: { slots?: HistorySlot[] } };
      return data.history?.slots || [];
    } catch {
      return null;
    }
  };

  const scoped = await fetchAll(true);
  if (scoped === null) return [];
  const found = matchSlots(scoped);
  if (found.length > 0) return found;

  const unscoped = await fetchAll(false);
  if (unscoped === null) return [];
  return matchSlots(unscoped);
}

/**
 * Delete one or more history entries in a single batched HTTP call using
 * nzbdav's repeated `?value=` param shape (matches RemoveFromHistoryController's
 * native batch path: ids land in RemoveRange + one SaveChangesAsync).
 * Single attempt; swallows errors as warnings. The wrapping cleanup flow is
 * best-effort and the user can re-trigger delete to retry naturally.
 */
export async function deleteFromHistory(nzoIds: string[], config: NZBDavConfig, reason?: string): Promise<void> {
  if (nzoIds.length === 0) return;
  const baseUrl = config.url.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'history');
  params.set('name', 'delete');
  for (const id of nzoIds) params.append('value', id);
  params.set('apikey', config.apiKey);
  const url = `${baseUrl}/api?${params.toString()}`;
  const reasonSuffix = reason ? ` (${reason})` : '';
  const idList = nzoIds.join(', ');

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': globalConfig.userAgents?.nzbdavOperations || getLatestVersions().chrome },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      console.log(`  \u{1F5D1}️ Removed NZBDav history entries (${nzoIds.length}): ${idList}${reasonSuffix}`);
      return;
    }
    console.warn(`  ⚠️ Failed to remove NZBDav history entries [${idList}]${reasonSuffix}: ${response.status}`);
  } catch (err) {
    console.warn(`  ⚠️ Error removing NZBDav history entries [${idList}]${reasonSuffix}: ${(err as Error).message}`);
  }
}

/**
 * Wrapper called from the webdav delete routes. Looks up history entries by
 * release name and deletes them sequentially. Never throws — best-effort.
 */
export async function cleanupHistoryForPath(
  targetPath: string,
  scope: 'file' | 'pack',
  config: NZBDavConfig,
): Promise<void> {
  try {
    const info = extractReleaseInfo(targetPath, scope);
    if (!info) return;
    const ids = await findHistoryEntriesByName(info.name, info.category, config);
    if (ids.length === 0) return;
    await deleteFromHistory(ids, config, info.name);
  } catch (err) {
    const info = extractReleaseInfo(targetPath, scope);
    const nameLabel = info ? `"${info.name}" (cat=${info.category})` : `"${targetPath}"`;
    console.warn(`  ⚠️ NZBDav history cleanup failed for ${nameLabel}: ${(err as Error).message}`);
  }
}

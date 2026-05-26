/**
 * Stale Library Folder Cleanup
 *
 * One-time startup migration that removes release folders left over from the
 * legacy file-scope delete (the version that only pruned empty parents and
 * therefore left release dirs behind when extras like samples or .sfv files
 * remained). Without cleanup nzbdav resubmits would land in iterated
 * `Release.Name (1)` paths because the original folder still existed.
 *
 * Gated by one config field: staleLibraryFolderCleanupVersion (number,
 * default 0). On update it runs the real deletion once, bumps the flag to
 * STALE_LIBRARY_FOLDER_CLEANUP_VERSION, and is a no-op on every later boot.
 *
 * Self-contained: imports the shared `folderHasPlayableVideo` helper and a
 * few existing best-effort cleanup helpers, but does not depend on the route
 * module's `runWebdavDelete`. The inline DELETE keeps this migration from
 * causing churn anywhere outside this file.
 */

import type { FileStat } from 'webdav';
import { configData, saveConfigFile } from '../config/schema.js';
import { buildNzbdavConfig, encodeWebdavPath } from './utils.js';
import { getWebdavClient } from './webdavClient.js';
import { folderHasPlayableVideo } from './videoDiscovery.js';
import { cleanupHistoryForPath } from './historyApi.js';
import { evictReadyByVideoPathPrefix, clearVideoNotFoundDeadEntries } from './streamCache.js';
import { WEBDAV_REQUEST_TIMEOUT_MS } from './types.js';

const STALE_LIBRARY_FOLDER_CLEANUP_VERSION = 1;
const DELETE_TIMEOUT_MS = 15_000;

// Inline recursive DELETE so the migration does not pull `runWebdavDelete`
// out of routes/nzbdav.ts (keeping that file untouched). Matches the route
// helper's contract: Depth: infinity, 404/410 treated as success.
async function staleCleanupWebdavDelete(targetPath: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const nzbdavConfig = buildNzbdavConfig();
  const webdavBase = (nzbdavConfig.webdavUrl || nzbdavConfig.url).replace(/\/+$/, '');
  const url = `${webdavBase}${encodeWebdavPath(targetPath)}`;
  const headers: Record<string, string> = { Depth: 'infinity' };
  if (nzbdavConfig.webdavUser && nzbdavConfig.webdavPassword) {
    headers.Authorization = 'Basic ' + Buffer.from(`${nzbdavConfig.webdavUser}:${nzbdavConfig.webdavPassword}`).toString('base64');
  }
  try {
    const resp = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) });
    await resp.body?.cancel().catch(() => {});
    if (resp.status === 404 || resp.status === 410) return { ok: true, status: resp.status };
    if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status };
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function runStaleLibraryFolderCleanup(): Promise<void> {
  if ((configData.staleLibraryFolderCleanupVersion ?? 0) >= STALE_LIBRARY_FOLDER_CLEANUP_VERSION) return;

  const nzbdavConfig = buildNzbdavConfig();
  if (!nzbdavConfig.webdavUrl && !nzbdavConfig.url) return;

  console.log('\u{1F5D1}️ Stale library folder cleanup: starting');

  try {
    // Build root list defensively: skip any root whose category component is
    // empty/whitespace. Without this guard a misconfig (empty tvCategory)
    // would produce `/content/` whose direct children are the category roots
    // themselves; recursively deleting one would wipe an entire category.
    const candidateRoots: Array<{ label: string; path: string }> = [
      { label: 'tv',     path: `/content/${nzbdavConfig.tvCategory ?? ''}` },
      { label: 'movies', path: `/content/${nzbdavConfig.moviesCategory ?? ''}` },
    ];
    if (nzbdavConfig.scanUncategorized) {
      candidateRoots.push({ label: 'uncategorized', path: '/content/uncategorized' });
    }
    const roots: string[] = [];
    for (const c of candidateRoots) {
      const segments = c.path.split('/').filter(s => s.trim().length > 0);
      if (segments.length < 2) {
        console.warn(`\u{1F5D1}️ Stale cleanup: skipping ${c.label} root, category name is empty/whitespace`);
        continue;
      }
      roots.push(c.path);
    }

    const client = getWebdavClient(nzbdavConfig);
    let totalRemoved = 0;

    for (const root of roots) {
      let children: FileStat[];
      try {
        const items = await client.getDirectoryContents(root, {
          deep: false,
          signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
        });
        children = Array.isArray(items)
          ? items
          : (items && Array.isArray((items as { data?: FileStat[] }).data) ? (items as { data: FileStat[] }).data : []);
      } catch {
        continue;
      }

      const folderChildren = children.filter(c => c.type === 'directory');

      // Sequential by design: fire-and-forget at startup, and 1-2s per folder
      // for typical library sizes finishes in a few minutes without
      // overloading WebDAV or needing concurrency bookkeeping.
      for (const child of folderChildren) {
        const hasVideo = await folderHasPlayableVideo(child.filename, nzbdavConfig);
        if (hasVideo) continue;

        const result = await staleCleanupWebdavDelete(child.filename);
        if (!result.ok) {
          console.warn(`\u{1F5D1}️ Stale cleanup: failed to delete ${child.filename}: ${result.error}`);
          continue;
        }
        await cleanupHistoryForPath(child.filename, 'pack', nzbdavConfig);
        evictReadyByVideoPathPrefix(child.filename, false);
        console.log(`\u{1F5D1}️ Stale cleanup: removed orphaned folder ${child.filename}`);
        totalRemoved++;
      }
    }

    console.log(`\u{1F5D1}️ Stale cleanup complete: ${totalRemoved} folder(s) removed`);

    // Same one-time migration also sweeps the dead-NZB DB of false-positives
    // this bug produced (job completed but the video was absent because the
    // release had been remounted at an iterated path). Pure local op, runs
    // regardless of the folder-sweep outcome, inside the same gate and
    // try/catch. Placed before the version bump so a crash here retries both.
    clearVideoNotFoundDeadEntries();

    configData.staleLibraryFolderCleanupVersion = STALE_LIBRARY_FOLDER_CLEANUP_VERSION;
    saveConfigFile(configData);
  } catch (err) {
    console.error('\u{1F5D1}️ Stale cleanup failed:', err);
  }
}

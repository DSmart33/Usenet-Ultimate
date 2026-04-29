/**
 * Video File Discovery
 * WebDAV directory traversal and video file pattern matching.
 * Finds video files in download directories, with support for episode matching
 * in season packs and BDMV Blu-ray structures.
 */

import { createClient, FileStat } from 'webdav';
import { getWebdavClient } from './webdavClient.js';
import { resolveCategory } from './nzbdavApi.js';
import { WEBDAV_REQUEST_TIMEOUT_MS, type NZBDavConfig, type StreamData } from './types.js';
import { encodeWebdavPath, nzbdavError, MULTI_EPISODE_BLOCKED_ERROR } from './utils.js';
import { config as globalConfig, getTvAllowMultiEpisode } from '../config/index.js';

/**
 * Cheap existence check for a single WebDAV path. Used to verify that a
 * cached videoPath still points at a real file before serving — keeps the
 * library as the single source of truth. A single PROPFIND/HEAD; ~10-50ms.
 */
export async function videoPathExists(videoPath: string, config: NZBDavConfig): Promise<boolean> {
  try {
    const client = getWebdavClient(config);
    return await client.exists(videoPath);
  } catch {
    return false;
  }
}

/**
 * Find video file in WebDAV directory
 */
export async function findVideoFile(
  client: ReturnType<typeof createClient>,
  dirPath: string,
  depth = 0,
  episodePattern?: string,
  episodesInSeason?: number
): Promise<{ path: string; size: number } | null> {
  if (depth > 6) return null;

  const videoExts = ['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.wmv', '.webm', '.mpg', '.mpeg'];
  const minFileSize = 100 * 1024 * 1024; // 100MB minimum

  try {
    const items = await client.getDirectoryContents(dirPath, {
      signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
    }) as FileStat[];

    const videos: { path: string; size: number }[] = [];

    // Collect video files
    for (const item of items) {
      if (item.type === 'file') {
        const basename = item.filename.split('/').pop() || '';
        const ext = basename.substring(basename.lastIndexOf('.')).toLowerCase();
        const pathLower = item.filename.toLowerCase();

        // Skip sample files
        const isSample = basename.toLowerCase().includes('sample') ||
                        pathLower.includes('/sample/') ||
                        pathLower.includes('/subs/') ||
                        pathLower.includes('/subtitle');

        if (videoExts.includes(ext) && !isSample && item.size && item.size >= minFileSize) {
          videos.push({ path: item.filename, size: item.size });
        }
      }
    }

    if (videos.length > 0) {
      if (episodePattern) {
        const allowMultiEp = getTvAllowMultiEpisode(globalConfig);

        // Try exact SxxExx pattern match first
        const pattern = new RegExp(episodePattern, 'i');
        const match = videos.find(v => pattern.test(v.path));
        if (match) return match;

        // Extract target episode number — /E(\d+)/i applied to the pattern STRING finds the
        // terminal E{digits} literal. Chain-aware patterns use E\\d+ (literal backslash-d)
        // in the non-capturing group body, so the regex skips those and matches the final number.
        const epMatch = episodePattern.match(/E(\d+)/i);
        if (epMatch) {
          const targetEp = parseInt(epMatch[1], 10);

          // Try alternative episode patterns (e.g. "3x01", ".E01.", "Episode 1")
          const altPatterns = [
            new RegExp(`\\d+x${targetEp.toString().padStart(2, '0')}(?!\\d)`, 'i'),  // 3x01
            new RegExp(`[. _-]E${targetEp.toString().padStart(2, '0')}[. _-]`, 'i'),   // .E01.
            new RegExp(`Episode[. _-]?${targetEp}(?!\\d)`, 'i'),                        // Episode.1
          ];
          for (const alt of altPatterns) {
            const altMatch = videos.find(v => alt.test(v.path));
            if (altMatch) return altMatch;
          }

          // Try to extract episode numbers from all filenames and pick the right one
          // (only captures first ep in chain — ep-in-chain check below handles the rest)
          const epRegex = allowMultiEp
            ? /S\d+E(\d+)/i
            : /S\d+E(\d+)(?!\d|[. _-]?E\d|-\d)/i;
          const numbered = videos
            .map(v => ({ ...v, ep: parseInt((v.path.match(epRegex)?.[1] || '0'), 10) }))
            .filter(v => v.ep > 0);
          if (numbered.length > 0) {
            const exact = numbered.find(v => v.ep === targetEp);
            if (exact) return exact;
          }

          // When multi-ep is allowed, check if targetEp appears anywhere in an SxxExx...Exx chain
          // (handles separators like dots/dashes between chained episode numbers)
          if (allowMultiEp) {
            const teStr = targetEp.toString().padStart(2, '0');
            const epInChain = new RegExp(`S\\d+(?:[. _-]?E\\d+|-\\d{1,2})*(?:[. _-]?E${teStr}|-${teStr})(?!\\d)`, 'i');
            const chainMatch = videos.find(v => epInChain.test(v.path));
            if (chainMatch) return chainMatch;
          }

          // Check if target episode only exists in a combined multi-episode file
          if (!allowMultiEp) {
            const te = targetEp.toString().padStart(2, '0');
            const multiEpRegex = new RegExp(
              `E${te}(?:[. _-]?E\\d+|-\\d{1,2}(?!\\d))|E\\d+(?:[. _-]?E${te}|-${te}(?!\\d))`, 'i'
            );
            if (videos.some(v => multiEpRegex.test(v.path.split('/').pop() || ''))) {
              throw nzbdavError(MULTI_EPISODE_BLOCKED_ERROR, false, true);
            }
          }

          // Season pack with multiple episodes but can't identify the file --
          // return null to signal ambiguity; waitForVideoFile will throw "not found"
          if (videos.length > 1) {
            return null;
          }
        }
      }

      // Default: return largest video (movies / single-file NZBs / no episode pattern)
      videos.sort((a, b) => b.size - a.size);
      return videos[0];
    }

    // Recurse into subdirectories
    for (const item of items) {
      if (item.type === 'directory') {
        const dirLower = item.filename.toLowerCase();
        if (!dirLower.includes('/sample') && !dirLower.includes('/subs')) {
          const found = await findVideoFile(client, item.filename, depth + 1, episodePattern, episodesInSeason);
          if (found) return found;
        }
      }
    }
  } catch (err) {
    if ((err as any).isNzbdavFailure) throw err;

    // Fallback: dirPath might be a flat file, not a directory.
    // NZBDav stores single-file releases at /content/<cat>/<title> directly when
    // the submitted nzbname carries a video extension. PROPFIND with Depth: 1 then
    // 404s, and /.ids/<nzo_id> returns a doubled path the proxy can't serve —
    // probe the path itself before giving up.
    try {
      const stat = await client.stat(dirPath, {
        signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
      }) as FileStat;
      if (stat.type === 'file' && stat.size && stat.size >= minFileSize) {
        if (episodePattern && !new RegExp(episodePattern, 'i').test(dirPath)) return null;
        return { path: dirPath, size: stat.size };
      }
    } catch (statErr) {
      if ((statErr as any).isNzbdavFailure) throw statErr;
    }
  }

  return null;
}

/**
 * Find video file in WebDAV after job completion.
 * Single scan — job completion is confirmed before this runs.
 */
export async function waitForVideoFile(
  nzoId: string,
  title: string,
  config: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
  logPrefix = '',
): Promise<{ path: string; size: number }> {
  const client = getWebdavClient(config);
  const category = resolveCategory(config, contentType);
  const paths = [
    `/content/${category}/${title}`,
    `/.ids/${nzoId}`,
  ];

  console.log(`${logPrefix}  \u{1F50D} Looking for video file...`);

  for (const p of paths) {
    const video = await findVideoFile(client, p, 0, episodePattern, episodesInSeason);
    if (video) {
      const sizeMB = Math.round(video.size / 1024 / 1024);
      console.log(`${logPrefix}  \u2705 Video found: ${video.path} (${sizeMB}MB)`);
      return video;
    }
  }

  console.log(`${logPrefix}  ❌ Video file not found in WebDAV after job completed`);
  throw nzbdavError('Video file not found in WebDAV after job completed');
}

/**
 * Check if a video file already exists in the NZBDav library (WebDAV).
 * Returns StreamData if found, null if not present.
 */
export async function checkNzbLibrary(
  title: string,
  config: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
  logPrefix = '',
  quiet = false,
): Promise<StreamData | null> {
  const client = getWebdavClient(config);
  const category = resolveCategory(config, contentType);
  const dirPath = `/content/${category}/${title}`;

  if (!quiet) console.log(`${logPrefix}\u{1F4DA} NZB library check: ${category}/${title}${episodePattern ? ` (${episodePattern})` : ''}`);

  try {
    const video = await findVideoFile(client, dirPath, 0, episodePattern, episodesInSeason);
    if (video) {
      const sizeMB = Math.round(video.size / 1024 / 1024);

      // Probe: verify the file is actually servable (not corrupted/gone)
      const webdavBase = (config.webdavUrl || config.url).replace(/\/+$/, '');
      const probeUrl = `${webdavBase}${encodeWebdavPath(video.path)}`;
      const probeHeaders: Record<string, string> = { 'Range': 'bytes=0-0' };
      if (config.webdavUser && config.webdavPassword) {
        probeHeaders['Authorization'] = 'Basic ' + Buffer.from(`${config.webdavUser}:${config.webdavPassword}`).toString('base64');
      }
      try {
        const probeResp = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(10_000) });
        await probeResp.body?.cancel().catch(() => {});
        if (probeResp.status === 404 || probeResp.status === 410) {
          if (!quiet) console.log(`${logPrefix}📚 Library HIT but file not servable (${probeResp.status}) — treating as miss`);
          return null;
        }
        if (probeResp.status !== 200 && probeResp.status !== 206) {
          if (!quiet) console.warn(`${logPrefix}📚 Library probe returned ${probeResp.status} — treating as miss`);
          return null;
        }
      } catch (probeErr) {
        if (!quiet) console.warn(`${logPrefix}📚 Library probe failed (${(probeErr as Error).message}) — treating as miss`);
        return null;
      }

      if (!quiet) console.log(`${logPrefix}📚 Library HIT - skipping indexer grab: ${video.path} (${sizeMB}MB)`);
      return {
        nzoId: 'library',
        videoPath: video.path,
        videoSize: video.size,
      };
    }
  } catch (err) {
    if ((err as any).isNzbdavFailure) throw err;
    if (!quiet) console.log(`${logPrefix}\u{1F4DA} Library check error (non-fatal): ${(err as Error).message}`);
  }

  if (!quiet) console.log(`${logPrefix}\u{1F4DA} Library MISS - will grab NZB from indexer`);
  return null;
}

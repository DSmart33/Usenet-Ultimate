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
import { encodeWebdavPath, nzbdavError } from './utils.js';

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
        // Try exact SxxExx pattern match first
        const pattern = new RegExp(episodePattern, 'i');
        const match = videos.find(v => pattern.test(v.path));
        if (match) return match;

        // Extract the episode number from the pattern (e.g. "S03E01" -> 1)
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
          const epRegex = /S\d+E(\d+)(?!\d|[. _-]?E\d)/i;
          const numbered = videos
            .map(v => ({ ...v, ep: parseInt((v.path.match(epRegex)?.[1] || '0'), 10) }))
            .filter(v => v.ep > 0);
          if (numbered.length > 0) {
            const exact = numbered.find(v => v.ep === targetEp);
            if (exact) return exact;
          }

          // Check if target episode only exists in a combined multi-episode file
          const te = targetEp.toString().padStart(2, '0');
          const multiEpRegex = new RegExp(
            `E${te}[. _-]?E\\d+|E\\d+[. _-]?E${te}`, 'i'
          );
          if (videos.some(v => multiEpRegex.test(v.path.split('/').pop() || ''))) {
            throw nzbdavError('Episode only found in combined multi-episode file');
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
    // Directory doesn't exist yet, that's ok
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
  episodesInSeason?: number
): Promise<{ path: string; size: number }> {
  const client = getWebdavClient(config);
  const category = resolveCategory(config, contentType);
  const paths = [
    `/content/${category}/${title}`,
    `/.ids/${nzoId}`,
  ];

  console.log(`  \u{1F50D} Looking for video file...`);

  for (const p of paths) {
    const video = await findVideoFile(client, p, 0, episodePattern, episodesInSeason);
    if (video) {
      const sizeMB = Math.round(video.size / 1024 / 1024);
      console.log(`  \u2705 Video found: ${video.path} (${sizeMB}MB)`);
      return video;
    }
  }

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
  episodesInSeason?: number
): Promise<StreamData | null> {
  const client = getWebdavClient(config);
  const category = resolveCategory(config, contentType);
  const dirPath = `/content/${category}/${title}`;

  console.log(`\u{1F4DA} NZB library check: ${category}/${title}${episodePattern ? ` (${episodePattern})` : ''}`);

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
          console.log(`📚 Library HIT but file not servable (${probeResp.status}) — treating as miss`);
          return null;
        }
        if (probeResp.status !== 200 && probeResp.status !== 206) {
          console.warn(`📚 Library probe returned ${probeResp.status} — treating as miss`);
          return null;
        }
      } catch (probeErr) {
        console.warn(`📚 Library probe failed (${(probeErr as Error).message}) — treating as miss`);
        return null;
      }

      console.log(`📚 Library HIT - skipping indexer grab: ${video.path} (${sizeMB}MB)`);
      return {
        nzoId: 'library',
        videoPath: video.path,
        videoSize: video.size,
      };
    }
  } catch (err) {
    if ((err as any).isNzbdavFailure) throw err;
    console.log(`\u{1F4DA} Library check error (non-fatal): ${(err as Error).message}`);
  }

  console.log(`\u{1F4DA} Library MISS - will grab NZB from indexer`);
  return null;
}

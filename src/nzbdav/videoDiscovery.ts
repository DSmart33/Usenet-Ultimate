/**
 * Video File Discovery
 * WebDAV directory traversal and video file pattern matching.
 * Finds video files in download directories, with support for episode matching
 * in season packs and BDMV Blu-ray structures.
 */

import { createClient, FileStat } from 'webdav';
import { extractDiscNumber } from '../parsers/bdmvParser.js';
import { resolveBdmvEpisode, resolveMultiDiscBdmvEpisode } from './bdmvResolver.js';
import { getWebdavClient } from './webdavClient.js';
import { resolveCategory } from './nzbdavApi.js';
import type { NZBDavConfig, StreamData } from './types.js';

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

  const videoExts = ['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.m2ts', '.wmv', '.webm', '.mpg', '.mpeg'];
  const minFileSize = 100 * 1024 * 1024; // 100MB minimum

  try {
    const items = await client.getDirectoryContents(dirPath) as FileStat[];

    // BDMV detection: check if this directory contains or IS a BDMV structure
    if (episodePattern) {
      // Check if current directory IS the BDMV directory
      const currentDirName = (dirPath.split('/').filter(Boolean).pop() || '').toUpperCase();
      if (currentDirName === 'BDMV') {
        const parentPath = dirPath.split('/').slice(0, -1).join('/');
        const bdmvResult = await resolveBdmvEpisode(client, dirPath, episodePattern, parentPath);
        if (bdmvResult) return bdmvResult;
      }

      // Check if any child directory is named BDMV (single-disc)
      const bdmvDir = items.find(
        item => item.type === 'directory' &&
                (item.filename.split('/').filter(Boolean).pop() || '').toUpperCase() === 'BDMV'
      );
      if (bdmvDir) {
        const bdmvResult = await resolveBdmvEpisode(client, bdmvDir.filename, episodePattern, dirPath);
        if (bdmvResult) return bdmvResult;
        // BDMV resolution failed -- fall through to existing video file matching
      }

      // Multi-disc detection: check if child directories are disc folders (S04D01, Disc1, etc.)
      // each containing their own BDMV -- common for complete season Blu-ray sets
      if (!bdmvDir) {
        const discDirs: Array<{ path: string; dirname: string; discNumber: number }> = [];
        for (const item of items) {
          if (item.type === 'directory') {
            const dirname = item.filename.split('/').filter(Boolean).pop() || '';
            const discNum = extractDiscNumber(dirname);
            if (discNum !== undefined) {
              discDirs.push({ path: item.filename, dirname, discNumber: discNum });
            }
          }
        }

        if (discDirs.length >= 2) {
          discDirs.sort((a, b) => a.discNumber - b.discNumber);
          const multiResult = await resolveMultiDiscBdmvEpisode(client, discDirs, episodePattern, episodesInSeason);
          if (multiResult) return multiResult;
          // Multi-disc resolution failed -- fall through to existing logic
        }
      }
    }

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
          const epRegex = /S\d+E(\d+)/i;
          const numbered = videos
            .map(v => ({ ...v, ep: parseInt((v.path.match(epRegex)?.[1] || '0'), 10) }))
            .filter(v => v.ep > 0);
          if (numbered.length > 0) {
            const exact = numbered.find(v => v.ep === targetEp);
            if (exact) return exact;
          }

          // Season pack with episode pattern but can't identify the file --
          // return null so waitForVideoFile keeps polling instead of playing the wrong episode
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
    // Directory doesn't exist yet, that's ok
  }

  return null;
}

/**
 * Wait for video file to appear in WebDAV
 */
export async function waitForVideoFile(
  nzoId: string,
  title: string,
  config: NZBDavConfig,
  timeoutMs = 30000,
  pollIntervalMs = 2000,
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

  const startTime = Date.now();
  console.log(`  \u{1F50D} Looking for video file...`);

  while (Date.now() - startTime < timeoutMs) {
    for (const p of paths) {
      const video = await findVideoFile(client, p, 0, episodePattern, episodesInSeason);
      if (video) {
        const sizeMB = Math.round(video.size / 1024 / 1024);
        console.log(`  \u2705 Video found: ${video.path} (${sizeMB}MB)`);
        return video;
      }
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  const error = new Error('Video file not found after job completed') as Error & { isNzbdavFailure: boolean };
  error.isNzbdavFailure = true;
  throw error;
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
      console.log(`\u{1F4DA} Library HIT - skipping indexer grab: ${video.path} (${sizeMB}MB)`);
      return {
        nzoId: 'library',
        videoPath: video.path,
        videoSize: video.size,
      };
    }
  } catch (err) {
    console.log(`\u{1F4DA} Library check error (non-fatal): ${(err as Error).message}`);
  }

  console.log(`\u{1F4DA} Library MISS - will grab NZB from indexer`);
  return null;
}

/**
 * BDMV Episode Resolver
 * Resolves target episodes from Blu-ray Disc (BDMV) directory structures.
 * Downloads and parses .mpls playlist files to map episodes to .m2ts clips.
 * Supports single-disc and multi-disc season pack Blu-ray sets.
 */

import { createClient, FileStat } from 'webdav';
import { parseMpls, buildEpisodeMap, resolveEpisode, type BdmvEpisodeMap } from '../parsers/bdmvParser.js';
import { WEBDAV_REQUEST_TIMEOUT_MS } from './types.js';

// Cache parsed BDMV episode maps to avoid re-downloading/parsing MPLS files on every poll
const bdmvMapCache = new Map<string, { map: BdmvEpisodeMap; timestamp: number }>();
const BDMV_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve a target episode from a BDMV directory structure.
 * Downloads and parses .mpls playlist files to map episodes to .m2ts clips.
 *
 * @param client - WebDAV client
 * @param bdmvPath - Path to the BDMV directory (e.g., "/content/TV/title/BDMV")
 * @param episodePattern - Episode pattern like "S04[. _-]?E15"
 * @param titlePath - Parent directory path (used for disc number extraction)
 */
export async function resolveBdmvEpisode(
  client: ReturnType<typeof createClient>,
  bdmvPath: string,
  episodePattern: string,
  titlePath: string
): Promise<{ path: string; size: number } | null> {
  try {
    // Extract target episode number from pattern
    const epMatch = episodePattern.match(/E(\d+)/i);
    if (!epMatch) return null;
    const targetEpisode = parseInt(epMatch[1], 10);

    // Check cache first
    const cached = bdmvMapCache.get(bdmvPath);
    let episodeMap: BdmvEpisodeMap;

    if (cached && Date.now() - cached.timestamp < BDMV_CACHE_TTL_MS) {
      episodeMap = cached.map;
    } else {
      // List playlist directory
      const playlistDir = `${bdmvPath}/PLAYLIST`;
      let playlistItems: FileStat[];
      try {
        playlistItems = await client.getDirectoryContents(playlistDir, {
          signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
        }) as FileStat[];
      } catch {
        console.warn(`  [bdmv] No PLAYLIST directory found in ${bdmvPath}`);
        return null;
      }

      const mplsFiles = playlistItems.filter(
        f => f.type === 'file' && f.filename.toLowerCase().endsWith('.mpls')
      );

      if (mplsFiles.length === 0) {
        console.warn(`  [bdmv] No .mpls files found in ${playlistDir}`);
        return null;
      }

      // Download and parse each MPLS file
      const playlists = [];
      for (const mplsFile of mplsFiles) {
        try {
          const data = await client.getFileContents(mplsFile.filename, {
            signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
          }) as Buffer;
          const parsed = parseMpls(data, mplsFile.filename.split('/').pop() || '');
          if (parsed) playlists.push(parsed);
        } catch (err) {
          // Individual MPLS parse failure is non-fatal
          console.warn(`  [bdmv] Failed to read ${mplsFile.filename}: ${(err as Error).message}`);
        }
      }

      if (playlists.length === 0) {
        console.warn(`  [bdmv] No valid MPLS playlists parsed`);
        return null;
      }

      // Build episode map using the title directory name for disc number extraction
      const dirTitle = titlePath.split('/').filter(Boolean).pop() || '';
      episodeMap = buildEpisodeMap(playlists, dirTitle);

      // Cache it
      bdmvMapCache.set(bdmvPath, { map: episodeMap, timestamp: Date.now() });

      // Log the episode map
      console.log(`  [bdmv] Found ${episodeMap.filteredCount} episodes from ${episodeMap.allPlaylists} playlists` +
        (episodeMap.discNumber ? ` (disc ${episodeMap.discNumber})` : ''));
      for (const ep of episodeMap.episodes) {
        const mins = Math.round(ep.durationSeconds / 60);
        console.log(`  [bdmv]   ${ep.playlistFile}: ${mins}min \u2192 ${ep.primaryClip}.m2ts`);
      }
    }

    if (episodeMap.episodes.length === 0) {
      console.warn(`  [bdmv] No episode-length playlists found`);
      return null;
    }

    // Resolve target episode to a clip
    const resolved = resolveEpisode(episodeMap, targetEpisode);
    if (!resolved) {
      console.warn(`  [bdmv] Could not resolve episode ${targetEpisode}`);
      return null;
    }

    console.log(`  [bdmv] Episode ${targetEpisode} \u2192 ${resolved.clipName}.m2ts (${resolved.method})`);

    // Find the actual .m2ts file in BDMV/STREAM/
    const streamDir = `${bdmvPath}/STREAM`;
    let streamItems: FileStat[];
    try {
      streamItems = await client.getDirectoryContents(streamDir, {
        signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
      }) as FileStat[];
    } catch {
      console.warn(`  [bdmv] No STREAM directory found in ${bdmvPath}`);
      return null;
    }

    const targetFilename = `${resolved.clipName}.m2ts`.toLowerCase();
    const targetFile = streamItems.find(
      f => f.type === 'file' && (f.filename.split('/').pop() || '').toLowerCase() === targetFilename
    );

    if (targetFile && targetFile.size) {
      const sizeMB = Math.round(targetFile.size / 1024 / 1024);
      console.log(`  [bdmv] \u2705 Found ${targetFile.filename} (${sizeMB}MB)`);
      return { path: targetFile.filename, size: targetFile.size };
    }

    console.warn(`  [bdmv] \u26A0\uFE0F .m2ts file not found for clip ${resolved.clipName}`);
    return null;
  } catch (err) {
    console.warn(`  [bdmv] Error resolving episode: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve a target episode from a multi-disc BDMV set.
 * Parses all discs' playlists, builds a cumulative episode map, and resolves
 * the target episode to the correct disc + position.
 *
 * @param client - WebDAV client
 * @param discDirs - Disc directories sorted by disc number
 * @param episodePattern - Episode pattern like "S04[. _-]?E15"
 */
export async function resolveMultiDiscBdmvEpisode(
  client: ReturnType<typeof createClient>,
  discDirs: Array<{ path: string; dirname: string; discNumber: number }>,
  episodePattern: string,
  episodesInSeason?: number
): Promise<{ path: string; size: number } | null> {
  const epMatch = episodePattern.match(/E(\d+)/i);
  if (!epMatch) return null;
  const targetEpisode = parseInt(epMatch[1], 10);

  console.log(`  [bdmv] Multi-disc set detected: ${discDirs.length} discs`);

  // For each disc, find its BDMV and parse episode playlists
  const discs: Array<{
    discNumber: number;
    bdmvPath: string;
    episodeMap: BdmvEpisodeMap;
  }> = [];

  for (const disc of discDirs) {
    const bdmvPath = `${disc.path}/BDMV`;

    try {
      // Check cache first
      const cached = bdmvMapCache.get(bdmvPath);
      let episodeMap: BdmvEpisodeMap;

      if (cached && Date.now() - cached.timestamp < BDMV_CACHE_TTL_MS) {
        episodeMap = cached.map;
      } else {
        const playlistDir = `${bdmvPath}/PLAYLIST`;
        let playlistItems: FileStat[];
        try {
          playlistItems = await client.getDirectoryContents(playlistDir, {
            signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
          }) as FileStat[];
        } catch {
          continue; // No PLAYLIST dir -- not a valid BDMV disc
        }

        const mplsFiles = playlistItems.filter(
          f => f.type === 'file' && f.filename.toLowerCase().endsWith('.mpls')
        );
        if (mplsFiles.length === 0) continue;

        const playlists = [];
        for (const mplsFile of mplsFiles) {
          try {
            const data = await client.getFileContents(mplsFile.filename, {
              signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
            }) as Buffer;
            const parsed = parseMpls(data, mplsFile.filename.split('/').pop() || '');
            if (parsed) playlists.push(parsed);
          } catch {}
        }
        if (playlists.length === 0) continue;

        // Don't pass title -- disc numbering is managed by the caller
        episodeMap = buildEpisodeMap(playlists);
        bdmvMapCache.set(bdmvPath, { map: episodeMap, timestamp: Date.now() });
      }

      if (episodeMap.episodes.length > 0) {
        discs.push({ discNumber: disc.discNumber, bdmvPath, episodeMap });
      }
    } catch {
      // Skip discs that can't be read
    }
  }

  if (discs.length === 0) return null;

  // Sort by disc number
  discs.sort((a, b) => a.discNumber - b.discNumber);

  // TMDB calibration: if we know the season's episode count, trim excess playlists
  const totalFound = discs.reduce((sum, d) => sum + d.episodeMap.episodes.length, 0);
  if (episodesInSeason && totalFound > episodesInSeason) {
    console.log(`  [bdmv] TMDB calibration: found ${totalFound} playlists but season has ${episodesInSeason} episodes \u2014 trimming ${totalFound - episodesInSeason}`);

    // Compute global median duration across all discs
    const allDurations = discs.flatMap(d => d.episodeMap.episodes.map(ep => ep.durationSeconds));
    allDurations.sort((a, b) => a - b);
    const globalMedian = allDurations[Math.floor(allDurations.length / 2)];

    // Tag every episode with its deviation from the global median
    const tagged: Array<{ disc: typeof discs[0]; ep: typeof discs[0]['episodeMap']['episodes'][0]; deviation: number }> = [];
    for (const disc of discs) {
      for (const ep of disc.episodeMap.episodes) {
        tagged.push({ disc, ep, deviation: Math.abs(ep.durationSeconds - globalMedian) });
      }
    }

    // Sort by deviation descending -- highest deviation = most likely an extra
    tagged.sort((a, b) => b.deviation - a.deviation);

    // Mark the top N for removal
    const toRemove = totalFound - episodesInSeason;
    const removeSet = new Set(tagged.slice(0, toRemove).map(t => t.ep));

    // Remove from each disc (create new arrays, don't mutate cached maps)
    for (const disc of discs) {
      const original = disc.episodeMap.episodes;
      const filtered = original.filter(ep => !removeSet.has(ep));
      if (filtered.length !== original.length) {
        const removed = original.filter(ep => removeSet.has(ep));
        for (const r of removed) {
          const dev = Math.round(Math.abs(r.durationSeconds - globalMedian) / 60);
          console.log(`  [bdmv]   Trimmed disc ${disc.discNumber}: ${r.playlistFile} (${Math.round(r.durationSeconds / 60)}min, ${dev}min from median)`);
        }
        disc.episodeMap = { ...disc.episodeMap, episodes: filtered, filteredCount: filtered.length };
      }
    }
  } else if (episodesInSeason) {
    console.log(`  [bdmv] TMDB calibration: ${totalFound} playlists matches ${episodesInSeason} episodes \u2014 no trimming needed`);
  }

  // Build cumulative episode map and find the target disc
  let cumulativeEpisode = 0;
  let targetDisc: typeof discs[0] | null = null;
  let positionOnDisc = -1;

  console.log(`  [bdmv] Multi-disc episode layout:`);
  for (const disc of discs) {
    const startEp = cumulativeEpisode + 1;
    const endEp = cumulativeEpisode + disc.episodeMap.episodes.length;
    console.log(`  [bdmv]   Disc ${disc.discNumber}: episodes ${startEp}-${endEp} (${disc.episodeMap.filteredCount} eps from ${disc.episodeMap.allPlaylists} playlists)`);
    for (const ep of disc.episodeMap.episodes) {
      const mins = Math.round(ep.durationSeconds / 60);
      console.log(`  [bdmv]     ${ep.playlistFile}: ${mins}min \u2192 ${ep.primaryClip}.m2ts`);
    }

    if (!targetDisc && targetEpisode >= startEp && targetEpisode <= endEp) {
      targetDisc = disc;
      positionOnDisc = targetEpisode - startEp; // 0-based
    }

    cumulativeEpisode = endEp;
  }

  if (!targetDisc || positionOnDisc < 0) {
    console.warn(`  [bdmv] Episode ${targetEpisode} not found in multi-disc set (total: ${cumulativeEpisode} episodes)`);
    return null;
  }

  const episode = targetDisc.episodeMap.episodes[positionOnDisc];
  console.log(`  [bdmv] Episode ${targetEpisode} \u2192 disc ${targetDisc.discNumber}, ` +
    `position ${positionOnDisc + 1}/${targetDisc.episodeMap.episodes.length} \u2192 ${episode.primaryClip}.m2ts`);

  // Find the .m2ts file in the target disc's STREAM directory
  const streamDir = `${targetDisc.bdmvPath}/STREAM`;
  try {
    const streamItems = await client.getDirectoryContents(streamDir, {
      signal: AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS),
    }) as FileStat[];
    const targetFilename = `${episode.primaryClip}.m2ts`.toLowerCase();
    const targetFile = streamItems.find(
      f => f.type === 'file' && (f.filename.split('/').pop() || '').toLowerCase() === targetFilename
    );

    if (targetFile && targetFile.size) {
      const sizeMB = Math.round(targetFile.size / 1024 / 1024);
      console.log(`  [bdmv] \u2705 Found ${targetFile.filename} (${sizeMB}MB)`);
      return { path: targetFile.filename, size: targetFile.size };
    }
  } catch {}

  console.warn(`  [bdmv] \u26A0\uFE0F .m2ts file not found for clip ${episode.primaryClip} on disc ${targetDisc.discNumber}`);
  return null;
}

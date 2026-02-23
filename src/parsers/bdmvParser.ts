/**
 * BDMV/MPLS Parser for Blu-ray Disc Episode Mapping
 *
 * Parses .mpls (Movie PlayList) binary files to map episodes to specific .m2ts
 * stream files. Used to resolve which .m2ts contains a specific episode on
 * season-pack Blu-ray discs where filenames are just numbers (00000.m2ts, etc.).
 *
 * MPLS binary format (BD-ROM Part 3):
 *   Header: "MPLS" + version + PlayList offset + PlayListMark offset
 *   PlayList: count of PlayItems, each referencing a clip (.m2ts) with in/out timestamps
 *   Duration calculated from timestamps in 45kHz ticks
 */

const TICKS_PER_SECOND = 45000;

// ============================================================================
// Types
// ============================================================================

export interface MplsPlaylist {
  filename: string;          // e.g., "00001.mpls"
  playlistNumber: number;    // e.g., 1
  durationSeconds: number;   // total duration in seconds
  clips: MplsClip[];         // referenced .m2ts clips
}

export interface MplsClip {
  clipName: string;          // e.g., "00001" (→ BDMV/STREAM/00001.m2ts)
  inTime: number;            // 45kHz ticks
  outTime: number;           // 45kHz ticks
  durationSeconds: number;   // (outTime - inTime) / 45000
}

export interface BdmvEpisodeMap {
  episodes: BdmvEpisode[];   // Ordered episode list (position = disc order)
  discNumber?: number;       // Extracted from title, if available
  allPlaylists: number;      // Total playlists parsed
  filteredCount: number;     // Playlists after filtering to episode-length
}

export interface BdmvEpisode {
  playlistFile: string;      // e.g., "00011.mpls"
  durationSeconds: number;
  primaryClip: string;       // Main .m2ts file (longest clip in playlist)
  allClips: string[];        // All .m2ts files referenced
}

export interface ResolvedEpisode {
  clipName: string;          // e.g., "00013"
  episodeIndex: number;      // 0-based position on disc
  method: string;            // Human-readable explanation of how it was resolved
}

// ============================================================================
// MPLS Binary Parser
// ============================================================================

/**
 * Parse an MPLS binary file buffer into structured playlist data.
 *
 * MPLS layout:
 *   Bytes 0-3:   "MPLS" magic
 *   Bytes 4-7:   Version ("0100", "0200", "0300")
 *   Bytes 8-11:  PlayList_start_address (uint32 BE)
 *   Bytes 12-15: PlayListMark_start_address (uint32 BE)
 *
 * PlayList section (at PlayList_start_address):
 *   Bytes 0-3:   length (uint32 BE)
 *   Bytes 4-5:   reserved
 *   Bytes 6-7:   number_of_PlayItems (uint16 BE)
 *   Bytes 8-9:   number_of_SubPaths (uint16 BE)
 *
 * Each PlayItem (after 2-byte length field):
 *   +0:  Clip_Information_file_name (5 ASCII chars, e.g., "00001")
 *   +5:  Clip_codec_identifier (4 ASCII chars, "M2TS")
 *   +9:  flags (2 bytes)
 *   +11: ref_to_STC_id (1 byte)
 *   +12: IN_time (uint32 BE, 45kHz ticks)
 *   +16: OUT_time (uint32 BE, 45kHz ticks)
 */
export function parseMpls(data: Buffer, filename: string): MplsPlaylist | null {
  try {
    if (data.length < 20) return null;

    // Validate magic bytes
    const magic = data.toString('ascii', 0, 4);
    if (magic !== 'MPLS') return null;

    // Validate version
    const version = data.toString('ascii', 4, 8);
    if (!['0100', '0200', '0300'].includes(version)) return null;

    // PlayList_start_address
    const playListStart = data.readUInt32BE(8);
    if (playListStart + 10 > data.length) return null;

    // PlayList section header
    const numPlayItems = data.readUInt16BE(playListStart + 6);
    if (numPlayItems === 0) return null;

    const clips: MplsClip[] = [];
    let offset = playListStart + 10; // First PlayItem starts here

    for (let i = 0; i < numPlayItems && offset + 2 < data.length; i++) {
      const itemLength = data.readUInt16BE(offset);
      if (itemLength < 20 || offset + 2 + itemLength > data.length) break;

      const itemStart = offset + 2; // Skip the 2-byte length field

      // Clip name: 5 ASCII chars
      const clipName = data.toString('ascii', itemStart, itemStart + 5);

      // IN_time and OUT_time: uint32 BE at offsets +12 and +16 from itemStart
      const inTime = data.readUInt32BE(itemStart + 12);
      const outTime = data.readUInt32BE(itemStart + 16);
      const durationSeconds = (outTime - inTime) / TICKS_PER_SECOND;

      clips.push({ clipName, inTime, outTime, durationSeconds });

      // Advance to next PlayItem
      offset += 2 + itemLength;
    }

    if (clips.length === 0) return null;

    const totalDuration = clips.reduce((sum, c) => sum + c.durationSeconds, 0);

    // Extract playlist number from filename (e.g., "00011.mpls" → 11)
    const numMatch = filename.match(/(\d+)\.mpls$/i);
    const playlistNumber = numMatch ? parseInt(numMatch[1], 10) : 0;

    return {
      filename,
      playlistNumber,
      durationSeconds: totalDuration,
      clips,
    };
  } catch (err) {
    console.warn(`  [bdmv] Failed to parse MPLS ${filename}: ${(err as Error).message}`);
    return null;
  }
}

// ============================================================================
// Episode Filtering
// ============================================================================

/**
 * Filter parsed playlists to identify episode playlists.
 *
 * Strategy:
 * 1. Count references per primary clip BEFORE dedup — episodes have multiple
 *    playlist variants (main + commentary), extras usually have just 1
 * 2. Deduplicate playlists referencing identical clip sets (BD discs often have
 *    multiple playlists for the same content with different audio/subtitle configs)
 * 3. Deduplicate by primary clip — commentary/alternate audio playlists reference
 *    the same .m2ts video file, keep only the lowest-numbered playlist per clip
 * 4. Remove very short playlists (<5 min — menus, bumpers)
 * 5. Remove duration outliers relative to median (when 3+ playlists):
 *    - Too short (<60% of median — extras, featurettes)
 *    - Too long (>2.5x median — "play all" playlists)
 * 6. Remove low-reference clips — if most clips have 2+ playlist variants,
 *    clips with only 1 reference are likely extras without commentary tracks
 * 7. Sort remaining by playlist number (episode order on disc)
 */
function filterEpisodePlaylists(playlists: MplsPlaylist[]): MplsPlaylist[] {
  if (playlists.length === 0) return [];

  // Step 1: Count references per primary clip BEFORE any deduplication
  // Real episodes typically have 2+ playlist variants (main + commentary),
  // while extras/featurettes usually have only 1 playlist
  const primaryClipRefCount = new Map<string, number>();
  for (const pl of playlists) {
    const primary = pl.clips.reduce((longest, c) =>
      c.durationSeconds > longest.durationSeconds ? c : longest
    ).clipName;
    primaryClipRefCount.set(primary, (primaryClipRefCount.get(primary) || 0) + 1);
  }

  // Step 2: Deduplicate by clip set (same clips with same timestamps = same content)
  const seen = new Map<string, MplsPlaylist>();
  for (const pl of playlists) {
    const key = pl.clips.map(c => `${c.clipName}:${c.inTime}-${c.outTime}`).join('|');
    // Keep the lower-numbered playlist (typically the "main" version)
    if (!seen.has(key) || pl.playlistNumber < seen.get(key)!.playlistNumber) {
      seen.set(key, pl);
    }
  }
  let unique = [...seen.values()];

  // Step 3: Deduplicate by primary clip (longest clip in each playlist)
  // Commentary/alt-audio playlists reference the same main .m2ts video file —
  // keeping only one playlist per primary clip eliminates these duplicates
  const byPrimaryClip = new Map<string, MplsPlaylist>();
  for (const pl of unique) {
    const primary = getPrimaryClip(pl);
    if (!byPrimaryClip.has(primary) || pl.playlistNumber < byPrimaryClip.get(primary)!.playlistNumber) {
      byPrimaryClip.set(primary, pl);
    }
  }
  unique = [...byPrimaryClip.values()];

  // Step 4: Remove very short playlists (< 5 minutes — menus, bumpers, logos)
  const MIN_EPISODE_SECONDS = 5 * 60;
  unique = unique.filter(pl => pl.durationSeconds >= MIN_EPISODE_SECONDS);

  if (unique.length === 0) return [];

  // Step 5: Remove duration outliers relative to median (when 3+ playlists)
  if (unique.length >= 3) {
    const sorted = [...unique].sort((a, b) => a.durationSeconds - b.durationSeconds);
    const median = sorted[Math.floor(sorted.length / 2)].durationSeconds;
    // Remove extras/featurettes (<60% of median) and "play all" playlists (>2.5x median)
    unique = unique.filter(pl =>
      pl.durationSeconds >= median * 0.6 && pl.durationSeconds < median * 2.5
    );
  }

  // Step 6: Remove low-reference clips when the disc has commentary tracks
  // If most clips have 2+ playlist variants, clips with only 1 are likely extras
  if (unique.length >= 3) {
    const refCounts = unique.map(pl => primaryClipRefCount.get(getPrimaryClip(pl)) || 1);
    const sortedRefs = [...refCounts].sort((a, b) => a - b);
    const medianRefs = sortedRefs[Math.floor(sortedRefs.length / 2)];

    // Only apply if the disc has commentary tracks (median refs > 1)
    if (medianRefs > 1) {
      const filtered = unique.filter(pl =>
        (primaryClipRefCount.get(getPrimaryClip(pl)) || 1) > 1
      );
      // Safety: don't remove everything — keep at least 2 episodes
      if (filtered.length >= 2) {
        unique = filtered;
      }
    }
  }

  // Step 7: Sort by playlist number for episode ordering
  unique.sort((a, b) => a.playlistNumber - b.playlistNumber);

  return unique;
}

/** Get the primary (longest) clip name from a playlist */
function getPrimaryClip(pl: MplsPlaylist): string {
  return pl.clips.reduce((longest, c) =>
    c.durationSeconds > longest.durationSeconds ? c : longest
  ).clipName;
}

// ============================================================================
// Disc Number Extraction
// ============================================================================

/**
 * Extract disc number from a release title or directory name.
 *
 * Handles patterns (checked in priority order):
 *   "S04D01"             → disc 1  (season+disc, most reliable)
 *   "Disc 3" / "Disc.3"  → disc 3
 *   "-D3-" / ".D3."      → disc 3  (standalone disc indicator)
 */
export function extractDiscNumber(title: string): number | undefined {
  // Pattern: "S04D01" or "S04D1" — season+disc format (most reliable for BD sets)
  const sdMatch = title.match(/S\d+D(\d+)/i);
  if (sdMatch) {
    const n = parseInt(sdMatch[1], 10);
    if (n >= 1 && n <= 20) return n;
  }

  // Pattern: "Disc N" / "Disc.N" / "DISC_N" / "Disc-N"
  const discMatch = title.match(/disc[. _-]?(\d+)/i);
  if (discMatch) {
    const n = parseInt(discMatch[1], 10);
    if (n >= 1 && n <= 20) return n;
  }

  // Pattern: "-D3-" or ".D3." (standalone disc indicator, not at end of string)
  const dMatch = title.match(/[.-]D(\d+)[.-]/i);
  if (dMatch) {
    const n = parseInt(dMatch[1], 10);
    if (n >= 1 && n <= 20) return n;
  }

  return undefined;
}

// ============================================================================
// Episode Map Builder
// ============================================================================

/**
 * Build an episode map from parsed MPLS playlists.
 *
 * @param playlists - All parsed MPLS playlists from the disc
 * @param discTitle - Optional release title for disc number extraction
 */
export function buildEpisodeMap(playlists: MplsPlaylist[], discTitle?: string): BdmvEpisodeMap {
  const episodes = filterEpisodePlaylists(playlists);
  const discNumber = discTitle ? extractDiscNumber(discTitle) : undefined;

  return {
    episodes: episodes.map(pl => ({
      playlistFile: pl.filename,
      durationSeconds: pl.durationSeconds,
      // Primary clip = the longest clip in the playlist
      primaryClip: pl.clips.reduce((longest, c) =>
        c.durationSeconds > longest.durationSeconds ? c : longest
      ).clipName,
      allClips: [...new Set(pl.clips.map(c => c.clipName))],
    })),
    discNumber,
    allPlaylists: playlists.length,
    filteredCount: episodes.length,
  };
}

// ============================================================================
// Episode Resolution
// ============================================================================

/**
 * Resolve a target episode number to a .m2ts clip name on this disc.
 *
 * For multi-disc sets (disc number known):
 *   1. Estimate disc offset: (discNumber - 1) * episodesOnDisc
 *   2. Calculate position: targetEpisode - offset - 1
 *   3. If out of range, fall back to modulo
 *
 * For single-disc or unknown disc number:
 *   1. Direct index if targetEpisode <= episodeCount
 *   2. Modulo fallback otherwise
 */
export function resolveEpisode(
  map: BdmvEpisodeMap,
  targetEpisode: number
): ResolvedEpisode | null {
  if (map.episodes.length === 0 || targetEpisode < 1) return null;

  const N = map.episodes.length;
  const D = map.discNumber;

  // With disc number: try offset-based calculation
  if (D !== undefined && D > 0) {
    const offset = (D - 1) * N;
    const position = targetEpisode - offset - 1;

    if (position >= 0 && position < N) {
      return {
        clipName: map.episodes[position].primaryClip,
        episodeIndex: position,
        method: `disc ${D} offset (ep ${targetEpisode} → position ${position + 1}/${N})`,
      };
    }

    // Offset didn't work (disc sizes aren't uniform) — fall back to modulo
    const modPosition = (targetEpisode - 1) % N;
    return {
      clipName: map.episodes[modPosition].primaryClip,
      episodeIndex: modPosition,
      method: `modulo fallback (ep ${targetEpisode} % ${N} → position ${modPosition + 1}/${N})`,
    };
  }

  // No disc number — direct index or modulo
  if (targetEpisode <= N) {
    return {
      clipName: map.episodes[targetEpisode - 1].primaryClip,
      episodeIndex: targetEpisode - 1,
      method: `direct index (ep ${targetEpisode}/${N})`,
    };
  }

  const modPosition = (targetEpisode - 1) % N;
  return {
    clipName: map.episodes[modPosition].primaryClip,
    episodeIndex: modPosition,
    method: `modulo (ep ${targetEpisode} % ${N} → position ${modPosition + 1}/${N})`,
  };
}

/**
 * Library Search
 *
 * Live WebDAV directory scan that runs before indexer queries when
 * `librarySearchThreshold > 0`. If the scan returns ≥ threshold matches,
 * `addon/index.ts` short-circuits indexer/EasyNews queries entirely and
 * builds the result list from library hits alone.
 *
 * Mirrors the indexer text-search match conventions: token-set title match
 * with year disambiguation (no substring false-positives), `additionalTitles`
 * support for anime dual-title flow, and a four-tier episode-pattern fallback
 * (seasonal SxxExx → canonical absolute → TVDB cumulative → Cinemeta cumulative).
 *
 * Library-origin results carry `origin: 'library'` so downstream code (dedup,
 * stream handler, health checks, UF) routes them via fast paths that skip
 * NZB-specific work (submission, dead-NZB checks, getCacheKey URL parsing).
 */

import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import { getWebdavClient } from './webdavClient.js';
import { resolveCategory } from './nzbdavApi.js';
import { findVideoFile } from './videoDiscovery.js';
import {
  parseQuality, parseCodec, parseSource, parseAudioTag, parseVisualTag,
  parseEdition, parseReleaseGroup, parseLanguage, formatBytes,
} from '../parsers/metadataParsers.js';
import { buildEpisodePattern, buildDateEpisodePattern, folderCouldContainSeason } from './utils.js';
import { isTextSearchMatch } from '../parsers/titleMatching.js';
import type { SearchContext } from '../addon/searchOrchestrator.js';
import type { NZBDavConfig } from './types.js';
import type { RawResult } from '../types.js';
import type { FileStat } from 'webdav';

const SCAN_BUDGET_MS = 5_000;

/**
 * Scan the WebDAV library for files matching the search context.
 * Returns RawResult[] tagged origin='library'. Callers gate on threshold
 * vs results.length to decide whether to short-circuit the indexer flow.
 */
export async function searchLibrary(
  ctx: SearchContext,
  config: NZBDavConfig,
): Promise<RawResult[]> {
  const client = getWebdavClient(config);
  const category = resolveCategory(config, ctx.type === 'movie' ? 'movie' : 'series');
  const roots = [`/content/${category}`];
  // Picks up content the user has manually uploaded to NZBDav.
  if (config.scanUncategorized) roots.push('/content/uncategorized');
  const start = Date.now();
  const remaining = () => Math.max(100, SCAN_BUDGET_MS - (Date.now() - start));

  const dirsByRoot = await Promise.all(roots.map(async (r) => {
    try {
      return (await client.getDirectoryContents(r, {
        signal: AbortSignal.timeout(remaining()),
      })) as FileStat[];
    } catch {
      return [] as FileStat[];
    }
  }));
  const dirs = dirsByRoot.flat();
  if (dirs.length === 0) return [];

  // Reuse the indexer flow's title matcher so the library scan inherits the same
  // year disambiguation (parseYear correctly distinguishes resolution markers like
  // 1080p from years), stylized digit-letter detection, country codes, alt-titles,
  // miniseries keyword, and normalization rules. Title match preserves per-root
  // grouping so the log output can break results down by source folder.
  const matchesByRoot = roots.map((root, i) => ({
    root,
    matches: dirsByRoot[i].filter(d =>
      d.type === 'directory' && isTextSearchMatch(ctx.title, d.basename, ctx.year, ctx.country, ctx.additionalTitles, ctx.titleYear)
    ),
  }));
  const titleMatches = matchesByRoot.flatMap(g => g.matches);

  // Season pre-filter: title match alone doesn't bound the season — a Season-1
  // pack folder can match the show name but cannot contain S02E03 content.
  // Reject whole top-level folders that can't contain the requested season up
  // front, saving a PROPFIND each. findVideoFile applies the same check at
  // every recursion step, so per-season subdirectories inside a multi-season
  // pack are also skipped without entering them.
  const seasonRejected = new Set<string>();
  const toScan: FileStat[] = [];
  for (const d of titleMatches) {
    if (ctx.type === 'series' && ctx.season != null && !folderCouldContainSeason(d.basename, ctx.season)) {
      seasonRejected.add(d.filename);
    } else {
      toScan.push(d);
    }
  }

  // Multi-tier episode-pattern chain (mirrors the indexer text-search fallback
  // chain): seasonal SxxExx, then canonical absolute, TVDB-derived cumulative,
  // Cinemeta-derived cumulative. Each tier produces a pattern STRING fed into
  // findVideoFile; the function handles its own SxxExx / 3x01 / Episode-N alt
  // matching and ep-in-chain logic on top of whichever pattern we pass.
  const tierPatterns: string[] = [];
  if (ctx.type === 'series' && ctx.season != null && ctx.episode != null) {
    tierPatterns.push(buildEpisodePattern(ctx.season, ctx.episode, true));
    if (ctx.absoluteEpisodeNumber != null) {
      tierPatterns.push(`(?:^|[^a-z0-9])E${ctx.absoluteEpisodeNumber}(?!\\d)`);
    }
    if (ctx.tvdbPriorSeasonsCount != null) {
      tierPatterns.push(`(?:^|[^a-z0-9])E${ctx.tvdbPriorSeasonsCount + ctx.episode}(?!\\d)`);
    }
    if (ctx.priorSeasonsEpisodeCount != null) {
      tierPatterns.push(`(?:^|[^a-z0-9])E${ctx.priorSeasonsEpisodeCount + ctx.episode}(?!\\d)`);
    }
  }

  // For each title-matched top-level entry, delegate inner-file discovery to
  // findVideoFile (the same helper checkNzbLibrary uses at stream-time). It
  // recurses up to 6 levels deep, filters samples + min-size, and tries
  // multiple episode formats. We just feed it the tier patterns in order.
  // PROPFINDs run in parallel across matched entries — sequential 200-500ms
  // calls would burn the scan budget.
  const scanned = await Promise.all(toScan.map(async (entry) => {
    if (Date.now() - start >= SCAN_BUDGET_MS) return { entry, video: null as { path: string; size: number } | null };
    if (ctx.type === 'series' && tierPatterns.length > 0) {
      for (const pattern of tierPatterns) {
        try {
          // strictEpisodeMatch=true: title-matched dir alone doesn't prove the requested
          // episode is inside. Without strict mode, a folder containing a single mkv for
          // a different episode would be returned via findVideoFile's "largest video"
          // fallback. Library scan must reject that.
          const video = await findVideoFile(client, entry.filename, 0, pattern, ctx.episodesInSeason, true);
          if (video) return { entry, video };
        } catch {
          // findVideoFile only rethrows isNzbdavFailure; transient WebDAV blips fall through.
        }
      }
      return { entry, video: null };
    }
    if (ctx.type === 'movie') {
      try {
        const video = await findVideoFile(client, entry.filename, 0);
        if (video) return { entry, video };
      } catch {}
    }
    return { entry, video: null };
  }));

  // Self-contained logging: header + one line per title-matched entry, marked
  // ✓ (scanned, video found), ✗ (scanned, no video), or ⊘ (filtered by the
  // season pre-filter, never scanned). Iterates titleMatches in original order
  // so the listing reads as it appeared on WebDAV. Keeps the addon/index.ts
  // call site clean and lets a 3am log-only diagnosis see every directory the
  // scan considered, not just the matches.
  const epTag = ctx.season != null && ctx.episode != null
    ? ` S${String(ctx.season).padStart(2, '0')}E${String(ctx.episode).padStart(2, '0')}`
    : '';
  const yearTag = ctx.year ? ` (${ctx.year})` : '';
  const titleList = [ctx.title, ...(ctx.additionalTitles ?? [])].map(t => `"${t}"`).join(' / ');
  const headerEntries = `${titleMatches.length} entr${titleMatches.length === 1 ? 'y' : 'ies'}`;
  const seasonNote = seasonRejected.size > 0 ? ` (${toScan.length} after season filter)` : '';
  console.log(`📚 Ultimate Library: title-matched ${headerEntries}${seasonNote} for ${titleList}${yearTag}${epTag}`);
  const scannedByPath = new Map(scanned.map(s => [s.entry.filename, s.video]));
  // When multiple roots are scanned, group entries under a per-root header so
  // operators can see at a glance which folder contributed which hit. Falls
  // back to a flat list when only one root is active to avoid empty hierarchy.
  const showRootGroups = roots.length > 1;
  const entryIndent = showRootGroups ? '      ' : '   ';
  for (const { root, matches } of matchesByRoot) {
    if (showRootGroups) {
      const rootLabel = root.replace(/^\/content\//, '');
      console.log(`   📂 ${rootLabel} (${matches.length})`);
    }
    for (const entry of matches) {
      if (seasonRejected.has(entry.filename)) {
        console.log(`${entryIndent}📚 ⊘            ${entry.basename} — season mismatch`);
        continue;
      }
      const video = scannedByPath.get(entry.filename);
      if (video) {
        console.log(`${entryIndent}📚 ✓  ${formatBytes(video.size ?? 0)}  ${entry.basename}`);
      } else {
        console.log(`${entryIndent}📚 ✗            ${entry.basename}`);
      }
    }
  }

  const pass1Results = scanned
    .filter((s): s is { entry: FileStat; video: { path: string; size: number } } => s.video !== null)
    .map(({ entry, video }) => buildLibraryResult(video, entry.basename));

  // Pass 2: alias-title + date-pattern fallback. Mirrors the search-side
  // alias-fallback (orchestrator's date-numbered alias retry) so library
  // matching covers daily/talk-show files named by alias + air date instead
  // of canonical title + SxxExx. Gated on Pass 1 returning zero AND the same
  // conditions the search alias fallback uses (TVDB-supplied air date and
  // a non-empty alias list), so regular shows with an aired date that already
  // matched via SxxExx see no behavior change.
  const datePattern = buildDateEpisodePattern(ctx.episodeAired);
  if (
    ctx.type === 'series'
    && pass1Results.length === 0
    && datePattern
    && ctx.searchAliases?.length
  ) {
    const aliasMatches: { entry: FileStat; alias: string }[] = [];
    const aliasMatchedPaths = new Set<string>();
    for (const alias of ctx.searchAliases) {
      for (const dirs of dirsByRoot) {
        for (const d of dirs) {
          if (d.type !== 'directory') continue;
          if (aliasMatchedPaths.has(d.filename)) continue;
          if (!isTextSearchMatch(alias, d.basename, ctx.year, ctx.country, undefined, ctx.titleYear)) continue;
          // Same season pre-filter as Pass 1: reject folders whose name carries
          // a season marker that contradicts the requested season.
          if (ctx.season != null && !folderCouldContainSeason(d.basename, ctx.season)) continue;
          aliasMatches.push({ entry: d, alias });
          aliasMatchedPaths.add(d.filename);
        }
      }
    }
    if (aliasMatches.length > 0) {
      const aliasScanned = await Promise.all(aliasMatches.map(async ({ entry, alias }) => {
        if (Date.now() - start >= SCAN_BUDGET_MS) return { entry, alias, video: null as { path: string; size: number } | null };
        try {
          const video = await findVideoFile(client, entry.filename, 0, datePattern, ctx.episodesInSeason, true);
          return { entry, alias, video };
        } catch {
          return { entry, alias, video: null };
        }
      }));
      const datedHits = aliasScanned.filter((s): s is { entry: FileStat; alias: string; video: { path: string; size: number } } => s.video !== null);
      if (datedHits.length > 0) {
        const aliasList = ctx.searchAliases.map(a => `"${a}"`).join(', ');
        console.log(`📚 [date] Alias-fallback library hits for ${aliasList} (aired ${ctx.episodeAired}): ${datedHits.length}`);
        for (const { entry, video } of datedHits) {
          console.log(`   📚 [date] ✓  ${formatBytes(video.size ?? 0)}  ${entry.basename}`);
        }
        return datedHits.map(({ entry, video }) => buildLibraryResult(video, entry.basename));
      }
    }
  }

  return pass1Results;
}

function buildLibraryResult(file: { path: string; size: number }, releaseTitle: string): RawResult {
  // Pack-detection signal: parse the folder release title and the inner file basename.
  //  - Folder=pack + file has episode marker → extracted pack episode
  //    (isSeasonPack=true so per-episode-in-pack filters still apply,
  //     extractedFromPack=true so pack-total size filters skip the entry
  //     because `size` is the per-episode file size, not the pack total)
  //  - Folder=pack + file has no episode marker → true single-file pack release
  //    (isSeasonPack=true, extractedFromPack=false; pack-total filter applies normally)
  //  - Folder=episode-or-other → not a pack (both flags false)
  const folderParsed = parseTorrentTitle(releaseTitle);
  const fileBasename = file.path.split('/').pop() ?? '';
  const fileParsed = parseTorrentTitle(fileBasename);
  const folderIsPack = (folderParsed.seasons?.length ?? 0) > 0 && (folderParsed.episodes?.length ?? 0) === 0;
  const fileHasEpisode = (fileParsed.episodes?.length ?? 0) > 0;
  const isSeasonPack = folderIsPack;
  const extractedFromPack = folderIsPack && fileHasEpisode;
  return {
    origin: 'library',
    title: releaseTitle,
    link: `library:${file.path}`,
    nzbUrl: `library:${file.path}`,
    libraryVideoPath: file.path,
    size: file.size ?? 0,
    indexerName: 'WebDAV Library',
    isSeasonPack,
    extractedFromPack,
    quality: parseQuality(releaseTitle),
    codec: parseCodec(releaseTitle),
    source: parseSource(releaseTitle),
    audioTag: parseAudioTag(releaseTitle),
    visualTag: parseVisualTag(releaseTitle),
    edition: parseEdition(releaseTitle),
    releaseGroup: parseReleaseGroup(releaseTitle),
    language: parseLanguage(releaseTitle),
  };
}

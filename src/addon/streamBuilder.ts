/**
 * Stream Builder
 *
 * Converts processed search results into Stremio Stream objects.
 * Handles URL construction for all streaming modes:
 *   - NZBDav (proxy URL with fallback groups)
 *   - EasyNews DDL (direct CDN resolve URL)
 *   - EasyNews NZB (routed through download client)
 *   - Native (external NZB link)
 *
 * Also handles fallback group creation and binge/auto-play group computation.
 */

import crypto from 'crypto';
import { config } from '../config/index.js';
import { parseQuality, parseCodec, parseSource, parseVisualTag, parseAudioTag, parseReleaseGroup, parseCleanTitle, parseYear, parseEdition, parseLanguage, resolutionToDisplay, formatBytes, formatAge, formatBitrate, parseDurationAttr, buildStreamFilename } from '../parsers/metadataParsers.js';
import type { Stream, AutoPlayConfig } from '../types.js';
import type { HealthCheckResult } from '../health/index.js';
import { requestContext } from '../requestContext.js';
import { createFallbackGroup, type FallbackCandidate } from '../nzbdav/index.js';
import { encodeTileEnvelope } from '../nzbdav/redirectHelpers.js';
import { buildStreamDisplay } from './streamDisplay.js';

// Ultimate Fallback tile name + path
const UF_TILE_BASE_NAME = '👑 Ultimate Fallback';
const UF_STREAM_PATH = 'ultimate-fallback';

/** Build the UF tile's display name + title based on the active preference mode.
 *  Brand goes in the `name` chip (left), mode + description in `title` (right detail). */
function ufTileDisplay(mode: 'speed' | 'priority' | undefined): { name: string; title: string } {
  if (mode === 'priority') {
    return { name: UF_TILE_BASE_NAME, title: '⚬ Priority Mode\n⚬ Auto-select highest-quality healthy stream' };
  }
  return { name: UF_TILE_BASE_NAME, title: '⚬ Speed Mode\n⚬ Auto-select fastest healthy stream' };
}


/** Resolve the base URL for stream/proxy URLs — uses the request's origin when available,
 *  falls back to BASE_URL env or localhost for background tasks (auto-queue, health checks). */
function getBaseUrl(): string {
  return requestContext.getStore()?.baseUrl || process.env.BASE_URL || 'http://localhost:1337';
}

/** Get the path prefix for manifest-key routes (empty for legacy root, '/stremio' for prefixed path). */
function getPathPrefix(): string {
  return requestContext.getStore()?.pathPrefix || '';
}

export interface StreamBuildContext {
  allResults: any[];
  healthResults: Map<string, HealthCheckResult>;
  type: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  episodesInSeason?: number;
  now: number;
  runtime?: number;
  /** True when Ultimate Library short-circuited indexer queries; gates the
   *  "Query indexers on next search" bypass tile insertion. */
  shortCircuited?: boolean;
}

export interface StreamBuildOutput {
  streams: Stream[];
  fallbackGroupId?: string;
  fallbackCandidates?: FallbackCandidate[];
}

/**
 * Build Stremio Stream objects from processed search results.
 */
export function buildStreams(ctx: StreamBuildContext): StreamBuildOutput {
  const { allResults, healthResults, type, imdbId, season, episode, episodesInSeason, now, runtime, shortCircuited } = ctx;
  // sessionKey includes manifestKey so concurrent requests from different Stremio installations
  // don't share UF session state (avoids cross-tenant state leaks on multi-user deployments).
  const streamManifestKey = requestContext.getStore()?.manifestKey || '';
  const sessionKey = imdbId ? `${streamManifestKey}:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}` : '';

  // Build auto-play / binge group settings
  const autoPlay: AutoPlayConfig = config.autoPlay || { enabled: true, method: 'firstFile' as const, attributes: ['resolution', 'quality', 'edition'] as ('resolution' | 'quality' | 'edition')[] };

  // Create fallback group for NZBDav mode (auto-retry next NZB on failure)
  let fallbackGroupId: string | undefined;
  let fallbackCandidates: FallbackCandidate[] | undefined;
  if (config.streamingMode === 'nzbdav' && config.ultimateFallback?.enabled) {
    fallbackGroupId = crypto.randomUUID().slice(0, 12);

    fallbackCandidates = allResults
      .filter(r => {
        // Include all results that go through NZBDav pipeline (skip EasyNews DDL)
        if (r.easynewsMeta && config.easynewsMode !== 'nzb') return false;
        return true;
      })
      .map(r => {
        let nzbUrl = r.link;
        // For EasyNews NZB mode, construct the proxy URL
        if (r.easynewsMeta && config.easynewsMode === 'nzb') {
          const meta = r.easynewsMeta;
          const nzbParams = new URLSearchParams({
            hash: meta.hash, filename: meta.filename, ext: meta.ext,
          });
          if (meta.sig) nzbParams.set('sig', meta.sig);
          nzbUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/easynews/nzb?${nzbParams.toString()}`;
        }
        return { nzbUrl, title: r.title, indexerName: r.indexerName, size: r.size, isSeasonPack: r.isSeasonPack || false, libraryVideoPath: r.libraryVideoPath };
      });

    createFallbackGroup(
      fallbackGroupId,
      fallbackCandidates,
      type,
      season?.toString(),
      episode?.toString(),
      episodesInSeason,
    );
    console.log(`🔄 Created fallback group ${fallbackGroupId} with ${fallbackCandidates.length} candidates`);
  }

  const streams: Stream[] = [];

  // Parallel array of library-origin entries collected during the main loop.
  // Used by the post-loop splice passes that insert delete tiles. Entries are
  // collected only for results that actually emit a library tile (origin
  // 'library' + libraryVideoPath set + nzbdav streaming mode). Indices into
  // `streams` shift when head tiles (UF, bypass) are inserted later, so the
  // splice passes apply a `headOffset` correction.
  const libraryStreamIndices: Array<{ originalIndex: number; libraryVideoPath: string; extractedFromPack: boolean }> = [];

  for (let streamIndex = 0; streamIndex < allResults.length; streamIndex++) {
    const result = allResults[streamIndex];
    const resolution = parseQuality(result.title);
    const resolutionDisplay = resolutionToDisplay(resolution);
    const quality = parseSource(result.title);
    const parsedCleanTitle = parseCleanTitle(result.title);
    const year = type === 'movie' ? parseYear(result.title) : undefined;
    const cleanTitle = year ? `${parsedCleanTitle} (${year})` : parsedCleanTitle;
    const streamFilename = buildStreamFilename(result.title, type, season, episode);
    const encode = parseCodec(result.title);
    const visualTag = parseVisualTag(result.title);
    const audioTag = parseAudioTag(result.title);
    const size = formatBytes(result.size);
    const releaseGroup = parseReleaseGroup(result.title);
    const edition = parseEdition(result.title);
    const language = parseLanguage(result.title);
    const indexer = result.indexerName;

    // Calculate age from pubDate
    const age = formatAge(result.pubDate, now);

    // Calculate bitrate from size + duration (EasyNews provides duration; Newznab may have runtime attribute)
    let durationSec: number | undefined = result.duration;
    if (!durationSec) {
      // Non-standard Newznab attributes — most indexers don't send these, but some may
      const runtimeAttr = result.attributes?.runtime || result.attributes?.duration;
      if (runtimeAttr) durationSec = parseDurationAttr(String(runtimeAttr));
    }
    if (!durationSec && runtime) {
      durationSec = runtime;
    }
    const bitrateSize = result.estimatedEpisodeSize ?? result.size;
    const bitrate = durationSec ? formatBitrate(bitrateSize, durationSec) : '';

    // Get health status if available
    const healthStatus = healthResults.get(result.link);
    let statusBadge = '';
    let providersLine = '';
    if (healthStatus) {
      const s = healthStatus.status;
      if (s === 'verified' || s === 'verified_stored' || s === 'verified_archive') {
        // Use distinct icons for special verification sources
        statusBadge = healthStatus.message === 'Zyclops' ? '🤖'
          : healthStatus.message === 'Library' ? '📚'
          : '✅';
      } else if (s === 'blocked') {
        statusBadge = '🚫';
      } else {
        statusBadge = '❌';
      }
      if (healthStatus.providersUsed?.length) {
        providersLine = `  📡 ${healthStatus.providersUsed.join(', ')}`;
      }
    }

    // Build display size string
    const displaySize = result.isSeasonPack && result.estimatedEpisodeSize
      ? `${formatBytes(result.estimatedEpisodeSize)}/ep (${size} pack)`
      : result.isSeasonPack
        ? `${size} (season pack)`
        : size;

    // Build stream name and title from display config (or legacy hardcoded format)
    const { name: streamName, title: streamTitle } = buildStreamDisplay(
      {
        resolutionDisplay, quality, cleanTitle, rawTitle: result.title, encode, displaySize,
        visualTag, audioTag, releaseGroup, indexer, statusBadge,
        providersLine, edition, language, age, bitrate, isSeasonPack: result.isSeasonPack || false,
      },
      config.streamDisplayConfig
    );

    // Compute bingeGroup for auto-play / binge watching
    let bingeGroup: string | undefined;
    if (autoPlay.enabled && type === 'series') {
      bingeGroup = 'usenetultimate';
      switch (autoPlay.method) {
        case 'matchingFile': {
          const attrs = (autoPlay.attributes || ['resolution', 'quality', 'releaseGroup']);
          const attrMap: Record<string, string> = {
            resolution, quality, encode, visualTag, audioTag, releaseGroup, indexer, edition,
          };
          const parts = attrs
            .map(a => attrMap[a])
            .filter(v => v && v !== 'Unknown' && v !== 'Standard');
          if (parts.length > 0) bingeGroup += `|${parts.join('|')}`;
          break;
        }
        case 'matchingIndex':
          bingeGroup += `|${streamIndex}`;
          break;
        // 'firstFile': all streams get the same bingeGroup (just 'usenetultimate')
      }
    }

    // For EasyNews results: DDL mode uses direct download resolve, NZB mode uses download client pipeline
    // For NZBDav mode, create a proxy URL that will send to NZBDav when user clicks play
    // For native mode, use direct NZB download link
    // Library-origin results (from search-time WebDAV scan) emit a tile URL that
    // carries the videoPath directly. handleStream's early-exit recognizes the
    // libraryVideoPath query param and serves the file directly without the NZB
    // grab cycle. URL is shaped as a single query param so Infuse's iOS handoff
    // (which strips everything after the first '&') doesn't drop the path.
    if (result.origin === 'library' && result.libraryVideoPath && config.streamingMode === 'nzbdav') {
      const streamManifestKey = requestContext.getStore()?.manifestKey || '';
      const base = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${encodeURIComponent(streamFilename || result.title || 'stream')}`;
      const tileUrl = `${base}?libraryVideoPath=${encodeURIComponent(result.libraryVideoPath)}`;
      streams.push({
        name: streamName,
        title: streamTitle,
        url: tileUrl,
        behaviorHints: { notWebReady: false, bingeGroup },
      });
      libraryStreamIndices.push({
        originalIndex: streamIndex,
        libraryVideoPath: result.libraryVideoPath,
        extractedFromPack: result.extractedFromPack === true,
      });
    } else if (result.easynewsMeta && config.easynewsMode === 'nzb') {
      // EasyNews NZB mode — route through download client like regular NZB results
      const meta = result.easynewsMeta;
      const nzbParams = new URLSearchParams({
        hash: meta.hash,
        filename: meta.filename,
        ext: meta.ext,
      });
      if (meta.sig) nzbParams.set('sig', meta.sig);
      const streamManifestKey = requestContext.getStore()?.manifestKey || '';
      const nzbProxyUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/easynews/nzb?${nzbParams.toString()}`;

      if (config.streamingMode === 'nzbdav') {
        // Same envelope shape as the regular indexer-result tile above. The
        // `url` field points at /easynews/nzb instead of a raw NZB URL, but
        // the stream handler treats it identically: fetch + submit to NZBDav.
        const candidateIdx = fallbackCandidates
          ? fallbackCandidates.findIndex(c => c.nzbUrl === nzbProxyUrl && c.title === result.title)
          : -1;
        const needsEpisodeCtx = result.isSeasonPack && season !== undefined && episode !== undefined;
        const tileT = encodeTileEnvelope({
          ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
          ...(candidateIdx >= 0 ? { idx: candidateIdx } : {}),
          ...(sessionKey ? { sk: sessionKey } : {}),
          ...(needsEpisodeCtx ? { season, episode, seasonpack: 1 as const, ...(episodesInSeason ? { epcount: episodesInSeason } : {}) } : {}),
          url: nzbProxyUrl,
          title: result.title,
          indexer: result.indexerName || '',
        });
        const proxyUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${encodeURIComponent(streamFilename || result.title || 'stream')}?t=${tileT}`;
        streams.push({
          name: streamName,
          title: streamTitle,
          url: proxyUrl,
          behaviorHints: {
            notWebReady: false,
            bingeGroup,
          },
        });
      } else {
        streams.push({
          name: streamName,
          title: streamTitle,
          externalUrl: nzbProxyUrl,
          behaviorHints: {
            notWebReady: true,
            bingeGroup,
          },
        });
      }
    } else if (result.easynewsMeta) {
      // EasyNews DDL mode — direct download/stream from EasyNews CDN
      const meta = result.easynewsMeta;
      const resolveParams = new URLSearchParams({
        hash: meta.hash,
        filename: meta.filename,
        ext: meta.ext,
        dlFarm: meta.dlFarm,
        dlPort: meta.dlPort,
        downURL: meta.downURL,
      });
      const streamManifestKey = requestContext.getStore()?.manifestKey || '';
      const resolveUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/easynews/resolve?${resolveParams.toString()}`;

      streams.push({
        name: streamName,
        title: streamTitle,
        url: resolveUrl,
        behaviorHints: {
          notWebReady: false,  // CDN URL is directly streamable
          bingeGroup,
        },
      });
    } else if (config.streamingMode === 'nzbdav') {
      const streamManifestKey = requestContext.getStore()?.manifestKey || '';
      // Single-param tile URL. Infuse and other iOS external-player handoff
      // chains truncate everything after the first `&` in the URL they
      // receive, so all tile state is packed into one base64url-JSON envelope
      // under `t`. The handler reads `fbg`+`idx` to look up the candidate in
      // the in-memory fallback group; `url`/`title`/`indexer` ride along as
      // a single-shot fallback for when the group has been evicted.
      const candidateIdx = fallbackCandidates
        ? fallbackCandidates.findIndex(c => c.nzbUrl === result.link && c.title === result.title)
        : -1;
      const base = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${encodeURIComponent(streamFilename || result.title || 'stream')}`;
      const needsEpisodeCtx = result.isSeasonPack && season !== undefined && episode !== undefined;
      const tileT = encodeTileEnvelope({
        ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
        ...(candidateIdx >= 0 ? { idx: candidateIdx } : {}),
        ...(sessionKey ? { sk: sessionKey } : {}),
        ...(needsEpisodeCtx ? { season, episode, seasonpack: 1 as const, ...(episodesInSeason ? { epcount: episodesInSeason } : {}) } : {}),
        url: result.link,
        title: result.title,
        indexer: result.indexerName || '',
      });
      streams.push({
        name: streamName,
        title: streamTitle,
        url: `${base}?t=${tileT}`,
        behaviorHints: { notWebReady: false, bingeGroup },
      });
    } else {
      streams.push({
        name: streamName,
        title: streamTitle,
        externalUrl: result.link,
        behaviorHints: {
          notWebReady: true,  // Native mode requires external NZB client
          bingeGroup,
        },
      });
    }
  }

  // Prepend synthetic Ultimate Fallback tile so users can opt into the UF lobby explicitly.
  // Guarded by streamingMode=nzbdav: UF resolves via NZBDav, so showing the tile in other
  // modes would produce a URL the handler can't serve. sessionKey gate skips item pages
  // that don't have an imdbId (shouldn't happen in practice, but defensive).
  if (
    config.ultimateFallback?.enabled
    && config.streamingMode === 'nzbdav'
    && sessionKey
  ) {
    // Pack sk + fbg into a single base64url-encoded JSON envelope so the URL
    // carries no `&`. iOS / Infuse handoff truncates URLs at the first `&`,
    // which previously dropped fbg from the request once a second param was
    // added (commit d5d9a42). When auto-resolve-on-search is off, no session
    // is pre-populated for the sk and the lobby cannot fall back to a cached
    // resolution; the truncated fbg leaves UF unable to look up the group at
    // all. Same envelope shape as the library-delete tiles.
    const ufT = encodeTileEnvelope({
      sk: sessionKey,
      ...(fallbackGroupId ? { fbg: fallbackGroupId } : {}),
    });
    const ufUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${UF_STREAM_PATH}?t=${ufT}`;
    // bingeGroup matches regular tiles so cross-episode auto-play can continue via UF.
    const ufBingeGroup = autoPlay.enabled && autoPlay.method === 'firstFile' ? 'usenetultimate' : undefined;
    const ufDisplay = ufTileDisplay(config.ultimateFallback?.preferenceMode);
    streams.unshift({
      name: ufDisplay.name,
      title: ufDisplay.title,
      url: ufUrl,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: ufBingeGroup,
      },
    });
  }

  // Ultimate Library bypass tile — appears at index 1 when Ultimate Library
  // short-circuited indexer queries. Lets the user request indexer results on
  // the next search of this same content without toggling the feature in the
  // UI. When UF lobby is at index 0, bypass lands at index 1 (after UF). When
  // UF lobby is absent, the first library result is at index 0 and bypass at
  // index 1. The tile is NEVER added to fallbackCandidates so UF skips it.
  const ufPresent = !!(config.ultimateFallback?.enabled && config.streamingMode === 'nzbdav' && sessionKey);
  const bypassPresent = !!(shortCircuited && sessionKey && streamManifestKey);
  // User-configurable position: 'second' (current default — splice at index 1)
  // or 'last' (deferred push to the very end of the streams array AFTER
  // delete-tile splices have run). headOffset below excludes bypass when at
  // 'last' so the delete-all tile still lands right after head tiles.
  const skipTileAtEnd = config.searchConfig?.librarySkipTilePosition === 'last';
  // The delete-all tile is built lazily inside the post-loop splice block below
  // (it depends on the libraryStreamIndices count). Hoisting the declaration
  // here so the final-placement code at the bottom of the function can read it.
  let deleteAllTile: Stream | null = null;
  const bypassTile: Stream | null = bypassPresent
    ? {
        name: '\u23ED\uFE0F Skip Ultimate Library',
        title: 'On the next request for this content, skip Ultimate Library and search indexers.',
        url: `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/library-bypass?sk=${encodeURIComponent(sessionKey)}`,
        behaviorHints: { notWebReady: true },
      }
    : null;
  if (bypassTile && !skipTileAtEnd) {
    streams.splice(1, 0, bypassTile);
  }

  // ── Library delete tiles (toggle-gated, NEVER added to fallbackCandidates
  // so UF cannot pull them as candidates) ───────────────────────────────
  // Two splice passes run only when at least one library-origin entry was
  // collected during the main loop. Passes are intentionally ordered:
  //   A. Per-stream tiles spliced after each library result. Walks indices
  //      end to start so prior splices do not shift unprocessed indices.
  //   B. Delete-all tile inserted at headOffset (after UF + bypass), so it
  //      sits right under the head tiles regardless of which combination
  //      is active.
  const headOffset = (ufPresent ? 1 : 0) + (bypassPresent && !skipTileAtEnd ? 1 : 0);
  const sc = config.searchConfig;
  if (libraryStreamIndices.length > 0 && (sc?.libraryDeletePerStreamTile || sc?.libraryDeleteAllTile)) {
    const idStr = imdbId
      ? ((season !== undefined || episode !== undefined)
          ? `${imdbId}:${season ?? ''}:${episode ?? ''}`
          : imdbId)
      : '';
    // iOS / Infuse handoff truncates the URL at the first `&`, so every delete
    // tile packs its inputs into a single `?t=<base64url(JSON)>` param,
    // matching the same single-param shape used by regular tiles above.
    const packTilePayload = (payload: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    // Pass A — per-stream tiles
    if (sc?.libraryDeletePerStreamTile && streamManifestKey) {
      for (let i = libraryStreamIndices.length - 1; i >= 0; i--) {
        const meta = libraryStreamIndices[i];
        if (!meta.libraryVideoPath) continue; // defensive
        const fileTile: Stream = {
          name: '\u274C Delete The (Above / Left) Result From WebDAV',
          title: 'Clicking this tile permanently deletes the result from your WebDAV mount.',
          url: `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/library-delete?t=${packTilePayload({
            scope: 'file', p: meta.libraryVideoPath, sk: sessionKey, type, id: idStr,
          })}`,
          behaviorHints: { notWebReady: true },
        };
        const tiles: Stream[] = [fileTile];
        if (meta.extractedFromPack) {
          // Pack folder: top-level release dir under /content/<root>/.
          // libraryVideoPath looks like /content/<root>/<releaseTitle>/.../file.mkv;
          // slice(0, 4) keeps the leading empty plus 3 segments and joins back to
          // /content/<root>/<releaseTitle>.
          const packFolder = meta.libraryVideoPath.split('/').slice(0, 4).join('/');
          tiles.push({
            name: '\u274C Delete The (Above / Left) Entire Series/Season Pack from WebDAV',
            title: 'Clicking this tile permanently deletes the entire release folder that contains the result from your WebDAV mount.',
            url: `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/library-delete?t=${packTilePayload({
              scope: 'pack', p: packFolder, sk: sessionKey, type, id: idStr,
            })}`,
            behaviorHints: { notWebReady: true },
          });
        }
        streams.splice(meta.originalIndex + headOffset + 1, 0, ...tiles);
      }
    }

    // Pass B — build the single delete-all tile (scoped to this request only).
    // Targets list rides inside the packed `t=` envelope so the route doesn't
    // need to look up library state from any cache (Ultimate Library results
    // never cache by design — see addon/index.ts:445-449).
    // Insertion is decided AFTER this block: the tile follows the bypass
    // tile's position so it lands right after "Skip Ultimate Library"
    // wherever that ends up.
    if (sc?.libraryDeleteAllTile && streamManifestKey) {
      // For pack-extracted results, the user's libraryDeleteAllPackScope
      // setting decides whether the delete targets the per-episode .mkv
      // ('episode', default) or the whole release folder ('pack'). Non-pack
      // results always target the file. The route reads scope per-target so
      // pack-folder DELETEs can use Depth: infinity per RFC 4918.
      const packScopeMode = sc?.libraryDeleteAllPackScope === 'pack';
      const targetEntries: Array<{ path: string; scope: 'file' | 'pack' }> = [];
      for (const meta of libraryStreamIndices) {
        if (typeof meta.libraryVideoPath !== 'string' || meta.libraryVideoPath.length === 0) continue;
        if (packScopeMode && meta.extractedFromPack) {
          const packFolder = meta.libraryVideoPath.split('/').slice(0, 4).join('/');
          targetEntries.push({ path: packFolder, scope: 'pack' });
        } else {
          targetEntries.push({ path: meta.libraryVideoPath, scope: 'file' });
        }
      }
      // Dedup by path: multiple per-episode entries inside the same pack
      // collapse to a single pack DELETE in pack-scope mode.
      const seen = new Set<string>();
      const allTargets = targetEntries.filter(t => {
        if (seen.has(t.path)) return false;
        seen.add(t.path);
        return true;
      });
      if (allTargets.length > 0) {
        const count = allTargets.length;
        const packNote = packScopeMode
          ? 'For series/season packs, the entire release folder is deleted.'
          : 'For series/season packs, only the individual episode is deleted.';
        deleteAllTile = {
          name: '\u274C Delete All Results From WebDAV',
          title: `Clicking this tile permanently deletes ${count} result(s) from your WebDAV mount. ${packNote}`,
          url: `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/library-delete-all?t=${packTilePayload({
            sk: sessionKey, type, id: idStr, targets: allTargets,
          })}`,
          behaviorHints: { notWebReady: true },
        };
      }
    }
  }

  // Final placement of bypass + delete-all tiles. The delete-all tile always
  // follows the bypass tile's position: when bypass is at top (default), the
  // delete-all lands at headOffset (right after bypass). When bypass is at
  // last, both are pushed at the end with bypass first, delete-all after.
  // When bypass isn't shown at all (no UL short-circuit), delete-all uses
  // the headOffset slot, since there's no skip tile to anchor to.
  if (bypassTile && skipTileAtEnd) {
    streams.push(bypassTile);
    if (deleteAllTile) streams.push(deleteAllTile);
  } else if (deleteAllTile) {
    streams.splice(headOffset, 0, deleteAllTile);
  }

  return { streams, fallbackGroupId, fallbackCandidates };
}

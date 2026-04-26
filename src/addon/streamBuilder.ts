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
import { buildStreamDisplay } from './streamDisplay.js';

// Ultimate Resolve tile + query param identifiers
const UR_TILE_BASE_NAME = '👑 Ultimate Resolve';
const UR_STREAM_PATH = 'ultimate-resolve';
const QUERY_PARAM_USER_PICK = 'user_pick';
const USER_PICK_FLAG = `&${QUERY_PARAM_USER_PICK}=1`;

/** Build the UR tile's display name + title based on the active preference mode.
 *  Brand goes in the `name` chip (left), mode + description in `title` (right detail). */
function urTileDisplay(mode: 'speed' | 'priority' | undefined): { name: string; title: string } {
  if (mode === 'priority') {
    return { name: UR_TILE_BASE_NAME, title: '⚬ Priority Mode\n⚬ Auto-select highest-quality healthy stream' };
  }
  return { name: UR_TILE_BASE_NAME, title: '⚬ Speed Mode\n⚬ Auto-select fastest healthy stream' };
}

/** Regular-tile episode params — only emits for season packs with both season & episode set.
 *  Carries `sp=1` so the handler's sentinel candidate honors the clicked pack semantics. */
function buildRegularTileEpisodeParams(result: { isSeasonPack: boolean }, season: number | undefined, episode: number | undefined, episodesInSeason: number | undefined): string {
  if (!result.isSeasonPack || season === undefined || episode === undefined) return '';
  return `&season=${season}&episode=${episode}&sp=1${episodesInSeason ? `&epcount=${episodesInSeason}` : ''}`;
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
  const { allResults, healthResults, type, imdbId, season, episode, episodesInSeason, now, runtime } = ctx;
  // sessionKey includes manifestKey so concurrent requests from different Stremio installations
  // don't share UR session state (avoids cross-tenant state leaks on multi-user deployments).
  const streamManifestKey = requestContext.getStore()?.manifestKey || '';
  const sessionKey = imdbId ? `${streamManifestKey}:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}` : '';
  const skParam = sessionKey ? `&sk=${encodeURIComponent(sessionKey)}` : '';

  // Build auto-play / binge group settings
  const autoPlay: AutoPlayConfig = config.autoPlay || { enabled: true, method: 'firstFile' as const, attributes: ['resolution', 'quality', 'edition'] as ('resolution' | 'quality' | 'edition')[] };

  // Create fallback group for NZBDav mode (auto-retry next NZB on failure)
  let fallbackGroupId: string | undefined;
  let fallbackCandidates: FallbackCandidate[] | undefined;
  if (config.streamingMode === 'nzbdav' && (config.nzbdavFallbackEnabled === true || config.ultimateResolve?.enabled)) {
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
        return { nzbUrl, title: r.title, indexerName: r.indexerName, isSeasonPack: r.isSeasonPack || false };
      });

    createFallbackGroup(
      fallbackGroupId,
      fallbackCandidates,
      type,
      season?.toString(),
      episode?.toString()
    );
    console.log(`🔄 Created fallback group ${fallbackGroupId} with ${fallbackCandidates.length} candidates`);
  }

  const streams: Stream[] = [];

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
    if (result.easynewsMeta && config.easynewsMode === 'nzb') {
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
        const episodeParams = buildRegularTileEpisodeParams(result, season, episode, episodesInSeason);
        const fbgParam = fallbackGroupId ? `&fbg=${fallbackGroupId}` : '';
        const proxyUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${encodeURIComponent(streamFilename || result.title || 'stream')}?nzb=${encodeURIComponent(nzbProxyUrl)}&title=${encodeURIComponent(result.title)}&type=${type}&indexer=${encodeURIComponent(result.indexerName)}${episodeParams}${fbgParam}${skParam}${USER_PICK_FLAG}`;
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
      // Single-param tile URL. Infuse (and probably other iOS external players
      // addon handoff chains) truncates everything after the first `&` in the
      // URL it receives, so we pack all tile state into one dot-separated `t`
      // query parameter. Presence of `t` also implies `user_pick=1`. Order:
      //   fbg . idx . encodedSessionKey . season . episode . sp . epcount
      // Empty fields are kept as empty strings so index positions are stable.
      // Falls back to the legacy long form when the candidate isn't in the
      // fallback group (shouldn't happen for streamingMode=nzbdav but keeps
      // the code defensive for edge configs).
      const candidateIdx = fallbackCandidates
        ? fallbackCandidates.findIndex(c => c.nzbUrl === result.link && c.title === result.title)
        : -1;
      const base = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${encodeURIComponent(streamFilename || result.title || 'stream')}`;
      if (fallbackGroupId && candidateIdx >= 0) {
        const sessionKeyEnc = sessionKey ? encodeURIComponent(sessionKey) : '';
        const needsEpisodeCtx = result.isSeasonPack && season !== undefined && episode !== undefined;
        const seasonStr = needsEpisodeCtx ? String(season) : '';
        const episodeStr = needsEpisodeCtx ? String(episode) : '';
        const spStr = needsEpisodeCtx ? '1' : '';
        const epcountStr = needsEpisodeCtx && episodesInSeason ? String(episodesInSeason) : '';
        // base64url has no `.`, so positional split() stays intact. These trailing fields
        // let the handler still attempt a single shot when the fallback group has been
        // evicted (group TTL < the lifetime of cached tile URLs).
        const urlB64 = Buffer.from(result.link, 'utf8').toString('base64url');
        const titleB64 = Buffer.from(result.title, 'utf8').toString('base64url');
        const indexerB64 = Buffer.from(result.indexerName || '', 'utf8').toString('base64url');
        const packed = `${fallbackGroupId}.${candidateIdx}.${sessionKeyEnc}.${seasonStr}.${episodeStr}.${spStr}.${epcountStr}.${urlB64}.${titleB64}.${indexerB64}`;
        streams.push({
          name: streamName,
          title: streamTitle,
          url: `${base}?t=${packed}`,
          behaviorHints: { notWebReady: false, bingeGroup },
        });
      } else {
        // Legacy long form — many `&` separators, but we only hit this when
        // there's no fallback group anyway, which is a config where there's
        // also no fallback iteration, so external-player compat matters less.
        const episodeParams = buildRegularTileEpisodeParams(result, season, episode, episodesInSeason);
        const proxyUrl = `${base}?nzb=${encodeURIComponent(result.link)}&title=${encodeURIComponent(result.title)}&type=${type}&indexer=${encodeURIComponent(result.indexerName)}${episodeParams}${skParam}${USER_PICK_FLAG}`;
        streams.push({
          name: streamName,
          title: streamTitle,
          url: proxyUrl,
          behaviorHints: { notWebReady: false, bingeGroup },
        });
      }
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

  // Prepend synthetic Ultimate Resolve tile so users can opt into the UR lobby explicitly.
  // Guarded by streamingMode=nzbdav: UR resolves via NZBDav, so showing the tile in other
  // modes would produce a URL the handler can't serve. sessionKey gate skips item pages
  // that don't have an imdbId (shouldn't happen in practice, but defensive).
  if (
    config.ultimateResolve?.enabled
    && config.streamingMode === 'nzbdav'
    && sessionKey
  ) {
    const urUrl = `${getBaseUrl()}${getPathPrefix()}/${streamManifestKey}/nzbdav/stream/${UR_STREAM_PATH}?sk=${encodeURIComponent(sessionKey)}`;
    // bingeGroup matches regular tiles so cross-episode auto-play can continue via UR.
    const urBingeGroup = autoPlay.enabled && autoPlay.method === 'firstFile' ? 'usenetultimate' : undefined;
    const urDisplay = urTileDisplay(config.ultimateResolve?.preferenceMode);
    streams.unshift({
      name: urDisplay.name,
      title: urDisplay.title,
      url: urUrl,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: urBingeGroup,
      },
    });
  }

  return { streams, fallbackGroupId, fallbackCandidates };
}

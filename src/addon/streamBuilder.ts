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
import { parseQuality, parseCodec, parseSource, parseVisualTag, parseAudioTag, parseReleaseGroup, parseCleanTitle, parseEdition, parseLanguage, resolutionToDisplay, formatBytes } from '../parsers/metadataParsers.js';
import type { Stream, AutoPlayConfig } from '../types.js';
import type { HealthCheckResult } from '../health/index.js';
import { requestContext } from '../requestContext.js';
import { createFallbackGroup, type FallbackCandidate } from '../nzbdav/index.js';
import { buildStreamDisplay } from './streamDisplay.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1337';

export interface StreamBuildContext {
  allResults: any[];
  healthResults: Map<string, HealthCheckResult>;
  type: string;
  season?: number;
  episode?: number;
  episodesInSeason?: number;
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
  const { allResults, healthResults, type, season, episode, episodesInSeason } = ctx;

  // Build auto-play / binge group settings
  const autoPlay: AutoPlayConfig = config.autoPlay || { enabled: true, method: 'firstFile' as const, attributes: ['resolution', 'quality', 'edition'] as ('resolution' | 'quality' | 'edition')[] };

  // Create fallback group for NZBDav mode (auto-retry next NZB on failure)
  let fallbackGroupId: string | undefined;
  let fallbackCandidates: FallbackCandidate[] | undefined;
  if (config.streamingMode === 'nzbdav' && config.nzbdavFallbackEnabled !== false) {
    fallbackGroupId = crypto.randomUUID().slice(0, 12);
    const streamManifestKey = requestContext.getStore()?.manifestKey || '';

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
          nzbUrl = `${BASE_URL}/${streamManifestKey}/easynews/nzb?${nzbParams.toString()}`;
        }
        return { nzbUrl, title: r.title, indexerName: r.indexerName };
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
    const cleanTitle = parseCleanTitle(result.title);
    const encode = parseCodec(result.title);
    const visualTag = parseVisualTag(result.title);
    const audioTag = parseAudioTag(result.title);
    const size = formatBytes(result.size);
    const releaseGroup = parseReleaseGroup(result.title);
    const edition = parseEdition(result.title);
    const language = parseLanguage(result.title);
    const indexer = result.indexerName;

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
      ? `~${formatBytes(result.estimatedEpisodeSize)}/ep (${size} pack)`
      : result.isSeasonPack
        ? `${size} (season pack)`
        : size;

    // Build stream name and title from display config (or legacy hardcoded format)
    const { name: streamName, title: streamTitle } = buildStreamDisplay(
      {
        resolutionDisplay, quality, cleanTitle, rawTitle: result.title, encode, displaySize,
        visualTag, audioTag, releaseGroup, indexer, statusBadge,
        providersLine, edition, language, isSeasonPack: result.isSeasonPack || false,
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
      const nzbProxyUrl = `${BASE_URL}/${streamManifestKey}/easynews/nzb?${nzbParams.toString()}`;

      if (config.streamingMode === 'nzbdav') {
        const episodeParams = result.isSeasonPack && season !== undefined && episode !== undefined
          ? `&season=${season}&episode=${episode}${episodesInSeason ? `&epcount=${episodesInSeason}` : ''}`
          : '';
        const fbgParam = fallbackGroupId ? `&fbg=${fallbackGroupId}` : '';
        const proxyUrl = `${BASE_URL}/${streamManifestKey}/nzbdav/stream?nzb=${encodeURIComponent(nzbProxyUrl)}&title=${encodeURIComponent(result.title)}&type=${type}&indexer=${encodeURIComponent(result.indexerName)}${episodeParams}${fbgParam}`;
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
      const resolveUrl = `${BASE_URL}/${streamManifestKey}/easynews/resolve?${resolveParams.toString()}`;

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
      // Encode the NZB URL and title as a proxy URL
      // For season packs, include season/episode so the correct file is selected
      const episodeParams = result.isSeasonPack && season !== undefined && episode !== undefined
        ? `&season=${season}&episode=${episode}${episodesInSeason ? `&epcount=${episodesInSeason}` : ''}`
        : '';
      const streamManifestKey = requestContext.getStore()?.manifestKey || '';
      const fbgParam = fallbackGroupId ? `&fbg=${fallbackGroupId}` : '';
      const proxyUrl = `${BASE_URL}/${streamManifestKey}/nzbdav/stream?nzb=${encodeURIComponent(result.link)}&title=${encodeURIComponent(result.title)}&type=${type}&indexer=${encodeURIComponent(result.indexerName)}${episodeParams}${fbgParam}`;

      streams.push({
        name: streamName,
        title: streamTitle,
        url: proxyUrl,
        behaviorHints: {
          notWebReady: false,  // NZBDav can stream in player
          bingeGroup,
        },
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

  return { streams, fallbackGroupId, fallbackCandidates };
}

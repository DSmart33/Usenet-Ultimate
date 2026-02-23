/**
 * Health Check Coordinator
 *
 * Orchestrates NZB health checking in two modes:
 *   - Smart: batch-based, stops when a healthy result is found
 *   - Fixed: checks a fixed number of top results
 *
 * Also handles auto-marking EasyNews/Zyclops results as verified,
 * filtering blocked results, and auto-queuing to NZBDav.
 */

import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { performBatchHealthChecks, type HealthCheckResult, type HealthCheckOptions } from '../health/index.js';
import { requestContext } from '../requestContext.js';
import { checkNzbLibrary } from '../nzbdav/videoDiscovery.js';
import type { NZBDavConfig } from '../nzbdav/types.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1337';

export interface HealthCheckContext {
  allResults: any[];
  type: string;
  season?: number;
  episode?: number;
  episodesInSeason?: number;
}

/**
 * Run health checks on the provided results and return a map of link → HealthCheckResult.
 * Also mutates allResults in-place to filter blocked results when hideBlocked is enabled.
 * Returns the (potentially filtered) allResults alongside the health map.
 */
export async function coordinateHealthChecks(
  ctx: HealthCheckContext
): Promise<{ healthResults: Map<string, HealthCheckResult>; filteredResults: any[] }> {
  let { allResults } = ctx;
  const healthResults = new Map<string, HealthCheckResult>();

  const enabledProviders = config.healthChecks?.providers?.filter(p => p.enabled) || [];
  if (!config.healthChecks?.enabled || enabledProviders.length === 0) {
    // No NNTP health checks — still auto-mark EasyNews/Zyclops
    autoMarkRemainingResults(allResults, healthResults);
    return { healthResults, filteredResults: allResults };
  }

  // Build health-check-enabled set based on index manager mode
  const isAggregatorMode = config.indexManager === 'prowlarr' || config.indexManager === 'nzbhydra';
  const healthCheckEnabledSet = new Set<string>();
  if (isAggregatorMode) {
    for (const si of config.syncedIndexers || []) {
      if (si.enabledForHealthCheck) healthCheckEnabledSet.add(si.name);
    }
  }
  const healthCheckIndexers = config.healthChecks?.healthCheckIndexers;
  const userAgent = config.userAgents?.nzbDownload || getLatestVersions().chrome;
  const healthCheckOpts: HealthCheckOptions = {
    archiveInspection: config.healthChecks?.archiveInspection ?? true,
    sampleCount: config.healthChecks?.sampleCount ?? 7,
  };
  const inspectionMethod = config.healthChecks.inspectionMethod || 'smart';
  const maxConnections = inspectionMethod === 'smart'
    ? (config.healthChecks?.smartBatchSize || 3)
    : (config.healthChecks?.nzbsToInspect || 6);

  // Check if EasyNews NZB results should be health-checked instead of auto-verified
  const shouldHealthCheckEasynews = config.easynewsHealthCheck && config.easynewsMode === 'nzb';

  // Build EasyNews link → NZB proxy URL mapping for health checks
  const easynewsLinkToNzbUrl = new Map<string, string>();
  const nzbUrlToEasynewsLink = new Map<string, string>();
  if (shouldHealthCheckEasynews) {
    const hcManifestKey = requestContext.getStore()?.manifestKey || '';
    for (const r of allResults) {
      if (r.easynewsMeta) {
        const meta = r.easynewsMeta;
        const nzbParams = new URLSearchParams({ hash: meta.hash, filename: meta.filename, ext: meta.ext });
        if (meta.sig) nzbParams.set('sig', meta.sig);
        const nzbUrl = `${BASE_URL}/${hcManifestKey}/easynews/nzb?${nzbParams.toString()}`;
        easynewsLinkToNzbUrl.set(r.link, nzbUrl);
        nzbUrlToEasynewsLink.set(nzbUrl, r.link);
      }
    }
  }

  // Helper: auto-mark EasyNews/Zyclops results as healthy and filter eligible results for NNTP check
  const processCandidate = (candidate: typeof allResults[0]) => {
    if (candidate.easynewsMeta) {
      if (shouldHealthCheckEasynews) {
        return true; // Eligible for NNTP health check
      }
      if (!healthResults.has(candidate.link)) {
        healthResults.set(candidate.link, { status: 'verified', message: 'EasyNews', playable: true });
      }
      return false; // Not eligible for NNTP check
    }
    if (candidate.zyclopsVerified) {
      if (!healthResults.has(candidate.link)) {
        healthResults.set(candidate.link, { status: 'verified', message: 'Zyclops', playable: true });
      }
      return false; // Already verified by Zyclops — not eligible for NNTP check
    }
    if (isAggregatorMode) return healthCheckEnabledSet.has(candidate.indexerName);
    return !healthCheckIndexers || healthCheckIndexers[candidate.indexerName] !== false;
  };

  // Helper: resolve NZB URL for health check (translates easynews:// links to proxy URLs)
  const resolveHealthCheckUrl = (r: typeof allResults[0]) => easynewsLinkToNzbUrl.get(r.link) || r.link;
  // Helper: reverse-map health check result URL back to original link
  const resolveOriginalLink = (url: string) => nzbUrlToEasynewsLink.get(url) || url;

  const isVerifiedStatus = (s: string) =>
    s === 'verified' || s === 'verified_stored' || s === 'verified_archive';

  // ── Library Pre-Check ──────────────────────────────────────────────
  // If NZBDav is configured and library pre-check is enabled, scan the
  // WebDAV library for each candidate before running expensive NNTP checks.
  // Content already downloaded is marked as verified ('Library') instantly.
  const libraryPreCheckEnabled = (config.healthChecks?.libraryPreCheck !== false)
    && config.streamingMode === 'nzbdav'
    && config.nzbdavWebdavUrl
    && config.nzbdavWebdavUser;

  let nzbdavConfig: NZBDavConfig | null = null;
  let libraryEpisodePattern: string | undefined;
  if (libraryPreCheckEnabled) {
    nzbdavConfig = {
      url: config.nzbdavUrl || 'http://localhost:3000',
      apiKey: config.nzbdavApiKey || '',
      webdavUrl: config.nzbdavWebdavUrl || config.nzbdavUrl || 'http://localhost:3000',
      webdavUser: config.nzbdavWebdavUser || '',
      webdavPassword: config.nzbdavWebdavPassword || '',
      moviesCategory: config.nzbdavMoviesCategory || 'Usenet-Ultimate-Movies',
      tvCategory: config.nzbdavTvCategory || 'Usenet-Ultimate-TV',
    };
    if (ctx.season !== undefined && ctx.episode !== undefined) {
      const s = ctx.season.toString().padStart(2, '0');
      const e = ctx.episode.toString().padStart(2, '0');
      libraryEpisodePattern = `S${s}[. _-]?E${e}`;
    }
  }

  const libraryContentType = ctx.type === 'movie' ? 'movie' : 'series';

  /** Check a batch of candidates against the NZBDav library (concurrent). */
  async function preCheckLibrary(candidates: any[]): Promise<number> {
    if (!nzbdavConfig) return 0;
    const unchecked = candidates.filter(r => !healthResults.has(r.link));
    if (unchecked.length === 0) return 0;

    let hits = 0;
    const checks = unchecked.map(async (r) => {
      try {
        const result = await checkNzbLibrary(
          r.title, nzbdavConfig!, libraryEpisodePattern, libraryContentType, ctx.episodesInSeason
        );
        if (result) {
          healthResults.set(r.link, { status: 'verified', message: 'Library', playable: true });
          hits++;
        }
      } catch {
        // Non-fatal — fall through to NNTP check
      }
    });
    await Promise.all(checks);
    return hits;
  }

  if (inspectionMethod === 'smart') {
    // --- SMART: Stop on Healthy ---
    const batchSize = config.healthChecks.smartBatchSize || 3;
    const additionalRuns = config.healthChecks.smartAdditionalRuns ?? 1;
    const maxBatches = 1 + additionalRuns;

    let foundHealthy = false;

    for (let batch = 0; batch < maxBatches; batch++) {
      const batchStart = batch * batchSize;
      const batchCandidates = allResults.slice(batchStart, batchStart + batchSize);
      if (batchCandidates.length === 0) break;

      // Process EasyNews and filter eligible NZBs
      const toCheck = batchCandidates.filter(processCandidate);

      const easynewsCount = batchCandidates.filter(r => r.easynewsMeta).length;
      const zyclopsCount = batchCandidates.filter(r => r.zyclopsVerified).length;
      if (easynewsCount > 0 && !shouldHealthCheckEasynews) {
        console.log(`✅ Auto-verified ${easynewsCount} EasyNews result(s) in batch ${batch + 1}`);
      } else if (easynewsCount > 0) {
        console.log(`🔍 Including ${easynewsCount} EasyNews result(s) in health check batch ${batch + 1}`);
      }
      if (zyclopsCount > 0) {
        console.log(`🤖 Auto-verified ${zyclopsCount} Zyclops result(s) in batch ${batch + 1}`);
      }
      // Library pre-check: skip NNTP for candidates already in NZBDav
      if (nzbdavConfig && toCheck.length > 0) {
        const libHits = await preCheckLibrary(toCheck);
        if (libHits > 0) {
          console.log(`📚 ${libHits} result(s) found in NZBDav library (batch ${batch + 1}), skipping NNTP`);
          // Remove library hits from NNTP queue
          const remaining = toCheck.filter(r => !healthResults.has(r.link));
          toCheck.length = 0;
          toCheck.push(...remaining);
        }
      }

      console.log(`🔍 Smart batch ${batch + 1}/${maxBatches}: checking ${toCheck.length} NZB(s) across ${enabledProviders.length} provider(s)...`);

      if (toCheck.length > 0) {
        const batchResults = await performBatchHealthChecks(
          toCheck.map(resolveHealthCheckUrl),
          enabledProviders,
          userAgent,
          Math.min(maxConnections, toCheck.length),
          healthCheckOpts
        );

        for (const [url, result] of batchResults.entries()) {
          healthResults.set(resolveOriginalLink(url), result);
        }

        // Log batch results
        for (const [nzbUrl, result] of batchResults.entries()) {
          const originalLink = resolveOriginalLink(nzbUrl);
          const resultTitle = allResults.find(r => r.link === originalLink)?.title || 'Unknown';
          const icon = isVerifiedStatus(result.status) ? '✅' : '🚫';
          console.log(`  ${icon} ${resultTitle.substring(0, 60)}...`);
        }
      }

      // Check if at least one healthy result found in this batch
      for (const r of batchCandidates) {
        const health = healthResults.get(r.link);
        if (health && isVerifiedStatus(health.status)) {
          foundHealthy = true;
          break;
        }
      }

      if (foundHealthy) {
        console.log(`✅ Smart mode: found healthy result in batch ${batch + 1}, stopping.`);
        break;
      }

      if (batch < maxBatches - 1) {
        console.log(`⏳ Smart mode: no healthy result in batch ${batch + 1}, continuing...`);
      }
    }

    if (!foundHealthy) {
      console.log(`⚠️ Smart mode: no healthy result found after checking`);
    }

  } else {
    // --- FIXED COUNT (default, existing behavior) ---
    const topN = allResults.slice(0, config.healthChecks.nzbsToInspect);

    // Process EasyNews and filter eligible NZBs
    const nonEasynewsToCheck = topN.filter(processCandidate);

    const easynewsCount = topN.filter(r => r.easynewsMeta).length;
    const zyclopsCount = topN.filter(r => r.zyclopsVerified).length;
    if (easynewsCount > 0 && !shouldHealthCheckEasynews) {
      console.log(`✅ Auto-verified ${easynewsCount} EasyNews result(s) in top ${topN.length}`);
    } else if (easynewsCount > 0) {
      console.log(`🔍 Including ${easynewsCount} EasyNews result(s) in health check`);
    }
    if (zyclopsCount > 0) {
      console.log(`🤖 Auto-verified ${zyclopsCount} Zyclops result(s) in top ${topN.length}`);
    }
    // Library pre-check: skip NNTP for candidates already in NZBDav
    if (nzbdavConfig && nonEasynewsToCheck.length > 0) {
      const libHits = await preCheckLibrary(nonEasynewsToCheck);
      if (libHits > 0) {
        console.log(`📚 ${libHits} result(s) found in NZBDav library, skipping NNTP`);
        const remaining = nonEasynewsToCheck.filter(r => !healthResults.has(r.link));
        nonEasynewsToCheck.length = 0;
        nonEasynewsToCheck.push(...remaining);
      }
    }

    console.log(`🔍 Health checking ${nonEasynewsToCheck.length} result(s) across ${enabledProviders.length} provider(s)...`);

    if (nonEasynewsToCheck.length > 0) {
      const usenetResults = await performBatchHealthChecks(
        nonEasynewsToCheck.map(resolveHealthCheckUrl),
        enabledProviders,
        userAgent,
        Math.min(maxConnections, nonEasynewsToCheck.length),
        healthCheckOpts
      );

      for (const [url, result] of usenetResults.entries()) {
        healthResults.set(resolveOriginalLink(url), result);
      }

      console.log(`✅ Health check complete: ${usenetResults.size} results checked`);

      for (const [nzbUrl, result] of usenetResults.entries()) {
        const originalLink = resolveOriginalLink(nzbUrl);
        const resultTitle = allResults.find(r => r.link === originalLink)?.title || 'Unknown';
        const icon = isVerifiedStatus(result.status) ? '✅' : '🚫';
        console.log(`  ${icon} ${resultTitle.substring(0, 60)}...`);
      }
    }
  }

  // Also auto-mark any remaining EasyNews/Zyclops results (beyond top N) as healthy
  // Skip auto-marking EasyNews if health checks are enabled for them
  let remainingEasynews = 0;
  let remainingZyclops = 0;
  for (const r of allResults) {
    if (r.easynewsMeta && !shouldHealthCheckEasynews && !healthResults.has(r.link)) {
      healthResults.set(r.link, {
        status: 'verified',
        message: 'EasyNews',
        playable: true,
      });
      remainingEasynews++;
    }
    if (r.zyclopsVerified && !healthResults.has(r.link)) {
      healthResults.set(r.link, {
        status: 'verified',
        message: 'Zyclops',
        playable: true,
      });
      remainingZyclops++;
    }
  }
  if (remainingEasynews > 0) {
    console.log(`✅ Auto-verified ${remainingEasynews} remaining EasyNews result(s) beyond inspection window`);
  }
  if (remainingZyclops > 0) {
    console.log(`🤖 Auto-verified ${remainingZyclops} remaining Zyclops result(s) beyond inspection window`);
  }

  // Filter out blocked/error NZBs if hideBlocked is enabled
  if (config.healthChecks.hideBlocked) {
    const beforeCount = allResults.length;
    allResults = allResults.filter(r => {
      const health = healthResults.get(r.link);
      // Keep results that weren't checked or that aren't blocked/error
      return !health || (health.status !== 'blocked' && health.status !== 'error');
    });
    const filteredCount = beforeCount - allResults.length;
    if (filteredCount > 0) {
      console.log(`🚫 Filtered out ${filteredCount} blocked/error NZB(s)`);
    }
  }

  return { healthResults, filteredResults: allResults };
}

/**
 * Auto-mark EasyNews and Zyclops results as verified (even without NNTP health checks).
 * Called both when health checks are disabled and as a final pass after health checks.
 */
export function autoMarkRemainingResults(
  allResults: any[],
  healthResults: Map<string, HealthCheckResult>,
): void {
  const skipEasynewsAutoMark = config.easynewsHealthCheck && config.easynewsMode === 'nzb';
  for (const r of allResults) {
    if (r.easynewsMeta && !skipEasynewsAutoMark && !healthResults.has(r.link)) {
      healthResults.set(r.link, { status: 'verified', message: 'EasyNews', playable: true });
    }
    if (r.zyclopsVerified && !healthResults.has(r.link)) {
      healthResults.set(r.link, { status: 'verified', message: 'Zyclops', playable: true });
    }
  }
}

/**
 * Early auto-queue: start NZBDav download BEFORE health checks complete.
 * Uses the top-ranked search result (without health verification) so the
 * NZBDav download overlaps with health checking, reducing wait time for
 * TV binge mode episode transitions.
 */
export function earlyAutoQueueToNzbdav(
  allResults: any[],
  type: string,
  season?: number,
  episode?: number,
  episodesInSeason?: number,
): void {
  const mode = config.healthChecks?.autoQueueMode;
  if (!config.healthChecks?.enabled || !mode || mode === 'off' || config.streamingMode !== 'nzbdav' || allResults.length === 0) {
    return;
  }

  // Find the first eligible result (skip EasyNews DDL — not NZBs)
  const firstEligible = allResults.find(r => {
    if (r.easynewsMeta && config.easynewsMode !== 'nzb') return false;
    return true;
  });

  if (!firstEligible) return;

  try {
    console.log(`🚀 Early auto-queue (pre-health-check): ${firstEligible.title}`);
    const autoEpParams = firstEligible.isSeasonPack && season !== undefined && episode !== undefined
      ? `&season=${season}&episode=${episode}${episodesInSeason ? `&epcount=${episodesInSeason}` : ''}`
      : '';
    const autoManifestKey = requestContext.getStore()?.manifestKey || '';

    let nzbUrl = firstEligible.link;
    if (firstEligible.easynewsMeta && config.easynewsMode === 'nzb') {
      const meta = firstEligible.easynewsMeta;
      const nzbParams = new URLSearchParams({
        hash: meta.hash, filename: meta.filename, ext: meta.ext,
      });
      if (meta.sig) nzbParams.set('sig', meta.sig);
      nzbUrl = `${BASE_URL}/${autoManifestKey}/easynews/nzb?${nzbParams.toString()}`;
    }

    const proxyUrl = `${BASE_URL}/${autoManifestKey}/nzbdav/stream?nzb=${encodeURIComponent(nzbUrl)}&title=${encodeURIComponent(firstEligible.title)}&type=${type}&indexer=${encodeURIComponent(firstEligible.indexerName)}&auto=true${autoEpParams}`;
    fetch(proxyUrl).catch(err => console.error('❌ Early auto-queue failed:', err));
  } catch (error) {
    console.error('❌ Early auto-queue failed:', error);
  }
}

/**
 * Auto-queue verified results to NZBDav cache.
 * Mode 'top': queue only the first verified result.
 * Mode 'all': queue all verified results in order.
 * Reuses NZB content cached during health checks to avoid extra indexer grabs.
 */
export function autoQueueToNzbdav(
  allResults: any[],
  healthResults: Map<string, HealthCheckResult>,
  type: string,
  season?: number,
  episode?: number,
  episodesInSeason?: number,
): void {
  const mode = config.healthChecks?.autoQueueMode;
  if (!config.healthChecks?.enabled || !mode || mode === 'off' || config.streamingMode !== 'nzbdav' || allResults.length === 0) {
    return;
  }

  const sendToNzbdav = (result: any, reason: string) => {
    try {
      console.log(`🚀 Auto-queueing (${reason}): ${result.title}`);
      const autoEpParams = result.isSeasonPack && season !== undefined && episode !== undefined
        ? `&season=${season}&episode=${episode}${episodesInSeason ? `&epcount=${episodesInSeason}` : ''}`
        : '';
      const autoManifestKey = requestContext.getStore()?.manifestKey || '';

      // For EasyNews NZB mode, construct the NZB proxy URL instead of using easynews:// link
      let nzbUrl = result.link;
      if (result.easynewsMeta && config.easynewsMode === 'nzb') {
        const meta = result.easynewsMeta;
        const nzbParams = new URLSearchParams({
          hash: meta.hash,
          filename: meta.filename,
          ext: meta.ext,
        });
        if (meta.sig) nzbParams.set('sig', meta.sig);
        nzbUrl = `${BASE_URL}/${autoManifestKey}/easynews/nzb?${nzbParams.toString()}`;
      }

      const proxyUrl = `${BASE_URL}/${autoManifestKey}/nzbdav/stream?nzb=${encodeURIComponent(nzbUrl)}&title=${encodeURIComponent(result.title)}&type=${type}&indexer=${encodeURIComponent(result.indexerName)}&auto=true${autoEpParams}`;
      fetch(proxyUrl).catch(err => console.error('❌ Auto-queue failed:', err));
    } catch (error) {
      console.error('❌ Auto-queue to NZBDav failed:', error);
    }
  };

  // Find verified results (skip EasyNews in DDL mode — not NZBs)
  const isVerifiedStatus = (s: string | undefined) =>
    s === 'verified' || s === 'verified_stored' || s === 'verified_archive';

  const isEligible = (r: any) => {
    if (r.easynewsMeta && config.easynewsMode !== 'nzb') return false;
    const health = healthResults.get(r.link);
    return health && isVerifiedStatus(health.status);
  };

  if (mode === 'all') {
    const verified = allResults.filter(isEligible);
    if (verified.length > 0) {
      console.log(`🚀 Auto-queueing all ${verified.length} verified result(s) to NZBDav`);
      verified.forEach((r, i) => sendToNzbdav(r, `verified ${i + 1}/${verified.length}`));
    }
  } else {
    // mode === 'top'
    const firstVerified = allResults.find(isEligible);
    if (firstVerified) {
      sendToNzbdav(firstVerified, 'verified');
    }
  }
}

/**
 * Health Check Pipeline
 *
 * Main orchestration for NZB health checks. Downloads and parses the NZB,
 * classifies files, optionally inspects archive headers, samples segments,
 * and verifies article availability across providers.
 */

import * as net from 'net';
import * as tls from 'tls';
import { downloadArchiveHeader, inspectArchive, hasVideoContent, download7zEndMetadata } from '../archive/index.js';
import type { UsenetProvider } from '../types.js';
import type { HealthCheckResult, HealthCheckOptions } from './types.js';
import { downloadAndParseNzb, CircuitChangedError } from './nzbParser.js';
import { extractFilename, isVideoFile, isCompressedArchive } from './fileClassifier.js';
import { findFirstArchivePart, selectMultiPartSamples, collectAllArchiveSegments } from './archiveGrouper.js';
import { NntpConnectionPool } from './nntpConnection.js';
import { checkArticlesMultiProvider } from './articleChecker.js';

/**
 * Perform health check on an NZB using multiple providers
 */
export async function performHealthCheck(
  nzbUrl: string,
  providers: UsenetProvider[],
  userAgent: string,
  options: HealthCheckOptions = { archiveInspection: true, sampleCount: 3 },
  pool?: NntpConnectionPool
): Promise<HealthCheckResult> {
  // Create a short label for log lines so parallel checks can be distinguished
  // Updated after NZB parsing to use the actual content base name
  let nzbLabel = (() => {
    try {
      const url = new URL(nzbUrl);
      const path = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
      return path.replace(/\.nzb$/i, '').substring(0, 30);
    } catch { return nzbUrl.substring(0, 30); }
  })();
  const log = (msg: string) => console.log(`  [${nzbLabel}] ${msg}`);
  const warn = (msg: string) => console.warn(`  [${nzbLabel}] ${msg}`);

  try {
    // Download and parse NZB
    const { files, password } = await downloadAndParseNzb(nzbUrl, userAgent);

    if (files.length === 0) {
      return {
        status: 'blocked',
        message: 'No files in NZB',
        playable: false,
        password
      };
    }

    // Update label to use actual content name from NZB (more readable than URL hash)
    if (files.length > 0) {
      const firstName = extractFilename(files[0].subject);
      // Strip part numbers and extensions to get a clean base name
      const baseName = firstName.replace(/\.(7z|rar|zip|par2|nfo|sfv|nzb)(\.\d+)?$/i, '')
        .replace(/\.part\d+$/i, '').replace(/\.r\d+$/i, '').replace(/\.\d{3}$/i, '');
      if (baseName.length >= 5) {
        nzbLabel = baseName.substring(0, 25);
      }
    }

    // Check if there are video files
    const videoFiles = files.filter(f => isVideoFile(f.subject));
    const archiveFiles = files.filter(f => isCompressedArchive(f.subject));

    log(`${files.length} files (${videoFiles.length} video, ${archiveFiles.length} archive)`);

    // Determine which file to check
    // For archives, find the first part (.7z.001, .part001.rar, .rar, etc.)
    // since only the first part has the archive header/signature
    let fileToCheck = null;
    let fileType = '';

    if (videoFiles.length > 0) {
      fileToCheck = videoFiles[0];
      fileType = 'video';
    } else if (archiveFiles.length > 0) {
      fileToCheck = findFirstArchivePart(archiveFiles) || archiveFiles[0];
      fileType = 'archive';
    } else {
      // No recognizable video or archive files — may be obfuscated (e.g. EasyNews NZBs)
      // Pick the largest file by total segment bytes and proceed with segment check
      const largest = files.reduce((a, b) => {
        const aSize = a.segments.reduce((s, seg) => s + seg.bytes, 0);
        const bSize = b.segments.reduce((s, seg) => s + seg.bytes, 0);
        return aSize > bSize ? a : b;
      });
      fileToCheck = largest;
      fileType = 'unknown';
      log(`No recognized file types — checking largest file: ${extractFilename(fileToCheck.subject)}`);
    }

    log(`Checking ${fileType}: ${extractFilename(fileToCheck.subject)}`);

    // For archives, inspect the header to determine compression and contents
    // Use first enabled pool provider (or first backup if no pool)
    // Archive inspection can be disabled for faster checks
    let archiveInfo = null;
    if (options.archiveInspection && fileType === 'archive' && fileToCheck.segments.length > 0) {
      const inspectionProvider = providers.find(p => p.enabled && p.type === 'pool')
        || providers.find(p => p.enabled);

      if (inspectionProvider) {
        try {
          log('🔍 Inspecting archive header...');
          const messageIds = fileToCheck.segments.slice(0, 3).map(s => s.messageId);
          // Use pool-acquired socket for archive inspection if pool available
          let inspectionSocket: net.Socket | tls.TLSSocket | undefined;
          if (pool) {
            inspectionSocket = await pool.acquire(inspectionProvider);
          }
          let headerData: Buffer;
          try {
            headerData = await downloadArchiveHeader(messageIds, {
              host: inspectionProvider.host,
              port: inspectionProvider.port,
              useTLS: inspectionProvider.useTLS,
              username: inspectionProvider.username,
              password: inspectionProvider.password
            }, undefined, inspectionSocket);
            // Only release back to pool on success — socket state is clean
            if (inspectionSocket && pool) {
              pool.release(inspectionProvider, inspectionSocket);
              inspectionSocket = undefined;
            }
          } catch (err) {
            // On error, destroy the socket — it may have partial/buffered data
            if (inspectionSocket) {
              try { inspectionSocket.destroy(); } catch {}
              inspectionSocket = undefined;
            }
            throw err;
          }

          archiveInfo = inspectArchive(headerData);

          // For 7z archives, fetch end-of-archive metadata for full file listing
          // Must use ALL segments from ALL parts (in order) since the 7z end header
          // lives at the end of the entire concatenated archive, not just one part
          if (archiveInfo.format === '7z' && archiveInfo.files.length === 0) {
            const allArchiveSegments = collectAllArchiveSegments(archiveFiles);
            log(`[7z] Fetching end metadata (${allArchiveSegments.length} segments across all parts)...`);
            let endSocket: net.Socket | tls.TLSSocket | undefined;
            if (pool) {
              endSocket = await pool.acquire(inspectionProvider);
            }
            try {
              const enhanced = await download7zEndMetadata(
                headerData,
                allArchiveSegments,
                {
                  host: inspectionProvider.host,
                  port: inspectionProvider.port,
                  useTLS: inspectionProvider.useTLS,
                  username: inspectionProvider.username,
                  password: inspectionProvider.password
                },
                endSocket
              );
              if (enhanced) {
                archiveInfo = enhanced;
                log(`[7z] End metadata: ${enhanced.files.length} files, encrypted=${enhanced.encrypted}`);
              }
              // Only release on success — socket state is clean
              if (endSocket && pool) {
                pool.release(inspectionProvider, endSocket);
                endSocket = undefined;
              }
            } catch (err) {
              // On error, destroy socket — it may have partial/buffered data
              if (endSocket) {
                try { endSocket.destroy(); } catch {}
                endSocket = undefined;
              }
              warn(`[7z] End metadata fetch failed: ${(err as Error).message}`);
            }
          }

          log(`Archive: ${archiveInfo.format}, encrypted=${archiveInfo.encrypted}, compression=${archiveInfo.compression}, ${archiveInfo.files.length} files`);
          if (archiveInfo.files.length > 0) {
            log(`  files: ${archiveInfo.files.slice(0, 3).map(f => f.name).join(', ')}`);
          }

          // If encrypted without a known password, block it
          if (archiveInfo.encrypted && !password) {
            log('→ Blocked: encrypted archive (no password)');
            return {
              status: 'blocked',
              message: 'Encrypted archive (no password)',
              playable: false,
            };
          }
          if (archiveInfo.encrypted && password) {
            log(`Encrypted archive — password available, continuing to segment check`);
          }

          // If nested archive, we can't verify what's inside the inner archive
          if (archiveInfo.hasNestedArchive) {
            log('→ Blocked: nested archive');
            return {
              status: 'blocked',
              message: 'Nested archive',
              playable: false,
              password
            };
          }

          if (!hasVideoContent(archiveInfo)) {
            log('→ Blocked: no video files in archive');
            return {
              status: 'blocked',
              message: 'No video files in archive',
              playable: false,
              password
            };
          }
        } catch (err) {
          warn(`⚠️ Archive inspection failed: ${(err as Error).message}`);
        }
      }
    }

    // Sample articles from the selected file
    const segments = fileToCheck.segments;

    if (segments.length === 0) {
      return {
        status: 'blocked',
        message: 'No segments found',
        playable: false,
        password
      };
    }

    // For multi-part archives, spread samples across different parts for better coverage
    // For single video files or single archives, sample within the single file
    let samplesToCheck: string[];
    const multiPartSamples = fileType === 'archive'
      ? selectMultiPartSamples(archiveFiles, options.sampleCount)
      : [];

    if (multiPartSamples.length > 0) {
      samplesToCheck = multiPartSamples;
      log(`Multi-part: sampling across ${samplesToCheck.length} parts`);
    } else {
      // Single-file sampling: spread across segments within the file
      // 3 samples: first, middle, last — faster
      // 7 samples: spread across file at 0%, 20%, 40%, 50%, 60%, 80%, 100% — more thorough
      samplesToCheck = [...new Set(
        (options.sampleCount === 3
          ? [
              segments[0]?.messageId,                                    // First
              segments[Math.floor(segments.length * 0.5)]?.messageId,   // Middle
              segments[segments.length - 1]?.messageId                   // Last
            ]
          : [
              segments[0]?.messageId,                                    // First
              segments[Math.floor(segments.length * 0.2)]?.messageId,   // 20%
              segments[Math.floor(segments.length * 0.4)]?.messageId,   // 40%
              segments[Math.floor(segments.length * 0.5)]?.messageId,   // Middle
              segments[Math.floor(segments.length * 0.6)]?.messageId,   // 60%
              segments[Math.floor(segments.length * 0.8)]?.messageId,   // 80%
              segments[segments.length - 1]?.messageId                   // Last
            ]
        ).filter(Boolean)
      )];
    }

    log(`Checking ${samplesToCheck.length} segments across ${providers.filter(p => p.enabled).length} provider(s)`);

    // Multi-provider check with fallback
    const result = await checkArticlesMultiProvider(providers, samplesToCheck, pool);
    const usedBackup = result.providersUsed.some(p => p.type === 'backup');
    const providerNames = result.providersUsed.map(p => `${p.name} (${p.found}/${p.total})`);

    log(`Result: ${result.totalExists}/${samplesToCheck.length} found (${providerNames.join(', ')})`);

    // All samples exist
    if (result.totalExists === samplesToCheck.length) {
      const backupNote = usedBackup ? ' (with backup)' : '';

      if (fileType === 'video' || fileType === 'unknown') {
        log(`→ Verified${backupNote}`);
        return {
          status: 'verified',
          message: `Verified (${samplesToCheck.length} samples checked${backupNote})`,
          playable: true,
          providersUsed: providerNames,
          password
        };
      } else {
        if (archiveInfo && archiveInfo.compression === 'stored') {
          log(`→ Verified: stored archive${backupNote}`);
          return {
            status: 'verified_stored',
            message: `Stored archive (${samplesToCheck.length} samples checked${backupNote})`,
            playable: true,
            providersUsed: providerNames,
            password
          };
        } else if (archiveInfo && archiveInfo.compression === 'compressed') {
          log(`→ Verified: compressed archive${backupNote}`);
          return {
            status: 'verified_archive',
            message: `Compressed archive (${samplesToCheck.length} samples checked${backupNote})`,
            playable: true,
            providersUsed: providerNames,
            password
          };
        } else {
          log(`→ Verified: archive available${backupNote}`);
          return {
            status: 'verified_archive',
            message: `Archive available (${samplesToCheck.length} samples checked${backupNote})`,
            playable: true,
            providersUsed: providerNames,
            password
          };
        }
      }
    }

    // Some missing — blocked
    if (result.totalMissing > 0) {

      const providerInfo = providerNames.length > 1
        ? ` (checked ${providerNames.length} providers)`
        : '';
      log(`→ Blocked: ${result.totalMissing}/${samplesToCheck.length} missing${providerInfo}`);
      return {
        status: 'blocked',
        message: `Missing ${result.totalMissing} of ${samplesToCheck.length} segments${providerInfo}`,
        playable: false,
        providersUsed: providerNames,
        password
      };
    }

    log('→ Error: unexpected state');
    return {
      status: 'error',
      message: 'Could not verify all articles',
      playable: false,
      providersUsed: providerNames,
      password
    };

  } catch (error) {
    if (error instanceof CircuitChangedError) {
      return {
        status: 'error',
        message: 'Skipped — VPN IP changed',
        playable: false
      };
    }
    const errorMsg = (error as Error).message;
    console.error(`❌ Health check error for ${nzbUrl.substring(0, 100)}:`, errorMsg);
    return {
      status: 'error',
      message: `Check failed: ${errorMsg}`,
      playable: false
    };
  }
}

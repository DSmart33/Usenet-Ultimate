/**
 * NZB Parser
 *
 * Downloads NZB files and parses their XML content.
 * Extracts file lists, segment information, and optional passwords
 * from NZB metadata, URL patterns, and query parameters.
 */

import { parseStringPromise } from 'xml2js';
import { proxyFetch, verifyProxyCircuit, ProxyCircuitAbortError } from '../proxy.js';
import type { NzbFile, NzbParseResult } from './types.js';
import { cacheNzbContent, getCachedNzbContent } from './nzbContentCache.js';

/** Thrown when proxy IP changed between search and grab — grab must be skipped */
export class CircuitChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitChangedError';
  }
}

/**
 * Download and parse an NZB file.
 * Extracts file list and optional password from NZB metadata.
 * `searchExitIp` is the proxy exit IP that was live when this candidate's
 * search ran. verifyProxyCircuit compares against it to detect search/grab
 * IP mismatch.
 */
export async function downloadAndParseNzb(nzbUrl: string, userAgent: string, indexerName?: string, searchExitIp?: string): Promise<NzbParseResult> {
  // Use cached NZB XML if available (populated by prefetchNzb or a prior health check)
  let nzbXml = getCachedNzbContent(nzbUrl);

  if (!nzbXml) {
    // Circuit verification: if the circuit changed since search, skip this
    // health check entirely rather than hitting the indexer with a mismatched IP.
    // Throws a tagged error so callers can distinguish it from real failures.
    try {
      await verifyProxyCircuit(nzbUrl, 'health-check', indexerName, searchExitIp);
    } catch (err) {
      if (err instanceof ProxyCircuitAbortError) {
        console.warn(`🔒 [health-check] Skipping health check: ${err.message} (${new URL(nzbUrl).hostname})`);
        throw new CircuitChangedError(err.message);
      }
      throw err;
    }
    const response = await proxyFetch(nzbUrl, {
      headers: { 'User-Agent': userAgent }
    }, indexerName);

    if (!response.ok) {
      throw new Error(`Failed to download NZB: ${response.status}`);
    }

    nzbXml = await response.text();
    // Cache raw NZB XML so other consumers can reuse it without re-downloading
    cacheNzbContent(nzbUrl, nzbXml);
  }
  const parsed = await parseStringPromise(nzbXml);

  // Extract password from NZB <head> metadata
  let password: string | undefined;
  const headMeta = parsed.nzb?.head?.[0]?.meta;
  if (Array.isArray(headMeta)) {
    for (const meta of headMeta) {
      if (meta.$?.type === 'password' || meta.$?.name === 'password') {
        password = typeof meta === 'string' ? meta : (meta._ || '');
        if (password) {
          console.log(`  [health-check] NZB contains password metadata`);
        }
      }
    }
  }

  // Check URL for password patterns: {{password}} or password=xxx
  if (!password) {
    const braceMatch = nzbUrl.match(/\{\{(.+?)\}\}/);
    if (braceMatch) {
      password = braceMatch[1];
      console.log(`  [health-check] NZB URL contains password pattern`);
    } else {
      try {
        const urlObj = new URL(nzbUrl);
        const urlPassword = urlObj.searchParams.get('password');
        if (urlPassword) {
          password = urlPassword;
          console.log(`  [health-check] NZB URL contains password parameter`);
        }
      } catch { /* ignore invalid URLs */ }
    }
  }

  const files: NzbFile[] = [];

  if (parsed.nzb?.file) {
    for (const file of parsed.nzb.file) {
      const subject = file.$.subject || '';
      const segments: Array<{ messageId: string; bytes: number; number: number }> = [];

      if (file.segments?.[0]?.segment) {
        for (const seg of file.segments[0].segment) {
          segments.push({
            messageId: seg._,
            bytes: parseInt(seg.$.bytes) || 0,
            number: parseInt(seg.$.number) || 0
          });
        }
      }

      files.push({ subject, segments });
    }
  }

  return { files, password };
}

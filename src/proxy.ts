/**
 * HTTP Proxy Support
 *
 * Routes indexer requests through an HTTP proxy to avoid IP-based blocks.
 * Exit IP is monitored and verified between search and grab to detect
 * proxy reconnects.
 *
 * Per-indexer control: Each indexer can be individually toggled to use or
 * bypass the proxy via config.proxyIndexers.
 *
 * IMPORTANT: Node's native fetch() is undici-based and does NOT support
 * the http.Agent option. We provide proxyFetch() which uses https.request
 * with the proxy agent, and getAxiosProxyConfig() for axios calls.
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'https';
import http from 'http';
import { config } from './config/index.js';

// Cache resolved exit IPs
const exitIpCache = new Map<string, string>();

// In-flight dedup: if multiple concurrent requests resolve the same key,
// they share one network call instead of firing duplicates
const exitIpInflight = new Map<string, Promise<string>>();

// HTTP proxy agent (single shared instance)
let proxyAgent: HttpsProxyAgent<string> | null = null;

const PROXY_DEFAULT_URL = '';

// Sentinel cache key for proxy — all traffic shares one tunnel
const PROXY_CACHE_KEY = '__proxy__';

/**
 * Check whether proxy mode is active.
 * Proxy is always disabled when Prowlarr or NZBHydra is the index manager —
 * the manager handles all indexer communication from its own IP, so proxying
 * would create an IP mismatch between search and grab.
 */
function isProxyEnabled(): boolean {
  if (config.indexManager === 'prowlarr' || config.indexManager === 'nzbhydra') return false;
  return !!config.proxyMode && config.proxyMode !== 'disabled';
}

/**
 * Check whether proxy is enabled for a specific indexer.
 */
function isProxyEnabledForIndexer(indexerName: string): boolean {
  if (config.proxyMode === 'disabled' || !config.proxyMode) return false;
  const indexerMap = config.proxyIndexers;
  if (!indexerMap) return true; // default: all indexers proxied
  return indexerMap[indexerName] !== false;
}

/**
 * Get the HTTP proxy agent.
 */
function getProxyAgent(): HttpsProxyAgent<string> {
  const url = config.proxyUrl || PROXY_DEFAULT_URL;
  if (!proxyAgent) {
    proxyAgent = new HttpsProxyAgent(url);
    startKeepalive();
  }
  return proxyAgent;
}

/**
 * Test connectivity through the HTTP proxy.
 * Returns the exit IP if successful.
 */
export async function testProxyConnection(proxyUrl?: string): Promise<{ connected: boolean; ip?: string; error?: string }> {
  const url = proxyUrl || config.proxyUrl || PROXY_DEFAULT_URL;
  try {
    const agent = new HttpsProxyAgent(url);
    const res = await new Promise<{ ip: string }>((resolve, reject) => {
      https.request({
        hostname: 'api.ipify.org',
        path: '/?format=json',
        method: 'GET',
        agent,
        timeout: 10000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ ip: data.ip || 'unknown' });
          } catch { reject(new Error('Invalid response')); }
        });
        res.on('error', reject);
      }).on('error', reject).end();
    });
    return { connected: true, ip: res.ip };
  } catch (error) {
    return { connected: false, error: (error as Error).message };
  }
}

/**
 * Probe the live exit IP through the HTTP proxy (bypasses cache).
 */
function probeLiveProxyIp(agent?: HttpsProxyAgent<string>): Promise<string> {
  const httpAgent = agent || getProxyAgent();
  return new Promise<string>((resolve) => {
    https.request({
      hostname: 'api.ipify.org',
      path: '/?format=json',
      method: 'GET',
      agent: httpAgent,
      timeout: 10000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.ip || 'unknown');
        } catch { resolve('unknown'); }
      });
      res.on('error', () => resolve('unknown'));
    }).on('error', () => resolve('unknown')).end();
  });
}

/**
 * Resolve and cache the proxy exit IP.
 * All traffic shares one tunnel, so we use a single global cache key.
 * Deduplicates concurrent lookups.
 */
async function resolveProxyExitIp(): Promise<string> {
  const cached = exitIpCache.get(PROXY_CACHE_KEY);
  if (cached) return cached;

  const inflight = exitIpInflight.get(PROXY_CACHE_KEY);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const ip = await probeLiveProxyIp();
      exitIpCache.set(PROXY_CACHE_KEY, ip);
      console.log(`🔒 Proxy exit IP → ${ip}`);
      return ip;
    } catch {
      return 'unknown';
    } finally {
      exitIpInflight.delete(PROXY_CACHE_KEY);
    }
  })();

  exitIpInflight.set(PROXY_CACHE_KEY, promise);
  return promise;
}

/**
 * Log the proxy exit IP for a target URL. Resolves once per tunnel, then cached.
 */
export async function logProxyExitIp(targetUrl: string, label: string): Promise<void> {
  if (!isProxyEnabled()) return;
  const hostname = new URL(targetUrl).hostname;
  const ip = await resolveProxyExitIp();
  console.log(`🔒 [${label}] ${hostname} via proxy exit ${ip}`);
}

/**
 * A fetch()-compatible function that routes through the configured proxy.
 * Node's native fetch (undici) doesn't support http.Agent, so we use
 * http/https.request directly and return a Response-like object.
 *
 * If proxy is disabled, falls back to native fetch().
 */
export async function proxyFetch(
  url: string,
  options?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; body?: any }
): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any>; headers: Map<string, string> }> {
  const proxyMode = config.proxyMode || 'disabled';

  // Bypass proxy for disabled mode, local URLs, or internal service URLs
  // (Prowlarr/NZBHydra are internal services whose download-proxy URLs must
  // be reached directly, not through the external HTTP proxy)
  const parsed = new URL(url);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || parsed.hostname.startsWith('127.');
  const isInternalService = (() => {
    try {
      const prowlarrHost = config.prowlarrUrl ? new URL(config.prowlarrUrl).hostname : '';
      const nzbhydraHost = config.nzbhydraUrl ? new URL(config.nzbhydraUrl).hostname : '';
      return (prowlarrHost && parsed.hostname === prowlarrHost)
          || (nzbhydraHost && parsed.hostname === nzbhydraHost);
    } catch { return false; }
  })();
  if (proxyMode === 'disabled' || isLocal || isInternalService) {
    const res = await fetch(url, options);
    const headersMap = new Map<string, string>();
    res.headers.forEach((v, k) => headersMap.set(k, v));
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      text: () => res.text(),
      json: () => res.json(),
      headers: headersMap,
    };
  }

  const agent = getProxyAgent();

  const isHttps = parsed.protocol === 'https:';
  const mod = isHttps ? https : http;

  // If the body is FormData, serialize it to a Buffer with proper multipart headers
  let bodyBuffer: Buffer | string | undefined;
  const headers: Record<string, string> = { ...(options?.headers || {}) };

  if (options?.body instanceof FormData) {
    const boundary = '----ProxyFetchBoundary' + Date.now().toString(36);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const parts: Buffer[] = [];
    for (const [key, value] of options.body.entries()) {
      if (value instanceof Blob) {
        const arrayBuf = await value.arrayBuffer();
        const fileName = (value as File).name || 'file';
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${fileName}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
        ));
        parts.push(Buffer.from(arrayBuf));
        parts.push(Buffer.from('\r\n'));
      } else {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        ));
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    bodyBuffer = Buffer.concat(parts);
    headers['Content-Length'] = bodyBuffer.length.toString();
  } else if (options?.body) {
    bodyBuffer = options.body;
  }

  const maxRedirects = 5;

  const doRequest = (targetUrl: string, redirectCount: number): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any>; headers: Map<string, string> }> => {
    return new Promise((resolve, reject) => {
      const targetParsed = new URL(targetUrl);
      const targetIsHttps = targetParsed.protocol === 'https:';
      const targetMod = targetIsHttps ? https : http;

      // Get a fresh agent for the redirect target
      const targetAgent = getProxyAgent();

      const reqOptions: https.RequestOptions = {
        hostname: targetParsed.hostname,
        port: targetParsed.port || (targetIsHttps ? 443 : 80),
        path: targetParsed.pathname + targetParsed.search,
        method: options?.method || 'GET',
        headers,
        agent: targetAgent,
      };

      const req = targetMod.request(reqOptions, (res) => {
        const status = res.statusCode || 0;

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          // Consume the response body to free the socket
          res.resume();

          if (redirectCount >= maxRedirects) {
            resolve({
              ok: false, status, statusText: res.statusMessage || '',
              text: () => Promise.resolve(''), json: () => Promise.resolve({}),
              headers: new Map(),
            });
            return;
          }

          // Resolve relative redirects against current URL
          const redirectUrl = new URL(res.headers.location, targetUrl).toString();
          console.log(`  ↪️  Redirect ${status} → ${redirectUrl.substring(0, 80)}...`);
          resolve(doRequest(redirectUrl, redirectCount + 1));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const headersMap = new Map<string, string>();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) headersMap.set(k, Array.isArray(v) ? v.join(', ') : v);
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || '',
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
            headers: headersMap,
          });
        });
        res.on('error', reject);
      });

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }

      if (redirectCount === 0 && bodyBuffer) {
        req.write(bodyBuffer);
      }

      req.on('error', reject);
      req.end();
    });
  };

  return doRequest(url, 0);
}

// Dedup concurrent circuit verification probes per hostname —
// prevents rate-limiting when many grabs fire at once
const verifyInflight = new Map<string, Promise<void>>();

/**
 * Verify the proxy exit IP for a URL still matches what we saw during search.
 * If the IP changed, this throws an error to abort the operation — a mismatched
 * IP between search and grab can get the indexer account banned.
 *
 * Concurrent verifications share a single probe.
 * Invalidates stale state so the next search+grab cycle starts fresh.
 */
export async function verifyProxyCircuit(targetUrl: string, label: string): Promise<void> {
  if (!isProxyEnabled()) return;

  const hostname = new URL(targetUrl).hostname;
  const expectedIp = exitIpCache.get(PROXY_CACHE_KEY);
  if (!expectedIp || expectedIp === 'unknown') return;

  if (!proxyAgent) return;

  // Dedup concurrent verifications
  const inflight = verifyInflight.get(PROXY_CACHE_KEY);
  if (inflight) return inflight;

  const promise = (async () => {
    const liveIp = await probeLiveProxyIp();
    if (liveIp === 'unknown') {
      console.warn(`🔒 ⚠️ [${label}] Could not verify VPN IP for ${hostname} — probe returned unknown, proceeding with caution`);
      return;
    }

    if (liveIp === expectedIp) {
      console.log(`🔒 [${label}] VPN IP verified for ${hostname} — exit IP ${liveIp} matches`);
      return;
    }

    // VPN IP changed — clear cached IP so next cycle resolves fresh
    console.error(`🔒 🚫 [${label}] VPN IP changed for ${hostname}: expected ${expectedIp}, got ${liveIp} — ABORTING to protect account`);
    exitIpCache.delete(PROXY_CACHE_KEY);
    throw new Error(`Proxy exit IP changed (expected ${expectedIp}, got ${liveIp}). Grab aborted to prevent account ban. Please retry — the next request will use the new IP.`);
  })();

  verifyInflight.set(PROXY_CACHE_KEY, promise);
  try {
    await promise;
  } finally {
    verifyInflight.delete(PROXY_CACHE_KEY);
  }
}

/**
 * Get an axios httpAgent/httpsAgent config object for the active proxy.
 * Returns empty object if proxy is disabled or disabled for this indexer.
 */
export function getAxiosProxyConfig(targetUrl: string, indexerName?: string): { httpAgent?: HttpsProxyAgent<string>; httpsAgent?: HttpsProxyAgent<string> } {
  if (indexerName && !isProxyEnabledForIndexer(indexerName)) return {};
  if (isProxyEnabled()) {
    const agent = getProxyAgent();
    return { httpAgent: agent, httpsAgent: agent };
  }
  return {};
}

// --- Proxy IP keepalive ---
// Periodically probe exit IPs to detect VPN reconnects/server rotation.
const KEEPALIVE_INTERVAL_MS = 30 * 1000; // 30 seconds
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(async () => {
    if (!isProxyEnabled()) return;

    // Probe the proxy tunnel for IP changes
    if (isProxyEnabled() && proxyAgent) {
      try {
        const ip = await probeLiveProxyIp();
        const previousIp = exitIpCache.get(PROXY_CACHE_KEY);
        if (previousIp && previousIp !== ip && ip !== 'unknown') {
          console.warn(`🔒 ⚠️ VPN IP changed: ${previousIp} → ${ip}`);
          exitIpCache.set(PROXY_CACHE_KEY, ip);
        }
      } catch { /* keepalive failure is non-fatal */ }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref(); // don't prevent process exit
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/**
 * Clear all cached proxy agents and state.
 */
export function clearProxyCache(): void {
  exitIpCache.clear();
  exitIpInflight.clear();
  verifyInflight.clear();
  proxyAgent = null;
  stopKeepalive();
}

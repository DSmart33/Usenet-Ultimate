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
import { createHash } from 'crypto';
import { config } from './config/index.js';
import { requestContext } from './requestContext.js';

/**
 * Deterministic short hash of a proxy egress IP. Used as the stable stamp on
 * search results, fallback candidates, and URL envelopes. The probe site still
 * logs the raw IP for local debugging; only the boundary between "probed
 * value" and "stored value" is hashed, so a leaked URL or shared link does not
 * directly expose the egress IP.
 *
 * 16 hex chars = 64 bits of entropy
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// Cache resolved exit IPs
const exitIpCache = new Map<string, string>();

// HTTP proxy agent (single shared instance)
let proxyAgent: HttpsProxyAgent<string> | null = null;

const PROXY_DEFAULT_URL = '';

// Sentinel cache key for proxy. All traffic shares one tunnel.
const PROXY_CACHE_KEY = '__proxy__';

// Sentinel returned by probeLiveProxyIp when the probe can't determine an IP.
// Never cached as a baseline (verifyProxyCircuit only writes the cache on a
// confirmed-match probe).
const PROBE_UNKNOWN = 'unknown';

/**
 * Thrown by verifyProxyCircuit when the grab must abort to protect the indexer
 * account (IP changed, baseline unavailable, proxy agent torn down, etc.).
 * Callers that walk a candidate list / batch use `instanceof` to break the
 * loop instead of treating it as a per-item failure and retrying the next
 * item against the same (still-broken) proxy state.
 */
export class ProxyCircuitAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyCircuitAbortError';
  }
}

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
 * Two cases force-bypass the HTTP proxy at every layer (search, grab,
 * prefetch, health-check):
 *  - Zyclops-routed indexers: Zyclops IS the proxy for that indexer, so an
 *    HTTP proxy on top would create a double-tunnel and a search/grab IP
 *    mismatch the verifier can't reason about.
 *  - The built-in EasyNews indexer: its searcher, /nzb route, and /resolve
 *    route all call easynews.com directly with no proxy agent attached. The
 *    HTTP proxy is never on the wire for EasyNews traffic, so verifyProxyCircuit
 *    must take the bypass branch instead of firing the "missing baseline"
 *    fan-out on every grab. Guarded by `!indexer` so a user who happens to
 *    name a custom Newznab indexer "EasyNews" is not silently bypassed.
 */
function isProxyEnabledForIndexer(indexerName: string): boolean {
  if (config.proxyMode === 'disabled' || !config.proxyMode) return false;
  const indexer = config.indexers?.find(i => i.name === indexerName);
  if (indexer?.zyclops?.enabled) return false;
  if (!indexer && indexerName.toLowerCase() === 'easynews') return false;
  const indexerMap = config.proxyIndexers;
  if (!indexerMap) return true; // default: all indexers proxied
  return indexerMap[indexerName] !== false;
}

/**
 * Combined gate: should this caller's traffic flow through the proxy?
 * Folds the global enable check together with the per-indexer opt-out.
 */
function isProxyApplicable(indexerName?: string): boolean {
  if (!isProxyEnabled()) return false;
  if (indexerName !== undefined && !isProxyEnabledForIndexer(indexerName)) return false;
  return true;
}

/**
 * URL-based bypass: true when the URL is reached directly (localhost or an
 * internal service like Prowlarr/NZBHydra) and not through the proxy tunnel.
 * Mirrors the bypass branches inside proxyFetch so IP verification and
 * IP logging skip URLs the actual fetch would never proxy.
 */
function isDirectUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.startsWith('127.')) return true;
    const prowlarrHost = config.prowlarrUrl ? new URL(config.prowlarrUrl).hostname : '';
    if (prowlarrHost && host === prowlarrHost) return true;
    const nzbhydraHost = config.nzbhydraUrl ? new URL(config.nzbhydraUrl).hostname : '';
    if (nzbhydraHost && host === nzbhydraHost) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Hide the addon's own deployment hostname in proxy log lines so a shared log
 * doesn't expose the operator's public URL. Indexer hostnames pass through
 * unchanged; only the live request's baseUrl or env-configured BASE_URL
 * is redacted.
 */
function redactOwnHost(hostname: string): string {
  try {
    const reqBase = requestContext.getStore()?.baseUrl;
    if (reqBase && new URL(reqBase).hostname === hostname) return '<addon>';
  } catch { /* ignore parse errors */ }
  if (process.env.BASE_URL) {
    try {
      if (new URL(process.env.BASE_URL).hostname === hostname) return '<addon>';
    } catch { /* ignore */ }
  }
  return hostname;
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
      const req = https.request({
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
            resolve({ ip: data.ip || PROBE_UNKNOWN });
          } catch { reject(new Error('Invalid response')); }
        });
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Proxy connectivity probe timed out after 10s')); });
      req.on('error', reject);
      req.end();
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
    const req = https.request({
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
          resolve(data.ip || PROBE_UNKNOWN);
        } catch { resolve(PROBE_UNKNOWN); }
      });
      res.on('error', () => resolve(PROBE_UNKNOWN));
    });
    req.on('timeout', () => { req.destroy(); resolve(PROBE_UNKNOWN); });
    req.on('error', () => resolve(PROBE_UNKNOWN));
    req.end();
  });
}

/**
 * Probe the host's direct (non-proxied) exit IP and cache it for the lifetime
 * of the process. Used to label bypass logs ("direct exit X.X.X.X") so the
 * operator can see which IP an opted-out indexer's traffic actually used.
 * The host's public IP doesn't change during normal operation, so a single
 * cached value is fine; concurrent callers share one in-flight probe.
 */
let directExitIpCache: string | null = null;
let directExitIpInflight: Promise<string> | null = null;
function probeDirectExitIp(): Promise<string> {
  if (directExitIpCache) return Promise.resolve(directExitIpCache);
  if (directExitIpInflight) return directExitIpInflight;
  directExitIpInflight = new Promise<string>((resolve) => {
    const req = https.request({
      hostname: 'api.ipify.org',
      path: '/?format=json',
      method: 'GET',
      timeout: 10000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.ip || PROBE_UNKNOWN);
        } catch { resolve(PROBE_UNKNOWN); }
      });
      res.on('error', () => resolve(PROBE_UNKNOWN));
    });
    req.on('timeout', () => { req.destroy(); resolve(PROBE_UNKNOWN); });
    req.on('error', () => resolve(PROBE_UNKNOWN));
    req.end();
  }).then(ip => {
    if (ip !== PROBE_UNKNOWN) directExitIpCache = ip;
    directExitIpInflight = null;
    return ip;
  });
  return directExitIpInflight;
}

/**
 * Probes the live proxy exit IP directly (no cache read, no cache write).
 * Call immediately AFTER an outbound indexer request so the stamp reflects
 * the proxy's exit IP at the moment that request completed. Bypassing the
 * cache is required because the cached exit IP is refreshed only by
 * verifyProxyCircuit on a confirmed-match grab, so it would be too stale
 * to stamp on results.
 *
 * Returns undefined when the proxy is bypassed (disabled, per-indexer opt-out,
 * direct URL) or when the probe cannot determine an IP.
 */
export async function probeSearchExitIp(targetUrl: string, label: string, indexerName?: string, silent = false): Promise<string | undefined> {
  if (!isProxyApplicable(indexerName)) {
    if (!silent && indexerName !== undefined && isProxyEnabled() && !isProxyEnabledForIndexer(indexerName)) {
      const hostname = new URL(targetUrl).hostname;
      const directIp = await probeDirectExitIp();
      console.log(`🔓 [${label}] proxy bypassed per indexer setting (${indexerName} → ${redactOwnHost(hostname)}, direct exit ${directIp})`);
    }
    return undefined;
  }
  if (isDirectUrl(targetUrl)) return undefined;
  const ip = await probeLiveProxyIp();
  if (!silent) {
    const hostname = new URL(targetUrl).hostname;
    console.log(`🔒 [${label}] ${redactOwnHost(hostname)} via proxy exit ${ip}`);
  }
  // Hash before returning. The raw IP is logged above for local debugging,
  // but the stamp that travels through result objects and URL envelopes is
  // the 16-char hash. See hashIp() for rationale.
  return ip === PROBE_UNKNOWN ? undefined : hashIp(ip);
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
  options?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; body?: any },
  indexerName?: string
): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any>; headers: Map<string, string> }> {
  // Bypass via the same gates as getAxiosProxyConfig and verifyProxyCircuit
  // so search, verify, and grab decide identically. The earlier ad-hoc check
  // missed config.indexManager === 'prowlarr' | 'nzbhydra' (which isProxyEnabled
  // treats as proxy-off), letting grabs route through the HTTP proxy while the
  // search ran via the manager on a different IP.
  const parsed = new URL(url);
  const proxyBypass = !isProxyApplicable(indexerName);
  const urlDirect = isDirectUrl(url);
  if (proxyBypass || urlDirect) {
    // Manual redirect loop so the fallback matches the proxy path's 5-redirect cap.
    const fallbackMaxRedirects = 5;
    let currentUrl = url;
    let redirectCount = 0;
    while (true) {
      const res = await fetch(currentUrl, { ...options, redirect: 'manual' });
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      const location = res.headers.get('location');
      if (isRedirect && location) {
        if (redirectCount >= fallbackMaxRedirects) {
          const headersMap = new Map<string, string>();
          res.headers.forEach((v, k) => headersMap.set(k, v));
          return {
            ok: false, status: res.status, statusText: res.statusText,
            text: () => Promise.resolve(''), json: () => Promise.resolve({}),
            headers: headersMap,
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        console.log(`  ↪️  Redirect ${res.status} → ${currentUrl.substring(0, 80)}...`);
        redirectCount++;
        continue;
      }
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

  // Per-indexer bypass applies to the entire redirect chain. The indexerName
  // scope is the originating indexer, not the destination host: if the indexer
  // is opted-in to the proxy, every hop here uses it (including any CDN the
  // download URL redirects to).
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

// Dedup concurrent circuit verification probes, keyed by expected IP.
// Concurrent grabs from the same search (same expected IP) share one probe;
// grabs from different searches (different expected IPs) do not collide.
const verifyInflight = new Map<string, Promise<string>>();

// Fire-and-forget the downstream cache clears shared by every rotation-detection
// path (grab-time IP mismatch, grab-time missing baseline, keepalive rotation).
// A rotation stales every pre-rotation stamp, so the next search re-probes and
// re-stamps. Fire-and-forget so the caller's abort/throw surfaces with no latency.
function fanOutRotationClears(): void {
  void import('./addon/index.js').then(m => m.clearSearchCache?.()).catch(err => console.warn('🔒 ⚠️ clearSearchCache failed:', err?.message));
  void import('./nzbdav/fallbackManager.js').then(m => m.clearFallbackGroups?.()).catch(err => console.warn('🔒 ⚠️ clearFallbackGroups failed:', err?.message));
  void import('./nzbdav/ultimateFallback.js').then(m => m.cancelAllUltimateFallbacks?.()).catch(err => console.warn('🔒 ⚠️ cancelAllUltimateFallbacks failed:', err?.message));
}

/**
 * Verify the proxy exit IP for a URL still matches what we saw during search.
 * If the IP changed, this throws an error to abort the operation. A mismatched
 * IP between search and grab can get the indexer account banned.
 *
 * `expectedIp` is the IP that was live when the search producing this grab ran.
 * It must be supplied by the caller (read from `result.searchExitIp` for a
 * grab, or from the CandidateState for an Ultimate Fallback submit). Per-result
 * binding is what protects against a newer search overwriting a global baseline
 * between rotation and grab.
 *
 * Concurrent verifications with the same expected IP share a single probe.
 * Invalidates stale state so the next search+grab cycle starts fresh.
 */
export async function verifyProxyCircuit(targetUrl: string, label: string, indexerName?: string, expectedIp?: string): Promise<void> {
  const proxyBypass = !isProxyApplicable(indexerName);
  const urlDirect = isDirectUrl(targetUrl);

  if (proxyBypass || urlDirect) {
    // If the caller stamped an expectedIp, the search ran through the proxy on
    // that IP. The proxy is no longer applicable here (globally disabled,
    // index-manager swapped, per-indexer flag flipped, or grab URL is direct),
    // so the grab would exit on a different IP than the search. That's the
    // mismatch this function exists to prevent. Abort.
    if (expectedIp) {
      const hostname = new URL(targetUrl).hostname;
      console.error(`🔒 🚫 [${label}] proxy bypass conflicts with stamp ${expectedIp} for ${redactOwnHost(hostname)}, ABORTING to protect account`);
      throw new ProxyCircuitAbortError(`Proxy bypass conflicts with search-time stamp (label: ${label}). Configuration changed between search and grab. Operation aborted to prevent account ban.`);
    }
    if (proxyBypass && indexerName !== undefined && isProxyEnabled() && !isProxyEnabledForIndexer(indexerName)) {
      const hostname = new URL(targetUrl).hostname;
      const directIp = await probeDirectExitIp();
      console.log(`🔓 [${label}] proxy bypassed per indexer setting (${indexerName} → ${redactOwnHost(hostname)}, direct exit ${directIp})`);
    }
    return;
  }

  const hostname = new URL(targetUrl).hostname;
  // expectedIp is always a 16-char hex hash or undefined after hashIp(); the raw
  // PROBE_UNKNOWN string never reaches here (probeSearchExitIp returns undefined
  // for it). Treat any falsy expectedIp as a missing baseline.
  if (!expectedIp) {
    // A missing baseline on a proxy-applicable grab means the search that
    // produced this result couldn't be stamped, which only happens on a
    // mid-search VPN rotation (consensusSearchIp bailed). That rotation also
    // stales every pre-rotation stamp, and the unstamped results are sitting in
    // the search cache. Without the fan-out they replay on every cache hit and
    // stay wedged until TTL; clear downstream so the next search re-stamps fresh.
    console.error(`🔒 🚫 [${label}] VPN IP baseline unavailable for ${redactOwnHost(hostname)}: ABORTING to protect account, invalidating search + fallback caches; retry from a fresh search`);
    fanOutRotationClears();
    throw new ProxyCircuitAbortError(`Proxy exit IP baseline unavailable for ${redactOwnHost(hostname)} (label: ${label}). Operation [${label}] aborted to prevent account ban. Please retry from a fresh search.`);
  }

  if (!proxyAgent) {
    // Caller asserted a specific search-time stamp, but the agent was torn
    // down (clearProxyCache or never initialised). The grab cannot be made
    // safely.
    console.error(`🔒 🚫 [${label}] proxy agent missing for ${redactOwnHost(hostname)} after search asserted stamp ${expectedIp}, ABORTING`);
    throw new ProxyCircuitAbortError(`Proxy agent unavailable (label: ${label}). Operation [${label}] aborted to prevent account ban.`);
  }

  // Concurrent verifies with the same expectedIp share one probe (saves a redundant
  // ipify round-trip), but the success log lives OUTSIDE this dedup so every caller
  // emits one log line with its own label. Without that lift, a multi-candidate UF
  // run only logs the first caller's verify and the rest pass through silently.
  const inflight = verifyInflight.get(expectedIp);
  let liveIp: string;
  if (inflight) {
    liveIp = await inflight;
  } else {
    const promise = (async () => {
      const ip = await probeLiveProxyIp();
      if (ip === PROBE_UNKNOWN) {
        console.error(`🔒 🚫 [${label}] VPN IP probe returned unknown for ${redactOwnHost(hostname)}, ABORTING to protect account`);
        throw new ProxyCircuitAbortError(`Proxy exit IP probe returned unknown (label: ${label}). Operation [${label}] aborted to prevent account ban. Please retry.`);
      }

      // expectedIp is the 16-char hash that was stamped at search time. Hash
      // the live IP and compare. Raw IPs are still logged for local debugging;
      // they only become hashes at this comparison boundary so leaked URLs do
      // not directly expose the egress IP.
      const liveHash = hashIp(ip);
      if (liveHash !== expectedIp) {
        // VPN IP changed. Every result carrying the old hash (this search, plus any
        // persisted fallback groups from before the rotation) would fail the same
        // way, so fan out the downstream clears and let the next search re-stamp on
        // the new IP. fanOutRotationClears is fire-and-forget, so the throw below
        // surfaces to the caller immediately without waiting on the clears.
        console.error(`🔒 🚫 [${label}] VPN IP changed for ${redactOwnHost(hostname)}: live exit IP ${ip} (hash ${liveHash}) does not match stamp ${expectedIp}, ABORTING to protect account`);
        exitIpCache.delete(PROXY_CACHE_KEY);
        fanOutRotationClears();
        throw new ProxyCircuitAbortError(`Proxy exit IP changed (live ${ip} hashes to ${liveHash}, expected stamp ${expectedIp}). Operation [${label}] aborted to prevent account ban. Please retry, the next request will use the new IP.`);
      }

      // verifyProxyCircuit owns this cache's lifecycle: set on confirmed match,
      // delete on rotation (above). The keepalive reads it to detect rotation
      // between ticks; nothing else writes it.
      exitIpCache.set(PROXY_CACHE_KEY, ip);
      return ip;
    })();

    verifyInflight.set(expectedIp, promise);
    try {
      liveIp = await promise;
    } finally {
      verifyInflight.delete(expectedIp);
    }
  }

  console.log(`🔒 [${label}] VPN IP verified for ${redactOwnHost(hostname)}, exit IP ${liveIp} matches stamp`);
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
// Periodically probe the tunnel to detect VPN reconnects / server rotation.
// Telemetry only after the per-result IP fix: verifyProxyCircuit compares the
// live probe against each result's stamped searchExitIp, so the cache is not
// the source of truth for grab verification. Clearing the cache here is a
// hygiene step so the next search re-probes and stamps fresh results.
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
        if (previousIp && previousIp !== ip && ip !== PROBE_UNKNOWN) {
          console.warn(`🔒 ⚠️ VPN IP changed: ${previousIp} → ${ip}, invalidating proxy + search + fallback caches; next search will re-probe`);
          exitIpCache.delete(PROXY_CACHE_KEY);
          // Same fan-out as verifyProxyCircuit's rotation branches: clear
          // downstream caches proactively so the next grab finds fresh
          // stamps instead of eating a bogus "VPN IP changed" abort.
          fanOutRotationClears();
          // Leave verifyInflight alone: it's keyed by expected IP, so any
          // in-flight verifications complete against their own stamped IP.
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
  verifyInflight.clear();
  proxyAgent = null;
  stopKeepalive();
}

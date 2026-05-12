/**
 * SSRF-guarded remote JSON fetcher for the rules importer.
 *
 * Security guards (layered):
 *  - http(s) protocol only
 *  - Hostname block for loopback, link-local, and RFC1918 private ranges
 *    (reuses the same set enforced by /api/favicon at src/routes/auth.ts:113-116)
 *  - 15s wallclock timeout via AbortController
 *  - Content-Length header cap at 1MB
 *  - Streaming size cap as secondary defense (servers can lie about or omit Content-Length)
 */

const MAX_BYTES = 1_048_576;          // 1MB
const TIMEOUT_MS = 15_000;

export class RemoteFetchError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('0.')) return true;
  if (h === '169.254.169.254') return true;                          // AWS metadata
  if (/^169\.254\./.test(h)) return true;                            // link-local
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;            // 172.16.0.0/12
  if (h.endsWith('.local') || h.endsWith('.internal')) return true; // common internal TLDs
  return false;
}

export async function fetchRemoteJson(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteFetchError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RemoteFetchError('Only HTTP(S) URLs are allowed');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new RemoteFetchError('Private, loopback, or internal URLs are not allowed');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/json, text/plain, */*' },
    });
    if (!response.ok) {
      throw new RemoteFetchError(`Upstream returned ${response.status}`, response.status);
    }

    // Cap via Content-Length if advertised
    const cl = response.headers.get('content-length');
    if (cl && Number.isFinite(Number(cl)) && Number(cl) > MAX_BYTES) {
      throw new RemoteFetchError(`Response exceeds ${MAX_BYTES} bytes (Content-Length: ${cl})`);
    }

    // Streaming read with running size cap
    const reader = response.body?.getReader();
    if (!reader) {
      // No stream available — fall back to .text() with a post-read cap
      const text = await response.text();
      if (text.length > MAX_BYTES) {
        throw new RemoteFetchError(`Response exceeds ${MAX_BYTES} bytes`);
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new RemoteFetchError(`Response exceeds ${MAX_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
    return new TextDecoder('utf-8').decode(merged);
  } catch (e: any) {
    if (e instanceof RemoteFetchError) throw e;
    if (e?.name === 'AbortError') throw new RemoteFetchError(`Fetch timed out after ${TIMEOUT_MS}ms`);
    throw new RemoteFetchError(e?.message ?? String(e));
  } finally {
    clearTimeout(timer);
  }
}

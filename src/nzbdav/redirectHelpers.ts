/**
 * Redirect URL helpers for self-redirect chains.
 *
 * The addon uses self-redirects to keep Stremio's HTTP client alive while
 * background work proceeds (UF resolution, candidate iteration, ExoPlayer
 * timer reset). Each redirect target carries two counters:
 *   - rc: how many self-redirects have happened (capped by MAX_SELF_REDIRECTS)
 *   - ci: candidate index to resume at (user-pick fallback iteration)
 *
 * iOS / Infuse handoff truncates URLs at the first `&`, which would drop
 * counters appended as standalone query params. To stay single-param, the
 * counters live INSIDE the existing `?t=<...>` value:
 *
 *   - UF tile envelope (base64url-JSON): `{ sk, fbg?, rc?, ci? }`
 *   - Regular tile (dot-positional): `<fbg>.<idx>.<sk>...<indexerB64>.<rc>.<ci>`
 *     Slots 11/12 (0-indexed 10/11) hold rc/ci; empty when unset.
 *
 * `incrementRedirectCounter` decodes the incoming `t`, mutates rc (and ci
 * when provided), re-encodes, and returns a URL pointing at the same path
 * with ONLY `?t=<new>` as the query. Used by sites 1-3 in streamHandler.ts.
 *
 * Sites 4-5 (user-pick → UF lobby) build a fresh UF envelope rather than
 * mutating an existing one; they call `encodeUfEnvelope` directly.
 *
 * Site 6 (routes/nzbdav.ts WebDAV proxy-error fallback) inlines the
 * dot-positional mutation against a reconstructed URL because its source
 * URL is built from the `_fb` query param, not `req.originalUrl`.
 */

import type { Request } from 'express';
import { resolveBaseUrl } from '../utils/urlHelpers.js';

export type UfEnvelope = { sk: string; fbg?: string; rc?: number; ci?: number };

export function encodeUfEnvelope(p: UfEnvelope): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** Mutate the incoming `?t=<...>` to bump rc by 1 (and set ci when provided),
 *  return a URL pointing at the same path with ONLY `?t=<new>` as the query.
 *  Other incoming query params are intentionally dropped on the redirect; only
 *  `auto=true` ever rides along on a stream-handler request, and even today
 *  it is read once at request entry and not propagated across redirects. */
export function incrementRedirectCounter(req: Request, ciOverride?: number): URL {
  const tRaw = typeof req.query.t === 'string' ? req.query.t : '';
  const isUfTilePath = req.params?.filename === 'ultimate-fallback';

  let newT = tRaw;
  if (isUfTilePath) {
    // UF envelope: base64url-JSON
    let payload: UfEnvelope = { sk: '' };
    try {
      const parsed = JSON.parse(Buffer.from(tRaw, 'base64url').toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.sk === 'string') payload.sk = parsed.sk;
        if (typeof parsed.fbg === 'string') payload.fbg = parsed.fbg;
        if (typeof parsed.rc === 'number' && parsed.rc >= 0 && !Number.isNaN(parsed.rc)) payload.rc = parsed.rc;
        if (typeof parsed.ci === 'number' && parsed.ci >= 0 && !Number.isNaN(parsed.ci)) payload.ci = parsed.ci;
      }
    } catch { /* fall through with empty payload, safe */ }
    payload.rc = (payload.rc ?? 0) + 1;
    if (ciOverride !== undefined) payload.ci = ciOverride;
    newT = encodeUfEnvelope(payload);
  } else {
    // Dot-positional regular tile: 12 slots, last two are rc/ci.
    const parts = tRaw.split('.');
    while (parts.length < 12) parts.push('');
    const rcSlot = 10;
    const ciSlot = 11;
    const currentRc = parts[rcSlot] ? parseInt(parts[rcSlot], 10) : 0;
    parts[rcSlot] = String(Number.isFinite(currentRc) ? currentRc + 1 : 1);
    if (ciOverride !== undefined) parts[ciSlot] = String(ciOverride);
    newT = parts.join('.');
  }

  // Strip the query string from req.originalUrl and re-attach only ?t=<new>.
  const path = (req.originalUrl || '').split('?')[0];
  return new URL(`${resolveBaseUrl(req)}${path}?t=${newT}`);
}

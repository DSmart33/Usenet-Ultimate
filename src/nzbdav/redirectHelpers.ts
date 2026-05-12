/**
 * Tile URL envelope helpers + self-redirect counter mutation.
 *
 * Every tile URL in the addon (regular indexer-result tiles, the UF lobby
 * tile, and the library-delete tiles) is encoded as a single base64url-JSON
 * envelope under the `t` query param. iOS / Infuse handoff truncates URLs
 * at the first `&`, so a single-param URL is the only iOS-safe shape.
 *
 * The schema differs per tile type but the encoding/decoding mechanism is
 * uniform. `parseTilePayload` runs all the per-field type guards in one
 * place; call sites destructure the result without repeating typeof checks.
 *
 * Self-redirect counters (rc, ci) live INSIDE the envelope so they survive
 * iOS truncation along with the rest of the tile state. Sites 1-3 in the
 * stream handler call `incrementRedirectCounter` to bump them on each
 * redirect; site 6 in the WebDAV proxy-error fallback uses
 * `incrementRedirectCounterOnUrl` against a reconstructed URL.
 */

import type { Request } from 'express';
import { resolveBaseUrl } from '../utils/urlHelpers.js';

/** Base64url-encode a JSON-serializable payload. All payload fields must be
 *  JSON-serializable (number, string, boolean, plain object, plain array).
 *  BigInt, Date, Map, Set, and similar non-serializable values throw at
 *  JSON.stringify; the encoder does NOT guard for them. Input type is
 *  Record<string, unknown> rather than the looser `object` so a typo like
 *  `encodeTileEnvelope([...])` fails at compile time. */
export function encodeTileEnvelope(p: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** Decode a `t=` value back to the parsed envelope object. Returns null on
 *  malformed input (missing, not base64url, not JSON, JSON but not a plain
 *  object). The array-rejection check prevents `[1,2,3]` decoding to a
 *  truthy object whose downstream field reads silently return undefined. */
export function decodeTileEnvelope(t: string): Record<string, unknown> | null {
  if (!t) return null;
  try {
    const parsed = JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  return null;
}

/** Typed payload shape for stream-handler tile URLs. Unifies the regular
 *  result-tile fields and the UF tile fields under one schema; per-route
 *  call sites read only the subset they expect. */
export type TilePayload = {
  sk?: string;
  fbg?: string;
  rc?: number;
  ci?: number;
  idx?: number;
  url?: string;
  title?: string;
  indexer?: string;
  season?: number;
  episode?: number;
  seasonpack?: 1;
  epcount?: number;
  /** Aired date (YYYY-MM-DD) for daily/talk-show episodes; enables a date-pattern
   *  fallback when SxxExx fails to locate the right file inside a season pack. */
  aired?: string;
};

/** Single trust-boundary validator. `req.query.t` is user-controllable;
 *  anyone can craft a URL with arbitrary JSON inside the envelope. This
 *  function decodes once and runs all per-field type checks in one place,
 *  returning a typed object the handler destructures cleanly. Each field
 *  that fails validation comes back as undefined. */
export function parseTilePayload(t: string | undefined): TilePayload {
  const raw = typeof t === 'string' ? decodeTileEnvelope(t) : null;
  if (!raw) return {};
  const isNum = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v);
  return {
    sk: typeof raw.sk === 'string' ? raw.sk : undefined,
    fbg: typeof raw.fbg === 'string' ? raw.fbg : undefined,
    rc: isNum(raw.rc) && raw.rc >= 0 ? raw.rc : undefined,
    ci: isNum(raw.ci) && raw.ci >= 0 ? raw.ci : undefined,
    idx: isNum(raw.idx) ? raw.idx : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    indexer: typeof raw.indexer === 'string' ? raw.indexer : undefined,
    season: isNum(raw.season) ? raw.season : undefined,
    episode: isNum(raw.episode) ? raw.episode : undefined,
    seasonpack: raw.seasonpack === 1 ? 1 : undefined,
    epcount: isNum(raw.epcount) ? raw.epcount : undefined,
    aired: typeof raw.aired === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.aired) ? raw.aired.slice(0, 10) : undefined,
  };
}

/** Mutate the incoming `?t=<...>` to bump rc by 1 (and set ci when provided),
 *  return a URL pointing at the same path with ONLY `?t=<new>` as the query.
 *  Other incoming query params are intentionally dropped on the redirect. */
export function incrementRedirectCounter(req: Request, ciOverride?: number): URL {
  const tRaw = typeof req.query.t === 'string' ? req.query.t : '';
  const parsed = decodeTileEnvelope(tRaw) ?? {};
  const next: Record<string, unknown> = { ...parsed };
  const currentRc = typeof next.rc === 'number' && next.rc >= 0 && !Number.isNaN(next.rc) ? next.rc : 0;
  next.rc = currentRc + 1;
  if (ciOverride !== undefined) next.ci = ciOverride;
  const path = (req.originalUrl || '').split('?')[0];
  return new URL(`${resolveBaseUrl(req)}${path}?t=${encodeTileEnvelope(next)}`);
}

/** Variant of incrementRedirectCounter that mutates an arbitrary URL in place.
 *  Used by site 6 (WebDAV proxy-error fallback) where the URL is reconstructed
 *  from the `_fb` query param rather than being the original request URL.
 *  When advanceCi is true, ci is incremented (used for non-404 errors that
 *  should skip the same broken candidate); when false, ci is left as-is. */
export function incrementRedirectCounterOnUrl(url: URL, advanceCi: boolean): void {
  const tRaw = url.searchParams.get('t') ?? '';
  const parsed = decodeTileEnvelope(tRaw) ?? {};
  const next: Record<string, unknown> = { ...parsed };
  const currentRc = typeof next.rc === 'number' && next.rc >= 0 && !Number.isNaN(next.rc) ? next.rc : 0;
  next.rc = currentRc + 1;
  if (advanceCi) {
    const currentCi = typeof next.ci === 'number' && next.ci >= 0 && !Number.isNaN(next.ci) ? next.ci : 0;
    next.ci = currentCi + 1;
  }
  url.searchParams.set('t', encodeTileEnvelope(next));
}

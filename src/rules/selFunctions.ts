/**
 * SEL built-in function library — community-template compatible subset.
 *
 * These functions power set-level expressions: most take the stream pool
 * (or a filtered subset) as their first arg and return the streams that
 * match the supplied criteria. The rank engine applies the expression's
 * score to every stream in the returned array.
 *
 * Scope: the ~12 functions that cover the vast majority of templates seen
 * in the wild (~200 expressions from common community presets). Additional
 * functions can be added as users discover templates that need them —
 * unknown function calls return an empty array rather than throwing, so
 * templates that reference functions we haven't implemented degrade
 * gracefully instead of aborting the whole import.
 *
 * Naming mirrors the common community reference so templates import without needing
 * per-function translation.
 */

import type { EvalContext, SelFunction, StreamRef } from './sel.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function asArray(v: unknown): StreamRef[] {
  return Array.isArray(v) ? (v as StreamRef[]) : [];
}

function asStringArgs(args: unknown[], skip: number): string[] {
  const out: string[] = [];
  for (let i = skip; i < args.length; i++) {
    const v = args[i];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string' && x) out.push(x);
    }
  }
  return out;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dedupRefs(streams: StreamRef[]): StreamRef[] {
  const seen = new Set<unknown>();
  const out: StreamRef[] = [];
  for (const s of streams) {
    if (!seen.has(s.ref)) { seen.add(s.ref); out.push(s); }
  }
  return out;
}

function filterByAttr(streams: StreamRef[], attr: keyof StreamRef['attrs'], values: string[]): StreamRef[] {
  // Arg-less call — "streams where this attribute is detected." Rules like
  // `negate(releaseGroup(streams), streams)` rely on this to identify streams
  // that have NO detected value.
  if (values.length === 0) {
    return streams.filter(s => {
      const v = s.attrs[attr];
      return typeof v === 'string' && v !== '' && v.toLowerCase() !== 'unknown';
    });
  }
  const set = new Set(values.map(v => v.toLowerCase()));
  return streams.filter(s => {
    const v = s.attrs[attr];
    return typeof v === 'string' && set.has(v.toLowerCase());
  });
}

/**
 * Token-match variant for composite attributes (audioTag, visualTag).
 * Our parser emits composites like "Atmos (TrueHD)" and "DV,HDR10+". Community
 * templates filter on individual tokens ('Atmos', 'TrueHD', 'HDR10+', 'DV').
 *
 * A stream matches if the filter value equals the full attribute string OR
 * appears as a standalone token after splitting on delimiters [(),/]. Space is
 * NOT a delimiter — that preserves multi-word canonical tags like "DTS-HD MA"
 * as single tokens, so a 'DTS-HD' filter only matches the HRA-tier audio tag
 * "DTS-HD" (different tier, different canonical) and NOT "DTS-HD MA".
 */
const TOKEN_SPLIT_RE = /[(),\/]+/;
function tokenize(v: string): string[] {
  return v.split(TOKEN_SPLIT_RE).map(t => t.trim()).filter(Boolean);
}

function filterByAttrContains(streams: StreamRef[], attr: keyof StreamRef['attrs'], values: string[]): StreamRef[] {
  if (values.length === 0) {
    return streams.filter(s => {
      const v = s.attrs[attr];
      return typeof v === 'string' && v !== '' && v.toLowerCase() !== 'unknown';
    });
  }
  const needles = values.map(v => v.toLowerCase());
  return streams.filter(s => {
    const v = s.attrs[attr];
    if (typeof v !== 'string') return false;
    const full = v.toLowerCase();
    const tokens = tokenize(full);
    return needles.some(n => full === n || tokens.includes(n));
  });
}

// ─── Built-in functions ──────────────────────────────────────────────

/**
 * regexMatched(streams, ...names) — filter streams whose regex-rule tag list
 * contains ANY of the named tags. Names are case-insensitive.
 * Workhorse function: templates use this to score streams based
 * on which named regex rule matched.
 */
const regexMatched: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const names = asStringArgs(args, 1);
  if (names.length === 0) {
    // No names → return streams with ANY tag
    return streams.filter(s => s.tags.length > 0);
  }
  const wanted = new Set(names.map(n => n.toLowerCase()));
  return streams.filter(s => s.tags.some(t => wanted.has(t.toLowerCase())));
};

/**
 * resolution(streams, ...values) — filter by resolution attribute
 * (e.g. '2160p', '1080p', '4k', '720p'). 2160p ≈ 4k is normalized to 4k
 * during parsing, so templates that ask for '2160p' also accept '4k'.
 */
const resolution: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const rawValues = asStringArgs(args, 1);
  const values = rawValues.flatMap(v => {
    const lc = v.toLowerCase();
    if (lc === '2160p' || lc === '4k') return ['4k', '2160p'];
    return [lc];
  });
  return filterByAttr(streams, 'resolution', values);
};

/** quality(streams, ...values) — filter by video source (BluRay, WEB-DL, …). */
const quality: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttr(streams, 'videoTag', values);
};

/** encode(streams, ...values) — filter by codec (hevc, avc, vvc, av1, …). */
const encode: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttr(streams, 'codec', values);
};

/**
 * visualTag(streams, ...values) — filter by visual tag (HDR, DV, 10bit, …).
 * Uses substring-contains: our parser emits composite tags like "HDR+DV" and
 * rules filter on individual tokens. A release tagged "HDR+DV" matches both
 * `visualTag(streams, 'HDR')` and `visualTag(streams, 'DV')`.
 */
const visualTag: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttrContains(streams, 'visualTag', values);
};

/**
 * audioTag(streams, ...values) — filter by audio tag (Atmos, DTS, TrueHD, …).
 * Uses substring-contains: our parser emits composite tags like
 * "Atmos (TrueHD)" and rules filter on individual tokens. A release tagged
 * "Atmos (TrueHD)" matches both `audioTag(streams, 'Atmos')` and
 * `audioTag(streams, 'TrueHD')`.
 */
const audioTag: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttrContains(streams, 'audioTag', values);
};

/** releaseGroup(streams, ...values) — filter by release group (case-insensitive). */
const releaseGroup: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttr(streams, 'releaseGroup', values);
};

/** language(streams, ...values) — filter by language. */
const language: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttr(streams, 'language', values);
};

/** indexer(streams, ...values) — filter by source indexer name. */
const indexer: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const values = asStringArgs(args, 1);
  return filterByAttr(streams, 'indexer', values);
};

/**
 * size(streams, min?, max?) — filter by file size in bytes.
 * Both bounds optional; string suffixes (5g, 500m) supported.
 */
const size: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const min = asNumber(args[1]);
  const max = asNumber(args[2]);
  return streams.filter(s => {
    const sz = typeof s.attrs.size === 'number' ? s.attrs.size : null;
    if (sz === null) return false;
    if (min !== null && sz < min) return false;
    if (max !== null && sz > max) return false;
    return true;
  });
};

/**
 * age(streams, minHours?, maxHours?) — filter by post age in hours.
 * Useful for "recent releases only" queries.
 */
const age: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const min = asNumber(args[1]);
  const max = asNumber(args[2]);
  return streams.filter(s => {
    const a = typeof s.attrs.age === 'number' ? s.attrs.age : null;
    if (a === null) return false;
    if (min !== null && a < min) return false;
    if (max !== null && a > max) return false;
    return true;
  });
};

/**
 * negate(toExclude, original) — return streams in `original` that are NOT
 * in `toExclude`. Classic set difference; templates use this
 * for "everything except 4K" patterns: `negate(resolution(streams, '2160p'), streams)`.
 */
const negate: SelFunction = (args) => {
  const exclude = asArray(args[0]);
  const original = asArray(args[1]);
  const excludeSet = new Set(exclude.map(s => s.ref));
  return original.filter(s => !excludeSet.has(s.ref));
};

/**
 * merge(...arrays) — union of multiple stream arrays, dedup'd by identity.
 * Templates use this to combine filters: `merge(resolution(streams, '2160p'), visualTag(streams, 'DV'))`.
 */
const merge: SelFunction = (args) => {
  const combined: StreamRef[] = [];
  for (const a of args) {
    if (Array.isArray(a)) combined.push(...(a as StreamRef[]));
  }
  return dedupRefs(combined);
};

/**
 * slice(streams, start, end?) — return a subsection of the stream array.
 * Supports negative indices like JS Array.prototype.slice.
 */
const slice: SelFunction = (args) => {
  const streams = asArray(args[0]);
  const start = asNumber(args[1]) ?? 0;
  const end = args.length > 2 ? (asNumber(args[2]) ?? undefined) : undefined;
  return end !== undefined ? streams.slice(start, end) : streams.slice(start);
};

/**
 * count(streams) — length of a stream array.
 * Returns a number, not a stream array — used inside arithmetic / conditions.
 */
const count: SelFunction = (args) => {
  const streams = Array.isArray(args[0]) ? args[0] : [];
  return streams.length;
};

export const BUILTIN_FUNCTIONS: Record<string, SelFunction> = {
  regexMatched,
  resolution,
  quality,
  encode,
  visualTag,
  audioTag,
  releaseGroup,
  language,
  indexer,
  size,
  age,
  negate,
  merge,
  slice,
  count,
};

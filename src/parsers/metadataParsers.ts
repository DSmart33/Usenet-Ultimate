/**
 * Metadata parsing utilities for release titles.
 *
 * Uses @viren070/parse-torrent-title as the primary parser, with normalization
 * and custom fallbacks where the library has gaps.
 */

import { parseTorrentTitle } from '@viren070/parse-torrent-title';

// ISO 639-1 code → display name mapping for language detection
const LANG_CODE_TO_DISPLAY: Record<string, string> = {
  'en': 'English', 'ja': 'Japanese', 'zh': 'Chinese', 'ru': 'Russian',
  'ar': 'Arabic', 'pt': 'Portuguese', 'es': 'Spanish', 'fr': 'French',
  'de': 'German', 'it': 'Italian', 'ko': 'Korean', 'hi': 'Hindi',
  'bn': 'Bengali', 'pa': 'Punjabi', 'mr': 'Marathi', 'gu': 'Gujarati',
  'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada', 'ml': 'Malayalam',
  'th': 'Thai', 'vi': 'Vietnamese', 'id': 'Indonesian', 'tr': 'Turkish',
  'he': 'Hebrew', 'fa': 'Persian', 'uk': 'Ukrainian', 'el': 'Greek',
  'lt': 'Lithuanian', 'lv': 'Latvian', 'et': 'Estonian', 'pl': 'Polish',
  'cs': 'Czech', 'sk': 'Slovak', 'hu': 'Hungarian', 'ro': 'Romanian',
  'bg': 'Bulgarian', 'sr': 'Serbian', 'hr': 'Croatian', 'sl': 'Slovenian',
  'nl': 'Dutch', 'da': 'Danish', 'fi': 'Finnish', 'sv': 'Swedish',
  'no': 'Norwegian', 'ms': 'Malay', 'es-419': 'Latino', 'zh-tw': 'Chinese',
  'multi audio': 'Multi', 'dual audio': 'Dual Audio', 'multi subs': 'Multi',
};

// ── Parsed metadata type ─────────────────────────────────────────────

export interface ParsedMetadata {
  resolution: string;
  codec: string;
  source: string;
  visualTag: string;
  audioTag: string;
  language: string;
  edition: string;
  releaseGroup: string;
  cleanTitle: string;
}

// ── Core parser — calls library once, normalizes all fields ──────────

export function parseMetadata(title: string): ParsedMetadata {
  // Strip trailing whitespace + dashes so indexer-mangled titles get their
  // release group extracted correctly. Scene convention is `-GROUP` at
  // end-of-title with nothing after; trailing dashes/spaces are always
  // indexer-side formatting artifacts.
  const cleanedTitle = title.replace(/[\s\-]+$/, '');
  const parsed = parseTorrentTitle(cleanedTitle);

  return {
    resolution: parseResolution(parsed, title),
    codec: normalizeCodec(parsed.codec, title),
    source: parseSourceFromLib(parsed, title),
    visualTag: parseVisualFromLib(parsed, title),
    audioTag: parseAudioFromLib(parsed, title),
    language: parseLanguageFromLib(parsed),
    edition: parseEditionFromLib(parsed, title),
    releaseGroup: parsed.group ?? 'Unknown',
    cleanTitle: buildCleanTitle(parsed),
  };
}

// ── Resolution ───────────────────────────────────────────────────────

// Bare resolution numbers without the `p` suffix. Recognized as fallback
// when the library parser misses them and UHD detection also failed.
// Rejects alphanumeric neighbors, so `Show.2160.WEB`, `Show 2160 WEB`,
// and `Show_2160_WEB` match while `Show2160WEB`, `OPUS720Codec`,
// `DTS2160kbps`, and `2160x1440` do not.
const BARE_RESOLUTION_PATTERN = /(?<![A-Za-z0-9])(2160|1440|1080|720)(?![A-Za-z0-9])/;
const BARE_RESOLUTION_MAP: Record<string, string> = {
  '2160': '4k',
  '1440': '1440p',
  '1080': '1080p',
  '720':  '720p',
};

function parseResolution(parsed: any, title: string): string {
  if (!parsed.resolution) {
    if (/\bUHD\b|UHDRip/i.test(title)) return '4k';
    const bareMatch = title.match(BARE_RESOLUTION_PATTERN);
    if (bareMatch) return BARE_RESOLUTION_MAP[bareMatch[1]];
    return 'Unknown';
  }
  const res = parsed.resolution.toLowerCase();
  if (res === '4k' || res === '2160p') return '4k';
  return res;
}

export function parseQuality(title: string): string {
  return parseMetadata(title).resolution;
}

export function resolutionToDisplay(resolution: string): string {
  if (resolution === '4k') return '4K';
  return resolution;
}

// ── Codec ────────────────────────────────────────────────────────────

// VVC / h.266 — parse-torrent-title doesn't recognize these, so detect
// from the raw title before falling back to the library's codec field.
const VVC_PATTERN = /(?:^|[^a-z0-9])(h\.?266|x266|vvc|vvenc)(?:[^a-z0-9]|$)/i;

// VC-1: parse-torrent-title doesn't recognize this Microsoft codec, so detect
// from the raw title before falling back to the library's codec field.
const VC1_PATTERN = /(?:^|[^a-z0-9])(vc-?1)(?:[^a-z0-9]|$)/i;

function normalizeCodec(codec: string | undefined, title?: string): string {
  if (title && VVC_PATTERN.test(title)) return 'vvc';
  if (title && VC1_PATTERN.test(title)) return 'vc1';
  if (!codec) return 'Unknown';
  const c = codec.toLowerCase();
  if (c === 'h265' || c === 'x265') return 'hevc';
  if (c === 'h264' || c === 'x264') return 'avc';
  if (c === 'h266' || c === 'x266' || c === 'vvc' || c === 'vvenc') return 'vvc';
  if (c === 'vc1' || c === 'vc-1') return 'vc1';
  if (c === 'divx' || c === 'dvix') return 'xvid';
  return c;
}

export function parseCodec(title: string): string {
  return parseMetadata(title).codec;
}

// ── Source ────────────────────────────────────────────────────────────

// parse-torrent-title doesn't recognize Digital Cinema Package (DCP) leaks —
// raw projection files dumped from theaters. Detect before library parse.
const DCP_PATTERN = /(?:^|[^a-z0-9])DCP(?:[^a-z0-9]|$)/i;

function parseSourceFromLib(parsed: any, title?: string): string {
  if (title && DCP_PATTERN.test(title)) return 'DCP';
  return parsed.quality ?? 'Unknown';
}

export function parseSource(title: string): string {
  return parseMetadata(title).source;
}

// ── Visual/HDR — normalized to current canonical format ──────────────

// HDR10P / HDR10plus are common sanitized filename spellings that the
// parse-torrent-title library misses. Detect them in the raw title and
// promote to an HDR10+ tag so downstream SEL rules pick them up.
const HDR10_PLUS_ALIAS_PATTERN = /(?:^|[^a-z0-9])(?:HDR10[P]|HDR10plus)\b/i;

function parseVisualFromLib(parsed: any, title: string): string {
  if (parsed.threeD) return '3D';
  // Custom fallback for 3D tag in title when library misses it
  if (/S\d{1,2}(?:E\d{1,2})+[._\s-].*\b(?:BD)?3D\b/i.test(title)) return '3D';

  const libHdr = (parsed.hdr as string[] | undefined) ?? [];
  // Augment the library's HDR list with aliases it doesn't recognise.
  const hdrSet = new Set(libHdr);
  if (HDR10_PLUS_ALIAS_PATTERN.test(title)) hdrSet.add('HDR10+');
  const hdr = [...hdrSet];

  if (hdr.length > 0) {
    const hasDV = hdr.some(h => h === 'DV');
    const otherHdr = hdr.filter(h => h !== 'DV' && h !== 'SDR');

    if (hasDV && otherHdr.length > 0) {
      // Preserve every detected HDR variant alongside DV so SEL rules like
      // `visualTag(streams, 'HDR10+')` match releases that carry DV + HDR10+.
      // Comma-separated so the token matcher in filterByAttrContains picks up
      // each variant independently without ambiguity.
      return ['DV', ...otherHdr].join(', ');
    }
    if (hasDV) return 'DV';
    return hdr[0];
  }

  // Library fields for non-HDR visual tags
  if (parsed.bitDepth === '10bit') return '10bit';
  if (parsed.upscaled) return 'AI';

  return 'Unknown';
}

export function parseVisualTag(title: string): string {
  return parseMetadata(title).visualTag;
}

// Composite visualTags ("DV, HDR10+") have no UI checkbox of their own;
// fold them into the single 'HDR+DV' bucket so that checkbox can disable
// and rank combos. parseVisualTag stays comma-form for the SEL tokenizer.
export function visualTagFilterKey(parsed: string): string {
  return parsed.includes(',') ? 'HDR+DV' : parsed;
}

// ── Audio ────────────────────────────────────────────────────────────
//
// parse-torrent-title collapses DTS variants ("DTS-HD MA" → "DTS Lossy" /
// "DTS Lossless" depending on context) and uses "DDP" for E-AC3. Community
// ranked-rules templates filter on specific tokens: "DTS-HD MA", "DTS:X",
// "DD+", etc. Emit canonical names that match those tokens, pre-detecting
// from the raw title where the library is imprecise.

// `(?=\d|\b)` after each codec name allows channel counts to attach directly
// to the codec token (e.g. DTSMA5.1, MA7.1, TrueHD7.1) — JS \b alone fails
// between a letter and a digit. HD is optional for DTS-HD MA/HRA variants
// because some release names use `DTSMA` / `DTSHRA` without the HD separator.
const AUDIO_PATTERNS: { re: RegExp; token: string }[] = [
  { re: /\bDTS[ ._:-]?X(?=\d|\b)(?!\d{2,})/i,                token: 'DTS:X' },
  { re: /\bDTS[ ._-]?(?:HD[ ._-]?)?MA(?=\d|\b)/i,            token: 'DTS-HD MA' },
  { re: /\bDTS[ ._-]?(?:HD[ ._-]?)?HRA?(?=\d|\b)/i,          token: 'DTS-HD' },
  { re: /\bDTS[ ._-]?ES(?=\d|\b)/i,                          token: 'DTS-ES' },
  { re: /\bDD[+]|\bDDP|\bE[ ._-]?AC3\b/i,                    token: 'DD+' },
  { re: /\bTrueHD(?=\d|\b)/i,                                 token: 'TrueHD' },
  { re: /\bFLAC(?=\d|\b)/i,                                   token: 'FLAC' },
  { re: /\bAtmos(?=\d|\b)/i,                                  token: 'Atmos' },
  { re: /\bDTS(?=\d|\b)/i,                                    token: 'DTS' },
  { re: /\bAC3\b|\bDD\d/i,                                   token: 'DD' },
  { re: /\bAAC(?=\d|\b)/i,                                    token: 'AAC' },
  { re: /\bOpus(?=\d|\b)/i,                                   token: 'Opus' },
  { re: /\bPCM(?=\d|\b)|\bLPCM(?=\d|\b)/i,                   token: 'PCM' },
  { re: /\bMP3(?=\d|\b)/i,                                    token: 'MP3' },
];

function detectAudioTokens(title: string): string[] {
  const found = new Set<string>();
  for (const { re, token } of AUDIO_PATTERNS) {
    if (re.test(title)) found.add(token);
  }
  return [...found];
}

function parseAudioFromLib(parsed: any, title?: string): string {
  // Prefer title-driven detection since the library flattens DTS variants.
  const titleTokens = title ? detectAudioTokens(title) : [];
  const libAudio = (parsed.audio as string[] | undefined) ?? [];
  // Merge library detections into the token set (library may catch nuances
  // the title-regex misses).
  const tokens = new Set(titleTokens);
  for (const t of libAudio) {
    // Normalize library-specific names to canonical tokens
    if (t === 'EAC3' || t === 'DDP') tokens.add('DD+');
    else if (t === 'AC3') tokens.add('DD');
    else tokens.add(t);  // Atmos, TrueHD, FLAC, etc. pass through
  }

  if (tokens.size === 0) return 'Unknown';

  const has = (v: string) => tokens.has(v);

  // Premium combinations (ordered by community scoring tier)
  if (has('Atmos') && has('TrueHD')) return 'Atmos (TrueHD)';
  if (has('Atmos') && has('DD+'))    return 'Atmos (DD+)';
  if (has('Atmos')) {
    // Infer base from source — BluRay-sourced Atmos is almost always TrueHD
    const q = (parsed.quality || '').toLowerCase();
    if (/bluray|remux|bdrip|brrip|uhdrip|bdmux|brmux/.test(q)) return 'Atmos (TrueHD)';
    return 'Atmos (DD+)';
  }

  // Standalone premium codecs (ordered by quality tier)
  if (has('DTS:X'))     return 'DTS:X';
  if (has('TrueHD'))    return 'TrueHD';
  if (has('DTS-HD MA')) return 'DTS-HD MA';
  if (has('DTS-HD'))    return 'DTS-HD';
  if (has('FLAC'))      return 'FLAC';
  if (has('DTS-ES'))    return 'DTS-ES';
  if (has('DD+'))       return 'DD+';
  if (has('DTS'))       return 'DTS';
  if (has('AAC'))       return 'AAC';
  if (has('Opus'))      return 'Opus';
  if (has('DD'))        return 'DD';
  if (has('PCM'))       return 'PCM';
  if (has('MP3'))       return 'MP3';

  // Fallback: first token seen
  return [...tokens][0];
}

export function parseAudioTag(title: string): string {
  return parseMetadata(title).audioTag;
}



// ── Language — already using library ─────────────────────────────────

function parseLanguageFromLib(parsed: any): string {
  try {
    const langs = parsed.languages as string[] | undefined;

    if (!langs || langs.length === 0) {
      return parsed.dubbed ? 'Dubbed' : 'English';
    } else if (langs.includes('multi audio') || langs.includes('multi subs')) {
      return 'Multi';
    } else if (langs.includes('dual audio')) {
      return 'Dual Audio';
    } else if (langs.length > 1) {
      return 'Multi';
    } else {
      return LANG_CODE_TO_DISPLAY[langs[0]] ?? 'Unknown';
    }
  } catch {
    return 'Unknown';
  }
}

export function parseLanguage(title: string): string {
  return parseMetadata(title).language;
}

// ── Edition — normalized to current canonical format ─────────────────

function parseEditionFromLib(parsed: any, title: string): string {
  // Library detects most editions directly
  if (parsed.edition) return parsed.edition;

  // Library boolean flags
  if (parsed.unrated) return 'Unrated';
  if (parsed.uncensored) return 'Uncensored';

  // Custom fallbacks for editions the library misses
  const s = '[\\s._-]*';
  if (new RegExp(`super${s}fan`, 'i').test(title)) return 'Superfan';
  if (/[.\s_-]dc[.\s_-]/i.test(title) || /[.\s_-]dc$/i.test(title)) return "Director's Cut";
  if (new RegExp(`special${s}edition`, 'i').test(title)) return 'Special Edition';

  return 'Standard';
}

export function parseEdition(title: string): string {
  return parseMetadata(title).edition;
}

// ── Release Group ────────────────────────────────────────────────────

export function parseReleaseGroup(title: string): string {
  return parseMetadata(title).releaseGroup;
}

// ── Clean Title ──────────────────────────────────────────────────────

function buildCleanTitle(parsed: any): string {
  let title = parsed.title ?? 'Unknown';
  if (parsed.seasons?.length > 0) {
    const s = String(parsed.seasons[0]).padStart(2, '0');
    if (parsed.episodes?.length > 0) {
      const eps = parsed.episodes.map((e: number) => 'E' + String(e).padStart(2, '0')).join('');
      title += ` S${s}${eps}`;
    } else {
      title += ` S${s}`;
    }
  }
  return title;
}

export function parseCleanTitle(title: string): string {
  return parseMetadata(title).cleanTitle;
}

export function parseYear(title: string): string | undefined {
  return parseTorrentTitle(title).year;
}

/**
 * Detect whether a title represents a season pack (one or more seasons, no
 * episode markers). Used by the rule preview endpoint so SEL `seasonPack()`
 * filters can be tested against a single sample title without going through
 * the full search pipeline that normally tags pack results upstream.
 */
export function parseSeasonPack(title: string): boolean {
  const parsed = parseTorrentTitle(title);
  return (parsed.seasons?.length ?? 0) > 0 && (parsed.episodes?.length ?? 0) === 0;
}

export function buildStreamFilename(title: string, type: string, season?: number, episode?: number): string {
  const parsed = parseCleanTitle(title);
  const year = type === 'movie' ? parseYear(title) : undefined;
  const clean = year ? `${parsed} (${year})` : parsed;
  return type === 'series' && season != null && episode != null
    ? `${parsed.replace(/\s*S\d+$/i, '')} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : clean;
}

// ── Utilities ────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatAge(pubDate: string, now: number): string {
  if (!pubDate) return '';
  const date = new Date(pubDate);
  if (isNaN(date.getTime())) return '';
  const diffMs = now - date.getTime();
  if (diffMs < 0) return '';
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 1) return '<1h';
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.floor(days)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

export function getAgeHours(pubDate: string, now: number): number {
  if (!pubDate) return Infinity;
  const date = new Date(pubDate);
  if (isNaN(date.getTime())) return Infinity;
  const diffMs = now - date.getTime();
  if (diffMs < 0) return Infinity;
  return diffMs / (1000 * 60 * 60);
}

export function formatBitrate(sizeBytes: number, durationSeconds: number): string {
  if (!sizeBytes || !durationSeconds || durationSeconds < 1) return '';
  const bps = (sizeBytes * 8) / durationSeconds;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} Kbps`;
  return `${Math.round(bps)} bps`;
}

export function getBitrateValue(sizeBytes: number, durationSeconds: number | undefined): number {
  if (!sizeBytes || !durationSeconds || durationSeconds < 1) return 0;
  return (sizeBytes * 8) / durationSeconds;
}

export function parseDurationAttr(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // HH:MM:SS or MM:SS
  const parts = trimmed.split(':').map(Number);
  if (parts.length >= 2 && parts.every(p => !isNaN(p))) {
    let seconds: number;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else seconds = parts[0] * 60 + parts[1];
    return seconds >= 60 ? seconds : undefined;
  }
  // Plain number (assume minutes)
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num > 0) {
    const seconds = Math.round(num * 60);
    return seconds >= 60 ? seconds : undefined;
  }
  return undefined;
}

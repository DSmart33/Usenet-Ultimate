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
  const parsed = parseTorrentTitle(title);

  return {
    resolution: parseResolution(parsed, title),
    codec: normalizeCodec(parsed.codec),
    source: parseSourceFromLib(parsed),
    visualTag: parseVisualFromLib(parsed),
    audioTag: parseAudioFromLib(parsed),
    language: parseLanguageFromLib(parsed),
    edition: parseEditionFromLib(parsed, title),
    releaseGroup: parsed.group ?? 'Unknown',
    cleanTitle: buildCleanTitle(parsed),
  };
}

// ── Resolution ───────────────────────────────────────────────────────

function parseResolution(parsed: any, title: string): string {
  if (!parsed.resolution) {
    if (/\bUHD\b|UHDRip/i.test(title)) return '4k';
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

function normalizeCodec(codec: string | undefined): string {
  if (!codec) return 'Unknown';
  const c = codec.toLowerCase();
  if (c === 'h265' || c === 'x265') return 'hevc';
  if (c === 'h264' || c === 'x264') return 'avc';
  if (c === 'divx' || c === 'dvix') return 'xvid';
  return c;
}

export function parseCodec(title: string): string {
  return parseMetadata(title).codec;
}

// ── Source ────────────────────────────────────────────────────────────

function parseSourceFromLib(parsed: any): string {
  return parsed.quality ?? 'Unknown';
}

export function parseSource(title: string): string {
  return parseMetadata(title).source;
}

// ── Visual/HDR — normalized to current canonical format ──────────────

function parseVisualFromLib(parsed: any): string {
  const hdr = parsed.hdr as string[] | undefined;

  if (hdr && hdr.length > 0) {
    const hasDV = hdr.some((h: string) => h === 'DV');
    const hasOtherHDR = hdr.some((h: string) => h !== 'DV' && h !== 'SDR');

    if (hasDV && hasOtherHDR) return 'HDR+DV';
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

// ── Audio — library direct ───────────────────────────────────────────

function parseAudioFromLib(parsed: any): string {
  const audio = parsed.audio as string[] | undefined;
  if (!audio || audio.length === 0) return 'Unknown';

  const hasAtmos = audio.includes('Atmos');
  if (hasAtmos) {
    if (audio.includes('TrueHD')) return 'Atmos (TrueHD)';
    if (audio.includes('DDP') || audio.includes('EAC3')) return 'Atmos (DDP)';
    // Standalone Atmos — infer base layer from source
    const quality = (parsed.quality || '').toLowerCase();
    if (quality.includes('bluray') || quality.includes('remux') || quality.includes('bdrip') || quality.includes('brrip') || quality.includes('uhdrip') || quality.includes('bdmux') || quality.includes('brmux')) {
      return 'Atmos (TrueHD)';
    }
    return 'Atmos (DDP)';
  }

  const primary = audio[0];
  if (primary === 'EAC3') return 'DDP';
  if (primary === 'AC3') return 'DD';
  return primary;
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

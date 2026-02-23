/**
 * Metadata parsing utilities for release titles.
 *
 * Extracts quality, source, codec, visual tags, audio tags, language,
 * edition, release group, clean title, and provides byte formatting.
 */

export function parseQuality(title: string): string {
  const titleLower = title.toLowerCase();

  if (titleLower.includes('2160p') || titleLower.includes('4k')) return '2160p';
  if (titleLower.includes('1440p')) return '1440p';
  if (titleLower.includes('1080p')) return '1080p';
  if (titleLower.includes('720p')) return '720p';
  if (titleLower.includes('576p')) return '576p';
  if (titleLower.includes('480p')) return '480p';
  if (titleLower.includes('360p')) return '360p';
  if (titleLower.includes('240p')) return '240p';
  if (titleLower.includes('144p')) return '144p';

  return 'Unknown';
}

export function resolutionToDisplay(resolution: string): string {
  const resMap: Record<string, string> = {
    '2160p': '4K',
    '1440p': '2K',
    '1080p': 'FHD',
    '720p': 'HD',
    '576p': 'SD',
    '480p': 'SD',
    '360p': 'SD',
    '240p': 'SD',
    '144p': 'SD',
    'Unknown': 'Unknown'
  };
  return resMap[resolution] || resolution;
}

export function parseCodec(title: string): string {
  const titleLower = title.toLowerCase();

  if (titleLower.includes('av1')) return 'AV1';
  if (titleLower.includes('hevc') || titleLower.includes('h265') || titleLower.includes('x265')) return 'HEVC';
  if (titleLower.includes('h264') || titleLower.includes('x264') || titleLower.includes('avc')) return 'AVC';
  if (titleLower.includes('xvid')) return 'Unknown';

  return 'Unknown';
}

export function parseSource(title: string): string {
  const titleLower = title.toLowerCase();

  // Check for BluRay REMUX first (most specific)
  if ((titleLower.includes('bluray') || titleLower.includes('blu-ray')) && titleLower.includes('remux')) return 'BluRay REMUX';
  if (titleLower.includes('remux')) return 'BluRay REMUX';
  if (titleLower.includes('bluray') || titleLower.includes('blu-ray')) return 'BluRay';
  if (titleLower.includes('web-dl') || titleLower.includes('webdl')) return 'WEB-DL';
  if (titleLower.includes('webrip')) return 'WEBRip';
  if (titleLower.includes('hdrip')) return 'HDRip';
  if (titleLower.includes('hc') && (titleLower.includes('hdrip') || titleLower.includes('hd-rip'))) return 'HC HD-Rip';
  if (titleLower.includes('dvdrip')) return 'DVDRip';
  if (titleLower.includes('hdtv')) return 'HDTV';

  return 'Unknown';
}

export function parseVisualTag(title: string): string {
  const titleLower = title.toLowerCase();

  // Check for DV variants (most specific first)
  if ((titleLower.includes('dv') || titleLower.includes('dolby') && titleLower.includes('vision')) &&
      (titleLower.includes('hdr10+') || titleLower.includes('hdr10plus'))) return 'HDR+DV';
  if (titleLower.includes('dv') || (titleLower.includes('dolby') && titleLower.includes('vision'))) return 'DV';

  // Check for HDR variants
  if (titleLower.includes('hdr10+') || titleLower.includes('hdr10plus')) return 'HDR10+';
  if (titleLower.includes('hdr10')) return 'HDR10';
  if (titleLower.includes('hdr')) return 'HDR';

  // Check for other visual tags
  if (titleLower.includes('imax')) return 'IMAX';
  if (titleLower.includes('10bit') || titleLower.includes('10-bit')) return '10bit';
  if (titleLower.includes(' ai ') || titleLower.includes('.ai.')) return 'AI';
  if (titleLower.includes('sdr')) return 'SDR';

  return 'Unknown';
}

export function parseAudioTag(title: string): string {
  const titleLower = title.toLowerCase();

  // Check for advanced audio formats
  if (titleLower.includes('atmos')) return 'Atmos';
  if (titleLower.includes('dts:x') || titleLower.includes('dtsx')) return 'DTS:X';
  if (titleLower.includes('dts-hd ma') || titleLower.includes('dts-hd.ma')) return 'DTS-HD MA';
  if (titleLower.includes('truehd')) return 'TrueHD';
  if (titleLower.includes('dts-hd') || titleLower.includes('dtshd')) return 'DTS-HD';
  if (titleLower.includes('dd+') || titleLower.includes('ddp') || titleLower.includes('eac3')) return 'DD+';
  if (titleLower.includes('dd5') || titleLower.includes('dd2') || titleLower.includes('ac3')) return 'DD';

  return 'Unknown';
}

export function parseLanguage(title: string): string {
  const t = title.toLowerCase();

  // Word-boundary helper: matches the term surrounded by common separators or string edges
  const wb = (pattern: string) => new RegExp(`(?:^|[\\s.\\-_\\[\\(])(?:${pattern})(?:$|[\\s.\\-_\\]\\)])`, 'i');

  // Multi/Dual/Dubbed first (broad tags)
  if (wb('multi').test(t)) return 'Multi';
  if (wb('dual[.\\-_ ]?(audio|lang(uage)?|flac|ac3|aac2?)').test(t)) return 'Dual Audio';
  if (wb('dub(s|bed|bing)?').test(t)) return 'Dubbed';

  // Specific languages — ordered by global prevalence
  if (wb('english|eng').test(t)) return 'English';
  if (wb('japanese|jap|jpn').test(t)) return 'Japanese';
  if (wb('chinese|chi').test(t)) return 'Chinese';
  if (wb('russian|rus').test(t)) return 'Russian';
  if (wb('arabic|ara').test(t)) return 'Arabic';
  if (wb('portuguese').test(t)) return 'Portuguese';
  if (wb('spanish|spa|esp').test(t)) return 'Spanish';
  if (wb('french|fra|vf|vff|vfi|vf2|vfq|truefrench').test(t)) return 'French';
  if (wb('deu(tsch)?(land)?|ger(man)?').test(t)) return 'German';
  if (wb('italian|ita').test(t)) return 'Italian';
  if (wb('korean|kor').test(t)) return 'Korean';
  if (wb('hindi|hin').test(t)) return 'Hindi';
  if (wb('bengali|ben(?![.\\-_ ]?the[.\\-_ ]?men)').test(t)) return 'Bengali';
  if (wb('punjabi|pan').test(t)) return 'Punjabi';
  if (wb('marathi|mar').test(t)) return 'Marathi';
  if (wb('gujarati|guj').test(t)) return 'Gujarati';
  if (wb('tamil|tam').test(t)) return 'Tamil';
  if (wb('telugu|tel').test(t)) return 'Telugu';
  if (wb('kannada|kan').test(t)) return 'Kannada';
  if (wb('malayalam|mal').test(t)) return 'Malayalam';
  if (wb('thai|tha').test(t)) return 'Thai';
  if (wb('vietnamese|vie').test(t)) return 'Vietnamese';
  if (wb('indonesian|ind').test(t)) return 'Indonesian';
  if (wb('turkish|tur').test(t)) return 'Turkish';
  if (wb('hebrew|heb').test(t)) return 'Hebrew';
  if (wb('persian|per').test(t)) return 'Persian';
  if (wb('ukrainian|ukr').test(t)) return 'Ukrainian';
  if (wb('greek|ell').test(t)) return 'Greek';
  if (wb('lithuanian|lit').test(t)) return 'Lithuanian';
  if (wb('latvian|lav').test(t)) return 'Latvian';
  if (wb('estonian|est').test(t)) return 'Estonian';
  if (wb('polish|pol').test(t)) return 'Polish';
  if (wb('czech|cze').test(t)) return 'Czech';
  if (wb('slovak|slo').test(t)) return 'Slovak';
  if (wb('hungarian|hun').test(t)) return 'Hungarian';
  if (wb('romanian|rum').test(t)) return 'Romanian';
  if (wb('bulgarian|bul').test(t)) return 'Bulgarian';
  if (wb('serbian|srp').test(t)) return 'Serbian';
  if (wb('croatian|hrv').test(t)) return 'Croatian';
  if (wb('slovenian|slv').test(t)) return 'Slovenian';
  if (wb('dutch|dut').test(t)) return 'Dutch';
  if (wb('danish|dan').test(t)) return 'Danish';
  if (wb('finnish|fin').test(t)) return 'Finnish';
  if (wb('swedish|swe').test(t)) return 'Swedish';
  if (wb('norwegian|nor').test(t)) return 'Norwegian';
  if (wb('malay').test(t)) return 'Malay';
  if (wb('latino|lat').test(t)) return 'Latino';

  return 'Unknown';
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function parseEdition(title: string): string {
  const titleLower = title.toLowerCase();
  // Release titles use dots/underscores/dashes as word separators (e.g., "Directors.Cut")
  // so all multi-word patterns must allow [\s._-]* between words, not just \s*
  const s = '[\\s._-]*'; // separator pattern

  // Check for superfan variants (most specific first)
  if (new RegExp(`super${s}fan`, 'i').test(title)) return 'Superfan';

  // Director's cut variants
  if (new RegExp(`director'?s?${s}cut`, 'i').test(title)) return "Director's Cut";
  // DC as edition (only when surrounded by separators to avoid false positives)
  if (/[.\s_-]dc[.\s_-]/i.test(title) || /[.\s_-]dc$/i.test(title)) return "Director's Cut";

  // Extended variants
  if (new RegExp(`extended${s}(edition|cut)`, 'i').test(title)) return 'Extended';
  if (/[.\s_-]extended[.\s_-]/i.test(title) || /[.\s_-]extended$/i.test(title)) return 'Extended';

  // Unrated / Uncut
  if (titleLower.includes('unrated')) return 'Unrated';
  if (titleLower.includes('uncut')) return 'Uncut';

  // Special Edition
  if (new RegExp(`special${s}edition`, 'i').test(title)) return 'Special Edition';

  // Theatrical
  if (titleLower.includes('theatrical')) return 'Theatrical';

  // Remastered
  if (titleLower.includes('remastered')) return 'Remastered';

  // IMAX Edition (distinct from visual IMAX tag - only when explicitly "imax edition")
  if (new RegExp(`imax${s}edition`, 'i').test(title)) return 'IMAX Edition';

  // Collector's Edition
  if (new RegExp(`collector'?s?${s}(edition|cut)?`, 'i').test(title)) return "Collector's Edition";

  return 'Standard';
}

export function parseReleaseGroup(title: string): string {
  // Release group is typically at the end after a dash, e.g., "-GROUPE" or "[GROUPE]"
  const dashMatch = title.match(/-([A-Za-z0-9]+)$/);
  if (dashMatch) return dashMatch[1];

  const bracketMatch = title.match(/\[([A-Za-z0-9]+)\]$/);
  if (bracketMatch) return bracketMatch[1];

  return 'Unknown';
}

export function parseCleanTitle(title: string): string {
  // Remove common release tags, resolution, quality markers, etc.
  // Goal: extract just the content name (+ season/episode markers) since all metadata is shown in dedicated elements
  let clean = title;

  // Remove year in parentheses or brackets
  clean = clean.replace(/[\(\[]\d{4}[\)\]]/g, '');

  // Remove bare year (standalone 19xx/20xx not in brackets)
  clean = clean.replace(/[\.\s](19|20)\d{2}[\.\s]/g, '.');

  // Remove resolution tags
  clean = clean.replace(/\b(2160p|1440p|1080p|720p|576p|480p|360p|240p|144p|4K|UHD)\b/gi, '');

  // Remove source tags
  clean = clean.replace(/\b(BluRay|Blu-ray|WEB-DL|WEBDL|WEBRip|HDRip|HC[\.\s]?HD-?Rip|DVDRip|HDTV|REMUX)\b/gi, '');

  // Remove codec tags
  clean = clean.replace(/\b(AV1|HEVC|H\.?265|x265|H\.?264|x264|AVC|XviD)\b/gi, '');

  // Remove HDR/visual tags
  clean = clean.replace(/\b(DV|Dolby[\s\.]?Vision|HDR10\+?|HDR|IMAX|10bit|10-bit|AI|SDR)\b/gi, '');

  // Remove audio tags
  clean = clean.replace(/\b(Atmos|DTS:?X|DTS-HD\.?MA|TrueHD|DTS-HD|DD\+?|EAC3|AC3|AAC)\b/gi, '');

  // Remove audio channel info (5.1, 7.1, 2.0, etc.)
  clean = clean.replace(/\b\d\.\d\b/g, '');

  // Remove edition tags (already shown in dedicated Edition element)
  clean = clean.replace(/\b(Remastered|Director'?s[\.\s]?Cut|Extended|Unrated|Uncut|Special[\.\s]?Edition|Theatrical|Collector'?s[\.\s]?Edition|Superfan|IMAX[\.\s]?Edition)\b/gi, '');

  // Remove series noise
  clean = clean.replace(/\b(Complete[\.\s]?Series|Complete)\b/gi, '');

  // Remove HC (hardcoded subs marker)
  clean = clean.replace(/\bHC\b/g, '');

  // Remove release group at end
  clean = clean.replace(/-[A-Za-z0-9]+$/, '');
  clean = clean.replace(/\[[A-Za-z0-9]+\]$/, '');

  // Remove extra dots, dashes, underscores and clean up
  clean = clean.replace(/\./g, ' ');
  clean = clean.replace(/[_\-]+/g, ' ');
  clean = clean.replace(/\s+/g, ' ');
  clean = clean.trim();

  return clean || 'Unknown';
}

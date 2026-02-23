/**
 * Archive Grouper
 *
 * Groups multi-part archive files into sets, selects sample segments
 * spread across parts, identifies first archive parts for header inspection,
 * and collects all segments from split archives in proper order.
 */

import type { NzbFile } from './types.js';
import { extractFilename } from './fileClassifier.js';

/**
 * Group archive files into multi-part sets by recognizing naming patterns.
 * Returns the largest group of related parts, sorted by part number.
 */
export function groupArchiveParts(archiveFiles: NzbFile[]): NzbFile[][] {
  const groups = new Map<string, { file: NzbFile; order: number }[]>();

  for (const file of archiveFiles) {
    const filename = extractFilename(file.subject).toLowerCase();
    let baseName: string | null = null;
    let partNum = 0;

    // .part001.rar, .part002.rar, etc.
    const partRar = filename.match(/^(.+)\.part(\d+)\.rar$/);
    if (partRar) { baseName = partRar[1]; partNum = parseInt(partRar[2]); }

    // .rar + .r00, .r01, .r02, etc. (old-style)
    if (!baseName) {
      const rNN = filename.match(/^(.+)\.r(\d{2,3})$/);
      if (rNN) { baseName = rNN[1]; partNum = parseInt(rNN[2]) + 1; } // +1 so .rar is part 0
      else if (filename.endsWith('.rar')) {
        baseName = filename.replace(/\.rar$/, '');
        partNum = 0;
      }
    }

    // .7z.001, .7z.002, etc.
    if (!baseName) {
      const sevenZ = filename.match(/^(.+)\.7z\.(\d{3})$/);
      if (sevenZ) { baseName = sevenZ[1]; partNum = parseInt(sevenZ[2]); }
    }

    // .zip.001, .zip.002, etc.
    if (!baseName) {
      const zipSplit = filename.match(/^(.+)\.zip\.(\d{3})$/);
      if (zipSplit) { baseName = zipSplit[1]; partNum = parseInt(zipSplit[2]); }
    }

    // Generic split: .001, .002, etc. (including obfuscated hex names)
    if (!baseName) {
      const generic = filename.match(/^(.+)\.(\d{3})$/);
      if (generic) { baseName = generic[1]; partNum = parseInt(generic[2]); }
    }

    if (baseName) {
      if (!groups.has(baseName)) groups.set(baseName, []);
      groups.get(baseName)!.push({ file, order: partNum });
    }
  }

  // Return all groups sorted by size (largest first), each sorted by part number
  return [...groups.values()]
    .filter(g => g.length > 1) // only multi-part groups
    .sort((a, b) => b.length - a.length)
    .map(g => g.sort((a, b) => a.order - b.order).map(e => e.file));
}

/**
 * Select sample segments spread across multiple archive parts.
 * Picks first segment from evenly-spaced parts, filling remaining
 * from the largest part using percentage-spread.
 */
export function selectMultiPartSamples(
  archiveFiles: NzbFile[],
  sampleCount: 3 | 7
): string[] {
  const partGroups = groupArchiveParts(archiveFiles);

  // If no multi-part groups found, fall back to single-file sampling
  if (partGroups.length === 0) return [];

  const parts = partGroups[0]; // largest group
  if (parts.length <= 1) return [];

  const samples: string[] = [];

  // Pick first segment from evenly-spaced parts
  const partCount = Math.min(parts.length, sampleCount);
  const step = parts.length / partCount;
  for (let i = 0; i < partCount; i++) {
    const partIndex = Math.min(Math.floor(i * step), parts.length - 1);
    const part = parts[partIndex];
    if (part.segments.length > 0) {
      samples.push(part.segments[0].messageId);
    }
  }

  // If we have fewer samples than sampleCount, fill from largest part using percentage-spread
  if (samples.length < sampleCount) {
    const largest = parts.reduce((a, b) => a.segments.length > b.segments.length ? a : b);
    const remaining = sampleCount - samples.length;
    const segs = largest.segments;
    for (let i = 0; i < remaining; i++) {
      const pct = (i + 1) / (remaining + 1);
      const idx = Math.floor(segs.length * pct);
      const id = segs[idx]?.messageId;
      if (id && !samples.includes(id)) {
        samples.push(id);
      }
    }
  }

  return [...new Set(samples)];
}

/**
 * Find the first part of a split archive set.
 * Only the first part has the archive signature/header needed for inspection.
 * Returns null if no recognizable first part is found.
 */
export function findFirstArchivePart(archiveFiles: NzbFile[]): NzbFile | null {
  for (const file of archiveFiles) {
    const filename = extractFilename(file.subject).toLowerCase();
    // .7z.001 — first 7z split part
    if (/\.7z\.001$/.test(filename)) return file;
    // .part001.rar or .part01.rar — first RAR new-style split
    if (/\.part0*1\.rar$/.test(filename)) return file;
    // .zip.001 — first ZIP split part
    if (/\.zip\.001$/.test(filename)) return file;
    // .001 — first generic split part
    if (/\.001$/.test(filename)) return file;
    // Single .rar (no .partNNN, no .rNN) — the main RAR file
    if (/\.rar$/.test(filename) && !/\.part\d+\.rar$/.test(filename)) return file;
    // Single .7z (no .NNN suffix) — non-split 7z
    if (/\.7z$/.test(filename)) return file;
    // Single .zip (no .NNN suffix) — non-split zip
    if (/\.zip$/.test(filename)) return file;
  }
  return null;
}

/**
 * Collect all segments from all parts of a split archive, in part order.
 * Needed for 7z end-of-archive metadata which spans the entire archive.
 */
export function collectAllArchiveSegments(archiveFiles: NzbFile[]): Array<{ messageId: string; bytes: number; number: number }> {
  const partGroups = groupArchiveParts(archiveFiles);
  if (partGroups.length === 0) {
    // Not a recognized multi-part set — return segments from the first file
    return archiveFiles[0]?.segments || [];
  }
  // Largest group (already sorted by part number from groupArchiveParts)
  const parts = partGroups[0];
  const allSegments: Array<{ messageId: string; bytes: number; number: number }> = [];
  let globalSegNum = 1;
  for (const part of parts) {
    // Sort segments within each part by number
    const sorted = [...part.segments].sort((a, b) => a.number - b.number);
    for (const seg of sorted) {
      allSegments.push({ messageId: seg.messageId, bytes: seg.bytes, number: globalSegNum++ });
    }
  }
  return allSegments;
}

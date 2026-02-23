/**
 * File Classifier
 *
 * Classifies files from NZB subject lines as video, archive, or other.
 * Handles filename extraction from various subject line formats,
 * video extension detection, and compressed archive recognition
 * (including multi-part RAR, 7z, ZIP, and obfuscated filenames).
 */

/**
 * Extract filename from NZB subject line
 * Handles formats like:
 *   [1/50] - "Movie.2024.mkv" yEnc (1/245)
 *   Movie.2024.mkv.part001.rar (1/96)
 */
export function extractFilename(subject: string): string {
  // Try to extract filename from quotes first (ignore empty quotes like "")
  const quoteMatch = subject.match(/"([^"]+)"/);
  if (quoteMatch && quoteMatch[1].trim()) {
    return quoteMatch[1];
  }

  // Try to extract a filename with a known extension from square brackets
  // Handles patterns like: [Group]-[Filename.mkv]-[1/15] - "" yEnc
  const bracketMatch = subject.match(/\[([^\]]+\.(mkv|mp4|avi|m4v|ts|m2ts|wmv|webm|mov|mpg|mpeg|rar|r\d{2,}|zip|7z))\]/i);
  if (bracketMatch) {
    return bracketMatch[1];
  }

  // No quotes or brackets - clean up the subject line
  // Remove leading brackets like [01/47] and trailing segment info like (1/96)
  let cleaned = subject
    .replace(/^\s*\[\d+\/\d+\]\s*-?\s*/i, '')  // Remove [01/47] - prefix
    .replace(/\s+yEnc\s*\(\d+\/\d+\)$/i, '')   // Remove yEnc (1/96) suffix
    .replace(/\s*\(\d+\/\d+\)$/i, '')          // Remove (1/96) suffix
    .trim();

  return cleaned;
}

/**
 * Check if a file is a video file based on extension
 * Excludes sample files which are preview clips, not the actual content
 */
export function isVideoFile(subject: string): boolean {
  const videoExtensions = ['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.m2ts', '.wmv', '.webm', '.mov', '.mpg', '.mpeg'];
  const filename = extractFilename(subject).toLowerCase();

  // Skip sample files - these are preview clips, not the actual episode/movie
  if (filename.includes('sample')) {
    return false;
  }

  // Check if filename ends with a video extension
  return videoExtensions.some(ext => filename.endsWith(ext));
}

/**
 * Check if a file is a compressed archive
 * Excludes .par2 parity files, .nfo info files, and .sfv checksum files
 */
export function isCompressedArchive(subject: string): boolean {
  const filename = extractFilename(subject).toLowerCase();

  // Exclude common non-archive files
  if (filename.endsWith('.par2') || filename.endsWith('.nfo') || filename.endsWith('.sfv') ||
      filename.endsWith('.txt') || filename.endsWith('.srt') || filename.endsWith('.idx') || filename.endsWith('.sub')) {
    return false;
  }

  // Check for single-file archive extensions
  const archiveExtensions = ['.rar', '.zip', '.7z', '.tar', '.gz', '.bz2'];
  if (archiveExtensions.some(ext => filename.endsWith(ext))) {
    return true;
  }

  // Check for multi-part RAR files: .r00, .r01, .r02, etc.
  if (/\.r\d{2,3}$/.test(filename)) {
    return true;
  }

  // Check for multi-part 7z files: .7z.001, .7z.002, etc.
  if (/\.7z\.\d{3}$/.test(filename)) {
    return true;
  }

  // Check for multi-part zip files: .zip.001, .zip.002, etc.
  if (/\.zip\.\d{3}$/.test(filename)) {
    return true;
  }

  // Check for .partXX.rar pattern
  if (/\.part\d+\.rar$/.test(filename)) {
    return true;
  }

  // Check for generic split files: .001, .002, etc. (any base name)
  if (/\.\d{3}$/.test(filename)) {
    return true;
  }

  // Obfuscated hash filenames with numeric extensions (hex or alphanumeric, e.g. EasyNews)
  if (/^[a-z0-9]{16,}\.\d+$/.test(filename)) {
    return true;
  }

  // Fully obfuscated hash filenames with no extension (hex or alphanumeric, e.g. EasyNews)
  if (/^[a-z0-9]{16,}$/.test(filename)) {
    return true;
  }

  return false;
}

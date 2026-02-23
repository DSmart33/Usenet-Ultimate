/**
 * Archive Inspector
 *
 * Downloads and parses archive headers to verify contents without full extraction.
 * Supports RAR4, RAR5, 7-Zip, and ZIP formats.
 *
 * Archive inspection system:
 * - Detects compression method (stored/uncompressed vs compressed)
 * - Detects encryption
 * - Detects nested archives and ISOs
 * - Reads file catalog from archive headers
 */

// Re-export types
export type { ArchiveInfo, ArchiveFile, UsenetConfig, EncodedHeaderInfo } from './types.js';

// Re-export segment downloader
export { downloadArchiveHeader, downloadSegment } from './nntpSegmentDownloader.js';

// Re-export format detection
export { isRAR4, isRAR5, is7Zip, isZip } from './formatDetector.js';

// Re-export parsers
export { parseRAR4 } from './rar4Parser.js';
export { parseRAR5 } from './rar5Parser.js';
export { parse7Zip, download7zEndMetadata, parse7zEndHeader, parse7zHeaderProperties } from './sevenZipParser.js';
export { parseZip } from './zipParser.js';

// Re-export utilities
export { readVInt, read7zNumber, checkFileContentType, hasVideoContent } from './utils.js';

// Re-export LZMA decoder
export { decompressLZMA1 } from './lzmaDecoder.js';

// Import format detectors and parsers for the orchestrator
import type { ArchiveInfo } from './types.js';
import { isRAR4, isRAR5, is7Zip, isZip } from './formatDetector.js';
import { parseRAR4 } from './rar4Parser.js';
import { parseRAR5 } from './rar5Parser.js';
import { parse7Zip } from './sevenZipParser.js';
import { parseZip } from './zipParser.js';

/**
 * Inspect archive header and extract metadata
 */
export function inspectArchive(headerData: Buffer): ArchiveInfo {
  // Check signatures to determine format
  if (isRAR4(headerData)) {
    return parseRAR4(headerData);
  } else if (isRAR5(headerData)) {
    return parseRAR5(headerData);
  } else if (is7Zip(headerData)) {
    return parse7Zip(headerData);
  } else if (isZip(headerData)) {
    return parseZip(headerData);
  }

  return {
    format: 'unknown',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };
}

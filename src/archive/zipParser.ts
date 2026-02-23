/**
 * ZIP Archive Parser
 *
 * Parses ZIP local file headers to enumerate files, detect encryption,
 * and determine compression method.
 */

import type { ArchiveInfo } from './types.js';
import { checkFileContentType } from './utils.js';

/**
 * Parse ZIP archive header
 */
export function parseZip(data: Buffer): ArchiveInfo {
  const info: ArchiveInfo = {
    format: 'zip',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };

  try {
    let offset = 0;

    // Parse local file headers (0x50 0x4B 0x03 0x04)
    while (offset + 30 < data.length) {
      // Check for local file header signature
      if (data[offset] !== 0x50 || data[offset + 1] !== 0x4B ||
          data[offset + 2] !== 0x03 || data[offset + 3] !== 0x04) {
        break;
      }

      const flags = data.readUInt16LE(offset + 6);
      const method = data.readUInt16LE(offset + 8);
      const compressedSize = data.readUInt32LE(offset + 18);
      const uncompressedSize = data.readUInt32LE(offset + 22);
      const nameLen = data.readUInt16LE(offset + 26);
      const extraLen = data.readUInt16LE(offset + 28);

      // Check for encryption flag (0x01)
      if (flags & 0x01) {
        info.encrypted = true;
      }

      // Extract filename
      if (offset + 30 + nameLen < data.length) {
        const filename = data.toString('utf8', offset + 30, offset + 30 + nameLen);

        // Method 0 = stored (uncompressed)
        const compressed = method !== 0;

        info.files.push({
          name: filename,
          size: uncompressedSize,
          compressed
        });

        // Update compression status
        if (method === 0 && info.compression !== 'compressed') {
          info.compression = 'stored';
        } else if (method !== 0) {
          info.compression = 'compressed';
        }

        // Check for nested archives and ISOs
        checkFileContentType(filename, info);
      }

      // Move to next file header
      offset += 30 + nameLen + extraLen + compressedSize;

      // Safety check
      if (offset >= data.length - 30) break;
    }
  } catch (err) {
    console.warn('Error parsing ZIP header:', (err as Error).message);
  }

  return info;
}

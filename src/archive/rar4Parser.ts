/**
 * RAR4 Archive Parser
 *
 * Parses RAR4 header blocks to enumerate files, detect encryption,
 * and determine compression method.
 */

import type { ArchiveInfo } from './types.js';
import { checkFileContentType } from './utils.js';

/**
 * Parse RAR4 archive header
 */
export function parseRAR4(data: Buffer): ArchiveInfo {
  const info: ArchiveInfo = {
    format: 'rar4',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };

  try {
    let offset = 7; // Skip signature

    // Read blocks until we find file headers or run out of data
    while (offset + 7 < data.length) {
      const type = data.readUInt8(offset + 2);
      const flags = data.readUInt16LE(offset + 3);
      const size = data.readUInt16LE(offset + 5);

      // Safety check to prevent infinite loops
      if (size === 0) break;

      // Main archive header (0x73): flag 0x0080 = MHD_PASSWORD (encrypted headers)
      if (type === 0x73 && (flags & 0x0080)) {
        info.encrypted = true;
      }

      // File header block (0x74)
      // Layout: +7 PACK_SIZE(4) +11 UNP_SIZE(4) +15 HOST_OS(1) +16 FILE_CRC(4)
      //         +20 FTIME(4) +24 UNP_VER(1) +25 METHOD(1) +26 NAME_SIZE(2) +28 ATTR(4)
      //         [+32 HIGH_PACK_SIZE(4) HIGH_UNP_SIZE(4) if flag 0x0100]
      //         +32/+40 FILE_NAME(NAME_SIZE bytes)
      if (type === 0x74 && offset + 32 <= data.length) {
        // File-level encryption (flag 0x04)
        if (flags & 0x04) {
          info.encrypted = true;
        }

        const packSize = data.readUInt32LE(offset + 7);
        const unpackedSize = data.readUInt32LE(offset + 11);
        const method = data.readUInt8(offset + 25);
        const nameSize = data.readUInt16LE(offset + 26);

        // Filename offset depends on LARGE_FILE flag (0x0100)
        let nameStart = offset + 32;
        if (flags & 0x0100) {
          nameStart = offset + 40;
        }

        if (nameStart + nameSize <= data.length && nameSize > 0 && nameSize < 4096) {
          const filename = data.toString('utf8', nameStart, nameStart + nameSize);

          // Check compression method (0x30 = stored/uncompressed)
          const compressed = method !== 0x30;

          info.files.push({
            name: filename,
            size: unpackedSize,
            compressed
          });

          // Update compression status
          if (method === 0x30 && info.compression !== 'compressed') {
            info.compression = 'stored';
          } else if (method !== 0x30) {
            info.compression = 'compressed';
          }

          // Check for nested archives and ISOs
          checkFileContentType(filename, info);
        }

        // Skip past header + compressed data (flag 0x8000 = LONG_BLOCK with add-on size)
        if (flags & 0x8000) {
          offset += size + packSize;
        } else {
          offset += size;
        }
      } else {
        // Non-file blocks: advance by header size only
        offset += size;
      }
    }
  } catch (err) {
    console.warn('Error parsing RAR4 header:', (err as Error).message);
  }

  return info;
}

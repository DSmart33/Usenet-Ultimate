/**
 * RAR5 Archive Parser
 *
 * Parses RAR5 headers using variable-length number (vint) encoding.
 * Handles file headers, encryption headers, and extra/data areas.
 *
 * RAR5 header format:
 *   CRC32 (4B) + header_size (vint) + header_type (vint) + header_flags (vint) + [extra fields based on type]
 *   header_size covers everything AFTER the CRC32 + header_size bytes
 *
 * Header types:
 *   1 = Main archive header
 *   2 = File header
 *   3 = Service header (e.g. comments)
 *   4 = Encryption header (archive-level encryption)
 *   5 = End of archive header
 *
 * File header (type 2) fields after header_flags:
 *   file_flags (vint) -> unpacked_size (vint) -> attributes (vint) -> mtime (uint32, if flag 0x02)
 *   -> data_crc32 (uint32, if flag 0x04) -> compression_info (vint) -> host_os (vint) -> name_length (vint) -> name (UTF-8)
 *
 * Compression info bits 0-5 = version (0 = stored, others = compressed)
 */

import type { ArchiveInfo } from './types.js';
import { readVInt, checkFileContentType } from './utils.js';

/**
 * Parse RAR5 archive header
 */
export function parseRAR5(data: Buffer): ArchiveInfo {
  const info: ArchiveInfo = {
    format: 'rar5',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };

  try {
    let offset = 8; // Skip RAR5 signature (8 bytes)

    while (offset + 7 < data.length) {
      // CRC32 (4 bytes)
      offset += 4;

      // Header size (vint) — covers everything from header_type to end of header
      const headerSize = readVInt(data, offset);
      if (!headerSize || headerSize.value === 0) break;
      offset += headerSize.length;

      const headerEnd = offset + headerSize.value;
      if (headerEnd > data.length) break;

      // Header type (vint)
      const headerType = readVInt(data, offset);
      if (!headerType) break;
      offset += headerType.length;

      // Header flags (vint)
      const headerFlags = readVInt(data, offset);
      if (!headerFlags) break;
      offset += headerFlags.length;

      const hasExtraArea = !!(headerFlags.value & 0x01);
      const hasDataArea = !!(headerFlags.value & 0x02);

      // Extra area size (vint) — present if flag 0x01 set, comes BEFORE type-specific fields
      let extraAreaSize = 0;
      if (hasExtraArea) {
        const eas = readVInt(data, offset);
        if (!eas) { offset = headerEnd; continue; }
        offset += eas.length;
        extraAreaSize = eas.value;
      }

      // Data area size (vint) — present if flag 0x02 set, comes BEFORE type-specific fields
      // The actual packed data of this size follows AFTER the header (after headerEnd)
      let dataAreaSize = 0;
      if (hasDataArea) {
        const das = readVInt(data, offset);
        if (!das) { offset = headerEnd; continue; }
        offset += das.length;
        dataAreaSize = das.value;
      }

      // Encryption header (type 4) — archive-level encryption
      if (headerType.value === 4) {
        info.encrypted = true;
      }

      // File header (type 2) — parse type-specific fields
      if (headerType.value === 2 && offset < headerEnd) {
        try {
          // File flags (vint)
          const fileFlags = readVInt(data, offset);
          if (!fileFlags) { offset = headerEnd + dataAreaSize; continue; }
          offset += fileFlags.length;

          // Unpacked size (vint)
          const unpackedSize = readVInt(data, offset);
          if (!unpackedSize) { offset = headerEnd + dataAreaSize; continue; }
          offset += unpackedSize.length;

          // Attributes (vint)
          const attributes = readVInt(data, offset);
          if (!attributes) { offset = headerEnd + dataAreaSize; continue; }
          offset += attributes.length;

          // mtime (uint32) — present if file_flags bit 1 (0x02) is set
          if (fileFlags.value & 0x02) {
            if (offset + 4 > headerEnd) { offset = headerEnd + dataAreaSize; continue; }
            offset += 4;
          }

          // Data CRC32 (uint32) — present if file_flags bit 2 (0x04) is set
          if (fileFlags.value & 0x04) {
            if (offset + 4 > headerEnd) { offset = headerEnd + dataAreaSize; continue; }
            offset += 4;
          }

          // Compression info (vint)
          const compressionInfo = readVInt(data, offset);
          if (!compressionInfo) { offset = headerEnd + dataAreaSize; continue; }
          offset += compressionInfo.length;

          // Compression version is bits 0-5 (0 = stored/no compression, >0 = compressed)
          const compressionVersion = compressionInfo.value & 0x3F;

          // Host OS (vint)
          const hostOS = readVInt(data, offset);
          if (!hostOS) { offset = headerEnd + dataAreaSize; continue; }
          offset += hostOS.length;

          // Name length (vint)
          const nameLength = readVInt(data, offset);
          if (!nameLength || offset + nameLength.length + nameLength.value > headerEnd) {
            offset = headerEnd + dataAreaSize;
            continue;
          }
          offset += nameLength.length;

          // Filename (UTF-8)
          const filename = data.toString('utf8', offset, offset + nameLength.value);
          offset += nameLength.value;

          const isStored = compressionVersion === 0;

          // Skip directory entries (file_flags bit 0)
          if (!(fileFlags.value & 0x01)) {
            info.files.push({
              name: filename,
              size: unpackedSize.value,
              compressed: !isStored
            });

            // Update overall compression status
            if (isStored && info.compression !== 'compressed') {
              info.compression = 'stored';
            } else if (!isStored) {
              info.compression = 'compressed';
            }

            // Check for nested archives and ISOs
            checkFileContentType(filename, info);
          }
        } catch {
          // If individual file header parsing fails, skip to next header
        }
      }

      // Skip past header + packed data area to reach next header
      offset = headerEnd + dataAreaSize;
    }
  } catch (err) {
    console.warn('Error parsing RAR5 header:', (err as Error).message);
  }

  // Default to compressed if no files were found to determine
  if (info.compression === 'unknown') {
    info.compression = 'compressed';
  }

  return info;
}

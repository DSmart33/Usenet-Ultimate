/**
 * 7-Zip Archive Parser
 *
 * Handles 7z start header parsing, end-of-archive metadata fetching,
 * LZMA decompression coordination, and encoded header extraction.
 *
 * 7z metadata uses a property-tree format:
 *   Property ID (1 byte) followed by property-specific data.
 *   kEnd = 0x00
 *   kHeader = 0x01
 *   kMainStreamsInfo = 0x04
 *   kFilesInfo = 0x05
 *   kPackInfo = 0x06
 *   kUnPackInfo = 0x07
 *   kFolder = 0x0B
 *   kCodersUnPackSize = 0x0C
 *   kNumUnPackStream = 0x0D
 *   kName = 0x11
 *   kEncodedHeader = 0x17
 *
 * Coder IDs for encryption: 0x06F10701 = AES-256
 */

import * as net from 'net';
import * as tls from 'tls';
import { connectToUsenet } from '../health/nntpConnection.js';
import { decompressLZMA1 } from './lzmaDecoder.js';
import type { ArchiveInfo, UsenetConfig, EncodedHeaderInfo } from './types.js';
import { read7zNumber, checkFileContentType } from './utils.js';
import { downloadSegment } from './nntpSegmentDownloader.js';

/**
 * Parse 7-Zip archive header (start header only, from first segments)
 */
export function parse7Zip(data: Buffer): ArchiveInfo {
  const info: ArchiveInfo = {
    format: '7z',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };

  try {
    // 7z signature header:
    // 6 bytes: signature
    // 2 bytes: version (major.minor)
    // 4 bytes: start header CRC
    // 8 bytes: next header offset
    // 8 bytes: next header size
    // 4 bytes: next header CRC

    if (data.length < 32) return info;

    const majorVersion = data.readUInt8(6);
    const minorVersion = data.readUInt8(7);

    // The actual file list is in the "next header" which might not be in our sample
    // 7z stores metadata at the end of the archive, so we can't easily read file list
    // from the header alone without parsing the entire structure

    // For 7z, we'll mark as compressed since most 7z archives use compression
    // and detecting stored method requires parsing the full header database
    info.compression = 'compressed';

    // Check for encryption by looking for password flag in archive properties
    // This would require parsing the header database which may not be in first 64KB
    // For now, return basic info
  } catch (err) {
    console.warn('Error parsing 7z header:', (err as Error).message);
  }

  return info;
}

/**
 * Download and parse 7z end-of-archive metadata.
 *
 * 7z stores its file catalog at the END of the archive. The start header
 * (first 32 bytes) contains NextHeaderOffset and NextHeaderSize which tell
 * us where the metadata lives. We calculate which NZB segments contain that
 * data and download them via NNTP.
 *
 * @param startHeader - Already-downloaded first segment(s) containing 7z start header
 * @param allSegments - All segments of the archive file from the NZB
 * @param config - Usenet connection config
 * @param existingSocket - Optional reusable socket (from pool)
 * @returns Enhanced ArchiveInfo with file listing, or null if unable to fetch
 */
export async function download7zEndMetadata(
  startHeader: Buffer,
  allSegments: Array<{ messageId: string; bytes: number; number: number }>,
  config: UsenetConfig,
  existingSocket?: net.Socket | tls.TLSSocket
): Promise<ArchiveInfo | null> {
  try {
    if (startHeader.length < 32) return null;

    // Read NextHeaderOffset (8 bytes LE at offset 12) and NextHeaderSize (8 bytes LE at offset 20)
    // Note: JavaScript can't handle full uint64, but archive metadata is unlikely to be >2^53 bytes in
    const nextHeaderOffset = Number(startHeader.readBigUInt64LE(12));
    const nextHeaderSize = Number(startHeader.readBigUInt64LE(20));

    if (nextHeaderSize === 0 || nextHeaderSize > 10 * 1024 * 1024) return null; // sanity: max 10MB metadata

    // The end header starts at byte 32 + nextHeaderOffset in the archive file
    const endHeaderStart = 32 + nextHeaderOffset;
    const endHeaderEnd = endHeaderStart + nextHeaderSize;

    // Calculate cumulative byte offsets for each segment
    // Segments are numbered 1-based in NZBs, sorted by number
    const sortedSegments = [...allSegments].sort((a, b) => a.number - b.number);
    let cumulativeBytes = 0;
    const segmentRanges: Array<{ messageId: string; startByte: number; endByte: number }> = [];
    for (const seg of sortedSegments) {
      segmentRanges.push({
        messageId: seg.messageId,
        startByte: cumulativeBytes,
        endByte: cumulativeBytes + seg.bytes
      });
      cumulativeBytes += seg.bytes;
    }

    // Find segments that overlap with the end header region
    const neededSegments = segmentRanges.filter(
      sr => sr.endByte > endHeaderStart && sr.startByte < endHeaderEnd
    );

    if (neededSegments.length === 0) return null;

    // Limit to 5 segments to avoid excessive downloads
    const segmentsToFetch = neededSegments.slice(0, 5);

    // Download the segments
    const socket = existingSocket || await connectToUsenet(config);
    const ownsSocket = !existingSocket;

    try {
      const chunks: Buffer[] = [];
      for (const seg of segmentsToFetch) {
        try {
          const data = await downloadSegment(socket, seg.messageId);
          chunks.push(data);
        } catch {
          // If a segment fails, try to parse what we have
          break;
        }
      }

      if (chunks.length === 0) return null;

      // Trim the downloaded data to the actual end header region.
      // The first fetched segment may start before endHeaderStart,
      // so we need to skip the leading bytes that aren't part of the header.
      const firstSegStartByte = segmentsToFetch[0].startByte;
      const trimOffset = endHeaderStart - firstSegStartByte;
      const rawData = Buffer.concat(chunks);
      const endData = rawData.slice(trimOffset, trimOffset + nextHeaderSize);

      // Check if the end header is an encoded (LZMA-compressed) header
      if (endData.length > 0 && endData[0] === 0x17) {
        const encInfo = parseEncodedHeaderInfo(endData);

        if (encInfo && encInfo.isLZMA && encInfo.coderProps.length === 5) {
          // The packed header data lives at byte 32 + packPos in the archive
          const packStart = 32 + encInfo.packPos;
          const packEnd = packStart + encInfo.packSize;

          // Find segments containing the packed header data
          const packSegments = segmentRanges.filter(
            sr => sr.endByte > packStart && sr.startByte < packEnd
          );

          if (packSegments.length > 0) {
            // Limit to 10 segments for packed header download
            const packToFetch = packSegments.slice(0, 10);
            console.log(`  [7z] Decoding compressed metadata (${encInfo.packSize} packed → ${encInfo.unpackSize} unpacked, ${packToFetch.length} segments)...`);

            const packChunks: Buffer[] = [];
            for (const seg of packToFetch) {
              try {
                const data = await downloadSegment(socket, seg.messageId);
                packChunks.push(data);
              } catch {
                break;
              }
            }

            if (packChunks.length > 0) {
              // Trim to the actual packed data region
              const packFirstStart = packToFetch[0].startByte;
              const packTrimOffset = packStart - packFirstStart;
              const packRaw = Buffer.concat(packChunks);
              const packedData = packRaw.slice(packTrimOffset, packTrimOffset + encInfo.packSize);

              try {
                const decompressed = decompressLZMA1(packedData, encInfo.coderProps, encInfo.unpackSize);
                const firstByte = decompressed.length > 0 ? decompressed[0] : -1;

                if (decompressed.length > 0) {
                  let result: ArchiveInfo;
                  if (firstByte === 0x01) {
                    // kHeader — parse normally
                    result = parse7zEndHeader(decompressed, decompressed.length);
                  } else {
                    // May start directly with properties (kMainStreamsInfo=0x04, kFilesInfo=0x05, etc.)
                    result = {
                      format: '7z',
                      encrypted: false,
                      compression: 'unknown',
                      files: [],
                      hasNestedArchive: false,
                      hasISO: false
                    };
                    parse7zHeaderProperties(decompressed, 0, result);
                    if (result.compression === 'unknown') result.compression = 'compressed';
                  }
                  if (encInfo.encrypted) result.encrypted = true;
                  return result;
                }
              } catch (err) {
                console.warn(`  [7z] LZMA decompression failed: ${(err as Error).message}`);
              }
            }
          }
        }

        // Fall back to basic encoded header info (encryption/compression only, no file listing)
        const basicInfo: ArchiveInfo = {
          format: '7z',
          encrypted: encInfo?.encrypted || false,
          compression: 'compressed',
          files: [],
          hasNestedArchive: false,
          hasISO: false
        };
        return basicInfo;
      }

      return parse7zEndHeader(endData, nextHeaderSize);
    } finally {
      if (ownsSocket) socket.destroy();
    }
  } catch (err) {
    console.warn(`  [7z] Failed to fetch end metadata: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Parse the StreamsInfo inside a kEncodedHeader (0x17).
 * Extracts pack position, sizes, and LZMA codec properties needed to
 * download and decompress the real file catalog.
 *
 * The encoded header structure:
 *   0x17 (kEncodedHeader)
 *     PackInfo (0x06): PackPos, NumPackStreams, [Sizes]
 *     UnPackInfo (0x07): Folders with coder definitions, UnPackSizes
 *     [SubStreamsInfo (0x08)]
 *     kEnd (0x00)
 */
function parseEncodedHeaderInfo(data: Buffer): EncodedHeaderInfo | null {
  try {
    if (data.length < 2 || data[0] !== 0x17) return null;

    let offset = 1; // Skip kEncodedHeader byte
    let packPos = 0;
    let packSize = 0;
    let unpackSize = 0;
    let coderProps = Buffer.alloc(0);
    let isLZMA = false;
    let encrypted = false;

    // Scan for AES encryption pattern
    const aesPattern = Buffer.from([0x06, 0xF1, 0x07, 0x01]);
    if (data.indexOf(aesPattern) !== -1) {
      encrypted = true;
    }

    while (offset < data.length) {
      const propId = data.readUInt8(offset);
      offset++;

      if (propId === 0x00) break; // kEnd

      if (propId === 0x06) { // kPackInfo
        const pp = read7zNumber(data, offset);
        if (!pp) return null;
        packPos = pp.value;
        offset += pp.length;

        const numStreams = read7zNumber(data, offset);
        if (!numStreams) return null;
        offset += numStreams.length;

        // Sub-properties within PackInfo
        while (offset < data.length) {
          const subId = data.readUInt8(offset);
          offset++;
          if (subId === 0x00) break; // kEnd

          if (subId === 0x09) { // kSize
            for (let i = 0; i < numStreams.value; i++) {
              const s = read7zNumber(data, offset);
              if (!s) return null;
              if (i === 0) packSize = s.value;
              offset += s.length;
            }
          } else if (subId === 0x0A) { // kCRC
            // AllAreDefined byte
            const allDefined = data.readUInt8(offset);
            offset++;
            if (allDefined) {
              offset += numStreams.value * 4;
            } else {
              // Bit array for which are defined, then CRC values
              const numBytes = Math.ceil(numStreams.value / 8);
              let definedCount = 0;
              for (let i = 0; i < numBytes && offset + i < data.length; i++) {
                const byte = data.readUInt8(offset + i);
                for (let b = 7; b >= 0; b--) {
                  if (i * 8 + (7 - b) < numStreams.value && (byte & (1 << b))) {
                    definedCount++;
                  }
                }
              }
              offset += numBytes + definedCount * 4;
            }
          }
        }
        continue;
      }

      if (propId === 0x07) { // kUnPackInfo
        while (offset < data.length) {
          const subId = data.readUInt8(offset);
          offset++;
          if (subId === 0x00) break; // kEnd

          if (subId === 0x0B) { // kFolder
            const numFolders = read7zNumber(data, offset);
            if (!numFolders) return null;
            offset += numFolders.length;

            const external = data.readUInt8(offset);
            offset++;

            if (external === 0 && numFolders.value >= 1) {
              // Parse first folder inline
              const numCoders = read7zNumber(data, offset);
              if (!numCoders) return null;
              offset += numCoders.length;

              let totalOutStreams = 0;

              for (let c = 0; c < numCoders.value; c++) {
                const flags = data.readUInt8(offset);
                offset++;

                const idSize = flags & 0x0F;
                const isComplex = !!(flags & 0x10);
                const hasAttrs = !!(flags & 0x20);

                if (offset + idSize > data.length) return null;
                const codecId = Buffer.from(data.slice(offset, offset + idSize));
                offset += idSize;

                // Check for LZMA1 (0x030101)
                if (c === 0 && codecId.length === 3 &&
                    codecId[0] === 0x03 && codecId[1] === 0x01 && codecId[2] === 0x01) {
                  isLZMA = true;
                }

                let numOut = 1;
                if (isComplex) {
                  const numIn = read7zNumber(data, offset);
                  if (!numIn) return null;
                  offset += numIn.length;
                  const numOutV = read7zNumber(data, offset);
                  if (!numOutV) return null;
                  numOut = numOutV.value;
                  offset += numOutV.length;
                }
                totalOutStreams += numOut;

                if (hasAttrs) {
                  const propsSize = read7zNumber(data, offset);
                  if (!propsSize) return null;
                  offset += propsSize.length;
                  if (c === 0) {
                    coderProps = Buffer.from(data.slice(offset, offset + propsSize.value));
                  }
                  offset += propsSize.value;
                }
              }

              // BindPairs: (totalOutStreams - 1) pairs, each is 2 vints
              const numBindPairs = totalOutStreams - 1;
              for (let bp = 0; bp < numBindPairs; bp++) {
                const inIdx = read7zNumber(data, offset);
                if (!inIdx) break;
                offset += inIdx.length;
                const outIdx = read7zNumber(data, offset);
                if (!outIdx) break;
                offset += outIdx.length;
              }

              // PackedStreams: for simple coders (1 in stream total), no packed stream indices
              // For complex coders, there are (numInStreamsTotal - numBindPairs) indices
              // For the common case (single simple coder), this section is empty

              // Skip remaining folders (we only need the first one)
              // This is a simplification - won't handle multi-folder encoded headers
            }
          } else if (subId === 0x0C) { // kCodersUnPackSize
            // One unpack size per output stream per folder
            const s = read7zNumber(data, offset);
            if (!s) return null;
            unpackSize = s.value;
            offset += s.length;
          } else if (subId === 0x0A) { // kCRC
            const allDefined = data.readUInt8(offset);
            offset++;
            if (allDefined) {
              offset += 4; // 1 folder = 1 CRC
            }
          }
        }
        continue;
      }

      if (propId === 0x08) { // kSubStreamsInfo - skip
        while (offset < data.length) {
          const subId = data.readUInt8(offset);
          offset++;
          if (subId === 0x00) break;
        }
        continue;
      }

      // Unknown property - stop parsing
      break;
    }

    if (packSize === 0 || unpackSize === 0 || coderProps.length === 0) return null;

    return { packPos, packSize, unpackSize, coderProps, isLZMA, encrypted };
  } catch (err) {
    console.warn(`  [7z] Failed to parse encoded header info: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Parse 7z end-of-archive header for file names, encryption, and compression.
 */
export function parse7zEndHeader(data: Buffer, expectedSize: number): ArchiveInfo {
  const info: ArchiveInfo = {
    format: '7z',
    encrypted: false,
    compression: 'unknown',
    files: [],
    hasNestedArchive: false,
    hasISO: false
  };

  try {
    let offset = 0;

    if (offset < data.length) {
      const propId = data.readUInt8(offset);

      if (propId === 0x17) {
        // Encoded header — metadata is compressed or encrypted
        // Scan for AES encryption coder ID pattern
        const aesPattern = Buffer.from([0x06, 0xF1, 0x07, 0x01]);
        if (data.indexOf(aesPattern) !== -1) {
          info.encrypted = true;
        }
        info.compression = 'compressed';
        // File listing requires LZMA decompression — handled by download7zEndMetadata
        return info;
      }

      if (propId === 0x01) {
        // kHeader — uncompressed metadata, we can parse it
        offset++;
        parse7zHeaderProperties(data, offset, info);
      }
    }
  } catch (err) {
    console.warn(`  [7z] Error parsing end header: ${(err as Error).message}`);
  }

  if (info.compression === 'unknown') {
    info.compression = 'compressed';
  }

  return info;
}

/**
 * Parse 7z header properties (recursive property tree).
 * Extracts file names, encryption detection, and compression info.
 */
export function parse7zHeaderProperties(data: Buffer, startOffset: number, info: ArchiveInfo): void {
  let offset = startOffset;

  while (offset < data.length) {
    const propId = data.readUInt8(offset);
    offset++;

    if (propId === 0x00) break; // kEnd

    // kMainStreamsInfo (0x04) — contains pack/unpack stream info
    // This section has complex nested sub-structures with variable-length data
    // (pack sizes, CRCs, coder properties) where raw bytes can match property IDs.
    // Instead of depth-based byte scanning (which misinterprets data as structure),
    // we scan for coder patterns, then search forward for kFilesInfo (0x05).
    if (propId === 0x04) {
      const sectionStart = offset;

      // Scan the raw bytes for encryption and compression coder patterns
      const scanEnd = Math.min(data.length, sectionStart + 16384);
      const aesPattern = Buffer.from([0x06, 0xF1, 0x07, 0x01]);
      const aesIdx = data.indexOf(aesPattern, sectionStart);
      if (aesIdx !== -1 && aesIdx < scanEnd) {
        info.encrypted = true;
      }
      const lzmaPattern = Buffer.from([0x03, 0x01, 0x01]);
      const lzmaIdx = data.indexOf(lzmaPattern, sectionStart);
      if (lzmaIdx !== -1 && lzmaIdx < scanEnd) {
        info.compression = 'compressed';
      }

      // Search forward for kFilesInfo (0x05) by looking for the pattern:
      // 0x05, numFiles (valid 7z number), then a kFilesInfo property ID (0x0E-0x19 or 0x00)
      const kFilesInfoPropertyIds = new Set([0x00, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x18, 0x19]);
      let found = false;
      for (let searchPos = sectionStart; searchPos < data.length - 3; searchPos++) {
        if (data.readUInt8(searchPos) !== 0x05) continue;

        const numFiles = read7zNumber(data, searchPos + 1);
        if (!numFiles || numFiles.value < 1 || numFiles.value > 100000) continue;

        const afterNumFiles = searchPos + 1 + numFiles.length;
        if (afterNumFiles >= data.length) continue;

        const nextByte = data.readUInt8(afterNumFiles);
        if (kFilesInfoPropertyIds.has(nextByte)) {
          // Found kFilesInfo — set offset so the loop reads 0x05 next iteration
          offset = searchPos;
          found = true;
          break;
        }
      }

      if (!found) {
        // Could not find kFilesInfo — skip to end
        offset = data.length;
      }
      continue;
    }

    // kFilesInfo (0x05) — contains file names
    if (propId === 0x05) {
      try {
        // Number of files
        const numFiles = read7zNumber(data, offset);
        if (!numFiles) break;
        offset += numFiles.length;

        // Properties within FilesInfo
        while (offset < data.length) {
          const filePropId = data.readUInt8(offset);
          offset++;

          if (filePropId === 0x00) break; // kEnd

          // Property data size
          const propSize = read7zNumber(data, offset);
          if (!propSize) break;
          offset += propSize.length;

          const propEnd = offset + propSize.value;

          // kName (0x11) — file names in UTF-16LE
          if (filePropId === 0x11 && propSize.value > 1) {
            try {
              // First byte is "external" flag (should be 0)
              const external = data.readUInt8(offset);
              let nameOffset = offset + 1;

              if (external === 0) {
                // Names are inline, UTF-16LE encoded, null-terminated
                for (let i = 0; i < numFiles.value && nameOffset + 2 <= propEnd; i++) {
                  // Find null terminator (two zero bytes)
                  let endPos = nameOffset;
                  while (endPos + 1 < propEnd) {
                    if (data.readUInt16LE(endPos) === 0) break;
                    endPos += 2;
                  }

                  if (endPos > nameOffset) {
                    const filename = data.toString('utf16le', nameOffset, endPos);
                    info.files.push({ name: filename, size: 0, compressed: info.compression === 'compressed' });

                    checkFileContentType(filename, info);
                  }

                  nameOffset = endPos + 2; // skip null terminator
                }
              }
            } catch {
              // Name parsing failed, continue with other properties
            }
          }

          offset = propEnd;
        }
      } catch {
        // FilesInfo parsing failed
      }
      continue;
    }

    // Unknown property — try to skip by reading its size
    const propSize = read7zNumber(data, offset);
    if (propSize) {
      offset += propSize.length + propSize.value;
    } else {
      break;
    }
  }
}

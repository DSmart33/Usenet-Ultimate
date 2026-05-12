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
import * as crypto from 'crypto';
import { connectToUsenet } from '../health/nntpConnection.js';
import { decompressLZMA1 } from './lzmaDecoder.js';
import { decompressLZMA2 } from './lzma2Decoder.js';
import type { ArchiveInfo, UsenetConfig, EncodedHeaderInfo } from './types.js';
import { read7zNumber, checkFileContentType } from './utils.js';
import { downloadSegment } from './nntpSegmentDownloader.js';

// AES-256 coder ID in the 7z coder-chain (4 bytes: 0x06F10701).
const AES256_CODEC_ID = Buffer.from([0x06, 0xF1, 0x07, 0x01]);

// Sanity caps applied to values parsed from untrusted NZB/archive bytes.
const MAX_METADATA_SIZE = 10 * 1024 * 1024;   // 10MB for pack/unpack/nextHeader sizes
const MAX_PASSWORD_LENGTH = 1024;              // characters, pre-utf16le expansion
const MAX_KDF_CYCLES_POWER = 24;               // 2^24 ≈ 16M SHA updates, ~1s on modern CPUs

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
  existingSocket?: net.Socket | tls.TLSSocket,
  password?: string,
): Promise<ArchiveInfo | null> {
  try {
    if (startHeader.length < 32) return null;

    // Read NextHeaderOffset (8 bytes LE at offset 12) and NextHeaderSize (8 bytes LE at offset 20)
    // Note: JavaScript can't handle full uint64, but archive metadata is unlikely to be >2^53 bytes in
    const nextHeaderOffset = Number(startHeader.readBigUInt64LE(12));
    const nextHeaderSize = Number(startHeader.readBigUInt64LE(20));

    if (nextHeaderSize === 0 || nextHeaderSize > 10 * 1024 * 1024) return null; // sanity: max 10MB metadata

    // ── End header extraction (tail-based) ──
    // NZB seg.bytes reflects yEnc article size, not decoded binary size.
    // Cumulative offset drift across thousands of segments makes offset-based
    // extraction unreliable at the archive tail. Instead, download the last
    // few segments and extract the end header from the decoded tail.
    const sortedSegments = [...allSegments].sort((a, b) => a.number - b.number);
    const estimatedSegSize = 490000; // ~490KB typical decoded segment
    // 25-segment floor (~12MB tail) — obfuscated archives often push the real
    // encoded end-header well past the last segment's worth of bytes even when
    // nextHeaderSize is lying about where the catalog lives.
    const numToDownload = Math.min(
      Math.max(25, Math.ceil(nextHeaderSize / estimatedSegSize) + 1),
      sortedSegments.length
    );
    const tailSegments = sortedSegments.slice(-numToDownload);

    const socket = existingSocket || await connectToUsenet(config);
    const ownsSocket = !existingSocket;

    try {
      const chunks: Buffer[] = [];
      for (const seg of tailSegments) {
        try {
          const data = await downloadSegment(socket, seg.messageId);
          chunks.push(data);
        } catch {
          break;
        }
      }

      if (chunks.length === 0) return null;

      const tailData = Buffer.concat(chunks);
      if (tailData.length < nextHeaderSize) return null;

      // End header is the last nextHeaderSize bytes of the archive
      let endData = tailData.slice(tailData.length - nextHeaderSize);
      let endHeaderFoundViaScan = false;

      console.log(`  [7z] Tail fetched: ${numToDownload}/${sortedSegments.length} segs, ${tailData.length}B decoded. nextHeaderOffset=${nextHeaderOffset}, nextHeaderSize=${nextHeaderSize}. endData first16=${endData.subarray(0, 16).toString('hex')}`);

      // If the slice isn't a valid header byte, the start header's offset is
      // corrupt/obfuscated. Scan the entire downloaded tail for a structurally
      // valid end header — parseEncodedHeaderInfo rejects random noise so the
      // wider window is safe and necessary (with nextHeaderSize also obfuscated
      // we have no tighter anchor to work with).
      if (endData.length > 0 && endData[0] !== 0x17 && endData[0] !== 0x01) {
        const scanStart = 0;
        const picked = findEndHeaderInTail(tailData, scanStart, nextHeaderSize);
        if (picked) {
          endData = tailData.slice(picked.offset);
          endHeaderFoundViaScan = true;
          console.log(`  [7z] Tail scan match: 0x${picked.kind.toString(16).padStart(2, '0')} at offset ${tailData.length - picked.offset} from end (${endData.length} bytes, ${picked.reason})`);
        } else {
          console.log(`  [7z] No valid end header in tail (likely obfuscated or truncated, first byte 0x${endData[0].toString(16).padStart(2, '0')}, scan window ${tailData.length - scanStart}B)`);
        }
      }
      if (endData.length > 0 && endData[0] === 0x17) {
        const encInfo = parseEncodedHeaderInfo(endData);

        if (!encInfo && endHeaderFoundViaScan) {
          console.log(`  [7z] Encoded header parse failed (endData: ${endData.length} bytes, first 16: ${endData.subarray(0, 16).toString('hex')})`);
        }

        // Fetch and decompress packed header data (LZMA1 or LZMA2)
        const canDecompress = encInfo && (
          (encInfo.codecType === 'lzma1' && encInfo.coderProps.length === 5) ||
          (encInfo.codecType === 'lzma2' && encInfo.coderProps.length >= 1)
        );

        if (canDecompress && encInfo) {
          // Extract packed catalog data. 7z layout: [packed catalog][end header].
          // When the start header is intact we derive packed-data position from
          // NextHeaderOffset; when we recovered via tail scan NextHeaderOffset
          // is untrustworthy so we position packed data relative to the scanned
          // end-header location instead.
          const archiveSize = 32 + nextHeaderOffset + nextHeaderSize;
          const packDataStart = 32 + encInfo.packPos;
          const packDataDistFromEnd = archiveSize - packDataStart;
          const packDataInTail = !endHeaderFoundViaScan
            && packDataDistFromEnd > 0
            && packDataDistFromEnd <= tailData.length;

          let packedData: Buffer | null = null;

          if (packDataInTail) {
            // Packed data is in our tail buffer — extract directly (no offset drift)
            const offsetInTail = tailData.length - packDataDistFromEnd;
            packedData = tailData.subarray(offsetInTail, offsetInTail + encInfo.packSize);
            console.log(`  [7z] Decoding ${encInfo.codecType} metadata (${encInfo.packSize} packed → ${encInfo.unpackSize} unpacked, from tail buffer)...`);
          } else if (endHeaderFoundViaScan && encInfo.packSize > 0) {
            // Start header was corrupted — extract packed data relative to where we found the end header
            // In 7z layout: [packed catalog][end header] — packed data sits right before the end header
            const endHeaderPosInTail = tailData.length - endData.length;
            const packStartInTail = endHeaderPosInTail - encInfo.packSize;
            if (packStartInTail >= 0) {
              packedData = tailData.subarray(packStartInTail, packStartInTail + encInfo.packSize);
              console.log(`  [7z] Decoding ${encInfo.codecType} metadata (${encInfo.packSize} packed → ${encInfo.unpackSize} unpacked, relative to scanned end header)...`);
            }
          } else {
            // Packed data is NOT in tail — fall back to offset-based segment fetch
            // (drift-prone, but this path is rare for typical archives)
            let cumulativeBytes = 0;
            const segmentRanges: Array<{ messageId: string; startByte: number; endByte: number }> = [];
            for (const seg of sortedSegments) {
              segmentRanges.push({ messageId: seg.messageId, startByte: cumulativeBytes, endByte: cumulativeBytes + seg.bytes });
              cumulativeBytes += seg.bytes;
            }
            const packStart = 32 + encInfo.packPos;
            const packEnd = packStart + encInfo.packSize;
            const packSegments = segmentRanges.filter(
              (sr: { startByte: number; endByte: number }) => sr.endByte > packStart && sr.startByte < packEnd
            );
            if (packSegments.length > 0) {
              const packToFetch = packSegments.slice(0, 10);
              console.log(`  [7z] Decoding ${encInfo.codecType} metadata (${encInfo.packSize} packed → ${encInfo.unpackSize} unpacked, ${packToFetch.length} segments, offset-based)...`);
              const packChunks: Buffer[] = [];
              for (const seg of packToFetch) {
                try { packChunks.push(await downloadSegment(socket, seg.messageId)); } catch { break; }
              }
              if (packChunks.length > 0) {
                const packFirstStart = packToFetch[0].startByte;
                const packTrimOffset = packStart - packFirstStart;
                const packRaw = Buffer.concat(packChunks);
                packedData = packRaw.subarray(packTrimOffset, packTrimOffset + encInfo.packSize);
              }
            }
          }

          if (packedData && packedData.length >= encInfo.packSize) {
            // Decrypt if AES-encrypted (must happen before LZMA decompression)
            if (encInfo.encrypted && encInfo.aesProps) {
              if (password) {
                // AES-CBC requires exact ciphertext length, 16-byte aligned.
                // Any drift here produces valid-looking garbage plaintext that
                // LZMA can't decode — fail loud instead of silent corruption.
                if (packedData.length !== encInfo.packSize || packedData.length % 16 !== 0) {
                  console.warn(`  [7z] Packed data length mismatch (got ${packedData.length}, expected ${encInfo.packSize}, 16-aligned=${packedData.length % 16 === 0}) — aborting decrypt`);
                  packedData = null;
                } else {
                  try {
                    const key = derive7zAESKey(password, encInfo.aesProps.salt, encInfo.aesProps.numCyclesPower);
                    if (!key) {
                      console.warn(`  [7z] AES key derivation rejected (numCyclesPower=${encInfo.aesProps.numCyclesPower}, pwLen=${password.length}) — out of sanity bounds`);
                      packedData = null;
                    } else {
                      packedData = decrypt7zAES(packedData, key, encInfo.aesProps.iv);
                      // Sanity-check the decrypted plaintext: 7z metadata always
                      // starts with 0x01 (kHeader). A different first byte means
                      // the key is wrong — bail before LZMA emits "invalid
                      // distance" which would falsely implicate the decoder.
                      if (packedData.length === 0 || packedData[0] !== 0x01) {
                        const firstHex = packedData.length > 0 ? packedData[0].toString(16).padStart(2, '0') : '--';
                        console.warn(`  [7z] AES decrypt produced first-byte 0x${firstHex}, expected 0x01 — likely wrong password`);
                        packedData = null;
                      } else {
                        console.log(`  [7z] AES decrypted (${encInfo.aesProps.numCyclesPower} cycles, ${packedData.length}B plaintext)`);
                      }
                    }
                  } catch (err) {
                    console.warn(`  [7z] AES decryption failed (wrong password?): ${(err as Error).message}`);
                    packedData = null;
                  }
                }
              } else {
                // Encrypted but no password — skip decompression entirely
                packedData = null;
              }
            }

            if (!packedData) {
              // Decryption failed or skipped — fall through to basic encrypted info
            } else try {
              const decompressed = encInfo.codecType === 'lzma2'
                ? decompressLZMA2(packedData, encInfo.coderProps[0], encInfo.unpackSize)
                : decompressLZMA1(packedData, encInfo.coderProps, encInfo.unpackSize);
              const firstByte = decompressed.length > 0 ? decompressed[0] : -1;

              if (decompressed.length > 0) {
                let result: ArchiveInfo;
                if (firstByte === 0x01) {
                  result = parse7zEndHeader(decompressed, decompressed.length);
                } else {
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
              console.warn(`  [7z] ${encInfo.codecType} decompression failed: ${(err as Error).message}`);
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

/** Parse AES-256 coder properties from raw property bytes (per 7z SDK 7zAes.cpp). */
function parseAESProps(props: Buffer): { numCyclesPower: number; salt: Buffer; iv: Buffer } | null {
  if (props.length < 1) return null;
  const byte0 = props[0];
  const numCyclesPower = byte0 & 0x3F;

  let saltSize = 0;
  let ivSize = 0;
  let offset = 1;

  // Per 7z SDK: bit 7 = hasSalt, bit 6 = hasIV
  // Size = flag_bit_value + nibble_from_byte1
  if ((byte0 & 0xC0) !== 0) {
    if (offset >= props.length) return null;
    const byte1 = props[offset++];
    saltSize = ((byte0 >> 7) & 1) + (byte1 >> 4);
    ivSize = ((byte0 >> 6) & 1) + (byte1 & 0x0F);
  }

  const salt = saltSize > 0 ? Buffer.from(props.subarray(offset, offset + saltSize)) : Buffer.alloc(0);
  offset += saltSize;
  const iv = ivSize > 0 ? Buffer.from(props.subarray(offset, offset + ivSize)) : Buffer.alloc(0);

  // AES-256-CBC requires exactly 16-byte IV — pad with zeros if shorter
  const paddedIV = Buffer.alloc(16);
  if (iv.length > 0) iv.copy(paddedIV);

  return { numCyclesPower, salt, iv: paddedIV };
}

/**
 * Derive AES-256 key from password using 7z's counter-based SHA-256 stretching.
 * Returns null if inputs violate sanity bounds (untrusted NZB input — DoS guard).
 */
function derive7zAESKey(password: string, salt: Buffer, numCyclesPower: number): Buffer | null {
  if (password.length > MAX_PASSWORD_LENGTH) return null;

  const passwordUtf16 = Buffer.from(password, 'utf16le');

  // Special case: numCyclesPower === 0x3F skips SHA entirely.
  // Key = (salt ‖ password)[:32] zero-padded. (7z SDK 7zAes.cpp, py7zr helpers.py)
  if (numCyclesPower === 0x3F) {
    const key = Buffer.alloc(32);
    const concat = Buffer.concat([salt, passwordUtf16]);
    concat.copy(key, 0, 0, Math.min(32, concat.length));
    return key;
  }

  // Reject implausibly high stretching — guards against a malicious NZB pinning
  // a worker on 2^63 SHA updates. Legitimate archives use 19-22.
  if (numCyclesPower > MAX_KDF_CYCLES_POWER) return null;

  const iterations = 2 ** numCyclesPower;
  // Per 7z SDK (7zAes.cpp) and py7zr: order is salt + password + counter per iteration.
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < iterations; i++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64LE(BigInt(i));
    hash.update(salt);
    hash.update(passwordUtf16);
    hash.update(counter);
  }
  return hash.digest();
}

/** Decrypt AES-256-CBC encrypted data. */
function decrypt7zAES(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false); // 7z doesn't use PKCS#7 padding
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Locate the archive's end header inside the downloaded tail when the start
 * header's NextHeaderOffset is corrupt (obfuscated by pirates or bit-rotted).
 *
 * Pass 1 prefers 0x17 (encoded header) and validates each candidate with a
 * structural parse — `parseEncodedHeaderInfo` only returns non-null for
 * syntactically valid encoded headers, so this is a strong filter that
 * naturally rejects AES-ciphertext false positives.
 *
 * Pass 2 falls back to 0x01 (direct header) with a two-byte signature that
 * matches the 7z spec (kHeader followed by kArchiveProperties / kAdditional /
 * kMainStreamsInfo / kFilesInfo) plus a property-id density check to reject
 * high-entropy candidates inside encrypted payload.
 */
type TailHeaderMatch = { offset: number; kind: 0x17 | 0x01; reason: string };
function findEndHeaderInTail(
  tailData: Buffer,
  scanStart: number,
  nextHeaderSize: number,
): TailHeaderMatch | null {
  // Pass 1: 0x17-encoded header candidates, validated by parseEncodedHeaderInfo.
  const encodedCandidates: TailHeaderMatch[] = [];
  for (let scan = scanStart; scan < tailData.length - 1; scan++) {
    if (tailData[scan] !== 0x17) continue;
    const next = tailData[scan + 1];
    if (next !== 0x06 && next !== 0x07) continue;
    const info = parseEncodedHeaderInfo(tailData.slice(scan));
    if (!info || info.codecType === 'none') continue;
    encodedCandidates.push({ offset: scan, kind: 0x17, reason: `codec=${info.codecType}, packSize=${info.packSize}` });
  }
  if (encodedCandidates.length > 0) {
    encodedCandidates.sort((a, b) => {
      const da = Math.abs((tailData.length - a.offset) - nextHeaderSize);
      const db = Math.abs((tailData.length - b.offset) - nextHeaderSize);
      return da - db;
    });
    return encodedCandidates[0];
  }

  // Pass 2: 0x01 direct headers. kHeader (0x01) is followed by one of:
  //   0x02 kArchiveProperties, 0x03 kAdditionalStreamsInfo,
  //   0x04 kMainStreamsInfo, 0x05 kFilesInfo.
  // Plus a density check: in a real direct header the structural skeleton
  // (property IDs + short vints) has most bytes ≤ 0x19. AES-encrypted bytes
  // look uniformly random, so >50% of bytes exceed 0x19.
  const directCandidates: TailHeaderMatch[] = [];
  for (let scan = scanStart; scan < tailData.length - 32; scan++) {
    if (tailData[scan] !== 0x01) continue;
    const next = tailData[scan + 1];
    if (next !== 0x02 && next !== 0x03 && next !== 0x04 && next !== 0x05) continue;
    const probe = tailData.slice(scan, scan + 32);
    let lowCount = 0;
    for (const b of probe) if (b <= 0x19) lowCount++;
    if (lowCount < 22) continue; // <70% low bytes — likely random/encrypted
    directCandidates.push({ offset: scan, kind: 0x01, reason: `density=${lowCount}/32` });
  }
  if (directCandidates.length > 0) {
    directCandidates.sort((a, b) => {
      const da = Math.abs((tailData.length - a.offset) - nextHeaderSize);
      const db = Math.abs((tailData.length - b.offset) - nextHeaderSize);
      return da - db;
    });
    return directCandidates[0];
  }

  return null;
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
    let codecType: 'none' | 'lzma1' | 'lzma2' = 'none';
    let encrypted = false;
    let aesRawProps: Buffer | undefined;

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
        let totalOutStreams = 1; // default: single output stream
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

              totalOutStreams = 0;

              for (let c = 0; c < numCoders.value; c++) {
                const flags = data.readUInt8(offset);
                offset++;

                const idSize = flags & 0x0F;
                const isComplex = !!(flags & 0x10);
                const hasAttrs = !!(flags & 0x20);

                if (offset + idSize > data.length) return null;
                const codecId = Buffer.from(data.slice(offset, offset + idSize));
                offset += idSize;

                // Detect codecs at any position (handles AES + LZMA chains)
                const isAES = codecId.equals(AES256_CODEC_ID);
                if (isAES) encrypted = true;
                if (codecType === 'none') {
                  if (codecId.length === 3 && codecId[0] === 0x03 && codecId[1] === 0x01 && codecId[2] === 0x01) {
                    codecType = 'lzma1';
                  } else if (codecId.length === 1 && codecId[0] === 0x21) {
                    codecType = 'lzma2';
                  }
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
                  // Capture LZMA/LZMA2 props
                  if (codecType !== 'none' && coderProps.length === 0) {
                    coderProps = Buffer.from(data.slice(offset, offset + propsSize.value));
                  }
                  // Capture AES props separately
                  if (isAES && !aesRawProps) {
                    aesRawProps = Buffer.from(data.slice(offset, offset + propsSize.value));
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
            // One unpack size per output stream per folder.
            // For multi-coder chains (e.g. AES+LZMA), there are multiple sizes —
            // use the LAST one (final output = actual decompressed header size).
            for (let u = 0; u < totalOutStreams; u++) {
              const s = read7zNumber(data, offset);
              if (!s) return null;
              unpackSize = s.value; // keeps overwriting — last one wins
              offset += s.length;
            }
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

    // Sanity caps — untrusted input from NZB. Matches nextHeaderSize cap elsewhere.
    if (packSize > MAX_METADATA_SIZE || unpackSize > MAX_METADATA_SIZE) return null;

    const aesProps = aesRawProps ? parseAESProps(aesRawProps) : undefined;
    return { packPos, packSize, unpackSize, coderProps, codecType, encrypted, aesProps: aesProps ?? undefined };
  } catch (err) {
    // RangeErrors are expected when findEndHeaderInTail tests a random 0x17
    // byte inside encrypted noise — the parser hits Buffer OOB and bails.
    // Silent null is the right outcome; other errors indicate real failures.
    if (err instanceof RangeError) return null;
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
        if (data.indexOf(AES256_CODEC_ID) !== -1) {
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

          // Clamp propEnd to buffer length (encrypted/truncated headers may extend past available data)
          const propEnd = Math.min(offset + propSize.value, data.length);

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

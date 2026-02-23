/**
 * Archive Utilities
 *
 * Shared utility functions for variable-length integer decoding
 * and content detection helpers used across archive parsers.
 */

import type { ArchiveInfo } from './types.js';

/**
 * Read variable-length integer (RAR5 vint encoding)
 */
export function readVInt(data: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= data.length) return null;

  let value = 0;
  let length = 0;

  for (let i = 0; i < 10; i++) { // Max 10 bytes for vint
    if (offset + i >= data.length) return null;

    const byte = data.readUInt8(offset + i);
    // Use multiplication instead of bit shift to avoid 32-bit integer overflow
    // JavaScript's << operator works on 32-bit signed ints, which overflows at i >= 5
    value += (byte & 0x7F) * (128 ** i);
    length++;

    // If high bit is not set, this is the last byte
    if (!(byte & 0x80)) {
      break;
    }
  }

  return { value, length };
}

/**
 * Read a 7z-style variable-length number.
 * First byte's set bits indicate how many following bytes are part of the number.
 * Bit 0 set -> 1 extra byte, bits 0-1 set -> 2 extra bytes, etc.
 */
export function read7zNumber(data: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= data.length) return null;

  const firstByte = data.readUInt8(offset);
  let mask = 0x80;
  let numBytes = 0;

  // Count leading 1-bits to determine size
  while ((firstByte & mask) !== 0 && numBytes < 8) {
    numBytes++;
    mask >>= 1;
  }

  if (numBytes === 0) {
    return { value: firstByte, length: 1 };
  }

  const totalBytes = numBytes + 1;
  if (offset + totalBytes > data.length) return null;

  // 7z encodes multi-byte numbers with:
  //   - Subsequent bytes in little-endian order (byte 1 = bits 0-7, byte 2 = bits 8-15, ...)
  //   - First byte's remaining bits are the high part, shifted above the subsequent bytes
  // Use multiplication instead of bit shift to avoid 32-bit integer overflow
  let value = 0;
  for (let i = 0; i < numBytes; i++) {
    value += data.readUInt8(offset + 1 + i) * (256 ** i);
  }
  // First byte's remaining bits go to the highest position
  const highPart = firstByte & (mask - 1);
  value += highPart * (256 ** numBytes);

  return { value, length: totalBytes };
}

/**
 * Check a filename for nested archive indicators and update info accordingly.
 */
export function checkFileContentType(filename: string, info: ArchiveInfo): void {
  const lowerName = filename.toLowerCase();

  // Check for nested archives
  if (lowerName.endsWith('.rar') || lowerName.endsWith('.zip') ||
      lowerName.endsWith('.7z') || lowerName.endsWith('.tar')) {
    info.hasNestedArchive = true;
  }

  // Check for ISO files
  if (lowerName.endsWith('.iso') || lowerName.endsWith('.img')) {
    info.hasISO = true;
  }
}

/**
 * Determine if archive contents are likely video files based on inspection
 */
export function hasVideoContent(info: ArchiveInfo): boolean {
  if (info.files.length === 0) {
    // Can't determine - assume might have video
    return true;
  }

  const videoExtensions = ['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.m2ts', '.wmv', '.webm', '.mov', '.mpg', '.mpeg'];

  for (const file of info.files) {
    const lowerName = file.name.toLowerCase();

    // Skip sample files
    if (lowerName.includes('sample')) continue;

    // Check for video extension
    if (videoExtensions.some(ext => lowerName.endsWith(ext))) {
      return true;
    }
  }

  return false;
}

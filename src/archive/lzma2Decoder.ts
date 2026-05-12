/**
 * LZMA2 Decoder
 *
 * Decompresses LZMA2 streams used in 7z encoded headers. LZMA2 wraps LZMA1
 * in a chunked format with dictionary carry-forward and reset control.
 * Reuses the exported LZMADecoder and RangeDecoder from lzmaDecoder.ts.
 */

import { RangeDecoder, LZMADecoder } from './lzmaDecoder.js';

const MAX_UNCOMPRESSED_SIZE = 10 * 1024 * 1024; // 10MB — sanity limit for 7z headers
const MAX_DICT_SIZE = 10 * 1024 * 1024;

/** Calculate dictionary size from LZMA2 properties byte. */
function lzma2DictSize(propsByte: number): number {
  if (propsByte === 0) return 1;
  return (2 + (propsByte & 1)) << ((propsByte >> 1) + 11);
}

/**
 * Decompress an LZMA2 stream. Used for 7z encoded headers with LZMA2 codec.
 * Processes chunks sequentially, carrying dictionary state across compressed chunks.
 */
export function decompressLZMA2(
  data: Buffer,
  propsByte: number,
  uncompressedSize: number,
): Buffer {
  if (uncompressedSize > MAX_UNCOMPRESSED_SIZE) {
    throw new Error(`LZMA2: uncompressed size too large (${uncompressedSize})`);
  }

  const dictSize = lzma2DictSize(propsByte);
  if (dictSize > MAX_DICT_SIZE) {
    throw new Error(`LZMA2: dictionary size too large (${dictSize})`);
  }

  const dictionary = new Uint8Array(dictSize);
  let dictPos = 0;
  const output: number[] = [];
  let pos = 0;

  // LZMA properties — carried forward between chunks unless reset
  let lc = 0, lp = 0, pb = 0;
  let hasProps = false;

  while (pos < data.length && output.length < uncompressedSize) {
    const control = data[pos++];

    // End of stream
    if (control === 0x00) break;

    // Uncompressed chunk
    if (control === 0x01 || control === 0x02) {
      if (pos + 2 > data.length) break;
      const chunkSize = ((data[pos] << 8) | data[pos + 1]) + 1;
      pos += 2;

      if (control === 0x01) {
        // Reset dictionary
        dictionary.fill(0);
        dictPos = 0;
      }

      if (pos + chunkSize > data.length) break;

      for (let i = 0; i < chunkSize && output.length < uncompressedSize; i++) {
        const byte = data[pos + i];
        output.push(byte);
        dictionary[dictPos % dictSize] = byte;
        dictPos++;
      }
      pos += chunkSize;
      continue;
    }

    // Reserved range
    if (control < 0x80) break;

    // Compressed LZMA1 chunk
    const resetLevel = (control >> 5) & 3;
    const uncompHigh = control & 0x1F;

    if (pos + 4 > data.length) break;
    const uncompSize = (uncompHigh << 16) | (data[pos] << 8) | data[pos + 1];
    const chunkUncompSize = uncompSize + 1;
    pos += 2;
    const compSize = ((data[pos] << 8) | data[pos + 1]) + 1;
    pos += 2;

    // Reset handling
    if (resetLevel >= 3) {
      // Full reset: dictionary + state + properties
      dictionary.fill(0);
      dictPos = 0;
    }

    if (resetLevel >= 2) {
      // New LZMA properties
      if (pos >= data.length) break;
      const propByte = data[pos++];
      lc = propByte % 9;
      const rem = Math.floor(propByte / 9);
      lp = rem % 5;
      pb = Math.floor(rem / 5);
      hasProps = true;
    }

    if (!hasProps) break; // No properties available — can't decompress

    if (pos + compSize > data.length) break;

    const chunkData = Buffer.from(data.slice(pos, pos + compSize));
    pos += compSize;

    // Decompress chunk using LZMADecoder with external dictionary for cross-chunk back-refs
    const rc = new RangeDecoder(chunkData);
    const decoder = new LZMADecoder(lc, lp, pb, dictSize, chunkUncompSize, rc, dictionary, dictPos);
    const decoded = decoder.decode();

    // Append to output and update dictionary
    for (let i = 0; i < decoded.length && output.length < uncompressedSize; i++) {
      const byte = decoded[i];
      output.push(byte);
      dictionary[dictPos % dictSize] = byte;
      dictPos++;
    }
  }

  return Buffer.from(output);
}

/**
 * Archive Format Detector
 *
 * Detects archive format via magic bytes signature matching.
 * Supports RAR4, RAR5, 7-Zip, and ZIP formats.
 */

/**
 * Check if data is RAR4 format
 * Signature: 0x52 0x61 0x72 0x21 0x1A 0x07 0x00 ("Rar!\x1A\x07\x00")
 */
export function isRAR4(data: Buffer): boolean {
  if (data.length < 7) return false;
  return data[0] === 0x52 && data[1] === 0x61 && data[2] === 0x72 &&
         data[3] === 0x21 && data[4] === 0x1A && data[5] === 0x07 &&
         data[6] === 0x00;
}

/**
 * Check if data is RAR5 format
 * Signature: 0x52 0x61 0x72 0x21 0x1A 0x07 0x01 0x00 ("Rar!\x1A\x07\x01\x00")
 */
export function isRAR5(data: Buffer): boolean {
  if (data.length < 8) return false;
  return data[0] === 0x52 && data[1] === 0x61 && data[2] === 0x72 &&
         data[3] === 0x21 && data[4] === 0x1A && data[5] === 0x07 &&
         data[6] === 0x01 && data[7] === 0x00;
}

/**
 * Check if data is 7-Zip format
 * Signature: 0x37 0x7A 0xBC 0xAF 0x27 0x1C ("7z" + magic bytes)
 */
export function is7Zip(data: Buffer): boolean {
  if (data.length < 6) return false;
  return data[0] === 0x37 && data[1] === 0x7A && data[2] === 0xBC &&
         data[3] === 0xAF && data[4] === 0x27 && data[5] === 0x1C;
}

/**
 * Check if data is ZIP format
 * Signature: 0x50 0x4B 0x03 0x04 or 0x50 0x4B 0x05 0x06
 */
export function isZip(data: Buffer): boolean {
  if (data.length < 4) return false;
  return data[0] === 0x50 && data[1] === 0x4B &&
         (data[2] === 0x03 || data[2] === 0x05);
}

/**
 * Archive Inspector Types
 *
 * Shared interfaces used across all archive parsing modules.
 */

export interface ArchiveInfo {
  format: 'rar4' | 'rar5' | '7z' | 'zip' | 'unknown';
  encrypted: boolean;
  compression: 'stored' | 'compressed' | 'unknown';
  files: ArchiveFile[];
  hasNestedArchive: boolean;
  hasISO: boolean;
}

export interface ArchiveFile {
  name: string;
  size: number;
  compressed: boolean;
}

export interface UsenetConfig {
  host: string;
  port: number;
  useTLS: boolean;
  username: string;
  password: string;
}

/**
 * Info extracted from a kEncodedHeader's StreamsInfo.
 * Tells us where the LZMA-compressed file catalog is stored in the archive.
 */
export interface EncodedHeaderInfo {
  packPos: number;       // Offset from byte 32 in archive where packed data starts
  packSize: number;      // Size of packed (compressed) data
  unpackSize: number;    // Expected size of unpacked data
  coderProps: Buffer;    // LZMA properties (5 bytes: lc/lp/pb + dictionary size)
  isLZMA: boolean;       // Whether the coder is LZMA1 (0x030101)
  encrypted: boolean;    // Whether AES encryption was detected
}

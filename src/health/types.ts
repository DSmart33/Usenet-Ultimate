/**
 * Health Check Types
 *
 * Shared type definitions for the health check system.
 */

export type HealthStatus =
  | 'verified'              // Video file confirmed available
  | 'verified_stored'       // Stored/uncompressed archive (fast to stream)
  | 'verified_archive'      // Compressed archive (confirmed available, needs decompression)
  | 'blocked'               // Missing segments or dead
  | 'error';                // Check failed (network error, provider failure, VPN change, etc.)

export interface HealthCheckResult {
  status: HealthStatus;
  message: string;
  playable: boolean;
  providersUsed?: string[];
  password?: string;
}

export interface NzbFile {
  subject: string;
  segments: Array<{ messageId: string; bytes: number; number: number }>;
}

export interface NzbParseResult {
  files: NzbFile[];
  password?: string;
}

export interface HealthCheckOptions {
  archiveInspection: boolean;
  sampleCount: 3 | 7;
}

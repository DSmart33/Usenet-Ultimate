/**
 * Health Check Module
 *
 * Re-exports all health check functionality for backward compatibility.
 * Consumers can import from './health/index.js' or individual submodules.
 */

// Types
export type { HealthStatus, HealthCheckResult, NzbFile, NzbParseResult, HealthCheckOptions } from './types.js';

// Segment cache
export {
  configureSegmentCache,
  clearSegmentCache,
  getSegmentCacheStats,
  addToSegmentCache,
  checkSegmentCache,
  saveSegmentCache,
  loadSegmentCache,
  shutdownSegmentCache,
} from './segmentCache.js';

// NZB content cache
export { cacheNzbContent, getCachedNzbContent } from './nzbContentCache.js';

// NZB parsing
export { CircuitChangedError, downloadAndParseNzb } from './nzbParser.js';

// File classification
export { extractFilename, isVideoFile, isCompressedArchive } from './fileClassifier.js';

// Archive grouping
export {
  groupArchiveParts,
  selectMultiPartSamples,
  findFirstArchivePart,
  collectAllArchiveSegments,
} from './archiveGrouper.js';

// NNTP connection management
export { connectToUsenet, NntpConnectionPool } from './nntpConnection.js';

// Article checking
export { checkArticlesDetailed, checkArticlesOnProvider, checkArticlesMultiProvider } from './articleChecker.js';

// Health check pipeline
export { performHealthCheck } from './healthCheckPipeline.js';

// Batch processing
export { performBatchHealthChecks } from './batchProcessor.js';

/**
 * Parsers — Barrel re-exports
 */

// Re-export metadata parsers
export {
  parseQuality, resolutionToDisplay, parseCodec, parseSource,
  parseVisualTag, parseAudioTag, parseLanguage, formatBytes,
  parseEdition, parseReleaseGroup, parseCleanTitle, parseMetadata,
} from './metadataParsers.js';
export type { ParsedMetadata } from './metadataParsers.js';

// Re-export newznab client
export { parseNewznabXmlWithMeta, parseNewznabXml, fetchIndexerCaps } from './newznabClient.js';
export type { NewznabParsedResponse } from './newznabClient.js';

// Re-export title matching
export { stripDiacritics, normalizeTitle, extractTitleFromRelease, isTextSearchMatch } from './titleMatching.js';

// Re-export Usenet searcher
export { UsenetSearcher } from './usenetSearcher.js';

// Re-export BDMV/MPLS parser
export { parseMpls, extractDiscNumber, buildEpisodeMap, resolveEpisode } from './bdmvParser.js';
export type { MplsPlaylist, MplsClip, BdmvEpisodeMap, BdmvEpisode, ResolvedEpisode } from './bdmvParser.js';

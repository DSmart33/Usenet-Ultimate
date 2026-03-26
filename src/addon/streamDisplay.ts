/**
 * Stream Display Builder
 *
 * Constructs the visual name/title for each stream card shown in Stremio.
 * Supports both the legacy hardcoded format and a fully customizable
 * StreamDisplayConfig with element groups and prefixes.
 */

import type { StreamDisplayConfig } from '../types.js';

const EDITION_DISPLAY: Record<string, string> = {
  'Extended Edition': 'Extended',
};

export interface StreamDisplayData {
  resolutionDisplay: string;
  quality: string;
  cleanTitle: string;
  rawTitle: string;
  encode: string;
  displaySize: string;
  visualTag: string;
  audioTag: string;
  releaseGroup: string;
  indexer: string;
  statusBadge: string;
  providersLine: string;
  edition: string;
  language: string;
  age: string;
  bitrate: string;
  isSeasonPack: boolean;
}

export function buildStreamDisplay(
  data: StreamDisplayData,
  displayConfig?: StreamDisplayConfig
): { name: string; title: string } {
  // If no custom config, use legacy hardcoded format (matches default StreamDisplayConfig)
  if (!displayConfig) {
    const streamName = `${data.statusBadge}\n${data.resolutionDisplay}\n${data.quality}`;
    const titleLine = data.isSeasonPack ? `📦 ${data.cleanTitle}` : `🎬 ${data.cleanTitle}`;
    const editionLangSpecs: string[] = [];
    if (data.edition && data.edition !== 'Standard') editionLangSpecs.push(`🏷️ ${EDITION_DISPLAY[data.edition] || data.edition}`);
    if (data.language && data.language !== 'Unknown') editionLangSpecs.push(`🗣️ ${data.language}`);
    const editionLangLine = editionLangSpecs.length > 0 ? `  ${editionLangSpecs.join('  ')}` : null;
    const sizeCodecSpecs: string[] = [];
    if (data.encode !== 'Unknown') sizeCodecSpecs.push(`⚙️ ${data.encode}`);
    sizeCodecSpecs.push(`💾 ${data.displaySize}`);
    const sizeCodecLine = `  ${sizeCodecSpecs.join('  ')}`;
    const tagSpecs: string[] = [];
    if (data.visualTag !== 'Unknown') tagSpecs.push(`🎨 ${data.visualTag}`);
    if (data.audioTag !== 'Unknown') tagSpecs.push(`🔊 ${data.audioTag}`);
    const tagLine = tagSpecs.length > 0 ? `  ${tagSpecs.join('  ')}` : null;
    const ageBitrateSpecs: string[] = [];
    if (data.age) ageBitrateSpecs.push(`📅 ${data.age}`);
    if (data.bitrate) ageBitrateSpecs.push(`📊 ${data.bitrate}`);
    const ageBitrateLine = ageBitrateSpecs.length > 0 ? `  ${ageBitrateSpecs.join('  ')}` : null;
    const metaLine = `  🏴‍☠️ ${data.releaseGroup}  🗂️ ${data.indexer}`;
    const streamTitle = [titleLine, editionLangLine, sizeCodecLine, tagLine, ageBitrateLine, metaLine, data.providersLine || null]
      .filter(Boolean).join('\n');
    return { name: streamName, title: streamTitle };
  }

  // Custom config: build from elements and lineGroups
  const valueMap: Record<string, string> = {
    resolution: data.resolutionDisplay,
    quality: data.quality,
    healthBadge: data.statusBadge,
    cleanTitle: (displayConfig?.cleanTitles !== false) ? data.cleanTitle : data.rawTitle,
    size: data.displaySize,
    codec: data.encode,
    visualTag: data.visualTag,
    audioTag: data.audioTag,
    releaseGroup: data.releaseGroup,
    indexer: data.indexer,
    healthProviders: data.providersLine?.replace(/^\s*📡\s*/, '') || '',
    edition: EDITION_DISPLAY[data.edition] || data.edition,
    language: data.language || '',
    age: data.age || '',
    bitrate: data.bitrate || '',
  };

  // Build name column
  const nameLines = displayConfig.nameElements
    .filter(id => displayConfig.elements[id]?.enabled)
    .map(id => {
      const el = displayConfig.elements[id];
      const val = valueMap[id];
      if (!val || (val === 'Unknown' && id !== 'cleanTitle') || (val === 'Standard' && id === 'edition')) return null;
      return el.prefix ? `${el.prefix} ${val}` : val;
    })
    .filter(Boolean);
  const name = nameLines.join('\n');

  // Build title column from line groups
  const titleLines: string[] = [];
  for (const group of displayConfig.lineGroups) {
    const parts: string[] = [];
    for (const elId of group.elementIds) {
      const el = displayConfig.elements[elId];
      if (!el?.enabled) continue;
      const val = valueMap[elId];
      if (!val || (val === 'Unknown' && elId !== 'cleanTitle') || (val === 'Standard' && elId === 'edition')) continue;

      if (elId === 'cleanTitle') {
        const prefix = data.isSeasonPack ? displayConfig.seasonPackPrefix : displayConfig.regularPrefix;
        parts.push(prefix ? `${prefix} ${val}` : val);
      } else if (el.prefix) {
        parts.push(`${el.prefix} ${val}`);
      } else {
        parts.push(val);
      }
    }
    if (parts.length === 0) continue;
    const indent = group.indent ? '  ' : '';
    titleLines.push(indent + parts.join('  '));
  }

  return { name, title: titleLines.join('\n') };
}

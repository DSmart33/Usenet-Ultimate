// What this does:
//   Stream display preview rendering and line group normalization

import type { StreamDisplayConfig, MockStreamData } from '../types';
import { MAX_TITLE_ROWS } from '../constants';

/** Ensure lineGroups always has exactly MAX_TITLE_ROWS entries and defaults are set */
export function normalizeLineGroups(config: StreamDisplayConfig): StreamDisplayConfig {
  const groups = [...config.lineGroups];
  while (groups.length < MAX_TITLE_ROWS) {
    groups.push({ id: `row-${groups.length + 1}`, elementIds: [], indent: true });
  }
  if (groups.length > MAX_TITLE_ROWS) groups.length = MAX_TITLE_ROWS;
  return { ...config, lineGroups: groups, cleanTitles: config.cleanTitles ?? true };
}

/** Render stream preview from display config + mock data (pure function, no hooks) */
export function renderStreamPreview(mockData: MockStreamData, cfg: StreamDisplayConfig) {
  const valueMap: Record<string, string> = {
    resolution: mockData.resolution,
    quality: mockData.quality,
    healthBadge: mockData.healthBadge,
    cleanTitle: cfg.cleanTitles ? mockData.cleanTitle : mockData.rawTitle,
    size: mockData.displaySize || mockData.size,
    codec: mockData.encode,
    visualTag: mockData.visualTag,
    audioTag: mockData.audioTag,
    releaseGroup: mockData.releaseGroup,
    indexer: mockData.indexer,
    healthProviders: mockData.healthProviders,
    edition: mockData.edition,
    language: mockData.language,
  };

  const nameLines = cfg.nameElements
    .filter(id => cfg.elements[id]?.enabled)
    .map(id => {
      const el = cfg.elements[id];
      const val = valueMap[id];
      if (!val || (val === 'Unknown' && id !== 'cleanTitle') || (val === 'Standard' && id === 'edition')) return null;
      return el.prefix ? `${el.prefix} ${val}` : val;
    })
    .filter(Boolean) as string[];

  const titleLines: string[] = [];
  for (const group of cfg.lineGroups) {
    const parts: string[] = [];
    for (const elId of group.elementIds) {
      const el = cfg.elements[elId];
      if (!el?.enabled) continue;
      const val = valueMap[elId];
      if (!val || (val === 'Unknown' && elId !== 'cleanTitle') || (val === 'Standard' && elId === 'edition')) continue;
      if (elId === 'cleanTitle') {
        const prefix = mockData.isSeasonPack ? cfg.seasonPackPrefix : cfg.regularPrefix;
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

  return { nameLines, titleLines };
}

// What this does:
//   Constants and static data used across the UI

import type { StreamDisplayConfig, MockStreamData } from '../types';

export const ZYCLOPS_BACKBONES = [
  'usenetexpress', 'abavia', 'eweka-internet-services', 'base-ip',
  'netnews', 'uzo-reto', 'omicron', 'giganews'
] as const;

export const MAX_TITLE_ROWS = 8;

export const DEFAULT_STREAM_DISPLAY: StreamDisplayConfig = {
  nameElements: ['healthBadge', 'resolution', 'quality'],
  seasonPackPrefix: '📦',
  regularPrefix: '🎬',
  elements: {
    resolution:      { id: 'resolution',      label: 'Resolution',       enabled: true,  prefix: ''    },
    quality:         { id: 'quality',          label: 'Quality/Source',   enabled: true,  prefix: ''    },
    healthBadge:     { id: 'healthBadge',      label: 'Health Badge',     enabled: true,  prefix: ''    },
    cleanTitle:      { id: 'cleanTitle',       label: 'Release Title',    enabled: true,  prefix: ''    },
    size:            { id: 'size',             label: 'File Size',        enabled: true,  prefix: '💾'  },
    codec:           { id: 'codec',            label: 'Codec/Encode',     enabled: true,  prefix: '⚙️'  },
    visualTag:       { id: 'visualTag',        label: 'Visual Tag (HDR)', enabled: true,  prefix: '🎨'  },
    audioTag:        { id: 'audioTag',         label: 'Audio Tag',        enabled: true,  prefix: '🔊'  },
    releaseGroup:    { id: 'releaseGroup',     label: 'Release Group',    enabled: true,  prefix: '🏴‍☠️' },
    indexer:         { id: 'indexer',           label: 'Indexer',          enabled: true,  prefix: '🗂️'  },
    healthProviders: { id: 'healthProviders',  label: 'Health Providers', enabled: true,  prefix: '📡'  },
    edition:         { id: 'edition',          label: 'Edition',          enabled: true,  prefix: '🏷️'  },
    language:        { id: 'language',          label: 'Language',         enabled: true,  prefix: '🗣️'  },
  },
  lineGroups: [
    { id: 'title-line',   elementIds: ['cleanTitle'],                   indent: false },
    { id: 'size-line',    elementIds: ['edition', 'language'],          indent: true  },
    { id: 'tag-line',     elementIds: ['codec', 'size'],               indent: true  },
    { id: 'edition-line', elementIds: ['visualTag', 'audioTag'],       indent: true  },
    { id: 'meta-line',    elementIds: ['releaseGroup', 'indexer'],     indent: true  },
    { id: 'health-line',  elementIds: ['healthProviders'],             indent: true  },
    { id: 'row-7',        elementIds: [],                              indent: true  },
    { id: 'row-8',        elementIds: [],                              indent: true  },
  ],
  cleanTitles: true,
};

export const MOCK_STREAM_DATA: Record<string, MockStreamData> = {
  regular: {
    cleanTitle: 'Neon Horizon',
    rawTitle: 'Neon.Horizon.2025.Remastered.2160p.BluRay.REMUX.HEVC.HDR10+.DTS-HD.MA-GALAXY',
    resolution: '2160p',
    quality: 'BluRay REMUX',
    encode: 'HEVC',
    size: '54.2 GB',
    displaySize: '54.2 GB',
    visualTag: 'HDR10+',
    audioTag: 'DTS-HD MA',
    releaseGroup: 'GALAXY',
    indexer: 'Indexer A',
    healthBadge: '✅',
    healthProviders: 'Provider1 (3/3), Provider2 (3/3)',
    edition: 'Remastered',
    language: 'English',
    isSeasonPack: false,
  },
  seasonPack: {
    cleanTitle: 'Signal Lost S01',
    rawTitle: 'Signal.Lost.S01.1080p.BluRay.AVC.DTS-HD.MA.5.1-ROVERS',
    resolution: '1080p',
    quality: 'BluRay',
    encode: 'AVC',
    size: '45.8 GB',
    displaySize: '~6.5 GB/ep (45.8 GB pack)',
    visualTag: 'SDR',
    audioTag: 'DTS-HD MA',
    releaseGroup: 'ROVERS',
    indexer: 'Indexer B',
    healthBadge: '✅',
    healthProviders: 'Provider1 (3/3)',
    edition: 'Standard',
    language: 'English',
    isSeasonPack: true,
  },
  minimal: {
    cleanTitle: 'Quiet Valley',
    rawTitle: 'Quiet.Valley.2024.720p.WEBRip.x264-DRIFT',
    resolution: '720p',
    quality: 'WEBRip',
    encode: 'Unknown',
    size: '1.2 GB',
    displaySize: '1.2 GB',
    visualTag: 'Unknown',
    audioTag: 'Unknown',
    releaseGroup: 'Unknown',
    indexer: 'Indexer C',
    healthBadge: '',
    healthProviders: '',
    edition: 'Standard',
    language: 'Unknown',
    isSeasonPack: false,
  },
};

export const IP_REGEX = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;

export const DEFAULT_HEALTH_CHECKS = {
  enabled: false,
  archiveInspection: true,
  sampleCount: 3 as 3 | 7,
  providers: [] as import('../types').UsenetProvider[],
  nzbsToInspect: 6,
  inspectionMethod: 'smart' as const,
  smartBatchSize: 3,
  smartAdditionalRuns: 1,
  maxConnections: 12,
  autoQueueMode: 'all' as 'off' | 'top' | 'all',
  hideBlocked: true,
  libraryPreCheck: true,
  healthCheckIndexers: {} as Record<string, boolean>,
  segmentCache: { enabled: true, ttlHours: 0, maxSizeMB: 50 },
};

export const DEFAULT_FILTERS = {
  sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition'] as string[],
  enabledSorts: {
    quality: true,
    videoTag: true,
    size: true,
    encode: true,
    visualTag: true,
    audioTag: true,
    language: false,
    edition: false
  } as Record<string, boolean>,
  enabledPriorities: {
    resolution: {} as Record<string, boolean>,
    video: {} as Record<string, boolean>,
    encode: {} as Record<string, boolean>,
    visualTag: {} as Record<string, boolean>,
    audioTag: {} as Record<string, boolean>,
    language: {} as Record<string, boolean>,
    edition: {} as Record<string, boolean>
  },
  maxFileSize: undefined as number | undefined,
  maxStreams: 10 as number | undefined,
  maxStreamsPerQuality: undefined as number | undefined,
  resolutionPriority: ['2160p', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'] as string[],
  videoPriority: ['BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDRip', 'HC HD-Rip', 'DVDRip', 'HDTV', 'Unknown'] as string[],
  encodePriority: ['AV1', 'HEVC', 'AVC', 'Unknown'] as string[],
  visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'IMAX', 'HDR10', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'] as string[],
  audioTagPriority: ['Atmos', 'DTS:X', 'DTS-HD MA', 'TrueHD', 'DTS-HD', 'DD+', 'DD'] as string[],
  languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'] as string[],
  editionPriority: ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard'] as string[],
  preferNonStandardEdition: false
};

export const DEFAULT_CARD_ORDER = ['streaming', 'indexManager', 'proxy', 'zyclops', 'healthChecks', 'autoPlay', 'cache', 'filters', 'userAgent', 'status', 'stats', 'power'];

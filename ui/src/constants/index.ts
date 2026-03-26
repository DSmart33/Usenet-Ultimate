// What this does:
//   Constants and static data used across the UI

import type { StreamDisplayConfig, MockStreamData } from '../types';

export const ZYCLOPS_BACKBONES = [
  'abavia', 'base-ip', 'elbracht', 'eweka-internet-services',
  'giganews', 'its-hosted', 'netnews', 'omicron',
  'usenetexpress', 'uzo-reto'
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
    age:             { id: 'age',              label: 'Post Age',         enabled: false, prefix: '📅'  },
    bitrate:         { id: 'bitrate',          label: 'Bitrate',          enabled: false, prefix: '📊'  },
  },
  lineGroups: [
    { id: 'title-line',   elementIds: ['cleanTitle'],                   indent: false },
    { id: 'size-line',    elementIds: ['edition', 'language'],          indent: true  },
    { id: 'tag-line',     elementIds: ['codec', 'size'],               indent: true  },
    { id: 'edition-line', elementIds: ['visualTag', 'audioTag'],       indent: true  },
    { id: 'meta-line',    elementIds: ['releaseGroup', 'indexer'],     indent: true  },
    { id: 'health-line',  elementIds: ['healthProviders'],             indent: true  },
    { id: 'row-7',        elementIds: ['age', 'bitrate'],              indent: true  },
    { id: 'row-8',        elementIds: [],                              indent: true  },
  ],
  cleanTitles: true,
};

export const MOCK_STREAM_DATA: Record<string, MockStreamData> = {
  regular: {
    cleanTitle: 'Neon Horizon',
    rawTitle: 'Neon.Horizon.2025.Remastered.2160p.BluRay.REMUX.HEVC.HDR10+.DTS-HD.MA-GALAXY',
    resolution: '4K',
    quality: 'BluRay REMUX',
    encode: 'hevc',
    size: '54.2 GB',
    displaySize: '54.2 GB',
    visualTag: 'HDR10+',
    audioTag: 'DTS Lossless',
    releaseGroup: 'GALAXY',
    indexer: 'Indexer A',
    healthBadge: '✅',
    healthProviders: 'Provider1 (3/3), Provider2 (3/3)',
    edition: 'Remastered',
    language: 'English',
    age: '2h',
    bitrate: '8.5 Mbps',
    isSeasonPack: false,
  },
  seasonPack: {
    cleanTitle: 'Signal Lost S01',
    rawTitle: 'Signal.Lost.S01.1080p.BluRay.AVC.DTS-HD.MA.5.1-ROVERS',
    resolution: '1080p',
    quality: 'BluRay',
    encode: 'avc',
    size: '45.8 GB',
    displaySize: '~6.5 GB/ep (45.8 GB pack)',
    visualTag: 'SDR',
    audioTag: 'DTS Lossless',
    releaseGroup: 'ROVERS',
    indexer: 'Indexer B',
    healthBadge: '✅',
    healthProviders: 'Provider1 (3/3)',
    edition: 'Standard',
    language: 'English',
    age: '3d',
    bitrate: '6.2 Mbps',
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
    age: '',
    bitrate: '',
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
};

export const DEFAULT_FILTERS = {
  sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition', 'age', 'bitrate'] as string[],
  enabledSorts: {
    quality: true,
    videoTag: true,
    size: true,
    encode: true,
    visualTag: true,
    audioTag: true,
    language: false,
    edition: false,
    age: false,
    bitrate: false,
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
  maxStreams: undefined as number | undefined,
  maxStreamsPerResolution: undefined as number | undefined,
  maxStreamsPerQuality: undefined as number | undefined,
  resolutionPriority: ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'] as string[],
  videoPriority: ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'] as string[],
  encodePriority: ['av1', 'hevc', 'vp9', 'avc', 'vp8', 'xvid', 'mpeg2', 'Unknown'] as string[],
  visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'] as string[],
  audioTagPriority: ['Atmos (TrueHD)', 'DTS Lossless', 'TrueHD', 'Atmos (DDP)', 'DTS Lossy', 'DDP', 'DD', 'FLAC', 'PCM', 'AAC', 'OPUS', 'MP3', 'Unknown'] as string[],
  languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'] as string[],
  editionPriority: ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard'] as string[],
  preferNonStandardEdition: false
};

export const DEFAULT_CARD_ORDER = ['streaming', 'indexManager', 'proxy', 'zyclops', 'fallback', 'healthChecks', 'nzbDatabase', 'autoPlay', 'streamDisplay', 'cache', 'filters', 'userAgent', 'status', 'stats', 'power'];

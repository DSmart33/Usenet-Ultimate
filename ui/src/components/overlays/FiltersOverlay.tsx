// What this does:
//   Filters & Sorting overlay with resolution priority, quality filtering, sort order,
//   per-type (Movie/TV) overrides, and drag-to-reorder priority lists

import { useState, useCallback, useRef } from 'react';
import { Filter, X, Check, GripVertical, ChevronDown, ArrowUpDown } from 'lucide-react';
import clsx from 'clsx';
import type { FiltersState } from '../../types';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';

interface StreamFilterFieldConfig {
  label: string;
  description: string;
  unit?: string;
  defaultValue: number;
  step: number;
  min: number;
  isFloat?: boolean;
  modeKey?: keyof FiltersState;
}

function StreamFilterField({ config: field, value: rawValue, onChange, modeValue, onModeChange }: {
  config: StreamFilterFieldConfig;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  modeValue?: 'episode' | 'pack';
  onModeChange?: (v: 'episode' | 'pack' | undefined) => void;
}) {
  const isLimited = rawValue != null;
  const GB = 1024 * 1024 * 1024;
  const toDisplay = (v: number) => field.unit === 'GB' ? parseFloat((v / GB).toFixed(2)) : v;
  const fromDisplay = (v: number) => field.unit === 'GB' ? v * GB : v;
  const displayValue = isLimited ? toDisplay(rawValue) : undefined;

  // Remember last value so toggling off→on restores it
  // Resets to field default when externally cleared (Reset to Default)
  const lastValue = useRef<number>(field.defaultValue);
  const wasToggledOff = useRef(false);
  if (displayValue != null) {
    lastValue.current = displayValue;
    wasToggledOff.current = false;
  } else if (!wasToggledOff.current) {
    lastValue.current = field.defaultValue;
  }

  const setDisplay = useCallback((v: number) => {
    const clamped = Math.max(field.min, field.isFloat ? parseFloat(v.toFixed(2)) : Math.round(v));
    onChange(fromDisplay(clamped));
  }, [field.min, field.isFloat, onChange]);

  const inc = useHoldRepeat(useCallback(() => setDisplay((displayValue ?? field.defaultValue) + field.step), [displayValue, field.defaultValue, field.step, setDisplay]));
  const dec = useHoldRepeat(useCallback(() => setDisplay(Math.max(field.min, (displayValue ?? field.defaultValue) - field.step)), [displayValue, field.defaultValue, field.step, field.min, setDisplay]));

  // Local string state allows free typing (clear, partial input, etc.)
  // Commits to real value on blur or Enter
  const [localText, setLocalText] = useState<string | null>(null);
  const isEditing = localText !== null;
  const shownValue = isEditing ? localText : (displayValue != null ? String(displayValue) : '');

  const commitText = () => {
    if (localText === null) return;
    const v = field.isFloat ? parseFloat(localText) : parseInt(localText, 10);
    if (!isNaN(v) && v >= field.min) {
      setDisplay(v);
    }
    setLocalText(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-slate-300">{field.label}</label>
        <button
          onClick={() => {
            if (isLimited) {
              wasToggledOff.current = true;
              onChange(undefined);
            } else {
              setDisplay(lastValue.current);
            }
          }}
          className={clsx(
            "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
            isLimited ? "bg-purple-500" : "bg-slate-600"
          )}
        >
          <div className={clsx(
            "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
            isLimited ? "left-5" : "left-1"
          )} />
        </button>
      </div>
      {isLimited ? (
        <div className="flex items-center gap-2">
          <button
            {...dec}
            className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
          >−</button>
          <input
            type="text"
            inputMode={field.isFloat ? 'decimal' : 'numeric'}
            value={shownValue}
            onFocus={() => setLocalText(displayValue != null ? String(displayValue) : '')}
            onChange={(e) => setLocalText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }}
            className="w-20 bg-slate-800/60 border border-slate-700/40 rounded-lg px-2 py-1 text-center text-sm font-medium text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
          />
          <button
            {...inc}
            className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
          >+</button>
          {field.unit && <span className="text-xs text-slate-500">{field.unit}</span>}
        </div>
      ) : (
        <div className="text-xs text-slate-500">Unlimited</div>
      )}
      {isLimited && onModeChange && (
        <div className="ml-4 mt-2">
          <label className="block text-xs font-medium text-slate-400 mb-1">Season Pack Size</label>
          <div className="flex rounded-lg overflow-hidden border border-slate-700/40 w-fit">
            {([['episode', 'Per-Episode'], ['pack', 'Full Pack']] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => onModeChange(mode === 'episode' ? undefined : mode)}
                className={clsx(
                  "px-3 py-1 text-xs font-medium transition-colors",
                  (modeValue ?? 'episode') === mode
                    ? "bg-purple-500/20 text-purple-300"
                    : "bg-slate-800/40 text-slate-400 hover:text-slate-300"
                )}
              >{label}</button>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500 mt-1">{field.description}</p>
    </div>
  );
}

const STREAM_FILTER_FIELDS: { key: keyof FiltersState; config: StreamFilterFieldConfig }[] = [
  { key: 'minFileSize', config: { label: 'Minimum File Size', description: 'Filters out files smaller than this size', unit: 'GB', defaultValue: 0.1, step: 1, min: 0.01, isFloat: true, modeKey: 'minFileSizeMode' } },
  { key: 'maxFileSize', config: { label: 'Maximum File Size', description: 'Filters out files larger than this size', unit: 'GB', defaultValue: 50, step: 1, min: 1, isFloat: true, modeKey: 'maxFileSizeMode' } },
  { key: 'maxStreams', config: { label: 'Max Total Streams', description: 'Maximum total streams to display overall', defaultValue: 25, step: 1, min: 1 } },
  { key: 'maxStreamsPerResolution', config: { label: 'Max Streams Per Resolution', description: 'Limit streams per resolution level (4K, 1080p, etc.)', defaultValue: 10, step: 1, min: 1 } },
  { key: 'maxStreamsPerQuality', config: { label: 'Max Streams Per Quality', description: 'Limit streams per source quality (BluRay, WEB-DL, etc.)', defaultValue: 10, step: 1, min: 1 } },
];

const SORT_DIRECTION_LABELS: Record<string, Record<string, string>> = {
  size: { desc: 'Largest first', asc: 'Smallest first' },
  age: { asc: 'Newest first', desc: 'Oldest first' },
  bitrate: { desc: 'Highest first', asc: 'Lowest first' },
};

const SORT_DIRECTION_DEFAULTS: Record<string, 'asc' | 'desc'> = {
  size: 'desc',
  age: 'asc',
  bitrate: 'desc',
};

const DISPLAY_LABELS: Record<string, string> = {
  '4k': '4K',
  'hevc': 'HEVC (h265 / x265)',
  'avc': 'AVC (h264 / x264)',
  'xvid': 'XviD (DivX)',
  'av1': 'AV1',
  'vp9': 'VP9',
  'vp8': 'VP8',
  'mpeg2': 'MPEG2',
};

function displayLabel(item: string): string {
  return DISPLAY_LABELS[item] || item;
}

interface FiltersOverlayProps {
  onClose: () => void;
  filters: FiltersState;
  setFilters: React.Dispatch<React.SetStateAction<FiltersState>>;
  movieFilters: FiltersState | null;
  setMovieFilters: React.Dispatch<React.SetStateAction<FiltersState | null>>;
  tvFilters: FiltersState | null;
  setTvFilters: React.Dispatch<React.SetStateAction<FiltersState | null>>;
}

export default function FiltersOverlay({
  onClose,
  filters,
  setFilters,
  movieFilters,
  setMovieFilters,
  tvFilters,
  setTvFilters,
}: FiltersOverlayProps) {
  // Local drag states for sort order
  const [draggedSortItem, setDraggedSortItem] = useState<string | null>(null);
  const [dragOverSortItem, setDragOverSortItem] = useState<string | null>(null);

  // Local drag states for priority sections
  const [draggedResolution, setDraggedResolution] = useState<string | null>(null);
  const [dragOverResolution, setDragOverResolution] = useState<string | null>(null);
  const [draggedVideoTag, setDraggedVideoTag] = useState<string | null>(null);
  const [dragOverVideoTag, setDragOverVideoTag] = useState<string | null>(null);
  const [draggedEncode, setDraggedEncode] = useState<string | null>(null);
  const [dragOverEncode, setDragOverEncode] = useState<string | null>(null);
  const [draggedVisualTag, setDraggedVisualTag] = useState<string | null>(null);
  const [dragOverVisualTag, setDragOverVisualTag] = useState<string | null>(null);
  const [draggedAudioTag, setDraggedAudioTag] = useState<string | null>(null);
  const [dragOverAudioTag, setDragOverAudioTag] = useState<string | null>(null);
  const [draggedLanguage, setDraggedLanguage] = useState<string | null>(null);
  const [dragOverLanguage, setDragOverLanguage] = useState<string | null>(null);
  const [draggedEdition, setDraggedEdition] = useState<string | null>(null);
  const [dragOverEdition, setDragOverEdition] = useState<string | null>(null);

  // Local UI state
  const [expandedPriorities, setExpandedPriorities] = useState<Set<string>>(new Set());
  const [filterTab, setFilterTab] = useState<'all' | 'movie' | 'tv'>('all');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50">
          <div className="p-4 md:p-6 pb-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Filter className="w-6 h-6 text-purple-400" />
                <h3 className="text-xl font-semibold text-slate-200">Filters & Sorting</h3>
              </div>
              <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>
          {/* Movie/TV Tab Bar */}
          <div className="flex gap-1 px-4 md:px-6 pt-4 pb-0">
            {([['all', 'Global'], ['movie', 'Movies'], ['tv', 'TV Shows']] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setFilterTab(tab)}
                className={clsx(
                  "px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
                  filterTab === tab
                    ? "bg-slate-800 text-purple-400 border border-slate-700/50 border-b-0"
                    : "text-slate-400 hover:text-slate-300 hover:bg-slate-800/50"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Per-type override toggle */}
        {filterTab !== 'all' && (
          <div className="px-4 md:px-6 pt-4">
            {(filterTab === 'movie' ? movieFilters : tvFilters) === null ? (
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-slate-300">Using Global Settings</div>
                  <div className="text-xs text-slate-500 mt-0.5">{filterTab === 'movie' ? 'Movies' : 'TV shows'} currently use the global filter configuration</div>
                </div>
                <button
                  onClick={() => {
                    const copy = JSON.parse(JSON.stringify(filters));
                    if (filterTab === 'movie') setMovieFilters(copy);
                    else setTvFilters(copy);
                  }}
                  className="btn-primary text-sm px-4 py-2"
                >
                  Customize
                </button>
              </div>
            ) : (
              <div className="bg-slate-900/50 rounded-lg border border-amber-700/30 p-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-amber-400">Custom {filterTab === 'movie' ? 'Movie' : 'TV'} Settings Active</div>
                  <div className="text-xs text-slate-500 mt-0.5">These settings override the global configuration for {filterTab === 'movie' ? 'movies' : 'TV shows'}</div>
                </div>
                <button
                  onClick={() => {
                    if (filterTab === 'movie') setMovieFilters(null);
                    else setTvFilters(null);
                  }}
                  className="text-sm px-4 py-2 text-red-400 hover:text-red-300 border border-red-700/50 rounded-lg hover:bg-red-900/20 transition-colors"
                >
                  Reset to Global
                </button>
              </div>
            )}
          </div>
        )}

        {(() => {
          // Compute active filters based on selected tab
          const activeFilters = filterTab === 'all' ? filters : (filterTab === 'movie' ? movieFilters : tvFilters) || filters;
          const isReadOnly = filterTab !== 'all' && (filterTab === 'movie' ? movieFilters : tvFilters) === null;
          const updateActiveFilters = (updater: FiltersState | ((prev: FiltersState) => FiltersState)) => {
            if (filterTab === 'all') {
              if (typeof updater === 'function') setFilters(updater);
              else setFilters(updater);
            } else if (filterTab === 'movie') {
              if (typeof updater === 'function') setMovieFilters(prev => updater(prev || filters));
              else setMovieFilters(updater);
            } else {
              if (typeof updater === 'function') setTvFilters(prev => updater(prev || filters));
              else setTvFilters(updater);
            }
          };

          return (
        <div className={clsx("p-4 md:p-6 space-y-6", isReadOnly && "opacity-50 pointer-events-none")}>
          {/* Stream Filters */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
            <div className="text-sm font-medium text-slate-300">Stream Filters</div>
            {STREAM_FILTER_FIELDS.map(({ key, config }) => (
              <StreamFilterField
                key={key}
                config={config}
                value={activeFilters[key] as number | undefined}
                onChange={(v) => updateActiveFilters({ ...activeFilters, [key]: v })}
                modeValue={config.modeKey ? activeFilters[config.modeKey] as 'episode' | 'pack' | undefined : undefined}
                onModeChange={config.modeKey ? (v) => updateActiveFilters({ ...activeFilters, [config.modeKey!]: v }) : undefined}
              />
            ))}
          </div>

          {/* Sort Order Priority */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Sort Order Priority
            </label>
            <p className="text-xs text-slate-500 mb-3">Drag to set primary, secondary, tertiary sort. Deselecting a sort method removes it from sorting entirely.</p>
            <div className="space-y-2">
              {(activeFilters.sortOrder || ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition']).map((method, index) => {
                const isDragging = draggedSortItem === method;
                const isOver = dragOverSortItem === method;
                const labels: Record<string, string> = {
                  quality: 'Resolution',
                  size: 'Size',
                  videoTag: 'Quality',
                  encode: 'Encode',
                  visualTag: 'Visual Tag',
                  audioTag: 'Audio Tag',
                  language: 'Language',
                  edition: 'Edition',
                  age: 'Age',
                  bitrate: 'Bitrate',
                };
                const hasDirection = method in SORT_DIRECTION_LABELS;
                const currentDir = activeFilters.sortDirections?.[method] ?? SORT_DIRECTION_DEFAULTS[method];

                return (
                  <div
                    key={method}
                    draggable
                    onDragStart={() => setDraggedSortItem(method)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverSortItem(method);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedSortItem && draggedSortItem !== method) {
                        const newOrder = [...activeFilters.sortOrder];
                        const draggedIndex = newOrder.indexOf(draggedSortItem);
                        const targetIndex = newOrder.indexOf(method);

                        newOrder.splice(draggedIndex, 1);
                        newOrder.splice(targetIndex, 0, draggedSortItem);

                        updateActiveFilters({ ...activeFilters, sortOrder: newOrder });
                      }
                      setDraggedSortItem(null);
                      setDragOverSortItem(null);
                    }}
                    onDragEnd={() => {
                      setDraggedSortItem(null);
                      setDragOverSortItem(null);
                    }}
                    className={clsx(
                      "flex items-center gap-3 p-3 rounded-lg border bg-slate-800/50 cursor-move transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-purple-400 scale-105",
                      !isDragging && !isOver && "border-slate-700 hover:border-slate-600"
                    )}
                  >
                    <button
                      type="button"
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        updateActiveFilters(prev => ({
                          ...prev,
                          enabledSorts: {
                            ...prev.enabledSorts,
                            [method]: prev.enabledSorts?.[method] === false ? true : false
                          }
                        }));
                      }}
                      className={clsx(
                        "w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors",
                        activeFilters.enabledSorts?.[method] !== false
                          ? "bg-purple-500 border-purple-500"
                          : "bg-slate-700 border-slate-600"
                      )}
                    >
                      {activeFilters.enabledSorts?.[method] !== false && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </button>
                    <GripVertical className="w-4 h-4 text-slate-500" />
                    <span className="text-sm font-medium text-slate-300">{index + 1}.</span>
                    <span className={clsx(
                      "text-sm flex-1",
                      activeFilters.enabledSorts?.[method] !== false ? "text-slate-200" : "text-slate-500"
                    )}>{labels[method] || method}</span>
                    {hasDirection && (
                      <button
                        type="button"
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const newDir = currentDir === 'asc' ? 'desc' : 'asc';
                          updateActiveFilters(prev => ({
                            ...prev,
                            sortDirections: { ...prev.sortDirections, [method]: newDir }
                          }));
                        }}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-slate-200 transition-colors flex-shrink-0"
                        title={`Toggle sort direction: ${SORT_DIRECTION_LABELS[method]?.[currentDir ?? ''] ?? ''}`}
                      >
                        <ArrowUpDown className="w-3 h-3" />
                        <span>{SORT_DIRECTION_LABELS[method]?.[currentDir ?? ''] ?? ''}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Priority sections - rendered in sort order */}
          {(activeFilters.sortOrder || ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition']).map((sortMethod) => {
            // Map sort method to priority section config
            const prioritySections: Record<string, { expandKey: string; title: string; subtitle: string; items: string[]; filterKey: keyof typeof activeFilters; priorityKey: string; dragState: [string | null, (v: string | null) => void]; dragOverState: [string | null, (v: string | null) => void] }> = {
              quality: { expandKey: 'resolution', title: 'Resolution Filters & Priorities', subtitle: 'Drag to reorder your preferred resolutions', items: activeFilters.resolutionPriority || ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'], filterKey: 'resolutionPriority' as keyof typeof activeFilters, priorityKey: 'resolution', dragState: [draggedResolution, setDraggedResolution], dragOverState: [dragOverResolution, setDragOverResolution] },
              videoTag: { expandKey: 'video', title: 'Quality Filters & Priorities', subtitle: 'Drag to reorder your preferred quality sources', items: activeFilters.videoPriority || ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'], filterKey: 'videoPriority' as keyof typeof activeFilters, priorityKey: 'video', dragState: [draggedVideoTag, setDraggedVideoTag], dragOverState: [dragOverVideoTag, setDragOverVideoTag] },
              encode: { expandKey: 'encode', title: 'Encode Filters & Priorities', subtitle: 'Drag to reorder your preferred encodes', items: activeFilters.encodePriority || ['av1', 'hevc', 'vp9', 'avc', 'vp8', 'xvid', 'mpeg2', 'Unknown'], filterKey: 'encodePriority' as keyof typeof activeFilters, priorityKey: 'encode', dragState: [draggedEncode, setDraggedEncode], dragOverState: [dragOverEncode, setDragOverEncode] },
              visualTag: { expandKey: 'visualTag', title: 'Visual Tag Filters & Priorities', subtitle: 'Drag to reorder your preferred visual tags', items: activeFilters.visualTagPriority || ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', '3D', 'Unknown'], filterKey: 'visualTagPriority' as keyof typeof activeFilters, priorityKey: 'visualTag', dragState: [draggedVisualTag, setDraggedVisualTag], dragOverState: [dragOverVisualTag, setDragOverVisualTag] },
              audioTag: { expandKey: 'audioTag', title: 'Audio Tag Filters & Priorities', subtitle: 'Drag to reorder your preferred audio tags', items: activeFilters.audioTagPriority || ['Atmos (TrueHD)', 'DTS Lossless', 'TrueHD', 'Atmos (DDP)', 'DTS Lossy', 'DDP', 'DD', 'FLAC', 'PCM', 'AAC', 'OPUS', 'MP3', 'Unknown'], filterKey: 'audioTagPriority' as keyof typeof activeFilters, priorityKey: 'audioTag', dragState: [draggedAudioTag, setDraggedAudioTag], dragOverState: [dragOverAudioTag, setDragOverAudioTag] },
              language: { expandKey: 'language', title: 'Language Filters & Priorities', subtitle: 'Drag to reorder your preferred languages', items: activeFilters.languagePriority || ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'], filterKey: 'languagePriority' as keyof typeof activeFilters, priorityKey: 'language', dragState: [draggedLanguage, setDraggedLanguage], dragOverState: [dragOverLanguage, setDragOverLanguage] },
              edition: { expandKey: 'edition', title: 'Edition Filters & Priorities', subtitle: 'Drag to reorder preferred editions (Extended, Director\'s Cut, etc.)', items: activeFilters.editionPriority || ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard'], filterKey: 'editionPriority' as keyof typeof activeFilters, priorityKey: 'edition', dragState: [draggedEdition, setDraggedEdition], dragOverState: [dragOverEdition, setDragOverEdition] },
            };

            const section = prioritySections[sortMethod];
            if (!section) return null; // 'size' has no priority section

            const [draggedItem, setDraggedItem] = section.dragState;
            const [dragOverItem, setDragOverItem] = section.dragOverState;
            const isEditionSection = sortMethod === 'edition';
            const preferNonStandard = activeFilters.preferNonStandardEdition || false;

            return (
              <div key={sortMethod} className="bg-slate-900/50 rounded-lg border border-slate-700/30 overflow-hidden">
                <button
                  onClick={() => setExpandedPriorities(prev => { const next = new Set(prev); next.has(section.expandKey) ? next.delete(section.expandKey) : next.add(section.expandKey); return next; })}
                  className="flex items-center justify-between w-full p-4 text-left hover:bg-slate-800/30 transition-colors"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-300">{section.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{section.subtitle}</div>
                  </div>
                  <ChevronDown className={clsx("w-5 h-5 text-slate-400 transition-transform", expandedPriorities.has(section.expandKey) && "rotate-180")} />
                </button>
                {expandedPriorities.has(section.expandKey) && (
                  <div className="px-4 pb-4 space-y-2">
                  <div className="flex items-center justify-between pb-1">
                    <p className="text-xs text-slate-500">Deselecting an item filters it out of results entirely.</p>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          const pKey = section.priorityKey as keyof NonNullable<typeof activeFilters.enabledPriorities>;
                          const allEnabled: Record<string, boolean> = {};
                          section.items.forEach((item: string) => { allEnabled[item] = true; });
                          updateActiveFilters(prev => ({
                            ...prev,
                            enabledPriorities: { ...prev.enabledPriorities, [pKey]: allEnabled }
                          }));
                        }}
                        className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
                      >
                        Select All
                      </button>
                      <span className="text-slate-600 text-[11px]">|</span>
                      <button
                        type="button"
                        onClick={() => {
                          const pKey = section.priorityKey as keyof NonNullable<typeof activeFilters.enabledPriorities>;
                          const allDisabled: Record<string, boolean> = {};
                          section.items.forEach((item: string) => { allDisabled[item] = false; });
                          updateActiveFilters(prev => ({
                            ...prev,
                            enabledPriorities: { ...prev.enabledPriorities, [pKey]: allDisabled }
                          }));
                        }}
                        className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
                      >
                        Deselect All
                      </button>
                    </div>
                  </div>
                  {/* Prefer Non-Standard Editions toggle (edition section only) */}
                  {isEditionSection && (
                    <div className="flex items-center justify-between p-3 rounded-lg border border-slate-700/50 bg-slate-800/30 mb-3">
                      <div>
                        <div className="text-sm font-medium text-slate-300">Prefer Non-Standard Editions</div>
                        <div className="text-xs text-slate-500 mt-0.5">Prioritize all enabled non-standard editions equally over Standard</div>
                      </div>
                      <button
                        onClick={() => updateActiveFilters(prev => ({ ...prev, preferNonStandardEdition: !prev.preferNonStandardEdition }))}
                        className={clsx(
                          "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                          preferNonStandard ? "bg-purple-500" : "bg-slate-600"
                        )}
                      >
                        <div className={clsx(
                          "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                          preferNonStandard ? "left-5" : "left-1"
                        )} />
                      </button>
                    </div>
                  )}
                  {section.items.map((item: string, index: number) => {
                    const isDragging = draggedItem === item;
                    const isOver = dragOverItem === item;

                    return (
                      <div
                        key={item}
                        draggable={!(isEditionSection && preferNonStandard)}
                        onDragStart={() => setDraggedItem(item)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverItem(item);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedItem && draggedItem !== item) {
                            const newPriority = [...(activeFilters[section.filterKey] as string[])];
                            const draggedIndex = newPriority.indexOf(draggedItem);
                            const targetIndex = newPriority.indexOf(item);

                            newPriority.splice(draggedIndex, 1);
                            newPriority.splice(targetIndex, 0, draggedItem);

                            updateActiveFilters({ ...activeFilters, [section.filterKey]: newPriority });
                          }
                          setDraggedItem(null);
                          setDragOverItem(null);
                        }}
                        onDragEnd={() => {
                          setDraggedItem(null);
                          setDragOverItem(null);
                        }}
                        className={clsx(
                          "flex items-center gap-3 p-3 rounded-lg border bg-slate-800/50 transition-all",
                          isEditionSection && preferNonStandard ? "cursor-default" : "cursor-move",
                          isDragging && "opacity-50 scale-95",
                          isOver && "ring-2 ring-purple-400 scale-105",
                          !isDragging && !isOver && "border-slate-700 hover:border-slate-600"
                        )}
                      >
                        <button
                          type="button"
                          draggable={false}
                          onDragStart={(e) => e.preventDefault()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const pKey = section.priorityKey;
                            updateActiveFilters(prev => {
                              const currentPriorities = prev.enabledPriorities?.[pKey as keyof typeof prev.enabledPriorities] || {};
                              const isCurrentlyEnabled = currentPriorities[item] !== false;
                              return {
                                ...prev,
                                enabledPriorities: {
                                  ...prev.enabledPriorities,
                                  [pKey]: {
                                    ...currentPriorities,
                                    [item]: !isCurrentlyEnabled
                                  }
                                }
                              };
                            });
                          }}
                          className={clsx(
                            "w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors",
                            activeFilters.enabledPriorities?.[section.priorityKey as keyof typeof activeFilters.enabledPriorities]?.[item] !== false
                              ? "bg-purple-500 border-purple-500"
                              : "bg-slate-700 border-slate-600"
                          )}
                        >
                          {activeFilters.enabledPriorities?.[section.priorityKey as keyof typeof activeFilters.enabledPriorities]?.[item] !== false && (
                            <Check className="w-3 h-3 text-white" />
                          )}
                        </button>
                        <GripVertical className={clsx("w-4 h-4", isEditionSection && preferNonStandard ? "text-slate-700" : "text-slate-500")} />
                        {!(isEditionSection && preferNonStandard) && (
                          <span className="text-sm font-medium text-slate-300">{index + 1}.</span>
                        )}
                        <span className={clsx(
                          "text-sm flex-1",
                          activeFilters.enabledPriorities?.[section.priorityKey as keyof typeof activeFilters.enabledPriorities]?.[item] !== false ? "text-slate-200" : "text-slate-500"
                        )}>{isEditionSection && item === 'Standard' ? 'Standard / No Edition Detected' : displayLabel(item)}</span>
                      </div>
                    );
                  })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex gap-3">
            <button
              onClick={() => {
                const defaults: FiltersState = {
                  sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition', 'age', 'bitrate'],
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
                  },
                  sortDirections: {},
                  enabledPriorities: {
                    resolution: {},
                    video: {},
                    encode: {},
                    visualTag: { '3D': false },
                    audioTag: {},
                    language: {},
                    edition: {}
                  },
                  minFileSize: undefined,
                  minFileSizeMode: undefined,
                  maxFileSize: undefined,
                  maxFileSizeMode: undefined,
                  maxStreams: undefined,
                  maxStreamsPerResolution: undefined,
                  maxStreamsPerQuality: undefined,
                  resolutionPriority: ['4k', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'],
                  videoPriority: ['BluRay REMUX', 'REMUX', 'BDMUX', 'BRMUX', 'BluRay', 'WEB-DL', 'WEB', 'DLMUX', 'UHDRip', 'BDRip', 'WEB-DLRip', 'WEBRip', 'BRRip', 'WEBCap', 'VODR', 'HDTV', 'HDTVRip', 'SATRip', 'TVRip', 'PPVRip', 'DVD', 'DVDRip', 'PDTV', 'SDTV', 'HDRip', 'SCR', 'WORKPRINT', 'TeleCine', 'TeleSync', 'CAM', 'VHSRip', 'Unknown'],
                  encodePriority: ['av1', 'hevc', 'vp9', 'avc', 'vp8', 'xvid', 'mpeg2', 'Unknown'],
                  visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'HDR', '10bit', 'AI', 'SDR', '3D', 'Unknown'],
                  audioTagPriority: ['Atmos (TrueHD)', 'DTS Lossless', 'TrueHD', 'Atmos (DDP)', 'DTS Lossy', 'DDP', 'DD', 'FLAC', 'PCM', 'AAC', 'OPUS', 'MP3', 'Unknown'],
                  languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'],
                  editionPriority: ['Extended Edition', "Director's Cut", 'Superfan', 'Unrated', 'Uncensored', 'Uncut', 'Theatrical', 'IMAX', 'Special Edition', "Collector's Edition", 'Criterion Collection', 'Ultimate Edition', 'Anniversary Edition', 'Diamond Edition', 'Dragon Box', 'Color Corrected', 'Remastered', 'Standard'],
                  preferNonStandardEdition: false
                };
                if (filterTab === 'tv') {
                  defaults.sortOrder = ['edition', 'quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'age', 'bitrate'];
                  defaults.enabledSorts.edition = true;
                  defaults.preferNonStandardEdition = true;
                  defaults.enabledPriorities.edition = { 'IMAX Edition': true, 'Theatrical': true, 'Remastered': true };
                  defaults.maxStreams = undefined;
                }
                updateActiveFilters(defaults);
              }}
              className="btn-secondary w-full"
            >
              Reset to Default
            </button>
          </div>
        </div>
          );
        })()}
      </div>
    </div>
  );
}

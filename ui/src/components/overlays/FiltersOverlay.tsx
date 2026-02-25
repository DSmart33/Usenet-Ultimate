// What this does:
//   Filters & Sorting overlay with resolution priority, quality filtering, sort order,
//   per-type (Movie/TV) overrides, and drag-to-reorder priority lists

import { useState } from 'react';
import { Filter, X, Check, GripVertical, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { FiltersState } from '../../types';

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

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Maximum File Size
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  value={activeFilters.maxFileSize ? (activeFilters.maxFileSize / (1024 * 1024 * 1024)).toFixed(1) : ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    updateActiveFilters({
                      ...activeFilters,
                      maxFileSize: value ? parseFloat(value) * 1024 * 1024 * 1024 : undefined
                    });
                  }}
                  placeholder="Unlimited"
                  className="input-field w-28"
                  step="0.1"
                  min="0"
                />
                <span className="text-slate-400 text-sm">GB</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">Leave empty for unlimited. Filters out larger files.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Max Total Streams
              </label>
              <input
                type="number"
                value={activeFilters.maxStreams || ''}
                onChange={(e) => {
                  const value = e.target.value;
                  updateActiveFilters({
                    ...activeFilters,
                    maxStreams: value ? parseInt(value) : undefined
                  });
                }}
                placeholder="Unlimited"
                className="input-field w-28"
                min="1"
              />
              <p className="text-xs text-slate-500 mt-1">Maximum total number of streams to display overall</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Max Streams Per Quality
              </label>
              <input
                type="number"
                value={activeFilters.maxStreamsPerQuality || ''}
                onChange={(e) => {
                  const value = e.target.value;
                  updateActiveFilters({
                    ...activeFilters,
                    maxStreamsPerQuality: value ? parseInt(value) : undefined
                  });
                }}
                placeholder="Unlimited"
                className="input-field w-28"
                min="1"
              />
              <p className="text-xs text-slate-500 mt-1">Limit how many streams of each quality level to return (e.g., 5 = top 5 per quality)</p>
            </div>
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
                  size: 'Size (Largest first)',
                  videoTag: 'Quality',
                  encode: 'Encode',
                  visualTag: 'Visual Tag',
                  audioTag: 'Audio Tag',
                  language: 'Language',
                  edition: 'Edition'
                };

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
                    )}>{labels[method]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Priority sections - rendered in sort order */}
          {(activeFilters.sortOrder || ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition']).map((sortMethod) => {
            // Map sort method to priority section config
            const prioritySections: Record<string, { expandKey: string; title: string; subtitle: string; items: string[]; filterKey: keyof typeof activeFilters; priorityKey: string; dragState: [string | null, (v: string | null) => void]; dragOverState: [string | null, (v: string | null) => void] }> = {
              quality: { expandKey: 'resolution', title: 'Resolution Priority', subtitle: 'Drag to reorder your preferred resolutions', items: activeFilters.resolutionPriority || ['2160p', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'], filterKey: 'resolutionPriority' as keyof typeof activeFilters, priorityKey: 'resolution', dragState: [draggedResolution, setDraggedResolution], dragOverState: [dragOverResolution, setDragOverResolution] },
              videoTag: { expandKey: 'video', title: 'Quality Priority', subtitle: 'Drag to reorder your preferred quality sources', items: activeFilters.videoPriority || ['BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDRip', 'HC HD-Rip', 'DVDRip', 'HDTV', 'Unknown'], filterKey: 'videoPriority' as keyof typeof activeFilters, priorityKey: 'video', dragState: [draggedVideoTag, setDraggedVideoTag], dragOverState: [dragOverVideoTag, setDragOverVideoTag] },
              encode: { expandKey: 'encode', title: 'Encode Priority', subtitle: 'Drag to reorder your preferred encodes', items: activeFilters.encodePriority || ['AV1', 'HEVC', 'AVC', 'Unknown'], filterKey: 'encodePriority' as keyof typeof activeFilters, priorityKey: 'encode', dragState: [draggedEncode, setDraggedEncode], dragOverState: [dragOverEncode, setDragOverEncode] },
              visualTag: { expandKey: 'visualTag', title: 'Visual Tag Priority', subtitle: 'Drag to reorder your preferred visual tags', items: activeFilters.visualTagPriority || ['DV', 'HDR+DV', 'HDR10+', 'IMAX', 'HDR10', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'], filterKey: 'visualTagPriority' as keyof typeof activeFilters, priorityKey: 'visualTag', dragState: [draggedVisualTag, setDraggedVisualTag], dragOverState: [dragOverVisualTag, setDragOverVisualTag] },
              audioTag: { expandKey: 'audioTag', title: 'Audio Tag Priority', subtitle: 'Drag to reorder your preferred audio tags', items: activeFilters.audioTagPriority || ['Atmos', 'DTS:X', 'DTS-HD MA', 'TrueHD', 'DTS-HD', 'DD+', 'DD'], filterKey: 'audioTagPriority' as keyof typeof activeFilters, priorityKey: 'audioTag', dragState: [draggedAudioTag, setDraggedAudioTag], dragOverState: [dragOverAudioTag, setDragOverAudioTag] },
              language: { expandKey: 'language', title: 'Language Priority', subtitle: 'Drag to reorder your preferred languages', items: activeFilters.languagePriority || ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'], filterKey: 'languagePriority' as keyof typeof activeFilters, priorityKey: 'language', dragState: [draggedLanguage, setDraggedLanguage], dragOverState: [dragOverLanguage, setDragOverLanguage] },
              edition: { expandKey: 'edition', title: 'Edition Priority', subtitle: 'Drag to reorder preferred editions (Extended, Director\'s Cut, etc.)', items: activeFilters.editionPriority || ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard'], filterKey: 'editionPriority' as keyof typeof activeFilters, priorityKey: 'edition', dragState: [draggedEdition, setDraggedEdition], dragOverState: [dragOverEdition, setDragOverEdition] },
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
                        )}>{isEditionSection && item === 'Standard' ? 'Standard / No Edition Detected' : item}</span>
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
                  sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language', 'edition'],
                  enabledSorts: {
                    quality: true,
                    videoTag: true,
                    size: true,
                    encode: true,
                    visualTag: true,
                    audioTag: true,
                    language: false,
                    edition: false
                  },
                  enabledPriorities: {
                    resolution: {},
                    video: {},
                    encode: {},
                    visualTag: {},
                    audioTag: {},
                    language: {},
                    edition: {}
                  },
                  maxFileSize: undefined,
                  maxStreams: 10,
                  maxStreamsPerQuality: undefined,
                  resolutionPriority: ['2160p', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'],
                  videoPriority: ['BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDRip', 'HC HD-Rip', 'DVDRip', 'HDTV', 'Unknown'],
                  encodePriority: ['AV1', 'HEVC', 'AVC', 'Unknown'],
                  visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'IMAX', 'HDR10', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'],
                  audioTagPriority: ['Atmos', 'DTS:X', 'DTS-HD MA', 'TrueHD', 'DTS-HD', 'DD+', 'DD'],
                  languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'],
                  editionPriority: ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard'],
                  preferNonStandardEdition: false
                };
                if (filterTab === 'tv') {
                  defaults.sortOrder = ['edition', 'quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language'];
                  defaults.enabledSorts.edition = true;
                  defaults.preferNonStandardEdition = true;
                  defaults.enabledPriorities.edition = { 'IMAX Edition': true, 'Theatrical': true, 'Remastered': true };
                  defaults.maxStreams = 10;
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

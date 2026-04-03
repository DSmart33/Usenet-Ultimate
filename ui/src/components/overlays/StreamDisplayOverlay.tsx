// What this does:
//   Stream display preview overlay with drag-and-drop element reordering,
//   emoji picker (portaled to body), and live Stremio stream preview

import { createPortal } from 'react-dom';
import { Monitor, X, Eye, EyeOff, GripVertical, Indent, Outdent } from 'lucide-react';
import clsx from 'clsx';
import type { StreamDisplayConfig, ElementDragState, ElementDragOverState } from '../../types';
import { DEFAULT_STREAM_DISPLAY, MOCK_STREAM_DATA } from '../../constants';
import { EMOJI_SECTIONS, EMOJI_NAMES } from '../../constants/emojis';
import { normalizeLineGroups, renderStreamPreview } from '../../utils/streamPreview';

interface StreamDisplayOverlayProps {
  onClose: () => void;
  streamDisplayConfig: StreamDisplayConfig;
  setStreamDisplayConfig: React.Dispatch<React.SetStateAction<StreamDisplayConfig>>;
  emojiPickerTarget: string | null;
  setEmojiPickerTarget: React.Dispatch<React.SetStateAction<string | null>>;
  emojiSearch: string;
  setEmojiSearch: React.Dispatch<React.SetStateAction<string>>;
  elementDrag: ElementDragState | null;
  setElementDrag: React.Dispatch<React.SetStateAction<ElementDragState | null>>;
  elementDragOver: ElementDragOverState | null;
  setElementDragOver: React.Dispatch<React.SetStateAction<ElementDragOverState | null>>;
  draggedLineGroup: string | null;
  setDraggedLineGroup: React.Dispatch<React.SetStateAction<string | null>>;
  dragOverLineGroup: string | null;
  setDragOverLineGroup: React.Dispatch<React.SetStateAction<string | null>>;
  handleElementDrop: (overrideDragOver?: ElementDragOverState) => void;
}

export function StreamDisplayOverlay({
  onClose,
  streamDisplayConfig,
  setStreamDisplayConfig,
  emojiPickerTarget,
  setEmojiPickerTarget,
  emojiSearch,
  setEmojiSearch,
  elementDrag,
  setElementDrag,
  elementDragOver,
  setElementDragOver,
  draggedLineGroup,
  setDraggedLineGroup,
  dragOverLineGroup,
  setDragOverLineGroup,
  handleElementDrop,
}: StreamDisplayOverlayProps) {
  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => { onClose(); setEmojiPickerTarget(null); }}>
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-5xl w-full max-h-[90vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Monitor className="w-6 h-6 text-indigo-400" />
                <h3 className="text-xl font-semibold text-slate-200">Stream Display Preview</h3>
              </div>
              <button onClick={() => { onClose(); setEmojiPickerTarget(null); }} className="text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">Customize how streams appear in Stremio. Changes auto-save and update live.</p>
          </div>

          {/* Body: two-column layout */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: Controls */}
              <div className="space-y-4">
                {/* Name Column (left side in Stremio) */}
                <div
                  className={clsx(
                    "bg-slate-800/50 rounded-lg border border-slate-700/30 p-3 transition-colors",
                    elementDrag && elementDrag.sourceType === 'title' && "border-indigo-400/30"
                  )}
                  onDragOver={(e) => {
                    if (!elementDrag) return;
                    e.preventDefault();
                    // Only set generic name target if not already hovering a specific element
                    if (!elementDragOver || elementDragOver.targetType !== 'name' || elementDragOver.targetElementId) return;
                    setElementDragOver({ targetType: 'name', position: 'after' });
                  }}
                  onDrop={(e) => { e.preventDefault(); handleElementDrop(); }}
                >
                  <h4 className="text-sm font-medium text-indigo-400 mb-2 flex items-center gap-2">
                    <div className="w-1.5 h-4 bg-indigo-400 rounded-full" />
                    Name Column <span className="text-slate-500 font-normal">(left side)</span>
                  </h4>
                  <div className="space-y-1">
                    {streamDisplayConfig.nameElements.map((elId) => {
                      const el = streamDisplayConfig.elements[elId];
                      if (!el) return null;
                      const isBeforeTarget = elementDragOver?.targetType === 'name' && elementDragOver.targetElementId === elId && elementDragOver.position === 'before';
                      const isAfterTarget = elementDragOver?.targetType === 'name' && elementDragOver.targetElementId === elId && elementDragOver.position === 'after';
                      return (
                        <div key={elId}>
                          {isBeforeTarget && <div className="h-0.5 bg-indigo-400 rounded-full mx-2 my-0.5" />}
                          <div
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.setData('type', 'element');
                              setElementDrag({ elementId: elId, sourceType: 'name' });
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                              setElementDragOver({ targetType: 'name', targetElementId: elId, position: pos });
                            }}
                            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleElementDrop(); }}
                            onDragEnd={() => { setElementDrag(null); setElementDragOver(null); }}
                            className={clsx(
                              "flex items-center gap-2 px-2 py-1.5 rounded-md transition-all cursor-move",
                              "hover:bg-slate-700/50",
                              elementDrag?.elementId === elId && "opacity-50 scale-95",
                            )}
                          >
                            <GripVertical className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                            <span className="text-xs text-slate-300 flex-1">{el.label}</span>
                            <button
                              onClick={() => setStreamDisplayConfig(prev => ({
                                ...prev,
                                elements: { ...prev.elements, [elId]: { ...el, enabled: !el.enabled } }
                              }))}
                              className="p-0.5 rounded transition-colors"
                            >
                              {el.enabled
                                ? <Eye className="w-3.5 h-3.5 text-indigo-400" />
                                : <EyeOff className="w-3.5 h-3.5 text-slate-600" />
                              }
                            </button>
                          </div>
                          {isAfterTarget && <div className="h-0.5 bg-indigo-400 rounded-full mx-2 my-0.5" />}
                        </div>
                      );
                    })}
                    {/* Empty state drop zone when name column is empty */}
                    {streamDisplayConfig.nameElements.length === 0 && (
                      <div
                        className={clsx(
                          "py-3 text-center text-[10px] text-slate-600 border border-dashed border-slate-700/50 rounded-md transition-colors",
                          elementDrag && "border-indigo-400/50 text-indigo-400/60 bg-indigo-500/5"
                        )}
                        onDragOver={(e) => { e.preventDefault(); setElementDragOver({ targetType: 'name', position: 'after' }); }}
                        onDrop={(e) => { e.preventDefault(); handleElementDrop(); }}
                      >
                        Drop elements here
                      </div>
                    )}
                  </div>
                </div>

                {/* Title Column (right side in Stremio) - Line Groups */}
                <div className="bg-slate-800/50 rounded-lg border border-slate-700/30 p-3">
                  <h4 className="text-sm font-medium text-indigo-400 mb-2 flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-indigo-400 rounded" />
                    Title Column <span className="text-slate-500 font-normal">(right side)</span>
                  </h4>

                  {/* Clean titles toggle */}
                  <div className="flex items-center justify-between mb-3 py-1.5 px-2 bg-slate-900/40 rounded-md">
                    <div>
                      <span className="text-xs text-slate-300">Clean Titles</span>
                      <p className="text-[10px] text-slate-500 mt-0.5">{streamDisplayConfig.cleanTitles ? 'Parsed title (e.g. "Neon Horizon")' : 'Raw release name (e.g. "Neon.Horizon.2025.2160p...")'}</p>
                      <p className="text-[10px] text-amber-400/80 mt-0.5">AIOStreams requires this to be disabled</p>
                    </div>
                    <button
                      onClick={() => setStreamDisplayConfig(prev => ({ ...prev, cleanTitles: !prev.cleanTitles }))}
                      className={clsx(
                        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                        streamDisplayConfig.cleanTitles ? "bg-indigo-500" : "bg-slate-600"
                      )}
                    >
                      <span className={clsx(
                        "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
                        streamDisplayConfig.cleanTitles ? "translate-x-[18px]" : "translate-x-0.5"
                      )} />
                    </button>
                  </div>

                  {/* Title prefix editors */}
                  <div className="flex items-center gap-3 mb-3 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-500">Regular:</span>
                      <button
                        onClick={() => setEmojiPickerTarget(emojiPickerTarget === '_regularPrefix' ? null : '_regularPrefix')}
                        className="px-2 py-0.5 bg-slate-700/60 rounded border border-slate-600/50 text-sm hover:border-indigo-400/50 transition-colors min-w-[28px] text-center"
                      >
                        {streamDisplayConfig.regularPrefix || '—'}
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-500">Season Pack:</span>
                      <button
                        onClick={() => setEmojiPickerTarget(emojiPickerTarget === '_seasonPrefix' ? null : '_seasonPrefix')}
                        className="px-2 py-0.5 bg-slate-700/60 rounded border border-slate-600/50 text-sm hover:border-indigo-400/50 transition-colors min-w-[28px] text-center"
                      >
                        {streamDisplayConfig.seasonPackPrefix || '—'}
                      </button>
                    </div>
                  </div>

                  {/* Title Rows — always show MAX_TITLE_ROWS slots */}
                  <div className="space-y-1">
                    {streamDisplayConfig.lineGroups.map((group, groupIndex) => {
                      const isEmpty = group.elementIds.length === 0;
                      const isDropTarget = elementDrag && elementDragOver?.targetType === 'title' && elementDragOver.targetGroupId === group.id && !elementDragOver.targetElementId;
                      return (
                        <div
                          key={group.id}
                          className={clsx(
                            "bg-slate-900/50 rounded-md border p-2 transition-all",
                            draggedLineGroup === group.id && "opacity-50 scale-95",
                            dragOverLineGroup === group.id && "ring-1 ring-indigo-400 bg-indigo-500/5",
                            isDropTarget ? "border-indigo-400/50 bg-indigo-500/5" : "border-slate-700/20"
                          )}
                          onDragOver={(e) => {
                            if (elementDrag) {
                              e.preventDefault();
                              // Only set as generic group target if not hovering a specific element
                              if (!elementDragOver || elementDragOver.targetGroupId !== group.id || elementDragOver.targetElementId) {
                                setElementDragOver({ targetType: 'title', targetGroupId: group.id, position: 'after' });
                              }
                            }
                          }}
                          onDrop={(e) => {
                            if (elementDrag) {
                              e.preventDefault();
                              const target = (elementDragOver?.targetGroupId === group.id && elementDragOver.targetElementId)
                                ? elementDragOver
                                : { targetType: 'title' as const, targetGroupId: group.id, position: 'after' as const };
                              handleElementDrop(target);
                            }
                          }}
                        >
                          {/* Row header: drag handle, label, indent toggle */}
                          <div className="flex items-center gap-2 mb-1">
                            <div
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation();
                                e.dataTransfer.setData('type', 'lineGroup');
                                setDraggedLineGroup(group.id);
                              }}
                              onDragOver={(e) => {
                                if (draggedLineGroup) {
                                  e.preventDefault();
                                  setDragOverLineGroup(group.id);
                                }
                              }}
                              onDrop={(e) => {
                                e.stopPropagation();
                                if (draggedLineGroup && draggedLineGroup !== group.id) {
                                  setStreamDisplayConfig(prev => {
                                    const newGroups = [...prev.lineGroups];
                                    const fromIdx = newGroups.findIndex(g => g.id === draggedLineGroup);
                                    const toIdx = newGroups.findIndex(g => g.id === group.id);
                                    if (fromIdx !== -1 && toIdx !== -1) {
                                      const [moved] = newGroups.splice(fromIdx, 1);
                                      newGroups.splice(toIdx, 0, moved);
                                    }
                                    return { ...prev, lineGroups: newGroups };
                                  });
                                }
                                setDraggedLineGroup(null);
                                setDragOverLineGroup(null);
                              }}
                              onDragEnd={() => { setDraggedLineGroup(null); setDragOverLineGroup(null); }}
                              className="cursor-move p-0.5"
                              title="Drag to reorder entire row"
                            >
                              <GripVertical className="w-3 h-3 text-slate-600 shrink-0" />
                            </div>
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium flex-1">Row {groupIndex + 1}</span>
                            <button
                              onClick={() => setStreamDisplayConfig(prev => ({
                                ...prev,
                                lineGroups: prev.lineGroups.map(g =>
                                  g.id === group.id ? { ...g, indent: !g.indent } : g
                                )
                              }))}
                              className={clsx(
                                "p-0.5 rounded transition-colors",
                                group.indent ? "text-indigo-400 hover:text-indigo-300" : "text-slate-600 hover:text-slate-400"
                              )}
                              title={group.indent ? "Indented (click to remove)" : "No indent (click to add)"}
                            >
                              {group.indent
                                ? <Indent className="w-3.5 h-3.5" />
                                : <Outdent className="w-3.5 h-3.5" />
                              }
                            </button>
                          </div>
                          {/* Elements within the row — each is individually draggable */}
                          <div className="space-y-0 ml-5">
                            {group.elementIds.map((elId) => {
                              const el = streamDisplayConfig.elements[elId];
                              if (!el) return null;
                              const isBeforeTarget = elementDragOver?.targetType === 'title' && elementDragOver.targetGroupId === group.id && elementDragOver.targetElementId === elId && elementDragOver.position === 'before';
                              const isAfterTarget = elementDragOver?.targetType === 'title' && elementDragOver.targetGroupId === group.id && elementDragOver.targetElementId === elId && elementDragOver.position === 'after';
                              return (
                                <div key={elId}>
                                  {isBeforeTarget && <div className="h-0.5 bg-indigo-400 rounded-full mx-1 my-0.5" />}
                                  <div
                                    draggable
                                    onDragStart={(e) => {
                                      e.stopPropagation();
                                      e.dataTransfer.setData('type', 'element');
                                      setElementDrag({ elementId: elId, sourceType: 'title', sourceGroupId: group.id });
                                    }}
                                    onDragOver={(e) => {
                                      if (!elementDrag) return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                                      setElementDragOver({ targetType: 'title', targetGroupId: group.id, targetElementId: elId, position: pos });
                                    }}
                                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleElementDrop(); }}
                                    onDragEnd={() => { setElementDrag(null); setElementDragOver(null); }}
                                    className={clsx(
                                      "flex items-center gap-1.5 py-0.5 rounded cursor-move transition-all",
                                      "hover:bg-slate-800/50",
                                      elementDrag?.elementId === elId && "opacity-50 scale-95",
                                    )}
                                  >
                                    <GripVertical className="w-3 h-3 text-slate-700 shrink-0" />
                                    {/* Prefix editor button */}
                                    {elId !== 'cleanTitle' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setEmojiPickerTarget(emojiPickerTarget === elId ? null : elId); }}
                                        className="w-6 h-6 flex items-center justify-center bg-slate-700/60 rounded border border-slate-600/50 text-xs hover:border-indigo-400/50 transition-colors shrink-0"
                                        title="Edit prefix"
                                      >
                                        {el.prefix || '—'}
                                      </button>
                                    )}
                                    {elId === 'cleanTitle' && <div className="w-6" />}
                                    <span className="text-xs text-slate-300 flex-1">{el.label}</span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setStreamDisplayConfig(prev => ({
                                        ...prev,
                                        elements: { ...prev.elements, [elId]: { ...el, enabled: !el.enabled } }
                                      })); }}
                                      className="p-0.5 rounded transition-colors"
                                    >
                                      {el.enabled
                                        ? <Eye className="w-3.5 h-3.5 text-indigo-400" />
                                        : <EyeOff className="w-3.5 h-3.5 text-slate-600" />
                                      }
                                    </button>
                                  </div>
                                  {isAfterTarget && <div className="h-0.5 bg-indigo-400 rounded-full mx-1 my-0.5" />}
                                </div>
                              );
                            })}
                            {/* Empty row indicator */}
                            {isEmpty && (
                              <div
                                className={clsx(
                                  "py-1.5 text-center text-[10px] border border-dashed rounded transition-colors",
                                  isDropTarget
                                    ? "border-indigo-400/50 text-indigo-400/60 bg-indigo-500/5"
                                    : "border-slate-700/30 text-slate-600/50"
                                )}
                              >
                                {elementDrag ? 'Drop here' : 'Empty'}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Reset to Defaults */}
                <button
                  onClick={() => setStreamDisplayConfig(normalizeLineGroups(DEFAULT_STREAM_DISPLAY))}
                  className="w-full py-2 text-xs text-slate-400 hover:text-white bg-slate-800/40 hover:bg-slate-700/50 border border-slate-700/40 rounded-lg transition-all"
                >
                  Reset to Defaults
                </button>
              </div>

              {/* Right: Live Preview */}
              <div className="space-y-4 lg:sticky lg:top-0 self-start">
                <h4 className="text-sm font-medium text-slate-400">Live Preview</h4>

                {/* Regular stream preview */}
                {(() => {
                  const preview = renderStreamPreview(MOCK_STREAM_DATA.regular, streamDisplayConfig);
                  return (
                    <div className="bg-slate-950/80 rounded-lg border border-slate-700/40 overflow-hidden">
                      <div className="px-2 py-1 bg-slate-800/40 border-b border-slate-700/30">
                        <span className="text-[10px] text-slate-500">4K HDR (Full Info)</span>
                      </div>
                      <div className="flex">
                        <div className="w-24 shrink-0 border-r border-slate-700/50 p-3 text-xs font-mono text-slate-200 leading-relaxed whitespace-pre-line">
                          {preview.nameLines.join('\n')}
                        </div>
                        <div className="flex-1 p-3 text-xs font-mono leading-relaxed min-w-0">
                          {preview.titleLines.map((line, i) => (
                            <div key={i} className={clsx("whitespace-pre", i === 0 ? "text-slate-200" : "text-slate-400")}>{line}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Season pack preview */}
                {(() => {
                  const preview = renderStreamPreview(MOCK_STREAM_DATA.seasonPack, streamDisplayConfig);
                  return (
                    <div className="bg-slate-950/80 rounded-lg border border-slate-700/40 overflow-hidden">
                      <div className="px-2 py-1 bg-slate-800/40 border-b border-slate-700/30">
                        <span className="text-[10px] text-slate-500">Season Pack</span>
                      </div>
                      <div className="flex">
                        <div className="w-24 shrink-0 border-r border-slate-700/50 p-3 text-xs font-mono text-slate-200 leading-relaxed whitespace-pre-line">
                          {preview.nameLines.join('\n')}
                        </div>
                        <div className="flex-1 p-3 text-xs font-mono leading-relaxed min-w-0">
                          {preview.titleLines.map((line, i) => (
                            <div key={i} className={clsx("whitespace-pre", i === 0 ? "text-slate-200" : "text-slate-400")}>{line}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Minimal data preview */}
                {(() => {
                  const preview = renderStreamPreview(MOCK_STREAM_DATA.minimal, streamDisplayConfig);
                  return (
                    <div className="bg-slate-950/80 rounded-lg border border-slate-700/40 overflow-hidden">
                      <div className="px-2 py-1 bg-slate-800/40 border-b border-slate-700/30">
                        <span className="text-[10px] text-slate-500">Sparse Info</span>
                      </div>
                      <div className="flex">
                        <div className="w-24 shrink-0 border-r border-slate-700/50 p-3 text-xs font-mono text-slate-200 leading-relaxed whitespace-pre-line">
                          {preview.nameLines.join('\n')}
                        </div>
                        <div className="flex-1 p-3 text-xs font-mono leading-relaxed min-w-0">
                          {preview.titleLines.map((line, i) => (
                            <div key={i} className={clsx("whitespace-pre", i === 0 ? "text-slate-200" : "text-slate-400")}>{line}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <p className="text-[10px] text-slate-600 text-center">
                  Preview shows how streams will appear in Stremio's stream picker
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Shared emoji picker — portaled to document.body to escape all CSS containment */}
      {emojiPickerTarget && createPortal(
        <div className="fixed inset-0 z-[9999]" onClick={() => { setEmojiPickerTarget(null); setEmojiSearch(''); }}>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-slate-800 border border-slate-600 rounded-xl p-4 shadow-2xl w-[360px]" onClick={(e) => e.stopPropagation()}>
            {/* Search bar */}
            <div className="mb-3">
              <input
                type="text"
                value={emojiSearch}
                onChange={(e) => setEmojiSearch(e.target.value)}
                placeholder="Search icons..."
                className="input text-sm px-3 py-1.5 w-full"
                autoFocus
              />
            </div>
            {/* Scrollable icon grid */}
            <div className="max-h-[360px] overflow-y-auto pr-1 space-y-3 mb-3">
              {(() => {
                const query = emojiSearch.toLowerCase().trim();
                const sections = query
                  ? [{
                      label: 'Results',
                      emojis: [...new Set(EMOJI_SECTIONS.flatMap(s => s.emojis))].filter(emoji =>
                        emoji.includes(query) || (EMOJI_NAMES[emoji] || '').includes(query)
                      )
                    }]
                  : EMOJI_SECTIONS;
                return sections.map(section => {
                  if (section.emojis.length === 0) return null;
                  return (
                    <div key={section.label}>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1.5 sticky top-0 bg-slate-800 py-0.5 z-10">{section.label}</div>
                      <div className="grid grid-cols-9 gap-1">
                        {section.emojis.map((emoji, i) => (
                          <button
                            key={`${emoji}-${i}`}
                            title={EMOJI_NAMES[emoji] || emoji}
                            onClick={() => {
                              if (emojiPickerTarget === '_regularPrefix') {
                                setStreamDisplayConfig(prev => ({ ...prev, regularPrefix: emoji }));
                              } else if (emojiPickerTarget === '_seasonPrefix') {
                                setStreamDisplayConfig(prev => ({ ...prev, seasonPackPrefix: emoji }));
                              } else {
                                const el = streamDisplayConfig.elements[emojiPickerTarget];
                                if (el) setStreamDisplayConfig(prev => ({ ...prev, elements: { ...prev.elements, [emojiPickerTarget!]: { ...el, prefix: emoji } } }));
                              }
                              setEmojiPickerTarget(null);
                              setEmojiSearch('');
                            }}
                            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-700 text-lg transition-colors"
                          >{emoji}</button>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
              {emojiSearch && EMOJI_SECTIONS.flatMap(s => s.emojis).filter(emoji =>
                emoji.includes(emojiSearch.toLowerCase().trim()) || (EMOJI_NAMES[emoji] || '').includes(emojiSearch.toLowerCase().trim())
              ).length === 0 && (
                <div className="py-4 text-center text-xs text-slate-500">No icons match "{emojiSearch}"</div>
              )}
            </div>
            {/* Custom text input + clear */}
            <div className="flex gap-1.5 border-t border-slate-700/50 pt-2.5">
              <input type="text" maxLength={4} placeholder="Custom text..." className="input text-sm px-3 py-1.5 flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = e.currentTarget.value;
                    if (emojiPickerTarget === '_regularPrefix') {
                      setStreamDisplayConfig(prev => ({ ...prev, regularPrefix: val }));
                    } else if (emojiPickerTarget === '_seasonPrefix') {
                      setStreamDisplayConfig(prev => ({ ...prev, seasonPackPrefix: val }));
                    } else {
                      const el = streamDisplayConfig.elements[emojiPickerTarget!];
                      if (el) setStreamDisplayConfig(prev => ({ ...prev, elements: { ...prev.elements, [emojiPickerTarget!]: { ...el, prefix: val } } }));
                    }
                    setEmojiPickerTarget(null);
                    setEmojiSearch('');
                  }
                }} />
              <button onClick={() => {
                if (emojiPickerTarget === '_regularPrefix') {
                  setStreamDisplayConfig(prev => ({ ...prev, regularPrefix: '' }));
                } else if (emojiPickerTarget === '_seasonPrefix') {
                  setStreamDisplayConfig(prev => ({ ...prev, seasonPackPrefix: '' }));
                } else {
                  const el = streamDisplayConfig.elements[emojiPickerTarget!];
                  if (el) setStreamDisplayConfig(prev => ({ ...prev, elements: { ...prev.elements, [emojiPickerTarget!]: { ...el, prefix: '' } } }));
                }
                setEmojiPickerTarget(null);
                setEmojiSearch('');
              }}
                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded hover:bg-slate-700/50 transition-colors">Clear</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

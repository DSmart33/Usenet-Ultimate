// What this does:
//   Auto play / binge group configuration overlay with method selection and attribute matching

import { FastForward, X } from 'lucide-react';
import clsx from 'clsx';
import type { AutoPlayState } from '../../types';

interface AutoPlayOverlayProps {
  onClose: () => void;
  autoPlay: AutoPlayState;
  setAutoPlay: React.Dispatch<React.SetStateAction<AutoPlayState>>;
}

export function AutoPlayOverlay({
  onClose,
  autoPlay,
  setAutoPlay,
}: AutoPlayOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FastForward className="w-6 h-6 text-orange-400" />
              <h3 className="text-xl font-semibold text-slate-200">Auto Play</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-6">
          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-300">Enable Auto Play</label>
              <p className="text-xs text-slate-500 mt-0.5">Set binge group hints for Stremio auto-play</p>
            </div>
            <button
              onClick={() => setAutoPlay(prev => ({ ...prev, enabled: !prev.enabled }))}
              className={clsx(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                autoPlay.enabled ? "bg-orange-500" : "bg-slate-600"
              )}
            >
              <span className={clsx(
                "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                autoPlay.enabled ? "translate-x-6" : "translate-x-1"
              )} />
            </button>
          </div>

          {autoPlay.enabled && (
            <>
              {/* Method Selection */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-3">Auto Play Method</label>
                <div className="space-y-2">
                  {[
                    { value: 'matchingFile', label: 'Matching File', desc: 'Auto-play the stream matching the same attributes (resolution, quality, etc.) as the current episode.' },
                    { value: 'matchingIndex', label: 'Matching Index', desc: 'Auto-play the stream in the same position in the results list.' },
                    { value: 'firstFile', label: 'First File', desc: 'Always auto-play the first stream in the results.' },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className={clsx(
                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
                        autoPlay.method === opt.value
                          ? "border-orange-400/50 bg-orange-400/5"
                          : "border-slate-700 hover:border-slate-600"
                      )}
                    >
                      <input
                        type="radio"
                        name="autoPlayMethod"
                        value={opt.value}
                        checked={autoPlay.method === opt.value}
                        onChange={() => setAutoPlay(prev => ({ ...prev, method: opt.value }))}
                        className="mt-1 accent-orange-400"
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-200">{opt.label}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Attributes (only for matchingFile) */}
              {autoPlay.method === 'matchingFile' && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-3">Matching Attributes</label>
                  <p className="text-xs text-slate-500 mb-3">Select which stream attributes must match for auto-play to continue with the same type of stream.</p>
                  <div className="space-y-2">
                    {[
                      { value: 'resolution', label: 'Resolution', desc: '1080p, 4k, 720p, etc.' },
                      { value: 'quality', label: 'Quality', desc: 'BluRay, WEB-DL, WEBRip, etc.' },
                      { value: 'encode', label: 'Encode', desc: 'hevc, avc, av1, etc.' },
                      { value: 'visualTag', label: 'Visual Tag', desc: 'HDR, DV, HDR10+, etc.' },
                      { value: 'audioTag', label: 'Audio Tag', desc: 'Atmos, DTS Lossless, TrueHD, etc.' },
                      { value: 'releaseGroup', label: 'Release Group', desc: 'Match the same release group' },
                      { value: 'edition', label: 'Edition', desc: 'Extended, Director\'s Cut, Superfan, Unrated, etc.' },
                      { value: 'indexer', label: 'Indexer', desc: 'Match results from the same indexer' },
                    ].map(attr => (
                      <label
                        key={attr.value}
                        className={clsx(
                          "flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-all",
                          autoPlay.attributes.includes(attr.value)
                            ? "border-orange-400/50 bg-orange-400/5"
                            : "border-slate-700 hover:border-slate-600"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={autoPlay.attributes.includes(attr.value)}
                          onChange={(e) => {
                            setAutoPlay(prev => ({
                              ...prev,
                              attributes: e.target.checked
                                ? [...prev.attributes, attr.value]
                                : prev.attributes.filter(a => a !== attr.value)
                            }));
                          }}
                          className="accent-orange-400"
                        />
                        <div>
                          <div className="text-sm font-medium text-slate-200">{attr.label}</div>
                          <div className="text-xs text-slate-500">{attr.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Info Note */}
              <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
                <p className="text-xs text-slate-400">
                  Auto-play uses Stremio's <span className="text-orange-400 font-mono">bingeGroup</span> hint to suggest the next stream.
                  For this to work, you must also have auto-play enabled in your Stremio settings. Only applies to series (TV shows).
                </p>
                <p className="text-xs text-amber-400/80 mt-1">
                  When enabled, a minimum search cache of 2.5 hours is enforced.
                </p>
              </div>
            </>
          )}
          <div className="pt-4 border-t border-slate-700">
            <button
              onClick={() => setAutoPlay({ enabled: true, method: 'firstFile', attributes: ['resolution', 'quality', 'edition'] })}
              className="btn-secondary w-full"
            >
              Reset to Default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

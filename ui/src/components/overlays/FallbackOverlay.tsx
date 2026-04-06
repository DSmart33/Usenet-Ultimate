// What this does:
//   NZB Fallback configuration overlay with enable toggle, fallback order, wait times, and streaming method

import { useCallback } from 'react';
import { RotateCcw, X, Film, Tv, Layers } from 'lucide-react';
import clsx from 'clsx';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';

interface FallbackOverlayProps {
  onClose: () => void;
  nzbdavFallbackEnabled: boolean;
  setNzbdavFallbackEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  nzbdavLibraryCheckEnabled: boolean;
  setNzbdavLibraryCheckEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  nzbdavMoviesTimeoutSeconds: number;
  setNzbdavMoviesTimeoutSeconds: React.Dispatch<React.SetStateAction<number>>;
  nzbdavTvTimeoutSeconds: number;
  setNzbdavTvTimeoutSeconds: React.Dispatch<React.SetStateAction<number>>;
  nzbdavSeasonPackTimeoutSeconds: number;
  setNzbdavSeasonPackTimeoutSeconds: React.Dispatch<React.SetStateAction<number>>;
  nzbdavFallbackOrder: 'selected' | 'top';
  setNzbdavFallbackOrder: React.Dispatch<React.SetStateAction<'selected' | 'top'>>;
  nzbdavMaxFallbacks: number;
  setNzbdavMaxFallbacks: React.Dispatch<React.SetStateAction<number>>;
  nzbdavProxyEnabled: boolean;
  setNzbdavProxyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoResolveOnSearch: boolean;
  setAutoResolveOnSearch: React.Dispatch<React.SetStateAction<boolean>>;
}

export function FallbackOverlay({
  onClose,
  nzbdavFallbackEnabled,
  setNzbdavFallbackEnabled,
  nzbdavLibraryCheckEnabled,
  setNzbdavLibraryCheckEnabled,
  nzbdavMoviesTimeoutSeconds,
  setNzbdavMoviesTimeoutSeconds,
  nzbdavTvTimeoutSeconds,
  setNzbdavTvTimeoutSeconds,
  nzbdavSeasonPackTimeoutSeconds,
  setNzbdavSeasonPackTimeoutSeconds,
  nzbdavFallbackOrder,
  setNzbdavFallbackOrder,
  nzbdavMaxFallbacks,
  setNzbdavMaxFallbacks,
  nzbdavProxyEnabled,
  setNzbdavProxyEnabled,
  autoResolveOnSearch,
  setAutoResolveOnSearch,
}: FallbackOverlayProps) {
  const movieDec = useHoldRepeat(useCallback(() => setNzbdavMoviesTimeoutSeconds(v => Math.max(1, v - 1)), [setNzbdavMoviesTimeoutSeconds]));
  const movieInc = useHoldRepeat(useCallback(() => setNzbdavMoviesTimeoutSeconds(v => Math.min(90, v + 1)), [setNzbdavMoviesTimeoutSeconds]));
  const tvDec = useHoldRepeat(useCallback(() => setNzbdavTvTimeoutSeconds(v => Math.max(1, v - 1)), [setNzbdavTvTimeoutSeconds]));
  const tvInc = useHoldRepeat(useCallback(() => setNzbdavTvTimeoutSeconds(v => Math.min(90, v + 1)), [setNzbdavTvTimeoutSeconds]));
  const seasonPackDec = useHoldRepeat(useCallback(() => setNzbdavSeasonPackTimeoutSeconds(v => Math.max(1, v - 1)), [setNzbdavSeasonPackTimeoutSeconds]));
  const seasonPackInc = useHoldRepeat(useCallback(() => setNzbdavSeasonPackTimeoutSeconds(v => Math.min(90, v + 1)), [setNzbdavSeasonPackTimeoutSeconds]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <RotateCcw className="w-6 h-6 text-amber-400" />
              <h3 className="text-xl font-semibold text-slate-200">NZB Fallback</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">

          {/* Enable Fallback Toggle */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={nzbdavFallbackEnabled}
                onChange={(e) => setNzbdavFallbackEnabled(e.target.checked)}
                className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800"
              />
              <div>
                <span className="text-sm font-medium text-slate-300">Enable Fallback</span>
                <p className="text-xs text-slate-500 mt-1">
                  Automatically try alternative NZBs when the primary download fails. When disabled, all streams use proxy without a redirect.
                </p>
              </div>
            </label>
          </div>

          {/* Library Check Toggle */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={nzbdavLibraryCheckEnabled}
                onChange={(e) => setNzbdavLibraryCheckEnabled(e.target.checked)}
                className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800"
              />
              <div>
                <span className="text-sm font-medium text-slate-300">Library Check</span>
                <p className="text-xs text-slate-500 mt-1">
                  Check WebDAV library for existing files before grabbing from indexer. Disable if library files are inaccessible or removed.
                </p>
              </div>
            </label>
          </div>

          {/* Streaming Method */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <label className="block text-sm font-medium text-slate-300">Streaming Method</label>
            <div className="flex gap-3">
              <button
                onClick={() => setNzbdavProxyEnabled(true)}
                className={clsx(
                  "flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  nzbdavProxyEnabled
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Proxy
              </button>
              <button
                onClick={() => setNzbdavProxyEnabled(false)}
                className={clsx(
                  "flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  !nzbdavProxyEnabled
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Direct
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {nzbdavProxyEnabled
                ? 'Video streams through a local proxy with buffering and automatic reconnection. Recommended for most devices.'
                : 'Player is redirected directly to the WebDAV URL. Only supported on select stremio applications.'}
            </p>
          </div>

          {/* Wait Times — combined card */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">Stream Wait Times</div>
              <button
                onClick={() => { setNzbdavMoviesTimeoutSeconds(30); setNzbdavTvTimeoutSeconds(15); setNzbdavSeasonPackTimeoutSeconds(30); }}
                className="text-xs text-amber-400 hover:text-amber-300"
              >
                Reset
              </button>
            </div>
            <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {/* Movie */}
              <div className="rounded-lg bg-slate-800/40 border border-slate-700/20 py-3 px-2 flex flex-col items-center gap-2">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Film className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">Movies</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    {...movieDec}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >−</button>
                  <div className="flex flex-col items-center">
                    {nzbdavMoviesTimeoutSeconds >= 60 ? (
                      <>
                        <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                          {Math.floor(nzbdavMoviesTimeoutSeconds / 60)}
                          <span className="text-lg text-amber-400/40 mx-px">:</span>
                          {String(nzbdavMoviesTimeoutSeconds % 60).padStart(2, '0')}
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">min : sec</span>
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          step={1}
                          value={nzbdavMoviesTimeoutSeconds}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setNzbdavMoviesTimeoutSeconds(Math.min(90, Math.max(1, v)));
                          }}
                          className="w-14 bg-transparent text-center text-2xl font-bold text-amber-400/90 focus:outline-none focus:text-amber-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none leading-none"
                        />
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">seconds</span>
                      </>
                    )}
                  </div>
                  <button
                    {...movieInc}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >+</button>
                </div>
              </div>
              {/* TV */}
              <div className="rounded-lg bg-slate-800/40 border border-slate-700/20 py-3 px-2 flex flex-col items-center gap-2">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Tv className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">TV Shows</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    {...tvDec}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >−</button>
                  <div className="flex flex-col items-center">
                    {nzbdavTvTimeoutSeconds >= 60 ? (
                      <>
                        <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                          {Math.floor(nzbdavTvTimeoutSeconds / 60)}
                          <span className="text-lg text-amber-400/40 mx-px">:</span>
                          {String(nzbdavTvTimeoutSeconds % 60).padStart(2, '0')}
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">min : sec</span>
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          step={1}
                          value={nzbdavTvTimeoutSeconds}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setNzbdavTvTimeoutSeconds(Math.min(90, Math.max(1, v)));
                          }}
                          className="w-14 bg-transparent text-center text-2xl font-bold text-amber-400/90 focus:outline-none focus:text-amber-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none leading-none"
                        />
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">seconds</span>
                      </>
                    )}
                  </div>
                  <button
                    {...tvInc}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >+</button>
                </div>
              </div>
            </div>
            <div className="flex justify-center">
              {/* Season Pack */}
              <div className="w-1/2 rounded-lg bg-slate-800/40 border border-slate-700/20 py-3 px-2 flex flex-col items-center gap-2">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Layers className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">Season Packs</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    {...seasonPackDec}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >−</button>
                  <div className="flex flex-col items-center">
                    {nzbdavSeasonPackTimeoutSeconds >= 60 ? (
                      <>
                        <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                          {Math.floor(nzbdavSeasonPackTimeoutSeconds / 60)}
                          <span className="text-lg text-amber-400/40 mx-px">:</span>
                          {String(nzbdavSeasonPackTimeoutSeconds % 60).padStart(2, '0')}
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">min : sec</span>
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          step={1}
                          value={nzbdavSeasonPackTimeoutSeconds}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setNzbdavSeasonPackTimeoutSeconds(Math.min(90, Math.max(1, v)));
                          }}
                          className="w-14 bg-transparent text-center text-2xl font-bold text-amber-400/90 focus:outline-none focus:text-amber-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none leading-none"
                        />
                        <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">seconds</span>
                      </>
                    )}
                  </div>
                  <button
                    {...seasonPackInc}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >+</button>
                </div>
              </div>
            </div>
            </div>
            <ul className="text-xs text-slate-500 space-y-1 list-disc list-inside">
              <li>How long to wait for a stream to become ready before trying the next NZB. Hold the +/- buttons to accelerate. Min 1s, max 1 min 30s.</li>
              <li>Timed-out NZBs can be excluded from the Dead NZBs Database in the NZB Database menu.</li>
            </ul>
          </div>

          {/* Fallback Order */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Fallback Order</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="fallbackOrder"
                checked={nzbdavFallbackOrder === 'top'}
                onChange={() => setNzbdavFallbackOrder('top')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">From Top of List</div>
                <p className="text-xs text-slate-500">Try the stream you selected first, then fall back from the top of the results list.</p>
              </div>
            </label>
            <div className={clsx("ml-6 space-y-3 transition-opacity", nzbdavFallbackOrder !== 'top' && "opacity-40 pointer-events-none")}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="auto-resolve-search"
                  checked={autoResolveOnSearch}
                  onChange={(e) => setAutoResolveOnSearch(e.target.checked)}
                  className="mt-1 w-3 h-3 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800 cursor-pointer"
                />
                <label htmlFor="auto-resolve-search" className="flex-1 cursor-pointer">
                  <div className="text-sm font-medium text-slate-300">Auto Resolve on Search</div>
                  <div className="text-xs text-slate-500 mt-0.5">Pre-resolve NZBs in the background when search results are fetched, including for auto play.</div>
                </label>
              </div>
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="fallbackOrder"
                checked={nzbdavFallbackOrder === 'selected'}
                onChange={() => setNzbdavFallbackOrder('selected')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">From Selected</div>
                <p className="text-xs text-slate-500">Start with the NZB you clicked, then try alternatives in displayed order.</p>
              </div>
            </label>
          </div>

          {/* Max Fallback Attempts */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Max Fallback Attempts</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="maxFallbacks"
                checked={nzbdavMaxFallbacks === 0}
                onChange={() => setNzbdavMaxFallbacks(0)}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">All Results</div>
                <p className="text-xs text-slate-500">Try every available NZB from the search results before giving up.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="maxFallbacks"
                checked={nzbdavMaxFallbacks > 0}
                onChange={() => { if (nzbdavMaxFallbacks === 0) setNzbdavMaxFallbacks(5); }}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Limit</div>
                <p className="text-xs text-slate-500">Stop after a set number of alternatives.</p>
              </div>
            </label>
            {nzbdavMaxFallbacks > 0 && (
              <div className="flex items-center gap-3 ml-6">
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={nzbdavMaxFallbacks}
                  onChange={(e) => setNzbdavMaxFallbacks(parseInt(e.target.value, 10))}
                  className="flex-1 accent-amber-400"
                />
                <span className="text-sm text-slate-300 w-8 text-right">{nzbdavMaxFallbacks}</span>
              </div>
            )}
          </div>

          {/* Reset All */}
          <div className="pt-2">
            <button
              onClick={() => {
                setNzbdavFallbackEnabled(false);
                setNzbdavLibraryCheckEnabled(true);
                setNzbdavMoviesTimeoutSeconds(30);
                setNzbdavTvTimeoutSeconds(15);
                setNzbdavSeasonPackTimeoutSeconds(30);
                setNzbdavFallbackOrder('top');
                setNzbdavMaxFallbacks(0);
                setNzbdavProxyEnabled(true);
                setAutoResolveOnSearch(true);
              }}
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

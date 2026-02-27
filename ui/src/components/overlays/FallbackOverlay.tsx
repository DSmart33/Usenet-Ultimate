// What this does:
//   NZB Fallback configuration overlay with enable toggle, fallback order, wait times, and cache TTL display

import { RotateCcw, X } from 'lucide-react';
import clsx from 'clsx';

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
  nzbdavFallbackOrder: 'selected' | 'top';
  setNzbdavFallbackOrder: React.Dispatch<React.SetStateAction<'selected' | 'top'>>;
  nzbdavMaxFallbacks: number;
  setNzbdavMaxFallbacks: React.Dispatch<React.SetStateAction<number>>;
  nzbdavStreamBufferMB: number;
  setNzbdavStreamBufferMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavProxyEnabled: boolean;
  setNzbdavProxyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  cacheTTL: number;
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
  nzbdavFallbackOrder,
  setNzbdavFallbackOrder,
  nzbdavMaxFallbacks,
  setNzbdavMaxFallbacks,
  nzbdavStreamBufferMB,
  setNzbdavStreamBufferMB,
  nzbdavProxyEnabled,
  setNzbdavProxyEnabled,
  cacheTTL,
}: FallbackOverlayProps) {
  const fallbackGroupTTLDisplay = cacheTTL >= 3600
    ? `${Math.round(cacheTTL / 3600 * 10) / 10}h`
    : `${Math.round(cacheTTL / 60)} min`;
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
                  Automatically try alternative NZBs when the primary download fails. When disabled, all streams use direct passthrough.
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
                ? 'Video streams through a local proxy with buffering and automatic reconnection. Recommended for mobile and TV.'
                : 'Player is redirected directly to the WebDAV URL. Recommended for desktop players.'}
            </p>
          </div>

          {/* Movie Wait Time — always editable because it controls the initial stream wait time too */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">Movie Wait Time</div>
              <button
                onClick={() => setNzbdavMoviesTimeoutSeconds(30)}
                className="text-xs text-amber-400 hover:text-amber-300"
              >
                Reset
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={600}
                step={5}
                value={nzbdavMoviesTimeoutSeconds}
                onChange={(e) => setNzbdavMoviesTimeoutSeconds(parseInt(e.target.value, 10))}
                className="flex-1 accent-amber-400"
              />
              <span className="text-sm text-slate-300 w-12 text-right">{nzbdavMoviesTimeoutSeconds}s</span>
            </div>
            <p className="text-xs text-slate-500">
              How long to wait for a movie stream to become ready. Also controls the initial stream preparation timeout.
            </p>
          </div>

          {/* TV Show Wait Time — always editable because it controls the initial stream wait time too */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">TV Show Wait Time</div>
              <button
                onClick={() => setNzbdavTvTimeoutSeconds(15)}
                className="text-xs text-amber-400 hover:text-amber-300"
              >
                Reset
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={600}
                step={5}
                value={nzbdavTvTimeoutSeconds}
                onChange={(e) => setNzbdavTvTimeoutSeconds(parseInt(e.target.value, 10))}
                className="flex-1 accent-amber-400"
              />
              <span className="text-sm text-slate-300 w-12 text-right">{nzbdavTvTimeoutSeconds}s</span>
            </div>
            <p className="text-xs text-slate-500">
              How long to wait for a TV episode stream to become ready. Also controls the initial stream preparation timeout.
            </p>
          </div>

          {/* Fallback Order */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Fallback Order</div>
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
                <p className="text-xs text-slate-500">Start with the NZB you clicked, then try alternatives in quality order.</p>
              </div>
            </label>
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
                <p className="text-xs text-slate-500">Always start from the highest-ranked search result, regardless of which stream you selected.</p>
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

          {/* Cache TTL (read-only, matches search cache) */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !nzbdavFallbackEnabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">Fallback & Failed NZB Cache</div>
              <span className="text-sm text-slate-300">{fallbackGroupTTLDisplay}</span>
            </div>
            <p className="text-xs text-slate-500">
              Matches your Search Cache TTL. Fallback candidates and failed NZB records are kept as long as search results are cached. Failed NZBs are skipped instantly on retry. Change this in the Search Cache TTL settings.
            </p>
          </div>

          {/* Stream Buffer Size */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", (!nzbdavFallbackEnabled || !nzbdavProxyEnabled) && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">Stream Buffer</div>
              <button
                onClick={() => setNzbdavStreamBufferMB(128)}
                className="text-xs text-amber-400 hover:text-amber-300"
              >
                Reset
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={8}
                max={256}
                step={8}
                value={nzbdavStreamBufferMB}
                onChange={(e) => setNzbdavStreamBufferMB(parseInt(e.target.value, 10))}
                className="flex-1 accent-amber-400"
              />
              <span className="text-sm text-slate-300 w-16 text-right">{nzbdavStreamBufferMB} MB</span>
            </div>
            <p className="text-xs text-slate-500">
              Internal buffer between WebDAV and the player. Larger buffers absorb network jitter but use more memory per stream. If you experience buffering on large files, try increasing this.
            </p>
          </div>

          {/* Reset All */}
          <div className="pt-2">
            <button
              onClick={() => {
                setNzbdavFallbackEnabled(true);
                setNzbdavLibraryCheckEnabled(true);
                setNzbdavMoviesTimeoutSeconds(30);
                setNzbdavTvTimeoutSeconds(15);
                setNzbdavFallbackOrder('selected');
                setNzbdavMaxFallbacks(0);
                setNzbdavStreamBufferMB(128);
                setNzbdavProxyEnabled(false);
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

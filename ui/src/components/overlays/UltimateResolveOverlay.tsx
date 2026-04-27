// What this does:
//   Ultimate Resolve configuration overlay — combines NZB Fallback with Health Checking
//   for the fastest possible NZB resolution

import { useCallback, useEffect } from 'react';
import { Crown, X, Film, Tv, Layers } from 'lucide-react';
import clsx from 'clsx';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';
import type { HealthChecksState, UsenetProvider } from '../../types';
import { ProviderManager } from '../shared/ProviderManager';

interface UltimateResolveOverlayProps {
  onClose: () => void;
  ultimateResolve: {
    enabled: boolean;
    healthCheckEnabled: boolean;
    whenToResolve: 'on-results' | 'on-tile-selection';
    userPickFallback: 'ur-lobby' | 'failure-video' | 'fallback-chain';
    candidateCount: number;
    preferenceMode: 'priority' | 'speed';
    archiveInspection: boolean;
    sampleCount: 3 | 7;
    desiredBackups: number;
    backupProcessingLimit: number;
    priorityMoviesTimeoutSeconds: number;
    priorityTvTimeoutSeconds: number;
    prioritySeasonPackTimeoutSeconds: number;
    speedMoviesTimeoutSeconds: number;
    speedTvTimeoutSeconds: number;
    speedSeasonPackTimeoutSeconds: number;
    healthCheckIndexers: Record<string, boolean>;
  };
  setUltimateResolve: React.Dispatch<React.SetStateAction<UltimateResolveOverlayProps['ultimateResolve']>>;
  healthChecks: HealthChecksState;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
  nzbdavStreamingMethod: 'pipe' | 'proxy' | 'direct';
  setNzbdavStreamingMethod: React.Dispatch<React.SetStateAction<'pipe' | 'proxy' | 'direct'>>;
  nzbdavStreamBufferMB: number;
  setNzbdavStreamBufferMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavPipeBufferMB: number;
  setNzbdavPipeBufferMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavFallbackEnabled: boolean;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function UltimateResolveOverlay({
  onClose,
  ultimateResolve,
  setUltimateResolve,
  healthChecks,
  setHealthChecks,
  nzbdavStreamingMethod,
  setNzbdavStreamingMethod,
  nzbdavStreamBufferMB,
  setNzbdavStreamBufferMB,
  nzbdavPipeBufferMB,
  setNzbdavPipeBufferMB,
  nzbdavFallbackEnabled,
  apiFetch,
}: UltimateResolveOverlayProps) {
  const update = useCallback(<K extends keyof typeof ultimateResolve>(key: K, value: (typeof ultimateResolve)[K]) => {
    setUltimateResolve(prev => ({ ...prev, [key]: value }));
  }, [setUltimateResolve]);

  const candidateDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, candidateCount: Math.max(1, prev.candidateCount - 1) })), [setUltimateResolve]));
  const candidateInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, candidateCount: Math.min(10, prev.candidateCount + 1) })), [setUltimateResolve]));
  const backupsDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, desiredBackups: Math.max(0, prev.desiredBackups - 1) })), [setUltimateResolve]));
  const backupsInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, desiredBackups: Math.min(10, prev.desiredBackups + 1) })), [setUltimateResolve]));
  const bplDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, backupProcessingLimit: Math.max(0, prev.backupProcessingLimit - 1) })), [setUltimateResolve]));
  const bplInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, backupProcessingLimit: Math.min(20, prev.backupProcessingLimit + 1) })), [setUltimateResolve]));

  // Wait-time +/- hooks. Each action reads prev.preferenceMode so the active set
  // is always the one being mutated — no stale closure across mode toggles.
  const moviesDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds';
    return { ...prev, [key]: Math.max(1, prev[key] - 1) };
  }), [setUltimateResolve]));
  const moviesInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateResolve]));
  const tvDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds';
    return { ...prev, [key]: Math.max(1, prev[key] - 1) };
  }), [setUltimateResolve]));
  const tvInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateResolve]));
  const seasonPackDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds';
    return { ...prev, [key]: Math.max(1, prev[key] - 1) };
  }), [setUltimateResolve]));
  const seasonPackInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => {
    const key = prev.preferenceMode === 'priority' ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateResolve]));

  // Cancel any active hold-to-accelerate when preferenceMode toggles, so the
  // user explicitly re-presses to continue against the new mode's value.
  useEffect(() => {
    moviesDec.onPointerUp(); moviesInc.onPointerUp();
    tvDec.onPointerUp(); tvInc.onPointerUp();
    seasonPackDec.onPointerUp(); seasonPackInc.onPointerUp();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimateResolve.preferenceMode]);

  const isPriority = ultimateResolve.preferenceMode === 'priority';
  const moviesValue = isPriority ? ultimateResolve.priorityMoviesTimeoutSeconds : ultimateResolve.speedMoviesTimeoutSeconds;
  const tvValue = isPriority ? ultimateResolve.priorityTvTimeoutSeconds : ultimateResolve.speedTvTimeoutSeconds;
  const seasonPackValue = isPriority ? ultimateResolve.prioritySeasonPackTimeoutSeconds : ultimateResolve.speedSeasonPackTimeoutSeconds;
  const setMoviesValue = (v: number) => update(isPriority ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds', Math.min(90, Math.max(1, v)));
  const setTvValue = (v: number) => update(isPriority ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds', Math.min(90, Math.max(1, v)));
  const setSeasonPackValue = (v: number) => update(isPriority ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds', Math.min(90, Math.max(1, v)));
  const resetActiveModeWaitTimes = () => {
    if (isPriority) {
      setUltimateResolve(prev => ({ ...prev, priorityMoviesTimeoutSeconds: 30, priorityTvTimeoutSeconds: 15, prioritySeasonPackTimeoutSeconds: 30 }));
    } else {
      setUltimateResolve(prev => ({ ...prev, speedMoviesTimeoutSeconds: 20, speedTvTimeoutSeconds: 10, speedSeasonPackTimeoutSeconds: 20 }));
    }
  };

  const enabledPoolProviders = healthChecks.providers.filter(p => p.enabled && p.type === 'pool').length;
  const hasProviders = enabledPoolProviders > 0 || healthChecks.providers.some(p => p.enabled && p.type === 'backup');
  const maxConnections = ultimateResolve.healthCheckEnabled ? ultimateResolve.candidateCount * Math.max(1, enabledPoolProviders) : 0;

  const handleProvidersChange = useCallback((providers: UsenetProvider[]) => {
    setHealthChecks(prev => ({ ...prev, providers }));
  }, [setHealthChecks]);

  // Backend forces proxy when both fallback AND UR are off — mirror here so the UI stays truthful
  const effectiveMethod = (!nzbdavFallbackEnabled && !ultimateResolve.enabled) ? 'proxy' as const : nzbdavStreamingMethod;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                <Crown className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-xl font-bold bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">
                Ultimate Resolve
              </h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">

          {/* Description */}
          <ul className="text-xs text-slate-400 leading-relaxed list-disc list-inside space-y-1">
            <li>Ultimate Resolve is the fastest way to start streaming a healthy NZB. It races one or more NZB candidates in parallel, verifies each is alive before and during submission, and streams from the best candidate based on your preference mode, highest priority or first to resolve.</li>
            <li>When backups are enabled, the pipeline keeps running after the primary starts to pre-cache container-matched fallbacks, if the stream dies mid-playback, the next one is already loaded.</li>
          </ul>

          {/* Enable Toggle */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">Enable Ultimate Resolve</span>
            <button
              aria-label="Enable Ultimate Resolve"
              aria-pressed={ultimateResolve.enabled}
              onClick={() => update('enabled', !ultimateResolve.enabled)}
              className={clsx(
                "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                ultimateResolve.enabled ? "bg-amber-500" : "bg-slate-600"
              )}
            >
              <div className={clsx(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                ultimateResolve.enabled ? "left-5" : "left-1"
              )} />
            </button>
          </div>

          {/* Streaming Method */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <label id="ur-streaming-method-label" className="block text-sm font-medium text-slate-300">Streaming Method</label>
            <div role="radiogroup" aria-labelledby="ur-streaming-method-label" className="flex gap-3">
              {(['pipe', 'proxy', 'direct'] as const).map((method) => (
                <button
                  key={method}
                  role="radio"
                  aria-checked={nzbdavStreamingMethod === method}
                  onClick={() => setNzbdavStreamingMethod(method)}
                  className={clsx(
                    "flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                    nzbdavStreamingMethod === method
                      ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                      : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                  )}
                >
                  {method === 'pipe' ? 'Pipe' : method === 'proxy' ? 'Dual-Stage Proxy' : 'Direct'}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              {nzbdavStreamingMethod === 'pipe'
                ? 'Streams through a local pipe with buffering and automatic reconnection. Lowest memory overhead, no request modifications.'
                : nzbdavStreamingMethod === 'proxy'
                ? 'Dual-stage buffered proxy with manual flow control and automatic reconnection. Recommended default for most setups.'
                : 'Player is redirected directly to the WebDAV URL. Only supported on select Stremio applications.'}
            </p>
          </div>

          {/* Stream Buffer — hidden for direct mode (no buffer needed); uses effectiveMethod so pipe appears when UR + fallback both off */}
          {effectiveMethod !== 'direct' && (
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">{effectiveMethod === 'pipe' ? 'Pipe Stream Buffer' : 'Dual-Stage Proxy Stream Buffer'}</div>
              <button
                onClick={() => effectiveMethod === 'pipe' ? setNzbdavPipeBufferMB(8) : setNzbdavStreamBufferMB(128)}
                className="text-xs text-amber-400 hover:text-amber-300"
              >
                Reset
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={effectiveMethod === 'pipe' ? 1 : 8}
                max={effectiveMethod === 'pipe' ? 16 : 256}
                step={effectiveMethod === 'pipe' ? 1 : 8}
                value={effectiveMethod === 'pipe' ? nzbdavPipeBufferMB : nzbdavStreamBufferMB}
                onChange={(e) => effectiveMethod === 'pipe' ? setNzbdavPipeBufferMB(parseInt(e.target.value, 10)) : setNzbdavStreamBufferMB(parseInt(e.target.value, 10))}
                className="flex-1 accent-amber-400"
              />
              <span className="text-sm text-slate-300 w-16 text-right">{effectiveMethod === 'pipe' ? nzbdavPipeBufferMB : nzbdavStreamBufferMB} MB</span>
            </div>
            <p className="text-xs text-slate-500">
              {effectiveMethod === 'pipe'
                ? 'Buffer between WebDAV and the player. Absorbs network jitter with minimal memory usage.'
                : 'Internal buffer between WebDAV and the player. Larger buffers absorb network jitter but use more memory per stream.'}
            </p>
          </div>
          )}

          {/* Empty providers warning */}
          {ultimateResolve.enabled && ultimateResolve.healthCheckEnabled && !hasProviders && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              <p className="text-xs text-amber-400">
                Configure at least one Usenet provider in Health Checks to use Ultimate Resolve.
              </p>
            </div>
          )}

          {/* When to Resolve */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">When to Resolve</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="whenToResolve"
                checked={ultimateResolve.whenToResolve === 'on-results'}
                onChange={() => update('whenToResolve', 'on-results')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">On Search</div>
                <p className="text-xs text-slate-500">Pre-resolve as soon as results arrive. Clicks are instant; some resources may be spent on titles you skip.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="whenToResolve"
                checked={ultimateResolve.whenToResolve === 'on-tile-selection'}
                onChange={() => update('whenToResolve', 'on-tile-selection')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">On Click</div>
                <p className="text-xs text-slate-500">Wait until you click a tile to resolve. Saves resources, but the first click takes longer.</p>
              </div>
            </label>
          </div>

          {/* On Individual Stream Failure */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">On Individual Stream Failure</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateResolve.userPickFallback === 'ur-lobby'}
                onChange={() => update('userPickFallback', 'ur-lobby')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Use Ultimate Resolve</div>
                <p className="text-xs text-slate-500">Reroute to Ultimate Resolve so a backup candidate can take over.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateResolve.userPickFallback === 'fallback-chain'}
                onChange={() => update('userPickFallback', 'fallback-chain')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Try Next Stream</div>
                <p className="text-xs text-slate-500">Move to the next stream in the results list, trying each one until something plays.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateResolve.userPickFallback === 'failure-video'}
                onChange={() => update('userPickFallback', 'failure-video')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Show Failure Video</div>
                <p className="text-xs text-slate-500">Skip the rescue and show the "Stream Unavailable" video right away.</p>
              </div>
            </label>
          </div>

          {/* Prefer Priority / Prefer Speed */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Preference Mode</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="preferenceMode"
                checked={ultimateResolve.preferenceMode === 'priority'}
                onChange={() => update('preferenceMode', 'priority')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Prefer Priority</div>
                <p className="text-xs text-slate-500">Prefer the highest potential NZB candidate even if others below it resolve first.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="preferenceMode"
                checked={ultimateResolve.preferenceMode === 'speed'}
                onChange={() => update('preferenceMode', 'speed')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Prefer Speed</div>
                <p className="text-xs text-slate-500">Prefer the fastest resolving NZB, even if there are unresolved candidates with higher priority.</p>
              </div>
            </label>
            <p className="text-xs text-slate-500 pt-1">Mode also controls NZBDav Wait Times below.</p>
          </div>

          {/* NZBDav Wait Times — per-mode set */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-slate-300">NZBDav Wait Times</div>
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300/90 font-medium">
                  Editing: {isPriority ? 'Priority' : 'Speed'}
                </span>
              </div>
              <button
                onClick={resetActiveModeWaitTimes}
                className="text-xs text-amber-400 hover:text-amber-300 whitespace-nowrap"
              >
                Reset {isPriority ? 'Priority' : 'Speed'} Defaults
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Movies */}
                <div className="rounded-lg bg-slate-800/40 border border-slate-700/20 py-3 px-2 flex flex-col items-center gap-2">
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <Film className="w-3.5 h-3.5" />
                    <span className="text-xs font-medium">Movies</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      {...moviesDec}
                      className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                    >−</button>
                    <div className="flex flex-col items-center">
                      {moviesValue >= 60 ? (
                        <>
                          <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                            {Math.floor(moviesValue / 60)}
                            <span className="text-lg text-amber-400/40 mx-px">:</span>
                            {String(moviesValue % 60).padStart(2, '0')}
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
                            value={moviesValue}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v)) setMoviesValue(v);
                            }}
                            className="w-14 bg-transparent text-center text-2xl font-bold text-amber-400/90 focus:outline-none focus:text-amber-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none leading-none"
                          />
                          <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">seconds</span>
                        </>
                      )}
                    </div>
                    <button
                      {...moviesInc}
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
                      {tvValue >= 60 ? (
                        <>
                          <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                            {Math.floor(tvValue / 60)}
                            <span className="text-lg text-amber-400/40 mx-px">:</span>
                            {String(tvValue % 60).padStart(2, '0')}
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
                            value={tvValue}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v)) setTvValue(v);
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
                      {seasonPackValue >= 60 ? (
                        <>
                          <div className="text-2xl font-bold text-amber-400/90 leading-none tabular-nums">
                            {Math.floor(seasonPackValue / 60)}
                            <span className="text-lg text-amber-400/40 mx-px">:</span>
                            {String(seasonPackValue % 60).padStart(2, '0')}
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
                            value={seasonPackValue}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v)) setSeasonPackValue(v);
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
              <li>The time Ultimate Resolve will wait for a health-verified NZB to finish processing in NZBDav before moving on to the next candidate.</li>
              <li>Priority and Speed modes use a separate set of wait times, switch the Preference Mode above to edit each one.</li>
              <li>Hold the +/- buttons to accelerate. Min 1s, max 1 min 30s.</li>
            </ul>
          </div>

          {/* Parallel NZB Candidates */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Parallel NZB Candidates</span>
              <div className="flex items-center gap-2">
                <button
                  {...candidateDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-6 text-center">{ultimateResolve.candidateCount}</span>
                <button
                  {...candidateInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">The number of NZBs to process from the top of the results list in parallel. The first to resolve (based on Preference Mode above) becomes the primary stream; the rest hold as backup candidates.</div>
            {maxConnections > 0 && (
              <>
                <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-1">
                  <span className="text-amber-400/70 font-medium tabular-nums">{maxConnections}</span>
                  <span>max NNTP connections ({ultimateResolve.candidateCount} candidate{ultimateResolve.candidateCount !== 1 ? 's' : ''} × {Math.max(1, enabledPoolProviders)} pool provider{enabledPoolProviders !== 1 ? 's' : ''})</span>
                </div>
                <div className="text-xs text-amber-400/50 mt-1">
                  These connections are separate from NZBDav's download connections. Ensure your provider allows enough concurrent connections for both.
                </div>
              </>
            )}
          </div>

          {/* Desired Backups */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Desired Backups</span>
              <div className="flex items-center gap-2">
                <button
                  {...backupsDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-10 text-center">{ultimateResolve.desiredBackups === 0 ? 'Off' : ultimateResolve.desiredBackups}</span>
                <button
                  {...backupsInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">Container-matched backups to pre-resolve after the primary. Processing stops once this number is reached (or candidates are exhausted). Backups must match the primary's container type (MKV, MP4, etc.).</div>
            <div className="text-xs text-amber-400/50">Values: Off, 1–10</div>

            {ultimateResolve.desiredBackups > 0 && (
              <div className="border-l-2 border-amber-500/20 pl-3 ml-1 mt-3 space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 whitespace-nowrap">Backup Processing Limit</span>
                  <div className="flex items-center gap-2">
                    <button
                      {...bplDec}
                      className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                    >−</button>
                    <span className="text-lg font-bold text-amber-400/90 tabular-nums w-8 text-center">{ultimateResolve.backupProcessingLimit === 0 ? 'All' : ultimateResolve.backupProcessingLimit}</span>
                    <button
                      {...bplInc}
                      className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                    >+</button>
                  </div>
                </div>
                <div className="text-xs text-slate-500">Cap on extra NZB grabs after the primary resolves, in search of more backups. NZBs grabbed earlier (while still searching for the primary) flow through as free backups and don't count. Library hits don't either.</div>
                <div className="text-xs text-amber-400/50">Values: All, 1–20</div>
                <div className="text-xs text-amber-400/50">
                  At least <span className="text-sm font-semibold tabular-nums">{ultimateResolve.candidateCount}</span> NZB{ultimateResolve.candidateCount !== 1 ? 's' : ''} grabbed during primary search (more if early candidates fail), then {ultimateResolve.backupProcessingLimit === 0 ? <span className="text-sm font-semibold">unlimited</span> : <>up to <span className="text-sm font-semibold tabular-nums">{ultimateResolve.backupProcessingLimit}</span> more</>} additional grab{ultimateResolve.backupProcessingLimit !== 1 ? 's' : ''} for backups.
                </div>
              </div>
            )}
          </div>

          {/* Health Checking — toggle, provider config, sample count, archive inspection */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-300">Health Checking</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Verifies every candidate in parallel before and during nzbdav submission, sampling articles to confirm the NZB is alive and detecting its container format up front. Disable to skip the parallel phase, UR will submit candidates straight to nzbdav and detect each container after extraction.
                </div>
              </div>
              <button
                aria-label="Enable Health Checking"
                aria-pressed={ultimateResolve.healthCheckEnabled}
                onClick={() => update('healthCheckEnabled', !ultimateResolve.healthCheckEnabled)}
                className={clsx(
                  "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                  ultimateResolve.healthCheckEnabled ? "bg-amber-500" : "bg-slate-600"
                )}
              >
                <div className={clsx(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  ultimateResolve.healthCheckEnabled ? "left-5" : "left-1"
                )} />
              </button>
            </div>

            <div className={clsx("space-y-4 transition-opacity", !ultimateResolve.healthCheckEnabled && "opacity-40 pointer-events-none")}>
              {/* Usenet Providers (shared with Health Checks) */}
              <ProviderManager
                providers={healthChecks.providers}
                onProvidersChange={handleProvidersChange}
                apiFetch={apiFetch}
                accentColor="amber"
              />

              {/* Articles to Sample */}
              <div className="space-y-3">
                <div className="text-sm font-medium text-slate-300">Articles to Sample</div>
                <div className="flex gap-3">
                  {([3, 7] as const).map(count => (
                    <button
                      key={count}
                      onClick={() => update('sampleCount', count)}
                      className={clsx(
                        "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                        ultimateResolve.sampleCount === count
                          ? "bg-amber-500/20 border border-amber-500/40 text-amber-300"
                          : "bg-slate-700/40 border border-slate-600/30 text-slate-400 hover:text-slate-200 hover:border-slate-500/50"
                      )}
                    >
                      {count} samples
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500">More samples means more accurate health checks but slightly slower.</p>
              </div>

              {/* Archive Inspection — always on for UR */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-200">Archive Header Inspection</div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Inspects RAR and 7Z archives to detect the container format, encryption, and
                    nested archives. Always on for Ultimate Resolve because backup matching works
                    best when detecting each candidate's format up front.
                  </p>
                </div>
                {ultimateResolve.healthCheckEnabled && (
                  <span
                    className="text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 flex-shrink-0"
                    aria-label="Always on"
                  >
                    Always On
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Reset to Default */}
          <div className="pt-2">
            <button
              onClick={() => {
                setUltimateResolve({
                  enabled: false,
                  healthCheckEnabled: true,
                  whenToResolve: 'on-results',
                  userPickFallback: 'ur-lobby',
                  candidateCount: 3,
                  preferenceMode: 'priority',
                  archiveInspection: true,
                  sampleCount: 3,
                  desiredBackups: 2,
                  backupProcessingLimit: 3,
                  priorityMoviesTimeoutSeconds: 30,
                  priorityTvTimeoutSeconds: 15,
                  prioritySeasonPackTimeoutSeconds: 30,
                  speedMoviesTimeoutSeconds: 20,
                  speedTvTimeoutSeconds: 10,
                  speedSeasonPackTimeoutSeconds: 20,
                  healthCheckIndexers: {},
                });
                setNzbdavStreamingMethod('proxy');
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

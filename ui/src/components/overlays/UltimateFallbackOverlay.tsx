// What this does:
//   Ultimate Fallback configuration overlay — combines retry-on-failure with Health Checking
//   for the fastest possible NZB resolution

import { useCallback, useEffect, useState } from 'react';
import { Crown, X, Film, Tv, Layers } from 'lucide-react';
import clsx from 'clsx';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';
import type { HealthChecksState, UsenetProvider } from '../../types';
import { DEFAULT_ULTIMATE_FALLBACK, UF_PRESET_CLASSIC, UF_PRESET_LITE, UF_PRESET_ENHANCED } from '../../constants';
import { ProviderManager } from '../shared/ProviderManager';

interface UltimateFallbackOverlayProps {
  onClose: () => void;
  ultimateFallback: {
    enabled: boolean;
    healthCheckEnabled: boolean;
    whenToResolve: 'on-results' | 'on-tile-selection';
    userPickFallback: 'uf-lobby' | 'failure-video' | 'fallback-chain';
    candidateCount: number;
    preferenceMode: 'priority' | 'speed';
    archiveInspection: boolean;
    sampleCount: 3 | 7;
    maxAttempts: number;
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
  setUltimateFallback: React.Dispatch<React.SetStateAction<UltimateFallbackOverlayProps['ultimateFallback']>>;
  healthChecks: HealthChecksState;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
  nzbdavStreamingMethod: 'pipe' | 'proxy' | 'direct';
  setNzbdavStreamingMethod: React.Dispatch<React.SetStateAction<'pipe' | 'proxy' | 'direct'>>;
  setDirectModeWarning: React.Dispatch<React.SetStateAction<{ show: boolean }>>;
  nzbdavStreamBufferMB: number;
  setNzbdavStreamBufferMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavPipeBufferMB: number;
  setNzbdavPipeBufferMB: React.Dispatch<React.SetStateAction<number>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function UltimateFallbackOverlay({
  onClose,
  ultimateFallback,
  setUltimateFallback,
  healthChecks,
  setHealthChecks,
  nzbdavStreamingMethod,
  setNzbdavStreamingMethod,
  setDirectModeWarning,
  nzbdavStreamBufferMB,
  setNzbdavStreamBufferMB,
  nzbdavPipeBufferMB,
  setNzbdavPipeBufferMB,
  apiFetch,
}: UltimateFallbackOverlayProps) {
  const update = useCallback(<K extends keyof typeof ultimateFallback>(key: K, value: (typeof ultimateFallback)[K]) => {
    setUltimateFallback(prev => ({ ...prev, [key]: value }));
  }, [setUltimateFallback]);

  // Ephemeral preset-button blink. Cleared 250ms after click.
  const [presetApplied, setPresetApplied] = useState<string | null>(null);
  const applyPreset = useCallback((name: string, preset: typeof UF_PRESET_ENHANCED) => {
    setUltimateFallback(prev => ({ ...prev, ...preset }));
    setPresetApplied(name);
    setTimeout(() => setPresetApplied(null), 250);
  }, [setUltimateFallback]);

  const candidateDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => ({ ...prev, candidateCount: Math.max(1, prev.candidateCount - 1) })), [setUltimateFallback]));
  const candidateInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const ceiling = prev.maxAttempts > 0 ? Math.min(10, prev.maxAttempts) : 10;
    return { ...prev, candidateCount: Math.min(ceiling, prev.candidateCount + 1) };
  }), [setUltimateFallback]));
  const attemptsDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const newAttempts = Math.max(0, prev.maxAttempts - 1);
    const newCandidateCount = newAttempts > 0 && prev.candidateCount > newAttempts ? newAttempts : prev.candidateCount;
    return { ...prev, maxAttempts: newAttempts, candidateCount: newCandidateCount };
  }), [setUltimateFallback]));
  const attemptsInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const newAttempts = Math.min(20, prev.maxAttempts + 1);
    const newCandidateCount = newAttempts > 0 && prev.candidateCount > newAttempts ? newAttempts : prev.candidateCount;
    return { ...prev, maxAttempts: newAttempts, candidateCount: newCandidateCount };
  }), [setUltimateFallback]));
  const backupsDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => ({ ...prev, desiredBackups: Math.max(0, prev.desiredBackups - 1) })), [setUltimateFallback]));
  const backupsInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => ({ ...prev, desiredBackups: Math.min(10, prev.desiredBackups + 1) })), [setUltimateFallback]));
  const bplDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => ({ ...prev, backupProcessingLimit: Math.max(0, prev.backupProcessingLimit - 1) })), [setUltimateFallback]));
  const bplInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => ({ ...prev, backupProcessingLimit: Math.min(20, prev.backupProcessingLimit + 1) })), [setUltimateFallback]));

  // Wait-time +/- hooks. Each action reads prev.preferenceMode so the active set
  // is always the one being mutated — no stale closure across mode toggles.
  const moviesDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds';
    return { ...prev, [key]: Math.max(0, prev[key] - 1) };
  }), [setUltimateFallback]));
  const moviesInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateFallback]));
  const tvDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds';
    return { ...prev, [key]: Math.max(0, prev[key] - 1) };
  }), [setUltimateFallback]));
  const tvInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateFallback]));
  const seasonPackDec = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds';
    return { ...prev, [key]: Math.max(0, prev[key] - 1) };
  }), [setUltimateFallback]));
  const seasonPackInc = useHoldRepeat(useCallback(() => setUltimateFallback(prev => {
    const key = prev.preferenceMode === 'priority' ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds';
    return { ...prev, [key]: Math.min(90, prev[key] + 1) };
  }), [setUltimateFallback]));

  // Cancel any active hold-to-accelerate when preferenceMode toggles, so the
  // user explicitly re-presses to continue against the new mode's value.
  useEffect(() => {
    moviesDec.onPointerUp(); moviesInc.onPointerUp();
    tvDec.onPointerUp(); tvInc.onPointerUp();
    seasonPackDec.onPointerUp(); seasonPackInc.onPointerUp();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimateFallback.preferenceMode]);

  const isPriority = ultimateFallback.preferenceMode === 'priority';
  const moviesValue = isPriority ? ultimateFallback.priorityMoviesTimeoutSeconds : ultimateFallback.speedMoviesTimeoutSeconds;
  const tvValue = isPriority ? ultimateFallback.priorityTvTimeoutSeconds : ultimateFallback.speedTvTimeoutSeconds;
  const seasonPackValue = isPriority ? ultimateFallback.prioritySeasonPackTimeoutSeconds : ultimateFallback.speedSeasonPackTimeoutSeconds;
  const setMoviesValue = (v: number) => update(isPriority ? 'priorityMoviesTimeoutSeconds' : 'speedMoviesTimeoutSeconds', Math.min(90, Math.max(0, v)));
  const setTvValue = (v: number) => update(isPriority ? 'priorityTvTimeoutSeconds' : 'speedTvTimeoutSeconds', Math.min(90, Math.max(0, v)));
  const setSeasonPackValue = (v: number) => update(isPriority ? 'prioritySeasonPackTimeoutSeconds' : 'speedSeasonPackTimeoutSeconds', Math.min(90, Math.max(0, v)));
  const resetActiveModeWaitTimes = () => {
    if (isPriority) {
      setUltimateFallback(prev => ({ ...prev, priorityMoviesTimeoutSeconds: 30, priorityTvTimeoutSeconds: 15, prioritySeasonPackTimeoutSeconds: 30 }));
    } else {
      setUltimateFallback(prev => ({ ...prev, speedMoviesTimeoutSeconds: 20, speedTvTimeoutSeconds: 10, speedSeasonPackTimeoutSeconds: 20 }));
    }
  };

  const enabledPoolProviders = healthChecks.providers.filter(p => p.enabled && p.type === 'pool').length;
  const hasProviders = enabledPoolProviders > 0 || healthChecks.providers.some(p => p.enabled && p.type === 'backup');
  const maxConnections = ultimateFallback.healthCheckEnabled ? ultimateFallback.candidateCount * Math.max(1, enabledPoolProviders) : 0;

  const handleProvidersChange = useCallback((providers: UsenetProvider[]) => {
    setHealthChecks(prev => ({ ...prev, providers }));
  }, [setHealthChecks]);

  // Backend forces proxy when both fallback AND UF are off — mirror here so the UI stays truthful
  const effectiveMethod = !ultimateFallback.enabled ? 'proxy' as const : nzbdavStreamingMethod;

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
                Ultimate Fallback
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
            <li>Ultimate Fallback is the fastest way to start streaming a healthy NZB. It races one or more NZB candidates in parallel, verifies each is alive before and during submission, and streams from the best candidate based on your preference mode, highest priority or first to resolve.</li>
            <li>When backups are enabled, the pipeline keeps running after the primary starts to pre-cache container-matched fallbacks, if the stream dies mid-playback, the next one is already loaded.</li>
          </ul>

          {/* Enable Toggle */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">Enable Ultimate Fallback</span>
            <button
              aria-label="Enable Ultimate Fallback"
              aria-pressed={ultimateFallback.enabled}
              onClick={() => update('enabled', !ultimateFallback.enabled)}
              className={clsx(
                "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                ultimateFallback.enabled ? "bg-amber-500" : "bg-slate-600"
              )}
            >
              <div className={clsx(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                ultimateFallback.enabled ? "left-5" : "left-1"
              )} />
            </button>
          </div>

          {/* Presets */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 px-3 py-2 space-y-1.5 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-xs font-medium text-slate-400">Presets</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                disabled={!ultimateFallback.enabled}
                onClick={() => applyPreset('Classic', UF_PRESET_CLASSIC)}
                className={clsx(
                  "w-full px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                  presetApplied === 'Classic'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Classic (Default)
              </button>
              <button
                type="button"
                disabled={!ultimateFallback.enabled}
                onClick={() => applyPreset('Lite', UF_PRESET_LITE)}
                className={clsx(
                  "w-full px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                  presetApplied === 'Lite'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Lite
              </button>
              <button
                type="button"
                disabled={!ultimateFallback.enabled}
                onClick={() => applyPreset('Enhanced', UF_PRESET_ENHANCED)}
                className={clsx(
                  "w-full px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                  presetApplied === 'Enhanced'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Enhanced
              </button>
            </div>
            <div className="text-xs text-amber-400/70 text-center">See Grab Estimate below for resource impact.</div>
          </div>

          {/* Streaming Method */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <label id="ur-streaming-method-label" className="block text-sm font-medium text-slate-300">Streaming Method</label>
            <div role="radiogroup" aria-labelledby="ur-streaming-method-label" className="flex gap-3">
              {(['pipe', 'proxy', 'direct'] as const).map((method) => (
                <button
                  key={method}
                  role="radio"
                  aria-checked={nzbdavStreamingMethod === method}
                  onClick={() => {
                    if (method === 'direct' && nzbdavStreamingMethod !== 'direct') {
                      setDirectModeWarning({ show: true });
                      return;
                    }
                    setNzbdavStreamingMethod(method);
                  }}
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
                : 'Player is redirected directly to the WebDAV URL with credentials embedded. Only supported on select Stremio applications.'}
            </p>
          </div>

          {/* Stream Buffer — hidden for direct mode (no buffer needed); uses effectiveMethod so pipe appears when UF + fallback both off */}
          {effectiveMethod !== 'direct' && (
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
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
          {ultimateFallback.enabled && ultimateFallback.healthCheckEnabled && !hasProviders && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              <p className="text-xs text-amber-400">
                Configure at least one Usenet provider in Health Checks to use Ultimate Fallback.
              </p>
            </div>
          )}

          {/* When to Resolve */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">When to Resolve Ultimate Fallback</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="whenToResolve"
                checked={ultimateFallback.whenToResolve === 'on-tile-selection'}
                onChange={() => update('whenToResolve', 'on-tile-selection')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">On Click</div>
                <p className="text-xs text-slate-500">Wait until you click a tile to resolve. Lobby tile for Ultimate Fallback, stream tile for individual streams.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="whenToResolve"
                checked={ultimateFallback.whenToResolve === 'on-results'}
                onChange={() => update('whenToResolve', 'on-results')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">On Search</div>
                <p className="text-xs text-slate-500">Pre-resolve Ultimate Fallback as soon as results arrive. By the time you enter the Ultimate Fallback lobby, results will have already begun processing.</p>
                <p className="text-[11px] text-amber-400 mt-1">⚠️ Suppresses Health Checks "Auto-queue to NzbDAV" when enabled.</p>
              </div>
            </label>
          </div>

          {/* Fallback Behavior on Individual Stream Failure */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Fallback Behavior on Individual Stream Failure</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateFallback.userPickFallback === 'failure-video'}
                onChange={() => update('userPickFallback', 'failure-video')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Show Failure Video</div>
                <p className="text-xs text-slate-500">Skip Fallback and show the "Stream Unavailable" video.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateFallback.userPickFallback === 'uf-lobby'}
                onChange={() => update('userPickFallback', 'uf-lobby')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Use Ultimate Fallback to Resolve From Top of List</div>
                <p className="text-xs text-slate-500">Fallback to the Ultimate Fallback lobby to resolve from the top of the results list.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="userPickFallback"
                checked={ultimateFallback.userPickFallback === 'fallback-chain'}
                onChange={() => update('userPickFallback', 'fallback-chain')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Fallback to Next Stream</div>
                <p className="text-xs text-slate-500">Fallback to the next stream in the results list from where you selected, iterating down until a healthy candidate is found. If the end of the results list is reached, you'll fallback to the top of the results list continuing the search for a healthy NZB until all candidates are exhausted.</p>
              </div>
            </label>
          </div>

          {/* Prefer Priority / Prefer Speed */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Preference Mode</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="preferenceMode"
                checked={ultimateFallback.preferenceMode === 'priority'}
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
                checked={ultimateFallback.preferenceMode === 'speed'}
                onChange={() => update('preferenceMode', 'speed')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Prefer Speed</div>
                <p className="text-xs text-slate-500">Prefer the fastest resolving NZB, even if there are unresolved candidates with higher priority.</p>
              </div>
            </label>
            <p className="text-xs text-slate-500 pt-1">Mode also controls NzbDAV Wait Times below.</p>
          </div>

          {/* NzbDAV Wait Times — per-mode set */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-slate-300">NzbDAV Wait Times</div>
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
                      {moviesValue === 0 ? (
                        <>
                          <div aria-label="Infinite (no timeout)" className="w-14 text-center text-2xl font-bold text-amber-400/90 leading-none">∞</div>
                          <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">infinite</span>
                        </>
                      ) : moviesValue >= 60 ? (
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
                            min={0}
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
                      {tvValue === 0 ? (
                        <>
                          <div aria-label="Infinite (no timeout)" className="w-14 text-center text-2xl font-bold text-amber-400/90 leading-none">∞</div>
                          <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">infinite</span>
                        </>
                      ) : tvValue >= 60 ? (
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
                            min={0}
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
                      {seasonPackValue === 0 ? (
                        <>
                          <div aria-label="Infinite (no timeout)" className="w-14 text-center text-2xl font-bold text-amber-400/90 leading-none">∞</div>
                          <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">infinite</span>
                        </>
                      ) : seasonPackValue >= 60 ? (
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
                            min={0}
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
              <li>The time Ultimate Fallback will wait for a health-verified NZB to finish processing in NzbDAV before moving on to the next candidate.</li>
              <li>Priority and Speed modes use a separate set of wait times, switch the Preference Mode above to edit each one.</li>
              <li>Set to 0 (∞) to disbale the timer and let nzbdav take as long as it needs to finish. Max 1 min 30s. Hold the +/- buttons to accelerate.</li>
            </ul>
          </div>

          {/* Primary Attempt Limit (with nested Parallel NZB Candidates) */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Primary Attempt Limit</span>
              <div className="flex items-center gap-2">
                <button
                  {...attemptsDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-10 text-center">{ultimateFallback.maxAttempts === 0 ? 'All' : ultimateFallback.maxAttempts}</span>
                <button
                  {...attemptsInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">How many NZBs Ultimate Fallback will try before giving up. Library hits don't count.</div>
            <div className="text-xs text-amber-400/50">Values: All, 1–20</div>

            <div className="border-l-2 border-amber-500/20 pl-3 ml-1 mt-3 space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400 whitespace-nowrap">Parallel NZB Candidates</span>
                <div className="flex items-center gap-2">
                  <button
                    {...candidateDec}
                    className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                  >−</button>
                  <span className="text-lg font-bold text-amber-400/90 tabular-nums w-6 text-center">{ultimateFallback.candidateCount}</span>
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
                    <span>max NNTP connections ({ultimateFallback.candidateCount} candidate{ultimateFallback.candidateCount !== 1 ? 's' : ''} × {Math.max(1, enabledPoolProviders)} pool provider{enabledPoolProviders !== 1 ? 's' : ''})</span>
                  </div>
                  <div className="text-xs text-amber-400/50 mt-1">
                    These connections are separate from NzbDAV's download connections. Ensure your provider allows enough concurrent connections for both.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Desired Backups */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Desired Backups</span>
              <div className="flex items-center gap-2">
                <button
                  {...backupsDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-10 text-center">{ultimateFallback.desiredBackups === 0 ? 'Off' : ultimateFallback.desiredBackups}</span>
                <button
                  {...backupsInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">Target number of grabbed backups to pre-resolve after the primary. Free library hits (NZBs already in your WebDAV library that match the primary's container) are always added on top of this target at zero NNTP cost, so the actual backup count can exceed the target when matching library hits exist. Backups must match the primary's container type (MKV, MP4, etc.).</div>
            <div className="text-xs text-amber-400/50">Values: Off, 1–10</div>

            {ultimateFallback.desiredBackups > 0 && (
              <div className="border-l-2 border-amber-500/20 pl-3 ml-1 mt-3 space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 whitespace-nowrap">Backup Processing Limit</span>
                  <div className="flex items-center gap-2">
                    <button
                      {...bplDec}
                      className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                    >−</button>
                    <span className="text-lg font-bold text-amber-400/90 tabular-nums w-8 text-center">{ultimateFallback.backupProcessingLimit === 0 ? 'All' : ultimateFallback.backupProcessingLimit}</span>
                    <button
                      {...bplInc}
                      className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                    >+</button>
                  </div>
                </div>
                <div className="text-xs text-slate-500">A limit on extra NZB grabs after the primary resolves, in search of more backups. NZBs grabbed earlier (while still searching for the primary) flow through as free backups and don't count. Library hits don't count against the limit as well.</div>
                <div className="text-xs text-amber-400/50">Values: All, 1–20</div>
              </div>
            )}
          </div>

          {/* Grab Estimate — always visible, dynamic by desiredBackups + maxAttempts */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Grab Estimate</div>
            <div className="text-xs text-amber-400/50">
              {ultimateFallback.maxAttempts > 0 ? (
                <>At least <span className="text-sm font-semibold tabular-nums">{ultimateFallback.candidateCount}</span> NZB{ultimateFallback.candidateCount !== 1 ? 's' : ''} grabbed during primary search (capped at <span className="text-sm font-semibold tabular-nums">{ultimateFallback.maxAttempts}</span> total)</>
              ) : (
                <>At least <span className="text-sm font-semibold tabular-nums">{ultimateFallback.candidateCount}</span> NZB{ultimateFallback.candidateCount !== 1 ? 's' : ''} grabbed during primary search (more if early candidates fail)</>
              )}
              {ultimateFallback.desiredBackups === 0 ? (
                <>. No additional NZB grabs after primary. Library hits will still be cached as backups.</>
              ) : ultimateFallback.backupProcessingLimit === 0 ? (
                <>, then <span className="text-sm font-semibold">unlimited</span> additional grabs for backups.</>
              ) : (
                <>, then up to <span className="text-sm font-semibold tabular-nums">{ultimateFallback.backupProcessingLimit}</span> more additional grab{ultimateFallback.backupProcessingLimit !== 1 ? 's' : ''} for backups.</>
              )}
            </div>
          </div>

          {/* Health Checking — toggle, provider config, sample count, archive inspection */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4 transition-opacity", !ultimateFallback.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-300">Health Checking</div>
                <ul className="text-xs text-slate-500 mt-0.5 list-disc list-inside space-y-1">
                  <li>Enabling verifies every candidate in parallel before and during NzbDAV submission, sampling articles to confirm the NZB is alive and detecting its container format up front. Evicting an NzbDAV job if necessary and cleansing the submission pipleline at the same time.</li>
                  <li>Disable to skip this parallel phase, Ultimate Fallback will submit candidates straight to nzbdav and detect each container after extraction.</li>
                </ul>
              </div>
              <button
                aria-label="Enable Health Checking"
                aria-pressed={ultimateFallback.healthCheckEnabled}
                onClick={() => update('healthCheckEnabled', !ultimateFallback.healthCheckEnabled)}
                className={clsx(
                  "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                  ultimateFallback.healthCheckEnabled ? "bg-amber-500" : "bg-slate-600"
                )}
              >
                <div className={clsx(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  ultimateFallback.healthCheckEnabled ? "left-5" : "left-1"
                )} />
              </button>
            </div>

            <div className={clsx("space-y-4 transition-opacity", !ultimateFallback.healthCheckEnabled && "opacity-40 pointer-events-none")}>
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
                        ultimateFallback.sampleCount === count
                          ? "bg-amber-500/20 border border-amber-500/40 text-amber-300"
                          : "bg-slate-700/40 border border-slate-600/30 text-slate-400 hover:text-slate-200 hover:border-slate-500/50"
                      )}
                    >
                      {count} samples
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500">More samples means more accurate health checks but are slightly slower to process.</p>
              </div>

              {/* Archive Inspection — always on for UF */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-200">Archive Header Inspection</div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Inspects RAR and 7z archives to detect the container format, encryption, and
                    nested archives. Always on for Ultimate Fallback because backup matching works
                    best when detecting each candidate's format up front.
                  </p>
                </div>
                {ultimateFallback.healthCheckEnabled && (
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
                setUltimateFallback({ ...DEFAULT_ULTIMATE_FALLBACK });
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

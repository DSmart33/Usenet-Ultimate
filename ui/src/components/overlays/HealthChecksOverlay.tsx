// What this does:
//   Health checks overlay for configuring NNTP health check providers, inspection settings,
//   per-indexer toggles, and stream status options

import { Heart, X } from 'lucide-react';
import clsx from 'clsx';
import type { Config, HealthChecksState, UsenetProvider, Indexer, SyncedIndexer } from '../../types';
import { ProviderManager } from '../shared/ProviderManager';
interface HealthChecksOverlayProps {
  onClose: () => void;
  config: Config | null;
  healthChecks: HealthChecksState;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  syncedIndexers: SyncedIndexer[];
  setSyncedIndexers: React.Dispatch<React.SetStateAction<SyncedIndexer[]>>;
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  easynewsHealthCheck: boolean;
  setEasynewsHealthCheck: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function HealthChecksOverlay({
  onClose,
  config,
  healthChecks,
  setHealthChecks,
  indexManager,
  syncedIndexers,
  setSyncedIndexers,
  failedLogos,
  setFailedLogos,
  apiFetch,
  easynewsHealthCheck,
  setEasynewsHealthCheck,
}: HealthChecksOverlayProps) {
  // Provider change handler for the shared ProviderManager component
  const handleProvidersChange = (providers: UsenetProvider[]) => {
    setHealthChecks(prev => ({ ...prev, providers }));
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
          <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Heart className="w-6 h-6 text-pink-400" />
                <h3 className="text-xl font-semibold text-slate-200">Health Checks</h3>
              </div>
              <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          <div className="p-4 md:p-6 space-y-6">
            {/* Enable/Disable */}
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={healthChecks.enabled}
                  onChange={(e) => setHealthChecks({ ...healthChecks, enabled: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                />
                <span className="text-sm font-medium text-slate-300">Enable Health Checks</span>
              </label>
              <p className="text-xs text-slate-500 mt-2 ml-8">Verify NZB availability before displaying streams</p>
            </div>

            <div className={clsx("space-y-6 transition-opacity", !healthChecks.enabled && "opacity-40 pointer-events-none")}>
            {/* Health Check Options */}
            <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
              <h4 className="text-sm font-semibold text-slate-300">Health Check Options</h4>

              {/* Archive Inspection toggle */}
              <div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={healthChecks.archiveInspection}
                    onChange={(e) => setHealthChecks({ ...healthChecks, archiveInspection: e.target.checked })}
                    className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                  />
                  <span className="text-sm font-medium text-slate-300">Archive Header Inspection</span>
                </label>
                <p className="text-xs text-slate-500 mt-2 ml-8">
                  Downloads and inspects archive headers (RAR, 7z, ZIP) to detect encryption, nested archives, and verify video content is present. Disable for faster checks that only verify segment availability.
                </p>
              </div>

              {/* Articles to Sample selector */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Articles to Sample</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setHealthChecks({ ...healthChecks, sampleCount: 3 })}
                    className={clsx(
                      "px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                      healthChecks.sampleCount === 3
                        ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                        : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                    )}
                  >
                    3 Samples
                  </button>
                  <button
                    onClick={() => setHealthChecks({ ...healthChecks, sampleCount: 7 })}
                    className={clsx(
                      "px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                      healthChecks.sampleCount === 7
                        ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                        : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                    )}
                  >
                    7 Samples
                  </button>
                </div>
              </div>

              {/* Sub-options */}
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Auto-queue to NzbDAV</label>
                  <select
                    value={healthChecks.autoQueueMode}
                    onChange={(e) => setHealthChecks({ ...healthChecks, autoQueueMode: e.target.value as 'off' | 'top' | 'all' })}
                    className="input max-w-xs"
                  >
                    <option value="off">Off</option>
                    <option value="top">Top Result</option>
                    <option value="all">All Healthy</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-1">
                    Automatically queue verified results to NzbDAV for caching. Uses cached NZB data from health checks to save indexer grabs. (NzbDAV streaming mode only)
                  </p>
                  <p className="text-xs text-amber-400 mt-1">
                    ⚠️ Suppressed when Ultimate Fallback is set to "On Search".
                  </p>
                </div>
                {config?.easynewsEnabled && config?.easynewsMode === 'nzb' && (
                  <div>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={easynewsHealthCheck}
                        onChange={(e) => setEasynewsHealthCheck(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                      />
                      <span className="text-sm font-medium text-slate-300">Include EasyNews in Health Checks</span>
                    </label>
                    <p className="text-xs text-slate-500 mt-1 ml-7">
                      Enabled: EasyNews NZBs will be verified via health checks.
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 ml-7">
                      Disabled: EasyNews results auto-marked as healthy.
                    </p>
                    <p className="text-xs text-amber-400 mt-1 ml-7">
                      ⚠️ With EasyNews bypassing health checks and auto-queue set to "All Healthy", this will queue all EasyNews results to NzbDAV. In this case, consider "Top Result" to avoid flooding your download client.
                    </p>
                  </div>
                )}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={healthChecks.hideBlocked}
                      onChange={(e) => setHealthChecks({ ...healthChecks, hideBlocked: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-300">Hide blocked/error NZBs</span>
                  </label>
                  <p className="text-xs text-slate-500 mt-1 ml-7">
                    Remove blocked and errored results so only verified healthy streams are shown
                  </p>
                </div>
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={healthChecks.libraryPreCheck}
                      onChange={(e) => setHealthChecks({ ...healthChecks, libraryPreCheck: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-300">Library Pre-Check</span>
                  </label>
                  <p className="text-xs text-slate-500 mt-1 ml-7">
                    Check the NzbDAV library before running NNTP health checks. Content already downloaded is instantly marked as verified, skipping expensive segment checks. (NzbDAV streaming mode only)
                  </p>
                </div>
              </div>
            </div>

            {/* Stream Status Legend */}
            <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              <h4 className="text-sm font-semibold text-slate-300 mb-3">Stream Status Legend</h4>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">✅</span>
                  <div>
                    <div className="font-medium text-green-400">Healthy</div>
                    <div className="text-slate-400 text-xs">Articles confirmed available on usenet. Expected to play.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">📚</span>
                  <div>
                    <div className="font-medium text-blue-400">In Library</div>
                    <div className="text-slate-400 text-xs">Already downloaded and available in your NzbDAV library. Skipped NNTP health check.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🚫</span>
                  <div>
                    <div className="font-medium text-red-400">Blocked</div>
                    <div className="text-slate-400 text-xs">Missing articles on usenet, unsupported format (ISO/IMG), or no video content. Will not play.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">❌</span>
                  <div>
                    <div className="font-medium text-red-300">Error</div>
                    <div className="text-slate-400 text-xs">Health check failed due to a network error, provider failure, or VPN change.</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Usenet Providers (shared component) */}
            <ProviderManager
              providers={healthChecks.providers}
              onProvidersChange={handleProvidersChange}
              apiFetch={apiFetch}
              accentColor="pink"
            />

            {/* Health Check Settings */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-300">Settings</h4>

              {/* Inspection Method */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Inspection Method</label>
                <select
                  value={healthChecks.inspectionMethod}
                  onChange={(e) => setHealthChecks({ ...healthChecks, inspectionMethod: e.target.value as 'fixed' | 'smart' })}
                  className="input max-w-xs"
                >
                  <option value="fixed">Fixed Count</option>
                  <option value="smart">Smart (Stop on Healthy)</option>
                </select>
                <div className="mt-2 text-xs text-slate-500">
                  {healthChecks.inspectionMethod === 'fixed'
                    ? 'Inspect a fixed number of top results.'
                    : 'Check NZBs in small batches. Stop as soon as a healthy result is found.'}
                </div>
              </div>

              {/* Fixed Count: NZBs to Inspect */}
              {healthChecks.inspectionMethod === 'fixed' && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Number of NZBs to Inspect</label>
                  <input
                    type="number"
                    value={healthChecks.nzbsToInspect ?? ''}
                    onChange={(e) => setHealthChecks({ ...healthChecks, nzbsToInspect: e.target.value === '' ? ('' as any) : parseInt(e.target.value) || 0 })}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => { if (e.target.value === '' || parseInt(e.target.value) < 1) setHealthChecks(prev => ({ ...prev, nzbsToInspect: 6 })); }}
                    min="1"
                    max="20"
                    className="input w-full"
                  />
                  <p className="text-xs text-slate-500 mt-1">How many top results to health check (1-20)</p>
                </div>
              )}

              {/* Smart: Batch Size + Additional Runs */}
              {healthChecks.inspectionMethod === 'smart' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Batch Size</label>
                    <select
                      value={healthChecks.smartBatchSize}
                      onChange={(e) => {
                        const newBatchSize = parseInt(e.target.value);
                        setHealthChecks(prev => ({
                          ...prev,
                          smartBatchSize: newBatchSize,
                        }));
                      }}
                      className="input max-w-xs"
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                      <option value="6">6</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">NZBs to check per batch</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Additional Runs</label>
                    <input
                      type="number"
                      value={healthChecks.smartAdditionalRuns ?? ''}
                      onChange={(e) => setHealthChecks({ ...healthChecks, smartAdditionalRuns: e.target.value === '' ? ('' as any) : parseInt(e.target.value) || 0 })}
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => { if (e.target.value === '' || parseInt(e.target.value) < 0) setHealthChecks(prev => ({ ...prev, smartAdditionalRuns: 1 })); }}
                      min="0"
                      max="5"
                      className="input w-full"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Additional batches to try if threshold not met (0-5).{' '}
                      <span className="text-pink-400 font-medium">
                        ({healthChecks.smartBatchSize * (1 + (healthChecks.smartAdditionalRuns || 0))} max NZB checks)
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Minimum Healthy Results</label>
                    <input
                      type="number"
                      value={healthChecks.smartMinHealthy ?? ''}
                      onChange={(e) => setHealthChecks({ ...healthChecks, smartMinHealthy: e.target.value === '' ? ('' as any) : parseInt(e.target.value) || 1 })}
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => { if (e.target.value === '' || parseInt(e.target.value) < 1) setHealthChecks(prev => ({ ...prev, smartMinHealthy: 1 })); }}
                      min="1"
                      max="10"
                      className="input w-full"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Smart mode keeps searching until this many healthy candidates are found (1-10). Higher values improve fallback resilience when individual candidates fail, at a small cost to initial response time.
                    </p>
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Connections</label>
                {(() => {
                  const poolProviderCount = healthChecks.providers.filter(p => p.enabled && p.type === 'pool').length;
                  const batchCount = healthChecks.inspectionMethod === 'smart'
                    ? healthChecks.smartBatchSize
                    : (healthChecks.nzbsToInspect || 6);
                  const totalConnections = batchCount * Math.max(1, poolProviderCount);
                  return (
                    <>
                      <div className="input w-full cursor-default opacity-70">
                        {totalConnections}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {batchCount} {healthChecks.inspectionMethod === 'smart' ? 'batch' : 'NZBs'} × {Math.max(1, poolProviderCount)} pool provider{poolProviderCount !== 1 ? 's' : ''}.
                        {' '}<span className="text-amber-400/80">These connections plus any NzbDAV connections must not exceed your provider's maximum allowed connections.</span>
                      </p>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Per-Indexer Health Check Toggles */}
            {config && ((indexManager === 'newznab' && config.indexers.length > 0) || ((indexManager === 'prowlarr' || indexManager === 'nzbhydra') && syncedIndexers.length > 0)) && (
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-3">
                <h4 className="text-sm font-semibold text-slate-300">Indexer Health Checks</h4>
                <p className="text-xs text-slate-500">Click to toggle. Disable for free-tier indexers to save grabs.</p>
                <div className="flex flex-wrap gap-3">
                  {(indexManager === 'newznab' ? config.indexers : syncedIndexers).map((indexer) => {
                    const isZyclopsEnabled = 'zyclops' in indexer && (indexer as Indexer).zyclops?.enabled;
                    const isEnabled = isZyclopsEnabled ? false : (indexManager === 'newznab'
                      ? healthChecks.healthCheckIndexers[indexer.name] !== false
                      : ('enabledForHealthCheck' in indexer ? indexer.enabledForHealthCheck : true));
                    return (
                      <button
                        key={indexer.name}
                        disabled={!!isZyclopsEnabled}
                        onClick={() => {
                          if (isZyclopsEnabled) return;
                          if (indexManager === 'newznab') {
                            setHealthChecks({
                              ...healthChecks,
                              healthCheckIndexers: { ...healthChecks.healthCheckIndexers, [indexer.name]: !isEnabled }
                            });
                          } else {
                            setSyncedIndexers(prev => prev.map(i =>
                              i.name === indexer.name ? { ...i, enabledForHealthCheck: !isEnabled } : i
                            ));
                          }
                        }}
                        className={clsx(
                          'relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all w-16',
                          isZyclopsEnabled
                            ? 'border-violet-500/20 bg-violet-500/5 opacity-60 cursor-not-allowed'
                            : isEnabled
                              ? 'border-slate-600 bg-slate-700/50 hover:bg-slate-700'
                              : 'border-slate-700/50 bg-slate-800/80 hover:bg-slate-800 opacity-60'
                        )}
                        title={isZyclopsEnabled ? `${indexer.name} — verified by Zyclops 🤖` : `${indexer.name} — health checks ${isEnabled ? 'enabled' : 'disabled'}`}
                      >
                        <div className="relative w-10 h-10 flex items-center justify-center">
                          {indexer.logo && !failedLogos.has(indexer.logo) ? (
                            <img
                              src={indexer.logo}
                              alt={indexer.name}
                              className={clsx(
                                'w-10 h-10 rounded-lg object-contain bg-slate-700/30 p-1 transition-all',
                                !isEnabled && !isZyclopsEnabled && 'grayscale'
                              )}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                setFailedLogos(prev => new Set(prev).add(indexer.logo!));
                              }}
                            />
                          ) : (
                            <div className={clsx(
                              'w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all',
                              isZyclopsEnabled ? 'bg-violet-700/30 text-violet-300' : isEnabled ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-500'
                            )}>
                              {indexer.name.substring(0, 2).toUpperCase()}
                            </div>
                          )}
                          {isZyclopsEnabled ? (
                            <div className="absolute -bottom-0.5 -right-0.5 text-[10px]" title="Verified by Zyclops">🤖</div>
                          ) : (
                            <div className={clsx(
                              'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 transition-all',
                              isEnabled
                                ? 'bg-green-400 shadow-lg shadow-green-400/50'
                                : 'bg-red-400 shadow-lg shadow-red-400/50'
                            )} />
                          )}
                        </div>
                        <span className={clsx(
                          'text-[10px] leading-tight text-center truncate w-full',
                          isZyclopsEnabled ? 'text-violet-400' : isEnabled ? 'text-slate-300' : 'text-slate-500'
                        )}>
                          {indexer.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Reset Button */}
            <div className="pt-4 border-t border-slate-700">
              <button
                onClick={() => {
                  setHealthChecks(prev => ({
                    enabled: false,
                    archiveInspection: true,
                    sampleCount: 3,
                    providers: prev.providers,
                    nzbsToInspect: 6,
                    inspectionMethod: 'smart',
                    smartBatchSize: 3,
                    smartAdditionalRuns: 1,
                    smartMinHealthy: 1,
                    maxConnections: 12,
                    autoQueueMode: 'all',
                    hideBlocked: true,
                    libraryPreCheck: true,
                    healthCheckIndexers: {},
                  }));
                }}
                className="btn-secondary w-full"
              >
                Reset to Default
              </button>
            </div>
            </div>
          </div>
        </div>
      </div>

    </>
  );
}

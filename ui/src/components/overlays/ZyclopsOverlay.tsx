// What this does:
//   Zyclops configuration overlay with per-indexer toggles, backbone selection,
//   confirmation dialogs for enabling Zyclops and disabling Single IP

import { Bot, X, Shield } from 'lucide-react';
import clsx from 'clsx';
import type { Config, ZyclopsIndexerConfig, HealthChecksState, ApiFetch } from '../../types';
import { ZYCLOPS_BACKBONES } from '../../constants';

interface ZyclopsOverlayProps {
  onClose: () => void;
  apiFetch: ApiFetch;
  config: Config | null;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;
  zyclopsEndpoint: string;
  setZyclopsEndpoint: React.Dispatch<React.SetStateAction<string>>;
  zyclopsTestStatus: 'idle' | 'testing' | 'success' | 'error';
  setZyclopsTestStatus: React.Dispatch<React.SetStateAction<'idle' | 'testing' | 'success' | 'error'>>;
  zyclopsTestMessage: string;
  setZyclopsTestMessage: React.Dispatch<React.SetStateAction<string>>;
  zyclopsConfirmDialog: { show: boolean; indexerName: string };
  setZyclopsConfirmDialog: React.Dispatch<React.SetStateAction<{ show: boolean; indexerName: string }>>;
  singleIpConfirmDialog: { show: boolean; indexerName: string };
  setSingleIpConfirmDialog: React.Dispatch<React.SetStateAction<{ show: boolean; indexerName: string }>>;
  setProxyIndexers: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
}

export function ZyclopsOverlay({
  onClose,
  apiFetch,
  config,
  setConfig,
  failedLogos,
  setFailedLogos,
  zyclopsEndpoint,
  setZyclopsEndpoint,
  zyclopsTestStatus,
  setZyclopsTestStatus,
  zyclopsTestMessage,
  setZyclopsTestMessage,
  zyclopsConfirmDialog,
  setZyclopsConfirmDialog,
  singleIpConfirmDialog,
  setSingleIpConfirmDialog,
  setProxyIndexers,
  setHealthChecks,
}: ZyclopsOverlayProps) {
  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
          <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Bot className="w-6 h-6 text-violet-400" />
                <h3 className="text-xl font-semibold text-slate-200">Zyclops Configuration</h3>
              </div>
              <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>
          <div className="p-4 md:p-6 space-y-4">
            {/* What is Zyclops */}
            <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg p-3">
              <p className="text-xs text-violet-300">
                <span className="font-semibold">🤖 Zyclops</span> is a Newznab health-check proxy by ElfHosted. When enabled, all queries for that indexer are routed through Zyclops, which returns only NZBs verified as healthy for your Usenet backbone. <a href="https://zyclops.elfhosted.com/" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline">Learn more</a>
              </p>
            </div>

            {/* Safety Warning */}
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-300">
                <span className="font-semibold">⚠️ Safety Notice:</span> When Zyclops is enabled for an indexer, that indexer will <strong>never</strong> be queried directly. All requests go through the Zyclops proxy. This also disables per-indexer proxy and health check toggles for that indexer (Zyclops handles verification).
              </p>
            </div>

            {/* Zyclops Badge Legend */}
            <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Icon Legend</div>
              <div className="flex items-start gap-3 text-sm">
                <span className="text-lg leading-none mt-0.5">🤖</span>
                <div>
                  <div className="font-medium text-violet-400">Zyclops Verified</div>
                  <div className="text-slate-400 text-xs">Verified healthy by Zyclops proxy for your Usenet backbone. These results skip NNTP health checks.</div>
                </div>
              </div>
            </div>

            {/* Endpoint Configuration */}
            <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
              <div className="text-sm font-medium text-slate-300">Zyclops Endpoint</div>
              <div>
                <input
                  type="text"
                  value={zyclopsEndpoint}
                  onChange={(e) => setZyclopsEndpoint(e.target.value)}
                  placeholder="https://zyclops.elfhosted.com"
                  className="input"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Default: https://zyclops.elfhosted.com</span>
                <button
                  onClick={async () => {
                    setZyclopsTestStatus('testing');
                    try {
                      const res = await apiFetch('/api/zyclops/test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ endpoint: zyclopsEndpoint }),
                      });
                      const data = await res.json();
                      setZyclopsTestStatus(data.success ? 'success' : 'error');
                      setZyclopsTestMessage(data.message);
                    } catch {
                      setZyclopsTestStatus('error');
                      setZyclopsTestMessage('Connection failed');
                    }
                  }}
                  disabled={zyclopsTestStatus === 'testing'}
                  className="text-xs text-violet-400 hover:text-violet-300 disabled:opacity-50"
                >
                  {zyclopsTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                </button>
              </div>
              {zyclopsTestStatus !== 'idle' && zyclopsTestStatus !== 'testing' && (
                <div className={clsx(
                  'text-xs px-2 py-1 rounded',
                  zyclopsTestStatus === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                )}>
                  {zyclopsTestMessage}
                </div>
              )}
            </div>

            {/* Per-Indexer Zyclops Toggles */}
            {config && config.indexers.length > 0 && (
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-slate-300">Indexer Configuration</h4>
                <p className="text-xs text-slate-500">Enable Zyclops for each indexer individually. Configure backbone/provider to match your Usenet service.</p>
                <div className="space-y-3">
                  {config.indexers.map((indexer) => {
                    const zyclopsConfig = indexer.zyclops || { enabled: false };
                    const isEnabled = zyclopsConfig.enabled;

                    return (
                      <div key={indexer.name} className={clsx(
                        'rounded-lg border p-3 transition-all',
                        isEnabled ? 'border-violet-500/30 bg-violet-500/5' : 'border-slate-700/30 bg-slate-800/30'
                      )}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            {indexer.logo && !failedLogos.has(indexer.logo) ? (
                              <img src={indexer.logo} alt={indexer.name} className="w-6 h-6 rounded object-contain bg-slate-700/30 p-0.5" onError={(e) => { e.currentTarget.style.display = 'none'; setFailedLogos(prev => new Set(prev).add(indexer.logo!)); }} />
                            ) : (
                              <div className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold bg-slate-700 text-slate-400">
                                {indexer.name.substring(0, 2).toUpperCase()}
                              </div>
                            )}
                            <span className="text-sm font-medium text-slate-300">{indexer.name}</span>
                            {isEnabled && <span className="text-sm" title="Zyclops verified">🤖</span>}
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  // Show confirmation dialog
                                  setZyclopsConfirmDialog({ show: true, indexerName: indexer.name });
                                } else {
                                  // Disable immediately
                                  const updated = { ...indexer, zyclops: { ...zyclopsConfig, enabled: false } };
                                  apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ zyclops: updated.zyclops }),
                                  }).then(() => {
                                    setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexer.name ? updated : i) } : prev);
                                  });
                                }
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600"></div>
                          </label>
                        </div>

                        {/* Per-indexer settings (visible when enabled) */}
                        {isEnabled && (
                          <div className="space-y-2 pt-2 border-t border-slate-700/30">
                            {/* Backbone Selection (multi-select) */}
                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1">Backbones</label>
                              <div className="space-y-1">
                                {ZYCLOPS_BACKBONES.map(b => {
                                  const selected = zyclopsConfig.backbone || [];
                                  const isChecked = selected.includes(b);
                                  return (
                                    <label key={b} className="flex items-center gap-1.5 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={(e) => {
                                          const newBackbones = e.target.checked
                                            ? [...selected, b]
                                            : selected.filter(x => x !== b);
                                          const newConfig: ZyclopsIndexerConfig = {
                                            ...zyclopsConfig,
                                            backbone: newBackbones,
                                          };
                                          apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                            method: 'PUT',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ zyclops: newConfig }),
                                          }).then(() => {
                                            setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexer.name ? { ...i, zyclops: newConfig } : i) } : prev);
                                          });
                                        }}
                                        className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-800"
                                      />
                                      <span className="text-[11px] text-slate-300">{b}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>

                            {/* Provider Hosts */}
                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1">Provider hosts</label>
                              <input
                                type="text"
                                value={zyclopsConfig.providerHosts || ''}
                                onChange={(e) => {
                                  const newConfig: ZyclopsIndexerConfig = {
                                    ...zyclopsConfig,
                                    providerHosts: e.target.value || undefined,
                                  };
                                  apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ zyclops: newConfig }),
                                  }).then(() => {
                                    setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexer.name ? { ...i, zyclops: newConfig } : i) } : prev);
                                  });
                                }}
                                placeholder="e.g. news.eweka.nl, news.example.com"
                                className="input text-xs"
                              />
                              <p className="text-[10px] text-slate-500 mt-1">Takes priority over backbone selections</p>
                            </div>

                            {/* Show Unknown & Single IP toggles */}
                            <div className="flex gap-4">
                              <label className={`flex items-center gap-1.5 ${(zyclopsConfig.singleIp ?? true) ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                                <input
                                  type="checkbox"
                                  checked={zyclopsConfig.showUnknown === true}
                                  disabled={zyclopsConfig.singleIp ?? true}
                                  onChange={(e) => {
                                    const newConfig = { ...zyclopsConfig, showUnknown: e.target.checked };
                                    apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ zyclops: newConfig }),
                                    }).then(() => {
                                      setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexer.name ? { ...i, zyclops: newConfig } : i) } : prev);
                                    });
                                  }}
                                  className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-800"
                                />
                                <span className="text-[11px] text-slate-400">Show unknown</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={zyclopsConfig.singleIp ?? true}
                                  onChange={(e) => {
                                    if (!e.target.checked) {
                                      // Show confirmation before disabling
                                      e.preventDefault();
                                      setSingleIpConfirmDialog({ show: true, indexerName: indexer.name });
                                      return;
                                    }
                                    // Re-enabling singleIp — also clear showUnknown (mutually exclusive)
                                    const newConfig = { ...zyclopsConfig, singleIp: true, showUnknown: false };
                                    apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ zyclops: newConfig }),
                                    }).then(() => {
                                      setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexer.name ? { ...i, zyclops: newConfig } : i) } : prev);
                                    });
                                  }}
                                  className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-800"
                                />
                                <span className="text-[11px] text-slate-400">Single IP</span>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Zyclops Confirmation Dialog */}
      {zyclopsConfirmDialog.show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setZyclopsConfirmDialog({ show: false, indexerName: '' })}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-red-500/30 shadow-2xl max-w-md w-full animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-red-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-200">Enable Zyclops?</h3>
                  <p className="text-xs text-slate-400">{zyclopsConfirmDialog.indexerName}</p>
                </div>
              </div>

              <div className="bg-slate-800/80 border border-slate-700/50 rounded-lg p-3">
                <p className="text-xs text-slate-300">
                  Zyclops proxies your indexer URL/API key and returns only known-healthy results for your providers. It also downloads and ingests the newest untested NZB to enrich the health database. (<a href="https://zyclops.elfhosted.com/" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline" onClick={(e) => e.stopPropagation()}>Learn more</a>)
                </p>
              </div>

              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <p className="text-xs text-red-300">
                  <strong>⚠️ TOS Violation Risk:</strong> Many indexers prohibit proxied access. Proceed at your own risk. The health database is directly searchable via Newznab on private ElfHosted instances only.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => setZyclopsConfirmDialog({ show: false, indexerName: '' })}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const indexerName = zyclopsConfirmDialog.indexerName;
                    const indexer = config?.indexers.find(i => i.name === indexerName);
                    if (indexer) {
                      const existing: Partial<ZyclopsIndexerConfig> = indexer.zyclops || {};
                      const newConfig: ZyclopsIndexerConfig = {
                        ...existing,
                        enabled: true,
                        backbone: existing.backbone ?? [],
                      };
                      apiFetch(`/api/indexers/${encodeURIComponent(indexerName)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zyclops: newConfig }),
                      }).then(async (res) => {
                        if (!res.ok) {
                          const err = await res.json();
                          alert(err.error || 'Failed to enable Zyclops');
                          return;
                        }
                        setConfig(prev => prev ? {
                          ...prev,
                          indexers: prev.indexers.map(i => i.name === indexerName ? { ...i, zyclops: newConfig } : i)
                        } : prev);
                        // Also disable proxy and health check for this indexer (mutual exclusion)
                        setProxyIndexers(prev => ({ ...prev, [indexerName]: false }));
                        setHealthChecks(prev => ({
                          ...prev,
                          healthCheckIndexers: { ...prev.healthCheckIndexers, [indexerName]: false }
                        }));
                      });
                    }
                    setZyclopsConfirmDialog({ show: false, indexerName: '' });
                  }}
                  className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors"
                >
                  Enable Zyclops
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Single IP Confirmation Dialog */}
      {singleIpConfirmDialog.show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setSingleIpConfirmDialog({ show: false, indexerName: '' })}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-amber-500/30 shadow-2xl max-w-md w-full animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-200">Disable Single IP?</h3>
                  <p className="text-xs text-slate-400">{singleIpConfirmDialog.indexerName}</p>
                </div>
              </div>

              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                <p className="text-xs text-amber-200">
                  <strong>⚠️ Multi-IP Warning:</strong> With Single IP disabled, search requests will go through Zyclops but NZB downloads will use your own IP. The indexer will see two different IPs which may result in a ban.
                </p>
              </div>

              <p className="text-xs text-slate-400">
                Only disable this if your indexer does not enforce single-IP restrictions or you understand the risk.
              </p>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => setSingleIpConfirmDialog({ show: false, indexerName: '' })}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const indexerName = singleIpConfirmDialog.indexerName;
                    const indexer = config?.indexers.find(i => i.name === indexerName);
                    if (indexer) {
                      const newConfig = { ...(indexer.zyclops || { enabled: true }), singleIp: false };
                      apiFetch(`/api/indexers/${encodeURIComponent(indexerName)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zyclops: newConfig }),
                      }).then(() => {
                        setConfig(prev => prev ? { ...prev, indexers: prev.indexers.map(i => i.name === indexerName ? { ...i, zyclops: newConfig } : i) } : prev);
                      });
                    }
                    setSingleIpConfirmDialog({ show: false, indexerName: '' });
                  }}
                  className="px-4 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
                >
                  Disable Single IP
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// What this does:
//   Proxy configuration overlay with mode selection, HTTP proxy settings, and per-indexer proxy toggles

import { Shield, X, Server } from 'lucide-react';
import clsx from 'clsx';
import type { Config, Indexer, SyncedIndexer } from '../../types';

interface ProxyOverlayProps {
  onClose: () => void;
  config: Config | null;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  proxyMode: 'disabled' | 'http';
  setProxyMode: React.Dispatch<React.SetStateAction<'disabled' | 'http'>>;
  proxyUrl: string;
  setProxyUrl: React.Dispatch<React.SetStateAction<string>>;
  proxyStatus: 'connected' | 'disconnected' | 'checking' | null;
  proxyIp: string;
  localIp: string;
  proxyIndexers: Record<string, boolean>;
  setProxyIndexers: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  syncedIndexers: SyncedIndexer[];
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;
  checkProxyStatus: () => Promise<void>;
}

export function ProxyOverlay({
  onClose,
  config,
  setConfig,
  proxyMode,
  setProxyMode,
  proxyUrl,
  setProxyUrl,
  proxyStatus,
  proxyIp,
  localIp,
  proxyIndexers,
  setProxyIndexers,
  indexManager,
  syncedIndexers,
  failedLogos,
  setFailedLogos,
  checkProxyStatus,
}: ProxyOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="w-6 h-6 text-teal-400" />
              <h3 className="text-xl font-semibold text-slate-200">Proxy Configuration</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          {/* Proxy Mode Selector */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-3">Proxy Mode</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: 'disabled' as const, label: 'Disabled', desc: 'Direct connection', available: true },
                { value: 'http' as const, label: 'HTTP Proxy', desc: 'Recommended', available: true },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  disabled={!opt.available}
                  onClick={() => {
                    if (!opt.available) return;
                    setProxyMode(opt.value);
                    if (config) setConfig({ ...config, proxyMode: opt.value });
                  }}
                  className={clsx(
                    'flex flex-col items-center gap-1 p-3 rounded-lg border transition-all text-center',
                    !opt.available && 'opacity-40 cursor-not-allowed',
                    opt.available && proxyMode === opt.value
                      ? 'border-teal-500/50 bg-teal-500/10 text-teal-300'
                      : opt.available
                        ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-300'
                        : 'border-slate-700/50 bg-slate-800/50 text-slate-500'
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-[10px] opacity-70">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* HTTP Proxy Settings (when HTTP Proxy selected) */}
          {proxyMode === 'http' && (
            <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
              <div className="text-sm font-medium text-slate-300">HTTP Proxy</div>
              <p className="text-xs text-slate-500">Routes indexer requests through an HTTP proxy. Recommended for use with <a href="https://tailscale.com" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:text-primary-300">Tailscale</a> + <a href="https://www.squid-cache.org" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:text-primary-300">Squid</a> for a reliable and invisible exit node proxy.</p>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Proxy URL</label>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://localhost:8888"
                  className="input"
                />
              </div>
              <div className={clsx(
                "flex items-center justify-between px-3 py-2 rounded-md border",
                proxyStatus === 'connected' && "bg-green-500/10 border-green-500/30",
                proxyStatus === 'disconnected' && "bg-red-500/10 border-red-500/30",
                (proxyStatus === 'checking' || !proxyStatus) && "bg-purple-500/10 border-purple-500/30"
              )}>
                <div className="flex items-center gap-2">
                  <Server className={clsx(
                    "w-3.5 h-3.5",
                    proxyStatus === 'connected' && "text-green-400",
                    proxyStatus === 'disconnected' && "text-red-400",
                    (proxyStatus === 'checking' || !proxyStatus) && "text-purple-400"
                  )} />
                  <span className={clsx(
                    "text-xs",
                    proxyStatus === 'connected' && "text-green-400",
                    proxyStatus === 'disconnected' && "text-red-400",
                    (proxyStatus === 'checking' || !proxyStatus) && "text-slate-400"
                  )}>
                    {proxyStatus === 'checking' && 'Checking...'}
                    {proxyStatus === 'connected' && (localIp ? <><a href={`https://iplocation.net/ip-lookup?query=${localIp}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-green-300" onClick={(e) => e.stopPropagation()}>{localIp}</a> <span className="text-slate-500 mx-1">&rarr;</span> <a href={`https://iplocation.net/ip-lookup?query=${proxyIp}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-green-300" onClick={(e) => e.stopPropagation()}>{proxyIp}</a></> : <>Connected (<a href={`https://iplocation.net/ip-lookup?query=${proxyIp}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-green-300" onClick={(e) => e.stopPropagation()}>{proxyIp}</a>)</>)}
                    {proxyStatus === 'disconnected' && 'Disconnected'}
                    {!proxyStatus && 'Not tested'}
                  </span>
                </div>
                <button onClick={checkProxyStatus} className="text-xs text-primary-400 hover:text-primary-300">
                  Test
                </button>
              </div>
            </div>
          )}

          {/* Per-Indexer Proxy Toggles */}
          {proxyMode !== 'disabled' && config && ((indexManager === 'newznab' && config.indexers.length > 0) || ((indexManager === 'prowlarr' || indexManager === 'nzbhydra') && syncedIndexers.length > 0)) && (
            <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-3">
              <h4 className="text-sm font-semibold text-slate-300">Proxied Indexers</h4>
              <p className="text-xs text-slate-500">
                {indexManager === 'newznab'
                  ? 'Click to toggle. Disable for indexers that don\'t need proxying.'
                  : 'Toggle proxy per indexer. In aggregator mode, proxy applies to the service connection.'}
              </p>
              <div className="flex flex-wrap gap-3">
                {(indexManager === 'newznab' ? config.indexers : syncedIndexers).map((indexer) => {
                  const isZyclopsEnabled = 'zyclops' in indexer && (indexer as Indexer).zyclops?.enabled;
                  const isEnabled = isZyclopsEnabled ? false : proxyIndexers[indexer.name] !== false;
                  return (
                    <button
                      key={indexer.name}
                      disabled={!!isZyclopsEnabled}
                      onClick={() => {
                        if (isZyclopsEnabled) return;
                        setProxyIndexers({
                          ...proxyIndexers,
                          [indexer.name]: !isEnabled
                        });
                      }}
                      className={clsx(
                        'relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all w-16',
                        isZyclopsEnabled
                          ? 'border-violet-500/20 bg-violet-500/5 opacity-60 cursor-not-allowed'
                          : isEnabled
                            ? 'border-slate-600 bg-slate-700/50 hover:bg-slate-700'
                            : 'border-slate-700/50 bg-slate-800/80 hover:bg-slate-800 opacity-60'
                      )}
                      title={isZyclopsEnabled ? `${indexer.name} — managed by Zyclops 🤖` : `${indexer.name} — proxy ${isEnabled ? 'enabled' : 'disabled'}`}
                    >
                      <div className="relative w-10 h-10 flex items-center justify-center">
                        {indexer.logo && !failedLogos.has(indexer.logo) ? (
                          <img
                            src={indexer.logo}
                            alt={indexer.name}
                            className={clsx(
                              'w-10 h-10 rounded-lg object-contain bg-slate-700/30 p-1 transition-all',
                              !isEnabled && 'grayscale'
                            )}
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              setFailedLogos(prev => new Set(prev).add(indexer.logo!));
                            }}
                          />
                        ) : (
                          <div className={clsx(
                            'w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all',
                            isEnabled ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-500'
                          )}>
                            {indexer.name.substring(0, 2).toUpperCase()}
                          </div>
                        )}
                        {isZyclopsEnabled ? (
                          <div className="absolute -bottom-0.5 -right-0.5 text-[10px]" title="Managed by Zyclops">🤖</div>
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
        </div>
      </div>
    </div>
  );
}

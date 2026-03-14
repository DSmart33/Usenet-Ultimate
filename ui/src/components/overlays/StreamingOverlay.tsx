// What this does:
//   Streaming configuration overlay with NZBDav connection settings, stream buffer, and categories

import { Play, X, Activity } from 'lucide-react';
import clsx from 'clsx';
import type { Config } from '../../types';

interface StreamingOverlayProps {
  onClose: () => void;
  config: Config | null;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  streamingMode: 'nzbdav' | 'stremio';
  setStreamingMode: React.Dispatch<React.SetStateAction<'nzbdav' | 'stremio'>>;
  nzbdavUrl: string;
  setNzbdavUrl: React.Dispatch<React.SetStateAction<string>>;
  nzbdavApiKey: string;
  setNzbdavApiKey: React.Dispatch<React.SetStateAction<string>>;
  nzbdavWebdavUrl: string;
  setNzbdavWebdavUrl: React.Dispatch<React.SetStateAction<string>>;
  nzbdavWebdavUser: string;
  setNzbdavWebdavUser: React.Dispatch<React.SetStateAction<string>>;
  nzbdavWebdavPassword: string;
  setNzbdavWebdavPassword: React.Dispatch<React.SetStateAction<string>>;
  nzbdavMoviesCategory: string;
  setNzbdavMoviesCategory: React.Dispatch<React.SetStateAction<string>>;
  nzbdavTvCategory: string;
  setNzbdavTvCategory: React.Dispatch<React.SetStateAction<string>>;
  nzbdavStreamBufferMB: number;
  setNzbdavStreamBufferMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavConnectionStatus: 'connected' | 'disconnected' | 'unconfigured' | 'checking' | null;
  nzbdavTestNzbStatus: 'idle' | 'sending' | 'success' | 'error';
  nzbdavTestNzbMessage: string;
  checkNzbdavConnection: () => Promise<void>;
  sendNzbdavTestNzb: () => Promise<void>;
}

export function StreamingOverlay({
  onClose,
  config,
  setConfig,
  streamingMode,
  setStreamingMode,
  nzbdavUrl,
  setNzbdavUrl,
  nzbdavApiKey,
  setNzbdavApiKey,
  nzbdavWebdavUrl,
  setNzbdavWebdavUrl,
  nzbdavWebdavUser,
  setNzbdavWebdavUser,
  nzbdavWebdavPassword,
  setNzbdavWebdavPassword,
  nzbdavMoviesCategory,
  setNzbdavMoviesCategory,
  nzbdavTvCategory,
  setNzbdavTvCategory,
  nzbdavStreamBufferMB,
  setNzbdavStreamBufferMB,
  nzbdavConnectionStatus,
  nzbdavTestNzbStatus,
  nzbdavTestNzbMessage,
  checkNzbdavConnection,
  sendNzbdavTestNzb,
}: StreamingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Play className="w-6 h-6 text-purple-400" />
              <h3 className="text-xl font-semibold text-slate-200">Streaming Configuration</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Streaming Mode</label>
            <select
              value={streamingMode}
              onChange={(e) => {
                const newMode = e.target.value as 'nzbdav' | 'stremio';
                setStreamingMode(newMode);
                if (config) setConfig({ ...config, streamingMode: newMode });
              }}
              className="input flex-1 max-w-xs"
            >
              <option value="stremio" disabled>Stremio Native (Unavailable)</option>
              <option value="nzbdav">NZBDav (Hosted)</option>
            </select>
            <p className="text-xs text-slate-500 mt-2">
              <strong>NZBDav:</strong> Stream through a hosted NZBDav WebDAV server instance
            </p>
          </div>

          {streamingMode === 'nzbdav' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">NZBDav URL</label>
                <input type="text" value={nzbdavUrl} onChange={(e) => setNzbdavUrl(e.target.value)} placeholder="http://localhost:3000" className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">NZBDav API Key</label>
                <input type="password" value={nzbdavApiKey} onChange={(e) => setNzbdavApiKey(e.target.value)} placeholder="Your NZBDav API key" className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">WebDAV URL</label>
                <p className="text-xs text-slate-500 mb-1">Must be a publicly reachable URL when using direct passthrough behind a reverse proxy (e.g. Authelia)</p>
                <input type="text" value={nzbdavWebdavUrl} onChange={(e) => setNzbdavWebdavUrl(e.target.value)} placeholder="http://localhost:3000" className="input" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">WebDAV Username</label>
                  <input type="text" value={nzbdavWebdavUser} onChange={(e) => setNzbdavWebdavUser(e.target.value)} placeholder="admin" className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">WebDAV Password</label>
                  <input type="password" value={nzbdavWebdavPassword} onChange={(e) => setNzbdavWebdavPassword(e.target.value)} placeholder="password" className="input" />
                </div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-300">NZB Mount Categories</div>
                  <button
                    onClick={() => { setNzbdavMoviesCategory('Usenet-Ultimate-Movies'); setNzbdavTvCategory('Usenet-Ultimate-TV'); }}
                    className="text-xs text-primary-400 hover:text-primary-300"
                  >
                    Reset to Defaults
                  </button>
                </div>
                <p className="text-xs text-slate-500">Folder names where NZBs are stored for each content type.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Movies Folder</label>
                    <input type="text" value={nzbdavMoviesCategory} onChange={(e) => setNzbdavMoviesCategory(e.target.value)} placeholder="Usenet-Ultimate-Movies" className="input" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">TV Folder</label>
                    <input type="text" value={nzbdavTvCategory} onChange={(e) => setNzbdavTvCategory(e.target.value)} placeholder="Usenet-Ultimate-TV" className="input" />
                  </div>
                </div>
              </div>
              {/* Stream Buffer Size */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-300">Proxy Stream Buffer</div>
                  <button
                    onClick={() => setNzbdavStreamBufferMB(128)}
                    className="text-xs text-primary-400 hover:text-primary-300"
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
                    className="flex-1 accent-purple-400"
                  />
                  <span className="text-sm text-slate-300 w-16 text-right">{nzbdavStreamBufferMB} MB</span>
                </div>
                <p className="text-xs text-slate-500">
                  Internal buffer between WebDAV and the player. Larger buffers absorb network jitter but use more memory per stream. If you experience buffering on large files, try increasing this.
                </p>
              </div>
              <div className={clsx(
                "flex items-center justify-between p-4 rounded-lg border",
                nzbdavConnectionStatus === 'connected' && "bg-green-500/10 border-green-500/30",
                (nzbdavConnectionStatus === 'disconnected' || nzbdavConnectionStatus === 'unconfigured') && "bg-red-500/10 border-red-500/30",
                (nzbdavConnectionStatus === 'checking' || !nzbdavConnectionStatus) && "bg-purple-500/10 border-purple-500/30"
              )}>
                <div className="flex items-center gap-3">
                  <Activity className={clsx(
                    "w-5 h-5",
                    nzbdavConnectionStatus === 'connected' && "text-green-400",
                    (nzbdavConnectionStatus === 'disconnected' || nzbdavConnectionStatus === 'unconfigured') && "text-red-400",
                    (nzbdavConnectionStatus === 'checking' || !nzbdavConnectionStatus) && "text-purple-400"
                  )} />
                  <div>
                    <div className="font-medium text-slate-200">Connection Status</div>
                    <div className={clsx(
                      "text-sm",
                      nzbdavConnectionStatus === 'connected' && "text-green-400",
                      (nzbdavConnectionStatus === 'disconnected' || nzbdavConnectionStatus === 'unconfigured') && "text-red-400",
                      (nzbdavConnectionStatus === 'checking' || !nzbdavConnectionStatus) && "text-slate-400"
                    )}>
                      {nzbdavConnectionStatus === 'checking' && 'Checking connection...'}
                      {nzbdavConnectionStatus === 'connected' && 'Connected'}
                      {nzbdavConnectionStatus === 'disconnected' && 'Disconnected'}
                      {nzbdavConnectionStatus === 'unconfigured' && 'Not configured'}
                      {!nzbdavConnectionStatus && 'Not tested'}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={checkNzbdavConnection} className="btn text-sm">
                    Test Connection
                  </button>
                  <button
                    onClick={sendNzbdavTestNzb}
                    disabled={nzbdavTestNzbStatus === 'sending' || !nzbdavUrl}
                    className="btn text-sm"
                  >
                    {nzbdavTestNzbStatus === 'sending' ? 'Sending...' : 'Send Test NZB'}
                  </button>
                </div>
              </div>
              {nzbdavTestNzbMessage && (
                <p className={clsx('text-xs mt-2 px-4 pb-3', nzbdavTestNzbStatus === 'success' ? 'text-green-400' : 'text-red-400')}>
                  {nzbdavTestNzbMessage}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

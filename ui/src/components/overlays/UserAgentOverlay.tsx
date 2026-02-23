// What this does:
//   User-Agent configuration overlay for different request types

import { Globe, X, Search, Download, Server, FolderOpen } from 'lucide-react';
import type { UserAgents } from '../../types';

const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface UserAgentOverlayProps {
  onClose: () => void;
  userAgents: UserAgents;
  setUserAgents: React.Dispatch<React.SetStateAction<UserAgents>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function UserAgentOverlay({
  onClose,
  userAgents,
  setUserAgents,
  apiFetch,
}: UserAgentOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-6 h-6 text-indigo-400" />
              <h3 className="text-xl font-semibold text-slate-200">User-Agent Configuration</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
          <p className="text-sm text-slate-400 mt-2">Configure custom User-Agent headers for different request types</p>
        </div>
        <div className="p-4 md:p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-2">
                <Search className="w-4 h-4 text-blue-400" />
                Indexer Search Requests
              </span>
            </label>
            <input
              type="text"
              value={userAgents.indexerSearch}
              onChange={(e) => setUserAgents({ ...userAgents, indexerSearch: e.target.value })}
              className="input w-full"
              placeholder="User agent string"
            />
            <p className="text-xs text-slate-500 mt-1">Used when searching indexers (Newznab, Prowlarr, NZBHydra)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-2">
                <Download className="w-4 h-4 text-green-400" />
                NZB Download Requests
              </span>
            </label>
            <input
              type="text"
              value={userAgents.nzbDownload}
              onChange={(e) => setUserAgents({ ...userAgents, nzbDownload: e.target.value })}
              className="input w-full"
              placeholder="User agent string"
            />
            <p className="text-xs text-slate-500 mt-1">Used when downloading NZB files from indexers</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-2">
                <Server className="w-4 h-4 text-purple-400" />
                NZBDav Operations
              </span>
            </label>
            <input
              type="text"
              value={userAgents.nzbdavOperations}
              onChange={(e) => setUserAgents({ ...userAgents, nzbdavOperations: e.target.value })}
              className="input w-full"
              placeholder="User agent string"
            />
            <p className="text-xs text-slate-500 mt-1">Used for NZBDav API operations (connection tests, NZB submissions)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-orange-400" />
                WebDAV Operations
              </span>
            </label>
            <input
              type="text"
              value={userAgents.webdavOperations}
              onChange={(e) => setUserAgents({ ...userAgents, webdavOperations: e.target.value })}
              className="input w-full"
              placeholder="User agent string"
            />
            <p className="text-xs text-slate-500 mt-1">Used for WebDAV file operations and connections</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-indigo-400" />
                General Requests
              </span>
            </label>
            <input
              type="text"
              value={userAgents.general}
              onChange={(e) => setUserAgents({ ...userAgents, general: e.target.value })}
              className="input w-full"
              placeholder="User agent string"
            />
            <p className="text-xs text-slate-500 mt-1">Used for other requests (favicon proxy, etc.)</p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={async () => {
                try {
                  const response = await apiFetch('/api/user-agents/latest');
                  if (response.ok) {
                    const latestVersions = await response.json();
                    setUserAgents(latestVersions);
                  } else {
                    // Fallback to hardcoded defaults if fetch fails
                    setUserAgents({
                      indexerSearch: 'Prowlarr/2.3.0.5236 (alpine 3.22.2)',
                      nzbDownload: 'SABnzbd/4.5.5',
                      nzbdavOperations: 'SABnzbd/4.5.5',
                      webdavOperations: 'SABnzbd/4.5.5',
                      general: DEFAULT_CHROME_UA
                    });
                  }
                } catch (error) {
                  console.error('Failed to fetch latest versions:', error);
                  // Fallback to hardcoded defaults
                  setUserAgents({
                    indexerSearch: 'Prowlarr/2.3.0.5236 (alpine 3.22.2)',
                    nzbDownload: 'SABnzbd/4.5.5',
                    nzbdavOperations: 'SABnzbd/4.5.5',
                    webdavOperations: 'SABnzbd/4.5.5',
                    general: DEFAULT_CHROME_UA
                  });
                }
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

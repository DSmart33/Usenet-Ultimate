// What this does:
//   Renders the Install tab content with addon manifest URL, copy button,
//   Stremio install link, and Discord community link.

import { useState } from 'react';
import { Download, Copy, ExternalLink, XCircle } from 'lucide-react';
import clsx from 'clsx';

interface InstallTabProps {
  manifestKey: string;
  hasIndexers: boolean;
}

export function InstallTab({ manifestKey, hasIndexers }: InstallTabProps) {
  const [copied, setCopied] = useState(false);

  const manifestUrl = manifestKey
    ? `${window.location.origin}/${manifestKey}/manifest.json`
    : '';

  const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(manifestUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 animate-fade-in-up">
      {hasIndexers ? (
        <div className="card p-4 md:p-6 space-y-5">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <Download className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-lg font-bold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">Install Addon</h3>
              <p className="text-xs text-slate-400">Add Usenet Ultimate to Stremio</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Addon Manifest URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={manifestUrl}
                readOnly
                className="input flex-1 font-mono text-sm"
              />
              <button
                onClick={copyToClipboard}
                className={clsx(
                  'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-all whitespace-nowrap',
                  copied
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-slate-700/50 hover:bg-slate-700 text-slate-300 border border-slate-600/50'
                )}
              >
                <Copy className="w-4 h-4" />
                <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <a
              href={stremioUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-3 px-4 text-sm font-medium bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-white rounded-lg transition-all shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30"
            >
              <ExternalLink className="w-5 h-5" />
              Open in Stremio
            </a>
            <button
              onClick={() => window.open(manifestUrl, '_blank', 'noopener,noreferrer')}
              className="flex items-center justify-center gap-2 py-3 px-4 text-sm font-medium bg-slate-700/50 hover:bg-slate-700 text-slate-300 border border-slate-600/50 rounded-lg transition-all"
            >
              <ExternalLink className="w-5 h-5" />
              View Manifest
            </button>
          </div>

          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4">
            <h4 className="font-medium text-amber-400 mb-2 text-sm">Installation Steps:</h4>
            <ol className="text-sm text-slate-300 space-y-1 list-decimal list-inside">
              <li>Click "Open in Stremio" or copy the manifest URL</li>
              <li>Paste URL in Stremio if needed</li>
              <li>Click "Install" in Stremio</li>
              <li>Start streaming with Usenet Ultimate!</li>
            </ol>
          </div>

          <a
            href="https://discord.gg/gkwR8xyW"
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-4 p-4 rounded-lg bg-[#5865F2]/10 border border-[#5865F2]/30 hover:bg-[#5865F2]/20 hover:border-[#5865F2]/50 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center shadow-lg shadow-[#5865F2]/20 shrink-0">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-[#5865F2] group-hover:text-[#7289DA] transition-colors">Join the Discord</h4>
              <p className="text-xs text-slate-400">Get help, share feedback, and connect with the community</p>
            </div>
            <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-[#5865F2] transition-colors shrink-0" />
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-4 md:p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-6 h-6 text-amber-400" />
            </div>
            <h3 className="text-lg font-semibold text-amber-400 mb-2">Configuration Required</h3>
            <p className="text-slate-300">Configure indexers before installation</p>
          </div>

          <a
            href="https://discord.gg/gkwR8xyW"
            target="_blank"
            rel="noopener noreferrer"
            className="card group flex items-center gap-4 p-4 bg-[#5865F2]/10 border border-[#5865F2]/30 hover:bg-[#5865F2]/20 hover:border-[#5865F2]/50 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center shadow-lg shadow-[#5865F2]/20 shrink-0">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-[#5865F2] group-hover:text-[#7289DA] transition-colors">Join the Discord</h4>
              <p className="text-xs text-slate-400">Get help, share feedback, and connect with the community</p>
            </div>
            <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-[#5865F2] transition-colors shrink-0" />
          </a>
        </div>
      )}
    </div>
  );
}

export default InstallTab;

// What this does:
//   Confirmation dialog shown when the user enables direct streaming mode.
//   Direct mode redirects the player to a WebDAV URL with credentials embedded,
//   so the modal lists the two best practices that mitigate that exposure.

import { AlertTriangle } from 'lucide-react';

interface DirectModeWarningModalProps {
  directModeWarning: { show: boolean };
  setDirectModeWarning: React.Dispatch<React.SetStateAction<{ show: boolean }>>;
  handleEnableDirectMode: () => void;
}

export function DirectModeWarningModal({ directModeWarning, setDirectModeWarning, handleEnableDirectMode }: DirectModeWarningModalProps) {
  if (!directModeWarning.show) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-md w-full p-4 md:p-6 animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
          </div>
          <h3 className="text-xl font-semibold text-slate-200">Direct Mode - Best Practices</h3>
        </div>
        <p className="text-slate-300 mb-3">
          Direct mode redirects the player straight to the WebDAV URL with WebDAV credentials embedded.
        </p>
        <p className="text-slate-300 mb-2">If your NzbDAV is accessible remotely, you'll want to follow the following best practices:</p>
        <ol className="text-sm text-slate-400 list-decimal list-inside space-y-1 mb-6">
          <li>Use different credentials for your NzbDAV admin login and WebDAV user.</li>
          <li>Keep NzbDAV's "Enforce Read Only" WebDAV option on (this is the default).</li>
        </ol>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setDirectModeWarning({ show: false })}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-300 hover:bg-slate-700/60 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleEnableDirectMode}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1.5 transition-colors"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Enable Direct Mode
          </button>
        </div>
      </div>
    </div>
  );
}

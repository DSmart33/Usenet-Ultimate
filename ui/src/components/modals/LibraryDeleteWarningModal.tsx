// What this does:
//   Confirmation dialog shown when the user enables either of the two
//   library-delete stream-tile toggles. The tiles trigger destructive WebDAV
//   DELETE operations, so the modal lists the prerequisites the user needs
//   to satisfy on their NzbDAV instance before turning the feature on.

import { AlertTriangle } from 'lucide-react';

export type LibraryDeleteToggleType = 'all' | 'perStream';

interface LibraryDeleteWarningModalProps {
  libraryDeleteWarning: { show: boolean; toggleType: LibraryDeleteToggleType | null };
  setLibraryDeleteWarning: React.Dispatch<React.SetStateAction<{ show: boolean; toggleType: LibraryDeleteToggleType | null }>>;
  handleEnableLibraryDelete: () => void;
}

export function LibraryDeleteWarningModal({ libraryDeleteWarning, setLibraryDeleteWarning, handleEnableLibraryDelete }: LibraryDeleteWarningModalProps) {
  if (!libraryDeleteWarning.show) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-md w-full p-4 md:p-6 animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
          </div>
          <h3 className="text-xl font-semibold text-slate-200">How To Enable Stream Delete Tiles</h3>
        </div>
        <p className="text-slate-300 mb-3">
          Follow these instructions to safely enable this feature.
        </p>
        <ol className="text-sm text-slate-400 list-decimal list-inside space-y-2 mb-6">
          <li>Ensure your NzbDAV instance is not publicly exposed.</li>
          <li>
            Disable "Enforce Read-Only" in NzbDAV
            <ol className="list-decimal list-inside pl-5 mt-1 space-y-0.5 text-slate-400/90">
              <li>Go to settings</li>
              <li>Select WebDAV</li>
              <li>Scroll down and turn off the "Enforce Read-Only" checkbox</li>
              <li>Click "Save" at the bottom</li>
            </ol>
          </li>
        </ol>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setLibraryDeleteWarning({ show: false, toggleType: null })}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-300 hover:bg-slate-700/60 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleEnableLibraryDelete}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1.5 transition-colors"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

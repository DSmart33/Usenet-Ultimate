// What this does:
//   Confirmation dialog for deleting an indexer

import { XCircle, X, Trash2 } from 'lucide-react';

interface DeleteConfirmModalProps {
  deleteConfirmation: { show: boolean; indexerName: string };
  setDeleteConfirmation: React.Dispatch<React.SetStateAction<{ show: boolean; indexerName: string }>>;
  handleDeleteIndexer: (name: string) => void;
}

export function DeleteConfirmModal({ deleteConfirmation, setDeleteConfirmation, handleDeleteIndexer }: DeleteConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-md w-full p-4 md:p-6 animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center">
            <XCircle className="w-6 h-6 text-red-400" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-slate-200">Delete Indexer</h3>
            <p className="text-sm text-slate-400">This action cannot be undone</p>
          </div>
        </div>
        <p className="text-slate-300 mb-6">
          Are you sure you want to delete <span className="font-semibold text-primary-400">{deleteConfirmation.indexerName}</span>?
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setDeleteConfirmation({ show: false, indexerName: '' })}
            className="btn flex-1 flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
          <button
            onClick={() => handleDeleteIndexer(deleteConfirmation.indexerName)}
            className="btn flex-1 flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

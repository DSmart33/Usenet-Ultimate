// What this does:
//   Modal for editing an existing indexer with capability discovery and test search

import { useEffect } from 'react';
import { Settings, X, Eye, EyeOff, Search, CheckCircle, XCircle, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { Config, IndexerCaps, EditIndexerForm } from '../../types';

interface EditIndexerModalProps {
  onClose: () => void;
  expandedIndexer: string;
  editForm: EditIndexerForm;
  setEditForm: React.Dispatch<React.SetStateAction<EditIndexerForm>>;
  showApiKey: { new: boolean; edit: boolean };
  setShowApiKey: React.Dispatch<React.SetStateAction<{ new: boolean; edit: boolean }>>;
  capsLoading: 'new' | 'edit' | null;
  config: Config | null;
  testResults: Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>;
  setTestResults: React.Dispatch<React.SetStateAction<Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>>>;
  testQuery: Record<string, string>;
  setTestQuery: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  discoverCaps: (url: string, apiKey: string, target: 'new' | 'edit') => void;
  getAvailableMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  renderMethodLabel: (m: { value: string; label: string }) => React.ReactNode;
  handleTestIndexer: (indexerName: string) => void;
  setDeleteConfirmation: React.Dispatch<React.SetStateAction<{ show: boolean; indexerName: string }>>;
  setExpandedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
}

export function EditIndexerModal({
  onClose,
  expandedIndexer,
  editForm,
  setEditForm,
  showApiKey,
  setShowApiKey,
  capsLoading,
  config,
  testResults,
  setTestResults,
  testQuery,
  setTestQuery,
  discoverCaps,
  getAvailableMovieMethods,
  getAvailableTvMethods,
  renderMethodLabel,
  handleTestIndexer,
  setDeleteConfirmation,
  setExpandedIndexer,
}: EditIndexerModalProps) {
  const currentIndexer = config?.indexers.find(i => i.name === expandedIndexer);
  const zyclopsActive = currentIndexer?.zyclops?.enabled === true;

  // Clear test state when modal unmounts
  useEffect(() => {
    return () => {
      setTestResults(prev => { const next = { ...prev }; delete next[expandedIndexer]; return next; });
      setTestQuery(prev => { const next = { ...prev }; delete next[expandedIndexer]; return next; });
    };
  }, [expandedIndexer, setTestResults, setTestQuery]);

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Settings className="w-6 h-6 text-blue-400" />
              <h3 className="text-xl font-semibold text-slate-200">Edit Indexer</h3>
            </div>
            <button
              onClick={() => onClose()}
              className="text-slate-400 hover:text-slate-200 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          {zyclopsActive && (
            <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg p-3">
              <p className="text-xs text-violet-300">
                <span className="font-semibold">🤖 Zyclops Active</span> — Name, URL, enabled status, and test search are locked while Zyclops is enabled. Disable Zyclops first to change these settings.
              </p>
            </div>
          )}
          <div>
            <label className="block text-sm text-slate-400 mb-2">Name</label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
              disabled={zyclopsActive}
              className={clsx('input', zyclopsActive && 'opacity-50 cursor-not-allowed')}
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-2">URL</label>
            <input
              type="text"
              value={editForm.url}
              onChange={(e) => setEditForm(prev => ({ ...prev, url: e.target.value }))}
              disabled={zyclopsActive}
              className={clsx('input', zyclopsActive && 'opacity-50 cursor-not-allowed')}
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-2">API Key</label>
            <div className="relative">
              <input
                type={showApiKey.edit ? "text" : "password"}
                value={editForm.apiKey}
                onChange={(e) => setEditForm(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder="Leave blank to keep current"
                className="input pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(prev => ({ ...prev, edit: !prev.edit }))}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors"
              >
                {showApiKey.edit ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-enabled"
              checked={editForm.enabled}
              onChange={(e) => setEditForm(prev => ({ ...prev, enabled: e.target.checked }))}
              disabled={zyclopsActive}
              className={clsx('w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500', zyclopsActive && 'opacity-50 cursor-not-allowed')}
            />
            <label htmlFor="edit-enabled" className={clsx('text-sm text-slate-300', zyclopsActive && 'opacity-50')}>
              Enabled {zyclopsActive && '(managed by Zyclops)'}
            </label>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edit-pagination"
                checked={editForm.pagination}
                onChange={(e) => setEditForm(prev => ({ ...prev, pagination: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500"
              />
              <label htmlFor="edit-pagination" className="flex-1 cursor-pointer">
                <span className="text-sm text-slate-300">Paginated search</span>
                <span className="text-xs text-slate-500 ml-2">Fetch additional pages of results when available</span>
              </label>
            </div>
            {editForm.pagination && (
              <div className="pl-6 flex items-center gap-2">
                <label className="text-xs text-slate-400">Max extra pages</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={editForm.maxPages}
                  onChange={(e) => setEditForm(prev => ({ ...prev, maxPages: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) }))}
                  onFocus={(e) => e.target.select()}
                  className="input w-20 text-sm"
                />
              </div>
            )}
          </div>

          {/* Search Method (per-indexer) */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 mt-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-300">Search Method</div>
              <button
                onClick={() => discoverCaps(editForm.url, editForm.apiKey || config?.indexers.find(i => i.name === expandedIndexer)?.apiKey || '', 'edit')}
                disabled={capsLoading === 'edit'}
                className="text-xs text-primary-400 hover:text-primary-300 transition-colors disabled:opacity-50"
              >
                {capsLoading === 'edit' ? 'Discovering...' : editForm.caps ? 'Re-discover' : 'Discover Capabilities'}
              </button>
            </div>
            {editForm.caps && (
              <p className="text-xs text-green-400/70">
                Capabilities: Movie [{editForm.caps.movieSearchParams.join(', ')}] TV [{editForm.caps.tvSearchParams.join(', ')}]
              </p>
            )}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Movies</label>
              <div className="flex flex-wrap gap-3">
                {getAvailableMovieMethods(editForm.caps).map(m => (
                  <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.movieSearchMethod.includes(m.value)}
                      onChange={(e) => setEditForm(prev => {
                        const updated = e.target.checked
                          ? [...prev.movieSearchMethod, m.value]
                          : prev.movieSearchMethod.filter(v => v !== m.value);
                        return { ...prev, movieSearchMethod: updated.length > 0 ? updated : prev.movieSearchMethod };
                      })}
                      className="accent-blue-500"
                    />
                    {renderMethodLabel(m)}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">TV Shows</label>
              <div className="flex flex-wrap gap-3">
                {getAvailableTvMethods(editForm.caps).map(m => (
                  <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.tvSearchMethod.includes(m.value)}
                      onChange={(e) => setEditForm(prev => {
                        const updated = e.target.checked
                          ? [...prev.tvSearchMethod, m.value]
                          : prev.tvSearchMethod.filter(v => v !== m.value);
                        return { ...prev, tvSearchMethod: updated.length > 0 ? updated : prev.tvSearchMethod };
                      })}
                      className="accent-blue-500"
                    />
                    {renderMethodLabel(m)}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Test Search */}
          <div className={clsx("border-t border-slate-700/50 pt-4 mt-4", zyclopsActive && "opacity-50 pointer-events-none")}>
            <label className="block text-sm text-slate-400 mb-2">Test Search</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={testQuery[expandedIndexer] || ''}
                onChange={(e) => setTestQuery(prev => ({ ...prev, [expandedIndexer]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !testResults[expandedIndexer]?.loading) {
                    handleTestIndexer(expandedIndexer);
                  }
                }}
                placeholder="Enter search query"
                className="input flex-1"
              />
              <button
                onClick={() => handleTestIndexer(expandedIndexer)}
                disabled={testResults[expandedIndexer]?.loading}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {testResults[expandedIndexer]?.loading ? (
                  <Settings className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                Test
              </button>
            </div>
            {testResults[expandedIndexer] && !testResults[expandedIndexer].loading && (
              <div className={clsx(
                "mt-2 p-3 rounded-lg text-sm",
                testResults[expandedIndexer].success
                  ? "bg-green-500/10 border border-green-500/30 text-green-400"
                  : "bg-red-500/10 border border-red-500/30 text-red-400"
              )}>
                <div className="flex items-start gap-2">
                  {testResults[expandedIndexer].success ? (
                    <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium break-words">{testResults[expandedIndexer].message}</div>
                    {testResults[expandedIndexer].success && testResults[expandedIndexer].results !== undefined && (
                      <div className="text-xs mt-1 opacity-80">
                        Found {testResults[expandedIndexer].results} result{testResults[expandedIndexer].results !== 1 ? 's' : ''}
                      </div>
                    )}
                    {testResults[expandedIndexer].titles && testResults[expandedIndexer].titles!.length > 0 && (
                      <div className="text-xs mt-2 space-y-1 opacity-80">
                        <div className="font-medium">Sample results:</div>
                        {testResults[expandedIndexer].titles!.slice(0, 3).map((title, i) => (
                          <div key={i} className="break-words">• {title}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                setDeleteConfirmation({ show: true, indexerName: expandedIndexer });
                setExpandedIndexer(null);
              }}
              className="btn flex items-center justify-center gap-2 px-4 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

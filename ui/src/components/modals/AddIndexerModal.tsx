// What this does:
//   Modal for adding a new indexer with preset selection, capability discovery, and test search

import { useEffect, useRef } from 'react';
import { Plus, X, Eye, EyeOff, Settings, Search, CheckCircle, XCircle, Save } from 'lucide-react';
import clsx from 'clsx';
import indexerPresets from '../../indexerPresets.json';
import type { IndexerCaps, IndexerPreset, NewIndexerForm } from '../../types';
import { normalizeNewznabUrl } from '../../utils/normalizeNewznabUrl';

const INDEXER_PRESETS: IndexerPreset[] = indexerPresets;

interface AddIndexerModalProps {
  onClose: () => void;
  newIndexer: NewIndexerForm;
  setNewIndexer: React.Dispatch<React.SetStateAction<NewIndexerForm>>;
  selectedPreset: string;
  setSelectedPreset: React.Dispatch<React.SetStateAction<string>>;
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;
  showApiKey: { new: boolean; edit: boolean };
  setShowApiKey: React.Dispatch<React.SetStateAction<{ new: boolean; edit: boolean }>>;
  capsLoading: 'new' | 'edit' | null;
  testResults: Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>;
  setTestResults: React.Dispatch<React.SetStateAction<Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>>>;
  testQuery: Record<string, string>;
  setTestQuery: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  handlePresetChange: (presetName: string) => void;
  discoverCaps: (url: string, apiKey: string, target: 'new' | 'edit') => void;
  getAvailableMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableAnimeMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableAnimeTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  renderMethodLabel: (m: { value: string; label: string }) => React.ReactNode;
  handleTestIndexer: (indexerName: string) => void;
  handleAddIndexer: () => void;
}

export function AddIndexerModal({
  onClose,
  newIndexer,
  setNewIndexer,
  selectedPreset,
  setSelectedPreset,
  failedLogos,
  setFailedLogos,
  showApiKey,
  setShowApiKey,
  capsLoading,
  testResults,
  setTestResults,
  testQuery,
  setTestQuery,
  handlePresetChange,
  discoverCaps,
  getAvailableMovieMethods,
  getAvailableTvMethods,
  getAvailableAnimeMovieMethods,
  getAvailableAnimeTvMethods,
  renderMethodLabel,
  handleTestIndexer,
  handleAddIndexer,
}: AddIndexerModalProps) {
  // Auto-discover capabilities when URL + API key are both filled (debounced)
  const prevAutoDiscoverKey = useRef('');
  useEffect(() => {
    if (!newIndexer.url || !newIndexer.apiKey || newIndexer.caps || capsLoading === 'new') return;
    const key = `${newIndexer.url}:${newIndexer.apiKey}`;
    if (prevAutoDiscoverKey.current === key) return;
    const timer = setTimeout(() => {
      prevAutoDiscoverKey.current = key;
      discoverCaps(newIndexer.url, newIndexer.apiKey, 'new');
    }, 500);
    return () => clearTimeout(timer);
  }, [newIndexer.url, newIndexer.apiKey, newIndexer.caps, capsLoading, discoverCaps]);

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => {
      onClose();
      setNewIndexer({ name: '', url: '', apiKey: '', website: '', logo: '', movieSearchMethod: ['text'], tvSearchMethod: ['text'], animeMovieSearchMethod: ['text'], animeTvSearchMethod: ['text'], caps: null, pagination: false, maxPages: 3 });
      setSelectedPreset('');
      setTestResults(prev => { const next = { ...prev }; delete next['__new__']; return next; });
      setTestQuery(prev => { const next = { ...prev }; delete next['__new__']; return next; });
    }}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Plus className="w-6 h-6 text-primary-400" />
              <h3 className="text-xl font-semibold text-slate-200">Add New Indexer</h3>
            </div>
            <button
              onClick={() => {
                onClose();
                setNewIndexer({ name: '', url: '', apiKey: '', website: '', logo: '', movieSearchMethod: ['text'], tvSearchMethod: ['text'], animeMovieSearchMethod: ['text'], animeTvSearchMethod: ['text'], caps: null, pagination: false, maxPages: 3 });
                setSelectedPreset('');
                setTestResults(prev => { const next = { ...prev }; delete next['__new__']; return next; });
                setTestQuery(prev => { const next = { ...prev }; delete next['__new__']; return next; });
              }}
              className="text-slate-400 hover:text-slate-200 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-2">Select Indexer</label>
            <div className="relative">
              {selectedPreset && selectedPreset !== 'Custom' && INDEXER_PRESETS.find(p => p.name === selectedPreset)?.logo && !failedLogos.has(INDEXER_PRESETS.find(p => p.name === selectedPreset)?.logo || '') && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                  <img
                    src={INDEXER_PRESETS.find(p => p.name === selectedPreset)?.logo}
                    alt=""
                    className="w-5 h-5 rounded object-contain"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      const logoUrl = INDEXER_PRESETS.find(p => p.name === selectedPreset)?.logo;
                      if (logoUrl) setFailedLogos(prev => new Set(prev).add(logoUrl));
                    }}
                  />
                </div>
              )}
              <select
                value={selectedPreset}
                onChange={(e) => handlePresetChange(e.target.value)}
                className={clsx("input", selectedPreset && selectedPreset !== 'Custom' && "pl-12")}
              >
                <option value="">Choose a preset or custom...</option>
                {INDEXER_PRESETS.map(preset => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-2">Name</label>
            <input
              type="text"
              value={newIndexer.name}
              onChange={(e) => setNewIndexer(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., My Indexer"
              className="input"
              disabled={selectedPreset !== '' && selectedPreset !== 'Custom'}
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-2">URL</label>
            <input
              type="text"
              value={newIndexer.url}
              onChange={(e) => setNewIndexer(prev => ({ ...prev, url: e.target.value }))}
              onBlur={() => setNewIndexer(prev => ({ ...prev, url: normalizeNewznabUrl(prev.url) }))}
              placeholder="https://api.indexer.com/api"
              className="input"
              disabled={selectedPreset !== '' && selectedPreset !== 'Custom'}
            />
          </div>
          <div>
            {selectedPreset && selectedPreset !== 'Custom' && INDEXER_PRESETS.find(p => p.name === selectedPreset)?.website ? (
              <label className="block text-sm mb-2">
                <a
                  href={INDEXER_PRESETS.find(p => p.name === selectedPreset)?.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 hover:text-primary-300 transition-colors font-semibold cursor-pointer"
                >
                  API Key
                </a>
              </label>
            ) : (
              <label className="block text-sm text-slate-400 mb-2">API Key</label>
            )}
            <div className="relative">
              <input
                type={showApiKey.new ? "text" : "password"}
                value={newIndexer.apiKey}
                onChange={(e) => setNewIndexer(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder="Your API key"
                className="input pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(prev => ({ ...prev, new: !prev.new }))}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors"
              >
                {showApiKey.new ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Search Method (per-indexer, shown after URL + API key entered) */}
          {newIndexer.url && newIndexer.apiKey && (
            <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-300">Search Method</div>
                <button
                  onClick={() => discoverCaps(newIndexer.url, newIndexer.apiKey, 'new')}
                  disabled={capsLoading === 'new'}
                  className="text-xs text-primary-400 hover:text-primary-300 transition-colors disabled:opacity-50"
                >
                  {capsLoading === 'new' ? 'Discovering...' : newIndexer.caps ? 'Re-discover' : 'Discover Capabilities'}
                </button>
              </div>
              {!newIndexer.caps && capsLoading !== 'new' && (
                <p className="text-xs text-slate-500">Click "Discover Capabilities" to detect supported search methods, or select manually.</p>
              )}
              {newIndexer.caps && (
                <p className="text-xs text-green-400/70">
                  Capabilities discovered: Movie [{newIndexer.caps.movieSearchParams.join(', ')}] TV [{newIndexer.caps.tvSearchParams.join(', ')}]
                </p>
              )}
              <div>
                <label className="block text-xs text-slate-400 mb-1">Movies</label>
                <div className="flex flex-wrap gap-3">
                  {getAvailableMovieMethods(newIndexer.caps).map(m => (
                    <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newIndexer.movieSearchMethod.includes(m.value)}
                        onChange={(e) => setNewIndexer(prev => {
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
                  {getAvailableTvMethods(newIndexer.caps).map(m => (
                    <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newIndexer.tvSearchMethod.includes(m.value)}
                        onChange={(e) => setNewIndexer(prev => {
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
              <div>
                <label className="block text-xs text-slate-400 mb-1">Anime Movies</label>
                <div className="flex flex-wrap gap-3">
                  {getAvailableAnimeMovieMethods(newIndexer.caps).map(m => (
                    <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newIndexer.animeMovieSearchMethod.includes(m.value)}
                        onChange={(e) => setNewIndexer(prev => {
                          const updated = e.target.checked
                            ? [...prev.animeMovieSearchMethod, m.value]
                            : prev.animeMovieSearchMethod.filter(v => v !== m.value);
                          return { ...prev, animeMovieSearchMethod: updated.length > 0 ? updated : prev.animeMovieSearchMethod };
                        })}
                        className="accent-blue-500"
                      />
                      {renderMethodLabel(m)}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Anime TV Shows</label>
                <div className="flex flex-wrap gap-3">
                  {getAvailableAnimeTvMethods(newIndexer.caps).map(m => (
                    <label key={m.value} className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newIndexer.animeTvSearchMethod.includes(m.value)}
                        onChange={(e) => setNewIndexer(prev => {
                          const updated = e.target.checked
                            ? [...prev.animeTvSearchMethod, m.value]
                            : prev.animeTvSearchMethod.filter(v => v !== m.value);
                          return { ...prev, animeTvSearchMethod: updated.length > 0 ? updated : prev.animeTvSearchMethod };
                        })}
                        className="accent-blue-500"
                      />
                      {renderMethodLabel(m)}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Test Search */}
          {newIndexer.name && newIndexer.url && newIndexer.apiKey && (
            <div className="border-t border-slate-700/50 pt-4">
              <label className="block text-sm text-slate-400 mb-2">Test Search</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={testQuery['__new__'] || ''}
                  onChange={(e) => setTestQuery(prev => ({ ...prev, '__new__': e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !testResults['__new__']?.loading && newIndexer.name && newIndexer.url && newIndexer.apiKey) {
                      handleTestIndexer('__new__');
                    }
                  }}
                  placeholder="Enter search query"
                  className="input flex-1"
                />
                <button
                  onClick={() => handleTestIndexer('__new__')}
                  disabled={testResults['__new__']?.loading}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  {testResults['__new__']?.loading ? (
                    <Settings className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  Test
                </button>
              </div>
              {testResults['__new__'] && !testResults['__new__'].loading && (
                <div className={clsx(
                  "mt-2 p-3 rounded-lg text-sm",
                  testResults['__new__'].success
                    ? "bg-green-500/10 border border-green-500/30 text-green-400"
                    : "bg-red-500/10 border border-red-500/30 text-red-400"
                )}>
                  <div className="flex items-start gap-2">
                    {testResults['__new__'].success ? (
                      <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium break-words">{testResults['__new__'].message}</div>
                      {testResults['__new__'].success && testResults['__new__'].results !== undefined && (
                        <div className="text-xs mt-1 opacity-80">
                          Found {testResults['__new__'].results} result{testResults['__new__'].results !== 1 ? 's' : ''}
                        </div>
                      )}
                      {testResults['__new__'].titles && testResults['__new__'].titles!.length > 0 && (
                        <div className="text-xs mt-2 space-y-1 opacity-80">
                          <div className="font-medium">Sample results:</div>
                          {testResults['__new__'].titles!.slice(0, 3).map((title, i) => (
                            <div key={i} className="break-words">• {title}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleAddIndexer}
            disabled={!newIndexer.name || !newIndexer.url || !newIndexer.apiKey}
            className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            Add Indexer
          </button>
        </div>
      </div>
    </div>
  );
}

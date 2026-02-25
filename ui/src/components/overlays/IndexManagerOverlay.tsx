// What this does:
//   Indexer management overlay — manages Newznab indexers, Prowlarr/NZBHydra sync,
//   search settings (TMDB/TVDB keys, season packs, anime), EasyNews, and indexer priority dedup.

import {
  Database,
  X,
  Crown,
  Zap,
  Filter,
  Search,
  ExternalLink,
  Eye,
  EyeOff,
  Activity,
  Loader2,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Plus,
  Settings,
} from 'lucide-react';
import clsx from 'clsx';
import type { Config, Indexer, SyncedIndexer, IndexerCaps } from '../../types';

interface IndexManagerOverlayProps {
  onClose: () => void;
  config: Config | null;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  setIndexManager: React.Dispatch<React.SetStateAction<'newznab' | 'prowlarr' | 'nzbhydra'>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;

  // Search settings
  tmdbApiKey: string;
  setTmdbApiKey: React.Dispatch<React.SetStateAction<string>>;
  tvdbApiKey: string;
  setTvdbApiKey: React.Dispatch<React.SetStateAction<string>>;
  showTmdbKey: boolean;
  setShowTmdbKey: React.Dispatch<React.SetStateAction<boolean>>;
  showTvdbKey: boolean;
  setShowTvdbKey: React.Dispatch<React.SetStateAction<boolean>>;
  tmdbKeyStatus: 'idle' | 'testing' | 'valid' | 'invalid';
  setTmdbKeyStatus: React.Dispatch<React.SetStateAction<'idle' | 'testing' | 'valid' | 'invalid'>>;
  tvdbKeyStatus: 'idle' | 'testing' | 'valid' | 'invalid';
  setTvdbKeyStatus: React.Dispatch<React.SetStateAction<'idle' | 'testing' | 'valid' | 'invalid'>>;
  testTmdbKey: () => void;
  testTvdbKey: () => void;

  // Season packs
  includeSeasonPacks: boolean;
  setIncludeSeasonPacks: React.Dispatch<React.SetStateAction<boolean>>;
  seasonPackPagination: boolean;
  setSeasonPackPagination: React.Dispatch<React.SetStateAction<boolean>>;
  seasonPackAdditionalPages: number;
  setSeasonPackAdditionalPages: React.Dispatch<React.SetStateAction<number>>;

  // Anime
  useTextSearchForAnime: boolean;
  setUseTextSearchForAnime: React.Dispatch<React.SetStateAction<boolean>>;
  skipAnimeTitleResolve: boolean;
  setSkipAnimeTitleResolve: React.Dispatch<React.SetStateAction<boolean>>;

  // Indexer priority dedup
  indexerPriorityDedup: boolean;
  setIndexerPriorityDedup: React.Dispatch<React.SetStateAction<boolean>>;
  indexerPriority: string[];
  setIndexerPriority: React.Dispatch<React.SetStateAction<string[]>>;
  dedupDraggedItem: string | null;
  setDedupDraggedItem: React.Dispatch<React.SetStateAction<string | null>>;
  dedupDragOverItem: string | null;
  setDedupDragOverItem: React.Dispatch<React.SetStateAction<string | null>>;
  easynewsEnabled: boolean;

  // EasyNews
  setEasynewsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  easynewsUsername: string;
  setEasynewsUsername: React.Dispatch<React.SetStateAction<string>>;
  easynewsPassword: string;
  setEasynewsPassword: React.Dispatch<React.SetStateAction<string>>;
  easynewsPagination: boolean;
  setEasynewsPagination: React.Dispatch<React.SetStateAction<boolean>>;
  easynewsMaxPages: number;
  setEasynewsMaxPages: React.Dispatch<React.SetStateAction<number>>;
  easynewsMode: 'ddl' | 'nzb';
  setEasynewsMode: React.Dispatch<React.SetStateAction<'ddl' | 'nzb'>>;
  easynewsHealthCheck: boolean;
  setEasynewsHealthCheck: React.Dispatch<React.SetStateAction<boolean>>;
  showEasynewsPassword: boolean;
  setShowEasynewsPassword: React.Dispatch<React.SetStateAction<boolean>>;
  easynewsTestStatus: 'idle' | 'testing' | 'success' | 'error';
  setEasynewsTestStatus: React.Dispatch<React.SetStateAction<'idle' | 'testing' | 'success' | 'error'>>;
  easynewsTestMessage: string;
  setEasynewsTestMessage: React.Dispatch<React.SetStateAction<string>>;

  // Prowlarr
  prowlarrUrl: string;
  setProwlarrUrl: React.Dispatch<React.SetStateAction<string>>;
  prowlarrApiKey: string;
  setProwlarrApiKey: React.Dispatch<React.SetStateAction<string>>;
  showProwlarrKey: boolean;
  setShowProwlarrKey: React.Dispatch<React.SetStateAction<boolean>>;

  // NZBHydra
  nzbhydraUrl: string;
  setNzbhydraUrl: React.Dispatch<React.SetStateAction<string>>;
  nzbhydraApiKey: string;
  setNzbhydraApiKey: React.Dispatch<React.SetStateAction<string>>;
  showNzbhydraKey: boolean;
  setShowNzbhydraKey: React.Dispatch<React.SetStateAction<boolean>>;

  // Sync state
  syncedIndexers: SyncedIndexer[];
  setSyncedIndexers: React.Dispatch<React.SetStateAction<SyncedIndexer[]>>;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error';
  setSyncStatus: React.Dispatch<React.SetStateAction<'idle' | 'syncing' | 'success' | 'error'>>;
  syncMessage: string;
  setSyncMessage: React.Dispatch<React.SetStateAction<string>>;
  selectedSyncedIndexer: string | null;
  setSelectedSyncedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  connectionTestStatus: 'idle' | 'testing' | 'success' | 'error';
  setConnectionTestStatus: React.Dispatch<React.SetStateAction<'idle' | 'testing' | 'success' | 'error'>>;
  connectionTestMessage: string;
  setConnectionTestMessage: React.Dispatch<React.SetStateAction<string>>;
  handleReorderSyncedIndexer: (id: string, direction: 'up' | 'down') => void;

  // Failed logos
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Helper functions for search methods
  getAvailableMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  renderMethodLabel: (m: { value: string; label: string }) => React.ReactNode;

  // Newznab indexer management
  setShowAddIndexer: React.Dispatch<React.SetStateAction<boolean>>;
  expandedIndexer: string | null;
  setExpandedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  draggedIndexer: string | null;
  setDraggedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  dragOverIndexer: string | null;
  setDragOverIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  pendingSave: boolean;
  testResults: Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>;
  handleDragReorder: (draggedName: string, targetName: string) => Indexer[] | null;
  saveIndexerOrder: (indexers: Indexer[]) => Promise<void>;
  startEdit: (indexer: Indexer) => void;
  handleReorderIndexer: (name: string, direction: 'up' | 'down') => void;
  fetchIndexers: () => Promise<void>;
}

export function IndexManagerOverlay({
  onClose,
  config,
  setConfig,
  indexManager,
  setIndexManager,
  apiFetch,
  tmdbApiKey,
  setTmdbApiKey,
  tvdbApiKey,
  setTvdbApiKey,
  showTmdbKey,
  setShowTmdbKey,
  showTvdbKey,
  setShowTvdbKey,
  tmdbKeyStatus,
  setTmdbKeyStatus,
  tvdbKeyStatus,
  setTvdbKeyStatus,
  testTmdbKey,
  testTvdbKey,
  includeSeasonPacks,
  setIncludeSeasonPacks,
  seasonPackPagination,
  setSeasonPackPagination,
  seasonPackAdditionalPages,
  setSeasonPackAdditionalPages,
  useTextSearchForAnime,
  setUseTextSearchForAnime,
  skipAnimeTitleResolve,
  setSkipAnimeTitleResolve,
  indexerPriorityDedup,
  setIndexerPriorityDedup,
  indexerPriority,
  setIndexerPriority,
  dedupDraggedItem,
  setDedupDraggedItem,
  dedupDragOverItem,
  setDedupDragOverItem,
  easynewsEnabled,
  setEasynewsEnabled,
  easynewsUsername,
  setEasynewsUsername,
  easynewsPassword,
  setEasynewsPassword,
  easynewsPagination,
  setEasynewsPagination,
  easynewsMaxPages,
  setEasynewsMaxPages,
  easynewsMode,
  setEasynewsMode,
  easynewsHealthCheck,
  setEasynewsHealthCheck,
  showEasynewsPassword,
  setShowEasynewsPassword,
  easynewsTestStatus,
  setEasynewsTestStatus,
  easynewsTestMessage,
  setEasynewsTestMessage,
  prowlarrUrl,
  setProwlarrUrl,
  prowlarrApiKey,
  setProwlarrApiKey,
  showProwlarrKey,
  setShowProwlarrKey,
  nzbhydraUrl,
  setNzbhydraUrl,
  nzbhydraApiKey,
  setNzbhydraApiKey,
  showNzbhydraKey,
  setShowNzbhydraKey,
  syncedIndexers,
  setSyncedIndexers,
  syncStatus,
  setSyncStatus,
  syncMessage,
  setSyncMessage,
  selectedSyncedIndexer,
  setSelectedSyncedIndexer,
  connectionTestStatus,
  setConnectionTestStatus,
  connectionTestMessage,
  setConnectionTestMessage,
  handleReorderSyncedIndexer,
  failedLogos,
  setFailedLogos,
  getAvailableMovieMethods,
  getAvailableTvMethods,
  renderMethodLabel,
  setShowAddIndexer,
  expandedIndexer,
  setExpandedIndexer,
  draggedIndexer,
  setDraggedIndexer,
  dragOverIndexer,
  setDragOverIndexer,
  pendingSave,
  testResults,
  handleDragReorder,
  saveIndexerOrder,
  startEdit,
  handleReorderIndexer,
  fetchIndexers,
}: IndexManagerOverlayProps) {
  /** Reset all sync-related UI state (called when credentials change or manager switches) */
  const resetSyncState = () => {
    setSyncedIndexers([]);
    setSelectedSyncedIndexer(null);
    setSyncStatus('idle');
    setSyncMessage('');
    setConnectionTestStatus('idle');
    setConnectionTestMessage('');
  };

  return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Database className="w-6 h-6 text-blue-400" />
                  <h3 className="text-xl font-semibold text-slate-200">Indexer Management</h3>
                </div>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>
            <div className="p-4 md:p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Manager Type</label>
                <select
                  value={indexManager}
                  onChange={async (e) => {
                    const newManager = e.target.value as 'newznab' | 'prowlarr' | 'nzbhydra';
                    setIndexManager(newManager);
                    if (config) setConfig({ ...config, indexManager: newManager });
                    resetSyncState();
                    // Auto-sync indexers for the new manager if credentials are available
                    if (newManager === 'prowlarr' && prowlarrUrl && prowlarrApiKey) {
                      setSyncStatus('syncing');
                      try {
                        const resp = await apiFetch('/api/prowlarr/sync', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url: prowlarrUrl, apiKey: prowlarrApiKey }),
                        });
                        const data = await resp.json();
                        if (!resp.ok || data.error) throw new Error(data.error || data.message || `Server error (${resp.status})`);
                        setSyncedIndexers(data.indexers || []);
                        setSyncStatus('success');
                        setSyncMessage(`Synced ${data.total} usenet indexer(s)`);
                      } catch (err: any) {
                        setSyncedIndexers([]);
                        setSyncStatus('error');
                        setSyncMessage(err.message);
                      }
                    } else if (newManager === 'nzbhydra' && nzbhydraUrl && nzbhydraApiKey) {
                      setSyncStatus('syncing');
                      try {
                        const resp = await apiFetch('/api/nzbhydra/sync', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url: nzbhydraUrl, apiKey: nzbhydraApiKey }),
                        });
                        const data = await resp.json();
                        if (!resp.ok || data.error) throw new Error(data.error || data.message || `Server error (${resp.status})`);
                        setSyncedIndexers(data.indexers || []);
                        setSyncStatus('success');
                        setSyncMessage(`Synced ${data.total} indexer(s)`);
                      } catch (err: any) {
                        setSyncedIndexers([]);
                        setSyncStatus('error');
                        setSyncMessage(err.message);
                      }
                    }
                  }}
                  className="input max-w-xs"
                >
                  <option value="newznab">Newznab</option>
                  <option value="prowlarr">Prowlarr</option>
                  <option value="nzbhydra">NZBHydra2</option>
                </select>
                <p className="text-xs text-slate-500 mt-2">
                  {indexManager === 'newznab' && 'Manage individual Newznab indexers manually'}
                  {indexManager === 'prowlarr' && 'Connect to Prowlarr to access all configured indexers'}
                  {indexManager === 'nzbhydra' && 'Connect to NZBHydra2 meta search aggregator'}
                </p>
              </div>

              {/* Search Settings - API keys and global options */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="text-sm font-medium text-slate-300">Search Settings</div>
                <p className="text-xs text-slate-500">
                  Search method is configured per-indexer. API keys below are shared across all indexers that use TMDB or TVDB search. Providing these keys also improves Ultimate Text Search accuracy by resolving canonical titles (TMDB for movies, TVDB for TV), which often differ from what Stremio provides.
                </p>

                {/* Ultimate Text Search Feature Highlight */}
                <div className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-yellow-500/5 to-amber-500/5">
                  <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 via-transparent to-yellow-500/5 animate-pulse" style={{ animationDuration: '4s' }} />
                  <div className="relative p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                        <Crown className="w-4 h-4 text-white" />
                      </div>
                      <h3 className="text-sm font-bold bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">Ultimate Text Search</h3>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Ultimate Text Search is a purpose-built search engine designed to return the absolute best and most accurate results from your indexers.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="flex items-start gap-2 text-xs text-slate-400">
                        <Crown className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span><span className="text-slate-300 font-medium">Canonical Title Resolution</span> — Resolves titles through TMDB/TVDB to find the correct official name, eliminating mismatches from Stremio metadata</span>
                      </div>
                      <div className="flex items-start gap-2 text-xs text-slate-400">
                        <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span><span className="text-slate-300 font-medium">Smart Query Construction</span> — Automatically builds optimized search queries with year tagging, season/episode formatting, and alias handling</span>
                      </div>
                      <div className="flex items-start gap-2 text-xs text-slate-400">
                        <Filter className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span><span className="text-slate-300 font-medium">Advanced Result Filtering</span> — Intelligent post-processing filters out irrelevant results, wrong seasons, and mismatched content with precision</span>
                      </div>
                      <div className="flex items-start gap-2 text-xs text-slate-400">
                        <Search className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span><span className="text-slate-300 font-medium">Universal Compatibility</span> — Works with every indexer regardless of API capabilities — no IMDB/TMDB/TVDB ID support required</span>
                      </div>
                    </div>
                    <p className="text-xs text-amber-400/60 italic">
                      Enable Ultimate Text Search per-indexer below, or globally for anime in the Anime section. For best results pair with TMDB and TVDB API keys.
                    </p>
                  </div>
                </div>

                {/* TMDB API Key */}
                <div>
                  <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 mb-1 hover:text-primary-400 transition-colors">
                    TMDB API Key / Read Access Token
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showTmdbKey ? 'text' : 'password'}
                        value={tmdbApiKey}
                        onChange={(e) => { setTmdbApiKey(e.target.value); setTmdbKeyStatus('idle'); }}
                        placeholder="API key (v3) or Read Access Token (v4)"
                        className="input w-full pr-9"
                      />
                      {tmdbApiKey && (
                        <button
                          type="button"
                          onClick={() => setShowTmdbKey(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          {showTmdbKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    <button
                      onClick={testTmdbKey}
                      disabled={!tmdbApiKey || tmdbKeyStatus === 'testing'}
                      className={clsx(
                        'px-3 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap',
                        tmdbKeyStatus === 'valid' && 'bg-green-500/20 text-green-400 border border-green-500/30',
                        tmdbKeyStatus === 'invalid' && 'bg-red-500/20 text-red-400 border border-red-500/30',
                        tmdbKeyStatus === 'testing' && 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
                        tmdbKeyStatus === 'idle' && 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600',
                        (!tmdbApiKey || tmdbKeyStatus === 'testing') && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      {tmdbKeyStatus === 'testing' ? 'Testing...' : tmdbKeyStatus === 'valid' ? 'Valid' : tmdbKeyStatus === 'invalid' ? 'Invalid' : 'Test'}
                    </button>
                  </div>
                </div>

                {/* TVDB API Key */}
                <div>
                  <a href="https://thetvdb.com/dashboard/account/apikeys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 mb-1 hover:text-primary-400 transition-colors">
                    TVDB API Key
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showTvdbKey ? 'text' : 'password'}
                        value={tvdbApiKey}
                        onChange={(e) => { setTvdbApiKey(e.target.value); setTvdbKeyStatus('idle'); }}
                        placeholder="Your TVDB API key (v4)"
                        className="input w-full pr-9"
                      />
                      {tvdbApiKey && (
                        <button
                          type="button"
                          onClick={() => setShowTvdbKey(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          {showTvdbKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    <button
                      onClick={testTvdbKey}
                      disabled={!tvdbApiKey || tvdbKeyStatus === 'testing'}
                      className={clsx(
                        'px-3 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap',
                        tvdbKeyStatus === 'valid' && 'bg-green-500/20 text-green-400 border border-green-500/30',
                        tvdbKeyStatus === 'invalid' && 'bg-red-500/20 text-red-400 border border-red-500/30',
                        tvdbKeyStatus === 'testing' && 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
                        tvdbKeyStatus === 'idle' && 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600',
                        (!tvdbApiKey || tvdbKeyStatus === 'testing') && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      {tvdbKeyStatus === 'testing' ? 'Testing...' : tvdbKeyStatus === 'valid' ? 'Valid' : tvdbKeyStatus === 'invalid' ? 'Invalid' : 'Test'}
                    </button>
                  </div>
                </div>

                {/* Include Season Packs */}
                <div className="pt-3 border-t border-slate-700/30 space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="include-season-packs"
                      checked={includeSeasonPacks}
                      onChange={(e) => setIncludeSeasonPacks(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500 cursor-pointer"
                    />
                    <label htmlFor="include-season-packs" className="flex-1 cursor-pointer">
                      <div className="text-sm font-medium text-slate-300">Include season packs</div>
                      <div className="text-xs text-slate-500 mt-0.5">Include full-season downloads in episode results (size estimated per episode for sorting).</div>
                    </label>
                  </div>
                  {includeSeasonPacks && (
                    <div className="pl-7 space-y-2">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="season-pack-pagination"
                          checked={seasonPackPagination}
                          onChange={(e) => setSeasonPackPagination(e.target.checked)}
                          className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500 cursor-pointer"
                        />
                        <label htmlFor="season-pack-pagination" className="flex-1 cursor-pointer">
                          <div className="text-xs text-slate-400">Enable pagination for season pack searches</div>
                        </label>
                      </div>
                      {seasonPackPagination && (
                        <div className="pl-7 flex items-center gap-2">
                          <label className="text-xs text-slate-400">Additional pages</label>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={seasonPackAdditionalPages}
                            onChange={(e) => setSeasonPackAdditionalPages(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                            onFocus={(e) => e.target.select()}
                            className="input w-20 text-sm"
                          />
                          <span className="text-xs text-slate-500">Extra pages for season pack searches</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Anime Settings */}
                <div className="pt-3 border-t border-slate-700/30">
                  <div className="text-sm font-medium text-slate-300 mb-2">Anime</div>
                  <div className="text-xs text-slate-500 mb-3">Anime is detected automatically via Cinemeta metadata (Animation genre + Japan country).</div>
                  <div className="space-y-3 pl-1">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="use-text-search-anime"
                        checked={useTextSearchForAnime}
                        onChange={(e) => setUseTextSearchForAnime(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500 cursor-pointer"
                      />
                      <label htmlFor="use-text-search-anime" className="flex-1 cursor-pointer">
                        <div className="text-sm font-medium text-slate-300">Use <span className="bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent font-semibold">Ultimate Text Search</span> for anime</div>
                        <div className="text-xs text-slate-500 mt-0.5">Override per-indexer search methods to use Ultimate Text Search for anime titles, which returns more accurate results than ID-based searches.</div>
                      </label>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="skip-anime-title-resolve"
                        checked={skipAnimeTitleResolve}
                        onChange={(e) => setSkipAnimeTitleResolve(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500 cursor-pointer"
                      />
                      <label htmlFor="skip-anime-title-resolve" className="flex-1 cursor-pointer">
                        <div className="text-sm font-medium text-slate-300">Skip title resolution for anime</div>
                        <div className="text-xs text-slate-500 mt-0.5">Use Cinemeta English title for anime instead of TVDB/TMDB which often returns Japanese titles.</div>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Indexer Priority Dedup */}
                <div className="pt-3 border-t border-slate-700/30">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="indexer-priority-dedup"
                      checked={indexerPriorityDedup}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setIndexerPriorityDedup(enabled);
                        // Auto-populate priority list when first enabled and list is empty
                        if (enabled && indexerPriority.length === 0) {
                          const names: string[] = [];
                          if (indexManager === 'newznab') {
                            config?.indexers.filter(i => i.enabled).forEach(i => names.push(i.name));
                          } else {
                            (config?.syncedIndexers || []).filter(i => i.enabledForSearch).forEach(i => names.push(i.name));
                          }
                          if (easynewsEnabled) names.push('EasyNews');
                          setIndexerPriority(names);
                        }
                      }}
                      className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-primary-600 focus:ring-2 focus:ring-primary-500 cursor-pointer"
                    />
                    <label htmlFor="indexer-priority-dedup" className="flex-1 cursor-pointer">
                      <div className="text-sm font-medium text-slate-300">Indexer Priority Deduplication</div>
                      <div className="text-xs text-slate-500 mt-0.5">When duplicate NZBs are found across indexers (same title + size), keep only the copy from the highest-priority indexer. Note: even identical uploads may have different articles across indexers.</div>
                    </label>
                  </div>

                  {indexerPriorityDedup && indexerPriority.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <div className="text-xs text-slate-500">Drag to reorder indexer priority (top = highest priority):</div>
                      {indexerPriority.map((name, idx) => (
                        <div
                          key={name}
                          draggable
                          onDragStart={() => setDedupDraggedItem(name)}
                          onDragOver={(e) => { e.preventDefault(); setDedupDragOverItem(name); }}
                          onDragEnd={() => { setDedupDraggedItem(null); setDedupDragOverItem(null); }}
                          onDrop={() => {
                            if (dedupDraggedItem && dedupDraggedItem !== name) {
                              const newOrder = [...indexerPriority];
                              const fromIdx = newOrder.indexOf(dedupDraggedItem);
                              const toIdx = newOrder.indexOf(name);
                              if (fromIdx !== -1 && toIdx !== -1) {
                                newOrder.splice(fromIdx, 1);
                                newOrder.splice(toIdx, 0, dedupDraggedItem);
                                setIndexerPriority(newOrder);
                              }
                            }
                            setDedupDraggedItem(null);
                            setDedupDragOverItem(null);
                          }}
                          className={clsx(
                            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-all cursor-grab active:cursor-grabbing',
                            dedupDragOverItem === name && dedupDraggedItem !== name
                              ? 'border-primary-500/50 bg-primary-500/10'
                              : 'border-slate-700/50 bg-slate-800/50 hover:bg-slate-700/50',
                            dedupDraggedItem === name && 'opacity-50'
                          )}
                        >
                          <GripVertical className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
                          <span className="text-xs font-mono text-slate-500 w-5">#{idx + 1}</span>
                          <span className="text-slate-300 text-sm">{name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* EasyNews — supplemental search source */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-300">EasyNews</div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={easynewsEnabled}
                      onChange={(e) => setEasynewsEnabled(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  Supplemental search source that runs alongside your index manager. Powered by <span className="bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent font-semibold">Ultimate Text Search</span>.
                </p>

                {easynewsEnabled && (
                  <div className="space-y-3 pt-2 border-t border-slate-700/30">
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">Mode</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEasynewsMode('ddl')}
                          className={clsx(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                            easynewsMode === 'ddl'
                              ? 'bg-primary-600/20 text-primary-400 border-primary-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                          )}
                        >
                          DDL
                        </button>
                        <button
                          onClick={() => setEasynewsMode('nzb')}
                          className={clsx(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                            easynewsMode === 'nzb'
                              ? 'bg-primary-600/20 text-primary-400 border-primary-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                          )}
                        >
                          NZB
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {easynewsMode === 'ddl'
                          ? 'Streams directly from EasyNews CDN.'
                          : 'Sends NZB to your download client for faster start times.'}
                      </p>
                    </div>
                    {easynewsMode === 'nzb' && (
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={easynewsHealthCheck}
                          onChange={(e) => setEasynewsHealthCheck(e.target.checked)}
                          className="accent-primary-500"
                        />
                        <span className="text-xs font-medium text-slate-300">Include in Health Checks</span>
                        <span className="text-xs text-slate-500">
                          {easynewsHealthCheck
                            ? 'EasyNews NZBs will be verified via NNTP.'
                            : 'EasyNews results auto-marked as healthy.'}
                        </span>
                      </label>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
                      <input
                        type="text"
                        value={easynewsUsername}
                        onChange={(e) => { setEasynewsUsername(e.target.value); setEasynewsTestStatus('idle'); }}
                        placeholder="EasyNews username"
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
                      <div className="relative">
                        <input
                          type={showEasynewsPassword ? 'text' : 'password'}
                          value={easynewsPassword}
                          onChange={(e) => { setEasynewsPassword(e.target.value); setEasynewsTestStatus('idle'); }}
                          placeholder="EasyNews password"
                          className="input pr-9"
                        />
                        {easynewsPassword && (
                          <button
                            type="button"
                            onClick={() => setShowEasynewsPassword(v => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                          >
                            {showEasynewsPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="easynews-pagination"
                          checked={easynewsPagination}
                          onChange={(e) => setEasynewsPagination(e.target.checked)}
                          className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                        />
                        <label htmlFor="easynews-pagination" className="flex-1 cursor-pointer">
                          <span className="text-xs text-slate-400">Paginated search</span>
                          <span className="text-[10px] text-slate-500 ml-1.5">Fetch additional pages of results (250 results/page)</span>
                        </label>
                      </div>
                      {easynewsPagination && (
                        <div className="pl-6 flex items-center gap-2">
                          <label className="text-xs text-slate-400">Additional pages</label>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={easynewsMaxPages}
                            onChange={(e) => setEasynewsMaxPages(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                            onFocus={(e) => e.target.select()}
                            className="input w-20 text-sm"
                          />
                        </div>
                      )}
                    </div>
                    <div className={clsx(
                      "flex items-center justify-between p-3 rounded-lg border",
                      easynewsTestStatus === 'success' && "bg-green-500/10 border-green-500/30",
                      easynewsTestStatus === 'error' && "bg-red-500/10 border-red-500/30",
                      (easynewsTestStatus === 'idle' || easynewsTestStatus === 'testing') && "bg-purple-500/10 border-purple-500/30"
                    )}>
                      <div className="flex items-center gap-2">
                        <Activity className={clsx(
                          "w-4 h-4",
                          easynewsTestStatus === 'success' && "text-green-400",
                          easynewsTestStatus === 'error' && "text-red-400",
                          (easynewsTestStatus === 'idle' || easynewsTestStatus === 'testing') && "text-purple-400"
                        )} />
                        <span className={clsx(
                          "text-sm",
                          easynewsTestStatus === 'success' && "text-green-400",
                          easynewsTestStatus === 'error' && "text-red-400",
                          (easynewsTestStatus === 'idle' || easynewsTestStatus === 'testing') && "text-slate-400"
                        )}>
                          {easynewsTestStatus === 'idle' && 'Not tested'}
                          {easynewsTestStatus === 'testing' && 'Checking...'}
                          {easynewsTestStatus === 'success' && (easynewsTestMessage || 'Authenticated')}
                          {easynewsTestStatus === 'error' && (easynewsTestMessage || 'Failed')}
                        </span>
                      </div>
                      <button
                        onClick={async () => {
                          setEasynewsTestStatus('testing');
                          setEasynewsTestMessage('');
                          try {
                            const res = await apiFetch('/api/easynews/test', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ username: easynewsUsername, password: easynewsPassword }),
                            });
                            const data = await res.json();
                            setEasynewsTestStatus(data.success ? 'success' : 'error');
                            setEasynewsTestMessage(data.message);
                          } catch (err: any) {
                            setEasynewsTestStatus('error');
                            setEasynewsTestMessage(err.message || 'Connection failed');
                          }
                        }}
                        disabled={!easynewsUsername || !easynewsPassword || easynewsTestStatus === 'testing'}
                        className="btn text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Test
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {indexManager === 'prowlarr' && (
                <div className="space-y-4 p-4 bg-slate-900/50 rounded-lg border border-blue-500/30">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Prowlarr URL</label>
                    <input type="text" value={prowlarrUrl} onChange={(e) => { setProwlarrUrl(e.target.value); resetSyncState(); }} placeholder="http://localhost:9696" className="input" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">API Key</label>
                    <div className="relative">
                      <input type={showProwlarrKey ? 'text' : 'password'} value={prowlarrApiKey} onChange={(e) => { setProwlarrApiKey(e.target.value); resetSyncState(); }} placeholder="Your Prowlarr API key" className="input pr-9" />
                      {prowlarrApiKey && (
                        <button
                          type="button"
                          onClick={() => setShowProwlarrKey(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          {showProwlarrKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Test + Sync buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setConnectionTestStatus('testing');
                        setConnectionTestMessage('');
                        setSyncStatus('idle');
                        setSyncMessage('');
                        try {
                          const resp = await apiFetch('/api/prowlarr/test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: prowlarrUrl, apiKey: prowlarrApiKey }),
                          });
                          const data = await resp.json();
                          if (!resp.ok) throw new Error(data.message || data.error || `Server error (${resp.status})`);
                          setConnectionTestStatus(data.success ? 'success' : 'error');
                          setConnectionTestMessage(data.message);
                        } catch (e: any) {
                          setConnectionTestStatus('error');
                          setConnectionTestMessage(e.message);
                        }
                      }}
                      disabled={connectionTestStatus === 'testing' || !prowlarrUrl || !prowlarrApiKey}
                      className="btn-secondary text-sm flex items-center gap-2"
                    >
                      {connectionTestStatus === 'testing' ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</>
                      ) : 'Test Connection'}
                    </button>
                    <button
                      onClick={async () => {
                        setSyncStatus('syncing');
                        setSyncMessage('');
                        setConnectionTestStatus('idle');
                        setConnectionTestMessage('');
                        setSelectedSyncedIndexer(null);
                        try {
                          const resp = await apiFetch('/api/prowlarr/sync', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: prowlarrUrl, apiKey: prowlarrApiKey }),
                          });
                          const data = await resp.json();
                          if (!resp.ok || data.error) throw new Error(data.error || data.message || `Server error (${resp.status})`);
                          setSyncedIndexers(data.indexers || []);
                          setSyncStatus('success');
                          setSyncMessage(`Synced ${data.total} usenet indexer(s)`);
                        } catch (e: any) {
                          setSyncStatus('error');
                          setSyncMessage(e.message);
                        }
                      }}
                      disabled={syncStatus === 'syncing' || !prowlarrUrl || !prowlarrApiKey}
                      className="btn-primary text-sm flex items-center gap-2"
                    >
                      {syncStatus === 'syncing' ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing...</>
                      ) : (
                        <><RefreshCw className="w-3.5 h-3.5" /> Sync Indexers</>
                      )}
                    </button>
                  </div>

                  {/* Status messages */}
                  {connectionTestMessage && (
                    <p className={clsx('text-sm font-medium', connectionTestStatus === 'success' ? 'text-green-400' : 'text-red-400')}>{connectionTestMessage}</p>
                  )}
                  {syncMessage && (
                    <p className={clsx('text-sm font-medium', syncStatus === 'success' ? 'text-green-400' : 'text-red-400')}>{syncMessage}</p>
                  )}

                  {/* Synced Indexers Grid */}
                  {syncedIndexers.length > 0 && (
                    <div className="space-y-3 pt-2 border-t border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold text-slate-300">
                          Synced Indexers ({syncedIndexers.filter(i => i.enabledForSearch).length}/{syncedIndexers.length} enabled)
                        </h4>
                      </div>
                      <p className="text-xs text-slate-500">Click to configure. Reorder with arrows to set priority.</p>
                      <div className="flex flex-wrap gap-3">
                        {syncedIndexers.map((indexer, idx) => (
                          <div key={indexer.id} className="flex flex-col items-center gap-0.5">
                            <button
                              onClick={() => setSelectedSyncedIndexer(selectedSyncedIndexer === indexer.id ? null : indexer.id)}
                              className={clsx(
                                'relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all w-16',
                                selectedSyncedIndexer === indexer.id
                                  ? 'border-blue-400 bg-blue-500/10 ring-1 ring-blue-400/50'
                                  : indexer.enabledForSearch
                                    ? 'border-slate-600 bg-slate-700/50 hover:bg-slate-700'
                                    : 'border-slate-700/50 bg-slate-800/80 hover:bg-slate-800 opacity-60'
                              )}
                              title={`${indexer.name} — search ${indexer.enabledForSearch ? 'on' : 'off'}`}
                            >
                              <div className="relative w-10 h-10 flex items-center justify-center">
                                {indexer.logo && !failedLogos.has(indexer.logo) ? (
                                  <img
                                    src={indexer.logo}
                                    alt={indexer.name}
                                    className={clsx('w-10 h-10 rounded-lg object-contain bg-slate-700/30 p-1 transition-all', !indexer.enabledForSearch && 'grayscale')}
                                    onError={(e) => { e.currentTarget.style.display = 'none'; setFailedLogos(prev => new Set(prev).add(indexer.logo!)); }}
                                  />
                                ) : (
                                  <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all', indexer.enabledForSearch ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-500')}>
                                    {indexer.name.substring(0, 2).toUpperCase()}
                                  </div>
                                )}
                                <div className={clsx(
                                  'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 transition-all',
                                  indexer.enabledForSearch ? 'bg-green-400 shadow-lg shadow-green-400/50' : 'bg-red-400 shadow-lg shadow-red-400/50'
                                )} />
                              </div>
                              <span className={clsx('text-[10px] leading-tight text-center truncate w-full', indexer.enabledForSearch ? 'text-slate-300' : 'text-slate-500')}>
                                {indexer.name}
                              </span>
                            </button>
                            {syncedIndexers.length > 1 && (
                              <div className="flex gap-0.5">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleReorderSyncedIndexer(indexer.id, 'up'); }}
                                  disabled={idx === 0}
                                  className={clsx('p-0.5 rounded transition-colors', idx === 0 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-slate-300')}
                                  title="Move up (higher priority)"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleReorderSyncedIndexer(indexer.id, 'down'); }}
                                  disabled={idx === syncedIndexers.length - 1}
                                  className={clsx('p-0.5 rounded transition-colors', idx === syncedIndexers.length - 1 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-slate-300')}
                                  title="Move down (lower priority)"
                                >
                                  <ArrowDown className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Per-indexer detail panel */}
                      {selectedSyncedIndexer && (() => {
                        const indexer = syncedIndexers.find(i => i.id === selectedSyncedIndexer);
                        if (!indexer) return null;
                        const updateSynced = (updates: Partial<SyncedIndexer>) => {
                          setSyncedIndexers(prev => prev.map(i => i.id === selectedSyncedIndexer ? { ...i, ...updates } : i));
                        };
                        return (
                          <div className="p-3 bg-slate-800/70 rounded-lg border border-slate-600 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-slate-300">{indexer.name}</span>
                              <button onClick={() => setSelectedSyncedIndexer(null)} className="text-slate-500 hover:text-slate-300">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Movie Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableMovieMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(Array.isArray(indexer.movieSearchMethod) ? indexer.movieSearchMethod : [indexer.movieSearchMethod]).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = Array.isArray(indexer.movieSearchMethod) ? indexer.movieSearchMethod : [indexer.movieSearchMethod];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ movieSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">TV Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableTvMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(Array.isArray(indexer.tvSearchMethod) ? indexer.tvSearchMethod : [indexer.tvSearchMethod]).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = Array.isArray(indexer.tvSearchMethod) ? indexer.tvSearchMethod : [indexer.tvSearchMethod];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ tvSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                            <div className="flex gap-4 text-xs">
                              <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                                <input type="checkbox" checked={indexer.enabledForSearch} onChange={(e) => updateSynced({ enabledForSearch: e.target.checked })} className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800" />
                                Include in Search
                              </label>
                            </div>
                            <div className="space-y-2 pt-2 border-t border-slate-700/30">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  id={`synced-pagination-${indexer.id}`}
                                  checked={indexer.pagination === true}
                                  onChange={(e) => updateSynced({ pagination: e.target.checked })}
                                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                                />
                                <label htmlFor={`synced-pagination-${indexer.id}`} className="flex-1 cursor-pointer">
                                  <span className="text-xs text-slate-400">Paginated search</span>
                                  <span className="text-[10px] text-slate-500 ml-1.5">Fetch additional pages of results</span>
                                </label>
                              </div>
                              {indexer.pagination && (
                                <div className="pl-6 flex items-center gap-2">
                                  <label className="text-xs text-slate-400">Additional pages</label>
                                  <input
                                    type="number"
                                    min={1}
                                    max={10}
                                    value={indexer.additionalPages ?? 3}
                                    onChange={(e) => updateSynced({ additionalPages: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })}
                                    onFocus={(e) => e.target.select()}
                                    className="input w-20 text-sm"
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              {indexManager === 'nzbhydra' && (
                <div className="space-y-4 p-4 bg-slate-900/50 rounded-lg border border-blue-500/30">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">NZBHydra2 URL</label>
                    <input type="text" value={nzbhydraUrl} onChange={(e) => { setNzbhydraUrl(e.target.value); resetSyncState(); }} placeholder="http://localhost:5076" className="input" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">API Key</label>
                    <div className="relative">
                      <input type={showNzbhydraKey ? 'text' : 'password'} value={nzbhydraApiKey} onChange={(e) => { setNzbhydraApiKey(e.target.value); resetSyncState(); }} placeholder="Your NZBHydra2 API key" className="input pr-9" />
                      {nzbhydraApiKey && (
                        <button
                          type="button"
                          onClick={() => setShowNzbhydraKey(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          {showNzbhydraKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Test + Sync buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setConnectionTestStatus('testing');
                        setConnectionTestMessage('');
                        setSyncStatus('idle');
                        setSyncMessage('');
                        try {
                          const resp = await apiFetch('/api/nzbhydra/test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: nzbhydraUrl, apiKey: nzbhydraApiKey }),
                          });
                          const data = await resp.json();
                          if (!resp.ok) throw new Error(data.message || data.error || `Server error (${resp.status})`);
                          setConnectionTestStatus(data.success ? 'success' : 'error');
                          setConnectionTestMessage(data.message);
                        } catch (e: any) {
                          setConnectionTestStatus('error');
                          setConnectionTestMessage(e.message);
                        }
                      }}
                      disabled={connectionTestStatus === 'testing' || !nzbhydraUrl || !nzbhydraApiKey}
                      className="btn-secondary text-sm flex items-center gap-2"
                    >
                      {connectionTestStatus === 'testing' ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</>
                      ) : 'Test Connection'}
                    </button>
                    <button
                      onClick={async () => {
                        setSyncStatus('syncing');
                        setSyncMessage('');
                        setConnectionTestStatus('idle');
                        setConnectionTestMessage('');
                        setSelectedSyncedIndexer(null);
                        try {
                          const resp = await apiFetch('/api/nzbhydra/sync', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: nzbhydraUrl, apiKey: nzbhydraApiKey }),
                          });
                          const data = await resp.json();
                          if (!resp.ok || data.error) throw new Error(data.error || data.message || `Server error (${resp.status})`);
                          setSyncedIndexers(data.indexers || []);
                          setSyncStatus('success');
                          setSyncMessage(`Synced ${data.total} indexer(s)`);
                        } catch (e: any) {
                          setSyncStatus('error');
                          setSyncMessage(e.message);
                        }
                      }}
                      disabled={syncStatus === 'syncing' || !nzbhydraUrl || !nzbhydraApiKey}
                      className="btn-primary text-sm flex items-center gap-2"
                    >
                      {syncStatus === 'syncing' ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing...</>
                      ) : (
                        <><RefreshCw className="w-3.5 h-3.5" /> Sync Indexers</>
                      )}
                    </button>
                  </div>

                  {/* Status messages */}
                  {connectionTestMessage && (
                    <p className={clsx('text-sm font-medium', connectionTestStatus === 'success' ? 'text-green-400' : 'text-red-400')}>{connectionTestMessage}</p>
                  )}
                  {syncMessage && (
                    <p className={clsx('text-sm font-medium', syncStatus === 'success' ? 'text-green-400' : 'text-red-400')}>{syncMessage}</p>
                  )}

                  {/* Synced Indexers Grid (same pattern as Prowlarr) */}
                  {syncedIndexers.length > 0 && (
                    <div className="space-y-3 pt-2 border-t border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold text-slate-300">
                          Synced Indexers ({syncedIndexers.filter(i => i.enabledForSearch).length}/{syncedIndexers.length} enabled)
                        </h4>
                      </div>
                      <p className="text-xs text-slate-500">Click to configure. Reorder with arrows to set priority.</p>
                      <div className="flex flex-wrap gap-3">
                        {syncedIndexers.map((indexer, idx) => (
                          <div key={indexer.id} className="flex flex-col items-center gap-0.5">
                            <button
                              onClick={() => setSelectedSyncedIndexer(selectedSyncedIndexer === indexer.id ? null : indexer.id)}
                              className={clsx(
                                'relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all w-16',
                                selectedSyncedIndexer === indexer.id
                                  ? 'border-blue-400 bg-blue-500/10 ring-1 ring-blue-400/50'
                                  : indexer.enabledForSearch
                                    ? 'border-slate-600 bg-slate-700/50 hover:bg-slate-700'
                                    : 'border-slate-700/50 bg-slate-800/80 hover:bg-slate-800 opacity-60'
                              )}
                              title={`${indexer.name} — search ${indexer.enabledForSearch ? 'on' : 'off'}`}
                            >
                              <div className="relative w-10 h-10 flex items-center justify-center">
                                {indexer.logo && !failedLogos.has(indexer.logo) ? (
                                  <img
                                    src={indexer.logo}
                                    alt={indexer.name}
                                    className={clsx('w-10 h-10 rounded-lg object-contain bg-slate-700/30 p-1 transition-all', !indexer.enabledForSearch && 'grayscale')}
                                    onError={(e) => { e.currentTarget.style.display = 'none'; setFailedLogos(prev => new Set(prev).add(indexer.logo!)); }}
                                  />
                                ) : (
                                  <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all', indexer.enabledForSearch ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-500')}>
                                    {indexer.name.substring(0, 2).toUpperCase()}
                                  </div>
                                )}
                                <div className={clsx(
                                  'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 transition-all',
                                  indexer.enabledForSearch ? 'bg-green-400 shadow-lg shadow-green-400/50' : 'bg-red-400 shadow-lg shadow-red-400/50'
                                )} />
                              </div>
                              <span className={clsx('text-[10px] leading-tight text-center truncate w-full', indexer.enabledForSearch ? 'text-slate-300' : 'text-slate-500')}>
                                {indexer.name}
                              </span>
                            </button>
                            {syncedIndexers.length > 1 && (
                              <div className="flex gap-0.5">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleReorderSyncedIndexer(indexer.id, 'up'); }}
                                  disabled={idx === 0}
                                  className={clsx('p-0.5 rounded transition-colors', idx === 0 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-slate-300')}
                                  title="Move up (higher priority)"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleReorderSyncedIndexer(indexer.id, 'down'); }}
                                  disabled={idx === syncedIndexers.length - 1}
                                  className={clsx('p-0.5 rounded transition-colors', idx === syncedIndexers.length - 1 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-slate-300')}
                                  title="Move down (lower priority)"
                                >
                                  <ArrowDown className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Per-indexer detail panel */}
                      {selectedSyncedIndexer && (() => {
                        const indexer = syncedIndexers.find(i => i.id === selectedSyncedIndexer);
                        if (!indexer) return null;
                        const updateSynced = (updates: Partial<SyncedIndexer>) => {
                          setSyncedIndexers(prev => prev.map(i => i.id === selectedSyncedIndexer ? { ...i, ...updates } : i));
                        };
                        return (
                          <div className="p-3 bg-slate-800/70 rounded-lg border border-slate-600 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-slate-300">{indexer.name}</span>
                              <button onClick={() => setSelectedSyncedIndexer(null)} className="text-slate-500 hover:text-slate-300">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Movie Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableMovieMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(Array.isArray(indexer.movieSearchMethod) ? indexer.movieSearchMethod : [indexer.movieSearchMethod]).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = Array.isArray(indexer.movieSearchMethod) ? indexer.movieSearchMethod : [indexer.movieSearchMethod];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ movieSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">TV Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableTvMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(Array.isArray(indexer.tvSearchMethod) ? indexer.tvSearchMethod : [indexer.tvSearchMethod]).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = Array.isArray(indexer.tvSearchMethod) ? indexer.tvSearchMethod : [indexer.tvSearchMethod];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ tvSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                            <div className="flex gap-4 text-xs">
                              <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                                <input type="checkbox" checked={indexer.enabledForSearch} onChange={(e) => updateSynced({ enabledForSearch: e.target.checked })} className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800" />
                                Include in Search
                              </label>
                            </div>
                            <div className="space-y-2 pt-2 border-t border-slate-700/30">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  id={`synced-pagination-${indexer.id}`}
                                  checked={indexer.pagination === true}
                                  onChange={(e) => updateSynced({ pagination: e.target.checked })}
                                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                                />
                                <label htmlFor={`synced-pagination-${indexer.id}`} className="flex-1 cursor-pointer">
                                  <span className="text-xs text-slate-400">Paginated search</span>
                                  <span className="text-[10px] text-slate-500 ml-1.5">Fetch additional pages of results</span>
                                </label>
                              </div>
                              {indexer.pagination && (
                                <div className="pl-6 flex items-center gap-2">
                                  <label className="text-xs text-slate-400">Additional pages</label>
                                  <input
                                    type="number"
                                    min={1}
                                    max={10}
                                    value={indexer.additionalPages ?? 3}
                                    onChange={(e) => updateSynced({ additionalPages: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })}
                                    onFocus={(e) => e.target.select()}
                                    className="input w-20 text-sm"
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Show Indexer Management below when Newznab mode */}
            {indexManager === 'newznab' && (
              <div className="p-4 md:p-6 border-t border-slate-700/50 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
                    <Database className="w-5 h-5 text-primary-400" />
                    Your Indexers ({config?.indexers.length || 0})
                  </h3>
                  <button
                    onClick={() => {
                      setShowAddIndexer(true);
                      setExpandedIndexer(null);
                    }}
                    className="btn-primary flex items-center gap-2 text-sm"
                  >
                    <Plus className="w-4 h-4" />
                    Add Indexer
                  </button>
                </div>

                {/* Indexer List */}
                <div className="space-y-3">
                  {config?.indexers.map((indexer, index) => (
                    <div
                      key={indexer.name}
                      draggable
                      onDragStart={() => setDraggedIndexer(indexer.name)}
                      onDragEnd={async () => {
                        if (draggedIndexer && dragOverIndexer && draggedIndexer !== dragOverIndexer) {
                          const newIndexers = handleDragReorder(draggedIndexer, dragOverIndexer);
                          if (newIndexers) {
                            await saveIndexerOrder(newIndexers);
                          }
                        }
                        setDraggedIndexer(null);
                        setDragOverIndexer(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverIndexer(indexer.name);
                      }}
                      className={clsx(
                        "bg-slate-900/30 rounded-lg border transition-all overflow-hidden",
                        draggedIndexer === indexer.name && "opacity-50",
                        dragOverIndexer === indexer.name && draggedIndexer !== indexer.name && "border-primary-500",
                        draggedIndexer !== indexer.name && "border-slate-700/30 hover:border-slate-600/50"
                      )}
                    >
                      <div
                        className="p-4 cursor-pointer"
                        onClick={() => {
                          if (expandedIndexer === indexer.name) {
                            setExpandedIndexer(null);
                          } else {
                            setExpandedIndexer(indexer.name);
                            startEdit(indexer);
                          }
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="cursor-grab active:cursor-grabbing" onClick={(e) => e.stopPropagation()}>
                              <GripVertical className="w-5 h-5 text-slate-500" />
                            </div>
                            <div className="relative w-8 h-8 flex items-center justify-center flex-shrink-0">
                              {indexer.logo && !failedLogos.has(indexer.logo) && (
                                <img
                                  src={indexer.logo}
                                  alt={indexer.name}
                                  className="w-8 h-8 rounded-lg object-contain bg-slate-700/30 p-1"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                    setFailedLogos(prev => new Set(prev).add(indexer.logo!));
                                  }}
                                />
                              )}
                              <div className={clsx(
                                'rounded-full transition-all',
                                indexer.logo && !failedLogos.has(indexer.logo) ? 'absolute w-2 h-2 bottom-0 right-0' : 'w-3 h-3',
                                indexer.enabled ? 'bg-green-400 shadow-lg shadow-green-400/50 animate-pulse' : 'bg-slate-600'
                              )} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-slate-200 truncate">{indexer.name}</div>
                              <div className="text-xs text-slate-400 truncate">{indexer.url}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const response = await apiFetch(`/api/indexers/${encodeURIComponent(indexer.name)}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ enabled: !indexer.enabled }),
                                  });
                                  if (response.ok) await fetchIndexers();
                                } catch (error) {
                                  console.error('Failed to toggle indexer:', error);
                                }
                              }}
                              className={clsx(
                                'px-3 py-1 rounded-full text-xs font-medium flex-shrink-0 cursor-pointer transition-colors',
                                indexer.enabled
                                  ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30'
                                  : 'bg-slate-600/20 text-slate-400 border border-slate-600/30 hover:bg-slate-600/30'
                              )}
                            >
                              {indexer.enabled ? 'Active' : 'Inactive'}
                            </button>
                            <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleReorderIndexer(indexer.name, 'up')}
                                disabled={index === 0}
                                className="p-1 hover:bg-slate-700/50 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                title="Move up"
                              >
                                <ArrowUp className="w-3 h-3 text-slate-400" />
                              </button>
                              <button
                                onClick={() => handleReorderIndexer(indexer.name, 'down')}
                                disabled={index === (config?.indexers.length || 0) - 1}
                                className="p-1 hover:bg-slate-700/50 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                title="Move down"
                              >
                                <ArrowDown className="w-3 h-3 text-slate-400" />
                              </button>
                            </div>
                            {(testResults[indexer.name]?.loading || pendingSave || (draggedIndexer && draggedIndexer === indexer.name)) ? (
                              <Settings className="w-5 h-5 text-primary-400 animate-spin" />
                            ) : (
                              <Settings className="w-5 h-5 text-slate-400" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
  );
}

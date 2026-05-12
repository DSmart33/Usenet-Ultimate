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
  ChevronDown,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import clsx from 'clsx';
import type { Config, Indexer, SyncedIndexer, IndexerCaps } from '../../types';
import { SERIES_PACK_KEYWORDS } from '../../types';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';
import { TimeoutStepper } from '../shared/TimeoutStepper';
import { PagesStepper } from '../shared/PagesStepper';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../../constants';

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
  includeMultiSeasonPacks: boolean;
  setIncludeMultiSeasonPacks: React.Dispatch<React.SetStateAction<boolean>>;

  // Series-pack indexer search (advanced; keyword-only releases without Sxx tokens).
  // Empty array means feature is off; selecting a chip enables that keyword's query.
  seriesPackKeywords: string[];
  setSeriesPackKeywords: React.Dispatch<React.SetStateAction<string[]>>;
  seasonPackPagination: boolean;
  setSeasonPackPagination: React.Dispatch<React.SetStateAction<boolean>>;
  seasonPackAdditionalPages: number;
  setSeasonPackAdditionalPages: React.Dispatch<React.SetStateAction<number>>;
  seriesPackPagination: boolean;
  setSeriesPackPagination: React.Dispatch<React.SetStateAction<boolean>>;
  seriesPackAdditionalPages: number;
  setSeriesPackAdditionalPages: React.Dispatch<React.SetStateAction<number>>;

  // URL dedup
  urlDedup: boolean;
  setUrlDedup: React.Dispatch<React.SetStateAction<boolean>>;

  // Library short-circuit threshold (0 = off, 1-10 = active)
  librarySearchThreshold: number;
  setLibrarySearchThreshold: React.Dispatch<React.SetStateAction<number>>;

  // Per-type apply toggles for Ultimate Library (default true each)
  libraryApplyToMovies: boolean;
  setLibraryApplyToMovies: React.Dispatch<React.SetStateAction<boolean>>;
  libraryApplyToSeries: boolean;
  setLibraryApplyToSeries: React.Dispatch<React.SetStateAction<boolean>>;

  // Include /content/uncategorized as a second scan root
  librarySearchScanUncategorized: boolean;
  setLibrarySearchScanUncategorized: React.Dispatch<React.SetStateAction<boolean>>;

  // Run Ultimate Library on cache hit (default false)
  libraryRunOnCacheHit: boolean;
  setLibraryRunOnCacheHit: React.Dispatch<React.SetStateAction<boolean>>;

  // Display library in results
  displayLibraryInResults: boolean;
  setDisplayLibraryInResults: React.Dispatch<React.SetStateAction<boolean>>;
  // Library delete tiles (two toggles, both default false). Two-step
  // click-confirm enforced server-side. Tiles are spliced into the streams
  // array post-build and never enter fallbackCandidates so UF skips them.
  libraryDeleteAllTile: boolean;
  setLibraryDeleteAllTile: React.Dispatch<React.SetStateAction<boolean>>;
  libraryDeletePerStreamTile: boolean;
  setLibraryDeletePerStreamTile: React.Dispatch<React.SetStateAction<boolean>>;
  // Opens the best-practices modal when the user enables either delete tile.
  // Toggling off bypasses the modal and flips the toggle directly.
  setLibraryDeleteWarning: React.Dispatch<React.SetStateAction<{ show: boolean; toggleType: 'all' | 'perStream' | null }>>;
  // Position of the "Skip Ultimate Library" stream tile in the results list.
  librarySkipTilePosition: 'second' | 'last';
  setLibrarySkipTilePosition: React.Dispatch<React.SetStateAction<'second' | 'last'>>;
  // For series/season pack results, the "Delete All" tile deletes either the
  // per-episode file ('episode', default) or the entire release folder ('pack').
  libraryDeleteAllPackScope: 'episode' | 'pack';
  setLibraryDeleteAllPackScope: React.Dispatch<React.SetStateAction<'episode' | 'pack'>>;
  absoluteEpisodeFallback: boolean;
  setAbsoluteEpisodeFallback: React.Dispatch<React.SetStateAction<boolean>>;
  parallelAlternateTitleSearch: boolean;
  setParallelAlternateTitleSearch: React.Dispatch<React.SetStateAction<boolean>>;
  aliasTitleFallback: boolean;
  setAliasTitleFallback: React.Dispatch<React.SetStateAction<boolean>>;
  tvdbPreferEnglishTitle: boolean;
  setTvdbPreferEnglishTitle: React.Dispatch<React.SetStateAction<boolean>>;

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
  easynewsTimeoutEnabled: boolean;
  setEasynewsTimeoutEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  easynewsTimeout: number;
  setEasynewsTimeout: React.Dispatch<React.SetStateAction<number>>;
  easynewsMode: 'ddl' | 'nzb';
  setEasynewsMode: React.Dispatch<React.SetStateAction<'ddl' | 'nzb'>>;
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
  prowlarrTimeoutEnabled: boolean;
  setProwlarrTimeoutEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  prowlarrTimeout: number;
  setProwlarrTimeout: React.Dispatch<React.SetStateAction<number>>;

  // NZBHydra
  nzbhydraUrl: string;
  setNzbhydraUrl: React.Dispatch<React.SetStateAction<string>>;
  nzbhydraApiKey: string;
  setNzbhydraApiKey: React.Dispatch<React.SetStateAction<string>>;
  showNzbhydraKey: boolean;
  setShowNzbhydraKey: React.Dispatch<React.SetStateAction<boolean>>;
  nzbhydraUsername: string;
  setNzbhydraUsername: React.Dispatch<React.SetStateAction<string>>;
  nzbhydraPassword: string;
  setNzbhydraPassword: React.Dispatch<React.SetStateAction<string>>;
  showNzbhydraPassword: boolean;
  setShowNzbhydraPassword: React.Dispatch<React.SetStateAction<boolean>>;
  nzbhydraTimeoutEnabled: boolean;
  setNzbhydraTimeoutEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  nzbhydraTimeout: number;
  setNzbhydraTimeout: React.Dispatch<React.SetStateAction<number>>;

  // Sync state
  syncedIndexers: SyncedIndexer[];
  setSyncedIndexers: React.Dispatch<React.SetStateAction<SyncedIndexer[]>>;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error';
  setSyncStatus: React.Dispatch<React.SetStateAction<'idle' | 'syncing' | 'success' | 'error'>>;
  syncMessage: string;
  setSyncMessage: React.Dispatch<React.SetStateAction<string>>;
  selectedSyncedIndexer: string | null;
  setSelectedSyncedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  handleReorderSyncedIndexer: (id: string, direction: 'up' | 'down') => void;

  // Failed logos
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Helper functions for search methods
  getAvailableMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableAnimeMovieMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
  getAvailableAnimeTvMethods: (caps: IndexerCaps | null) => { value: string; label: string }[];
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
  includeMultiSeasonPacks,
  setIncludeMultiSeasonPacks,
  seriesPackKeywords,
  setSeriesPackKeywords,
  seasonPackPagination,
  setSeasonPackPagination,
  seasonPackAdditionalPages,
  setSeasonPackAdditionalPages,
  seriesPackPagination,
  setSeriesPackPagination,
  seriesPackAdditionalPages,
  setSeriesPackAdditionalPages,
  urlDedup,
  setUrlDedup,
  librarySearchThreshold,
  setLibrarySearchThreshold,
  libraryApplyToMovies,
  setLibraryApplyToMovies,
  libraryApplyToSeries,
  setLibraryApplyToSeries,
  librarySearchScanUncategorized,
  setLibrarySearchScanUncategorized,
  libraryRunOnCacheHit,
  setLibraryRunOnCacheHit,
  displayLibraryInResults,
  setDisplayLibraryInResults,
  libraryDeleteAllTile,
  setLibraryDeleteAllTile,
  libraryDeletePerStreamTile,
  setLibraryDeletePerStreamTile,
  setLibraryDeleteWarning,
  librarySkipTilePosition,
  setLibrarySkipTilePosition,
  libraryDeleteAllPackScope,
  setLibraryDeleteAllPackScope,
  absoluteEpisodeFallback,
  setAbsoluteEpisodeFallback,
  parallelAlternateTitleSearch,
  setParallelAlternateTitleSearch,
  aliasTitleFallback,
  setAliasTitleFallback,
  tvdbPreferEnglishTitle,
  setTvdbPreferEnglishTitle,
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
  easynewsTimeoutEnabled,
  setEasynewsTimeoutEnabled,
  easynewsTimeout,
  setEasynewsTimeout,
  easynewsMode,
  setEasynewsMode,
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
  prowlarrTimeoutEnabled,
  setProwlarrTimeoutEnabled,
  prowlarrTimeout,
  setProwlarrTimeout,
  nzbhydraUrl,
  setNzbhydraUrl,
  nzbhydraApiKey,
  setNzbhydraApiKey,
  showNzbhydraKey,
  setShowNzbhydraKey,
  nzbhydraUsername,
  setNzbhydraUsername,
  nzbhydraPassword,
  setNzbhydraPassword,
  showNzbhydraPassword,
  setShowNzbhydraPassword,
  nzbhydraTimeoutEnabled,
  setNzbhydraTimeoutEnabled,
  nzbhydraTimeout,
  setNzbhydraTimeout,
  syncedIndexers,
  setSyncedIndexers,
  syncStatus,
  setSyncStatus,
  syncMessage,
  setSyncMessage,
  selectedSyncedIndexer,
  setSelectedSyncedIndexer,
  handleReorderSyncedIndexer,
  failedLogos,
  setFailedLogos,
  getAvailableMovieMethods,
  getAvailableTvMethods,
  getAvailableAnimeMovieMethods,
  getAvailableAnimeTvMethods,
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
  const [showNzbhydraAdvanced, setShowNzbhydraAdvanced] = useState(false);

  // Hold-to-accelerate +/− handlers for the 3 top-level searcher timeouts.
  // Mirrors the wait-time stepper pattern from UltimateFallbackOverlay.
  const prowlarrTimeoutDec = useHoldRepeat(useCallback(() => setProwlarrTimeout(p => Math.max(1, p - 1)), [setProwlarrTimeout]));
  const prowlarrTimeoutInc = useHoldRepeat(useCallback(() => setProwlarrTimeout(p => Math.min(45, p + 1)), [setProwlarrTimeout]));
  const nzbhydraTimeoutDec = useHoldRepeat(useCallback(() => setNzbhydraTimeout(p => Math.max(1, p - 1)), [setNzbhydraTimeout]));
  const nzbhydraTimeoutInc = useHoldRepeat(useCallback(() => setNzbhydraTimeout(p => Math.min(45, p + 1)), [setNzbhydraTimeout]));
  const easynewsTimeoutDec = useHoldRepeat(useCallback(() => setEasynewsTimeout(p => Math.max(1, p - 1)), [setEasynewsTimeout]));
  const easynewsTimeoutInc = useHoldRepeat(useCallback(() => setEasynewsTimeout(p => Math.min(45, p + 1)), [setEasynewsTimeout]));
  const libraryThresholdDec = useHoldRepeat(useCallback(() => setLibrarySearchThreshold(p => Math.max(1, p - 1)), [setLibrarySearchThreshold]));
  const libraryThresholdInc = useHoldRepeat(useCallback(() => setLibrarySearchThreshold(p => Math.min(10, p + 1)), [setLibrarySearchThreshold]));
  const seasonPackPagesDec = useHoldRepeat(useCallback(() => setSeasonPackAdditionalPages(p => Math.max(1, p - 1)), [setSeasonPackAdditionalPages]));
  const seasonPackPagesInc = useHoldRepeat(useCallback(() => setSeasonPackAdditionalPages(p => Math.min(10, p + 1)), [setSeasonPackAdditionalPages]));
  const seriesPackPagesDec = useHoldRepeat(useCallback(() => setSeriesPackAdditionalPages(p => Math.max(1, p - 1)), [setSeriesPackAdditionalPages]));
  const seriesPackPagesInc = useHoldRepeat(useCallback(() => setSeriesPackAdditionalPages(p => Math.min(10, p + 1)), [setSeriesPackAdditionalPages]));
  const easynewsPagesDec = useHoldRepeat(useCallback(() => setEasynewsMaxPages(p => Math.max(1, p - 1)), [setEasynewsMaxPages]));
  const easynewsPagesInc = useHoldRepeat(useCallback(() => setEasynewsMaxPages(p => Math.min(10, p + 1)), [setEasynewsMaxPages]));

  /** Reset all sync-related UI state (called when credentials change or manager switches) */
  const resetSyncState = () => {
    setSyncedIndexers([]);
    setSelectedSyncedIndexer(null);
    setSyncStatus('idle');
    setSyncMessage('');
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
                          body: JSON.stringify({ url: nzbhydraUrl, apiKey: nzbhydraApiKey, username: nzbhydraUsername, password: nzbhydraPassword }),
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
                      <div className="flex items-start gap-2 text-xs text-slate-400">
                        <Crown className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span><span className="text-slate-300 font-medium">Anime-Aware Search</span> — Uses Kitsu canonical titles for anime with Cinemeta as fallback, searching both when they differ to maximize results</span>
                      </div>
                    </div>
                    <p className="text-xs text-amber-400/60 italic">
                      Enable Ultimate Text Search per-indexer below. For best results pair with TMDB and TVDB API keys.
                    </p>
                  </div>
                </div>

                {/* Absolute episode fallback (Ultimate Text Search retry on zero-result series queries) */}
                <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-300">Absolute Episode Fallback</div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        id="absolute-episode-fallback"
                        checked={absoluteEpisodeFallback}
                        onChange={(e) => setAbsoluteEpisodeFallback(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                  </div>
                  <div className="text-xs text-slate-500">When a series text-search returns zero results for a SxxExx query, retry with absolute episode numbering (Title E31 instead of S03E07). Applies to Ultimate Text Search only.</div>
                </div>

                {/* Alias Title Fallback (zero-result UTS retry with TVDB substring aliases) */}
                <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-300">Alias Title Fallback</div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        id="alias-title-fallback"
                        checked={aliasTitleFallback}
                        onChange={(e) => setAliasTitleFallback(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                  </div>
                  <div className="text-xs text-slate-500">When a search returns zero results, retry once per English alias from TVDB whose normalized form is a strict substring of the canonical title and substantially shorter. Helps shows whose release groups publish under a shortened name rather than the full canonical title. Applies to Ultimate Text Search only.</div>
                </div>

                {/* TVDB English title preference (substitute non-English canonical names with the English translation) */}
                <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-300">Always Resolve TVDB Title in English</div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        id="tvdb-prefer-english-title"
                        checked={tvdbPreferEnglishTitle}
                        onChange={(e) => setTvdbPreferEnglishTitle(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                  </div>
                  <div className="text-xs text-slate-500">When TVDB's canonical title is in a non-English language, substitute the English translation when one exists. Improves indexer match rates for English release groups. Toggling clears the TVDB title cache so the change applies on your next search. Applies to Ultimate Text Search only.</div>
                </div>

                {/* Parallel alternate-title search (Ultimate Text Search dual-title concurrency) */}
                <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-300">Always Search Alternate Titles In Parallel</div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        id="parallel-alternate-title-search"
                        checked={parallelAlternateTitleSearch}
                        onChange={(e) => setParallelAlternateTitleSearch(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                  </div>
                  <div className="text-xs text-slate-500">When alternate titles are available (Cinemeta vs TVDB/TMDB mismatch, or TVDB's native title vs its English translation when "Always Resolve TVDB Title in English" is on), query them in parallel with the primary instead of as a zero-result fallback. Doubles indexer load for shows with title mismatches. Applies to Ultimate Text Search only.</div>
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

              </div>

              {/* Anime — own card */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="text-sm font-medium text-slate-300">Anime</div>
                <div className="text-xs text-slate-500">Anime is detected automatically via the Fribb anime database or Cinemeta metadata. Configure anime search methods per-indexer below.</div>
                <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
                  <div className="text-xs font-medium text-slate-400 mb-1">Supported Anime IDs</div>
                  <div className="text-xs text-slate-500">Kitsu · MAL · AniList · AniDB</div>
                  <div className="text-xs text-slate-500 mt-1">Incoming anime IDs from metadata addons like AIOMetadata or Anime Kitsu are automatically resolved and mapped to the search methods configured per-indexer below.</div>
                </div>
              </div>

              {/* Display Library in Results — own card */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-slate-300">Display library in results</div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      id="display-library-in-results"
                      checked={displayLibraryInResults}
                      onChange={(e) => setDisplayLibraryInResults(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                  </label>
                </div>
                <div className="text-xs text-slate-500">Mark search results that already exist in your library with the 📚 icon. Adds a quick WebDAV check to each result before sending to Stremio.</div>
              </div>

              {/* Ultimate Library — primary search source */}
              <div className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-yellow-500/5 to-amber-500/5">
                <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 via-transparent to-yellow-500/5 animate-pulse" style={{ animationDuration: '4s' }} />
                <div className="relative p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                        <Crown className="w-3.5 h-3.5 text-white" />
                      </div>
                      <h3 className="text-sm font-bold bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">Ultimate Library</h3>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={librarySearchThreshold > 0}
                        onChange={(e) => setLibrarySearchThreshold(e.target.checked ? 1 : 0)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                    </label>
                  </div>
                  <div className="space-y-2 text-xs text-slate-300 leading-relaxed">
                    <p>Scan your WebDAV library before any indexer is queried.</p>
                    <p>When Ultimate Library returns at least the configured number of results after filtering, indexer searches are skipped entirely.</p>
                    <p>Supports <span className="bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent font-semibold">Ultimate Fallback</span> and is powered by <span className="bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent font-semibold">Ultimate Text Search</span>.</p>
                  </div>
                  <p className="text-xs text-amber-400/60 italic">Pairs best with Season and Series Packs enabled.</p>

                  {librarySearchThreshold > 0 && (
                    <div className="space-y-3 pt-2 border-t border-amber-500/20">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-slate-300 font-medium">Result Threshold</span>
                        <div className="flex items-center gap-2">
                          <button
                            {...libraryThresholdDec}
                            aria-label="Decrease library threshold"
                            className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                          >−</button>
                          <span className="text-lg font-bold text-amber-400/90 tabular-nums w-10 text-center">{librarySearchThreshold}</span>
                          <button
                            {...libraryThresholdInc}
                            aria-label="Increase library threshold"
                            className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                          >+</button>
                        </div>
                      </div>
                      <p className="text-xs text-amber-400/60 italic">Skip indexer queries when the library returns as least this many results after filtering · NzbDAV streaming mode only</p>

                      <div className="space-y-3 pt-3 border-t border-amber-500/20">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-slate-300 font-medium">Apply to Movies</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={libraryApplyToMovies}
                              onChange={(e) => setLibraryApplyToMovies(e.target.checked)}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                          </label>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-slate-300 font-medium">Apply to TV</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={libraryApplyToSeries}
                              onChange={(e) => setLibraryApplyToSeries(e.target.checked)}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                          </label>
                        </div>
                        <p className="text-xs text-amber-400/60 italic">Scope which content types Ultimate Library applies to.</p>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-3 border-t border-amber-500/20">
                        <span className="text-xs text-slate-300 font-medium">Scan Uncategorized</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={librarySearchScanUncategorized}
                            onChange={(e) => setLibrarySearchScanUncategorized(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                        </label>
                      </div>
                      <p className="text-xs text-amber-400/60 italic">Scan <code className="text-amber-300/80">/content/uncategorized</code>, in additon to the default categories, for content that's been manually uploaded to the default location in NzbDAV.</p>

                      <div className="flex items-center justify-between gap-3 pt-3 border-t border-amber-500/20">
                        <span className="text-xs text-slate-300 font-medium">Run on Cache Hit</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={libraryRunOnCacheHit}
                            onChange={(e) => setLibraryRunOnCacheHit(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                        </label>
                      </div>
                      <div className="text-xs text-amber-400/60 italic space-y-1">
                        <p>When enabled, Ultimate Library runs on every request, including when cached results exist.</p>
                        <p>If the post-filter Ultimate Library scan meets your threshold, library results replace the cached results for that request.</p>
                        <p>Otherwise, the cached results are returned.</p>
                        <p>The "Skip Ultimate Library" stream tile will bypass Ultimate Library and return cached results, if they exist, on the next request.</p>
                      </div>

                      <div className="space-y-3 pt-3 border-t border-amber-500/20">
                        <div className="text-sm font-semibold text-slate-200 py-2">Skip Ultimate Library Stream Tile</div>

                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-slate-300 font-medium">Tile Position</span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setLibrarySkipTilePosition('second')}
                              className={clsx(
                                "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
                                librarySkipTilePosition === 'second'
                                  ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                                  : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                              )}
                            >First</button>
                            <button
                              onClick={() => setLibrarySkipTilePosition('last')}
                              className={clsx(
                                "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
                                librarySkipTilePosition === 'last'
                                  ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                                  : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                              )}
                            >Last</button>
                          </div>
                        </div>
                        <div className="text-xs text-amber-400/60 italic space-y-1">
                          <p>A "Skip Ultimate Library" stream tile is added to the results list when Ultimate Library displays results.</p>
                          <p>Clicking the tile arms a one-time bypass.</p>
                          <p>Your next search for the same content skips Ultimate Library and queries your indexers instead.</p>
                          <p>This allows you to fetch new content from your enabled indexers.</p>
                          <p>Use the position selector to pin the tile to the top slot (or second if Ultimate Fallback is enabled) or to the end of the results list.</p>
                        </div>
                      </div>

                      <div className="space-y-3 pt-3 border-t border-amber-500/20">
                        <div className="text-sm font-semibold text-slate-200 py-2">Manage your WebDAV library from the Ultimate Library results list</div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-slate-300 font-medium">Stream Tile: Delete All Results From WebDAV</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={libraryDeleteAllTile}
                              onChange={(e) => {
                                if (e.target.checked && !libraryDeleteAllTile) {
                                  setLibraryDeleteWarning({ show: true, toggleType: 'all' });
                                } else {
                                  setLibraryDeleteAllTile(e.target.checked);
                                }
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                          </label>
                        </div>
                        <div className="text-xs text-amber-400/60 italic space-y-1">
                          <p>Enabling this toggle adds a "Delete All Results From WebDAV" stream tile to the results list.</p>
                          <p>The tile is placed immediately after the "Skip Ultimate Library" tile, so its position follows whichever slot you chose above (top or last).</p>
                          <p>Clicking the tile deletes all Ultimate Library results for the current request from your WebDAV mount.</p>
                          <p>For series / season pack results, the pack-scope selector below decides whether the tile deletes the per-episode file or the entire release pack.</p>
                        </div>

                        {libraryDeleteAllTile && (
                          <div className="flex items-center justify-between gap-3 pt-1">
                            <span className="text-xs text-slate-300 font-medium">Pack scope</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setLibraryDeleteAllPackScope('episode')}
                                className={clsx(
                                  "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
                                  libraryDeleteAllPackScope === 'episode'
                                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                                )}
                              >Episode</button>
                              <button
                                onClick={() => setLibraryDeleteAllPackScope('pack')}
                                className={clsx(
                                  "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
                                  libraryDeleteAllPackScope === 'pack'
                                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                                )}
                              >Pack</button>
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between gap-3 pt-2">
                          <span className="text-xs text-slate-300 font-medium">Stream Tile: Delete Result From WebDAV</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={libraryDeletePerStreamTile}
                              onChange={(e) => {
                                if (e.target.checked && !libraryDeletePerStreamTile) {
                                  setLibraryDeleteWarning({ show: true, toggleType: 'perStream' });
                                } else {
                                  setLibraryDeletePerStreamTile(e.target.checked);
                                }
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                          </label>
                        </div>
                        <div className="text-xs text-amber-400/60 italic space-y-1">
                          <p>Enabling this toggle adds a "Delete The (Above / Left) Result From WebDAV" stream tile to the results list.</p>
                          <p>The stream tile is placed after the stream it deletes in the results list.</p>
                          <p>Clicking the tile deletes the individual result from your WebDAV mount.</p>
                          <p>For season / series pack results, an additional tile is placed next in the results list that allows you to delete the entire season / series pack for that result.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Season Packs — own card, separate from Search Settings */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-300">Season Packs</div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeSeasonPacks}
                      onChange={(e) => setIncludeSeasonPacks(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  Requests an extra <code className="text-slate-400">Show Title Sxx</code> query (e.g., <code className="text-slate-400">Show Title S03</code>) per enabled indexer to catch full-season releases (size estimated per episode for sorting). Adds one query per indexer per search.
                </p>

                {includeSeasonPacks && (
                  <div className="space-y-3 pt-2 border-t border-slate-700/30">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="season-pack-pagination" className="flex-1 cursor-pointer text-xs text-slate-400">
                        Enable pagination for season pack searches
                      </label>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          id="season-pack-pagination"
                          checked={seasonPackPagination}
                          onChange={(e) => setSeasonPackPagination(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                      </label>
                    </div>
                    {seasonPackPagination && (
                      <div className="flex items-center gap-3">
                        <TimeoutStepper
                          value={seasonPackAdditionalPages}
                          defaultValue={1}
                          min={1}
                          max={10}
                          decProps={seasonPackPagesDec}
                          incProps={seasonPackPagesInc}
                          onChange={setSeasonPackAdditionalPages}
                          unit="pages"
                          ariaLabel="additional pages"
                          compact
                        />
                        <span className="text-xs text-slate-500">Extra pages for season pack searches</span>
                      </div>
                    )}
                  </div>
                )}

              </div>

              {/* Series Packs (own card) */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-300">Series Packs</div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeMultiSeasonPacks}
                      onChange={(e) => setIncludeMultiSeasonPacks(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  Requests an extra <code className="text-slate-400">Show Title S01</code> query for non-S01 searches to catch starts-at-S01 multi-season packs (S01-S06, etc.). Adds one query per indexer per search when season &gt; 1.
                </p>
                {includeMultiSeasonPacks && (
                  <>
                    <div className="pt-3 border-t border-slate-700/30 space-y-2">
                      <div className="text-xs font-medium text-slate-300">Keyword queries</div>
                      <p className="text-xs text-slate-500">
                        Each selected keyword requests a <code className="text-slate-400">Show Title &lt;keyword&gt;</code> query. Adds value for keyword-only releases without Sxx tokens. Click a chip to enable; deselect all to disable the feature.
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {SERIES_PACK_KEYWORDS.map((kw) => {
                          const checked = seriesPackKeywords.includes(kw);
                          return (
                            <button
                              key={kw}
                              type="button"
                              onClick={() => {
                                if (checked) {
                                  setSeriesPackKeywords(seriesPackKeywords.filter(k => k !== kw));
                                } else {
                                  setSeriesPackKeywords([...seriesPackKeywords, kw]);
                                }
                              }}
                              className={clsx(
                                "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
                                checked
                                  ? "bg-primary-500/20 border-primary-500/50 text-primary-300"
                                  : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                              )}
                            >{kw}</button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-slate-500">Each enabled keyword adds one query per indexer per search.</p>
                    </div>

                    <div className="pt-3 border-t border-slate-700/30 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="series-pack-pagination" className="flex-1 cursor-pointer text-xs text-slate-400">
                          Enable pagination for series pack searches
                        </label>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            id="series-pack-pagination"
                            checked={seriesPackPagination}
                            onChange={(e) => setSeriesPackPagination(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                        </label>
                      </div>
                      {seriesPackPagination && (
                        <div className="flex items-center gap-3">
                          <TimeoutStepper
                            value={seriesPackAdditionalPages}
                            defaultValue={1}
                            min={1}
                            max={10}
                            decProps={seriesPackPagesDec}
                            incProps={seriesPackPagesInc}
                            onChange={setSeriesPackAdditionalPages}
                            unit="pages"
                            ariaLabel="additional pages"
                            compact
                          />
                          <span className="text-xs text-slate-500">Extra pages for series pack searches</span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Results Deduplication — own card */}
              <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
                <div className="text-sm font-medium text-slate-300">Results Deduplication</div>

                {/* URL Deduplication */}
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="url-dedup" className="flex-1 cursor-pointer">
                    <div className="text-sm font-medium text-slate-300">URL Deduplication</div>
                    <div className="text-xs text-slate-500 mt-0.5">Remove duplicate results that share the same download URL. These NZBs always reference the same articles, so keeping only the first occurrence has no effect on results.</div>
                  </label>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      id="url-dedup"
                      checked={urlDedup}
                      onChange={(e) => setUrlDedup(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                  </label>
                </div>

                {/* Indexer Priority Dedup */}
                <div className="pt-3 border-t border-slate-700/30 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="indexer-priority-dedup" className="flex-1 cursor-pointer">
                      <div className="text-sm font-medium text-slate-300">Indexer Priority Deduplication</div>
                      <div className="text-xs text-slate-500 mt-0.5">When duplicate NZBs are found across indexers (same title + size), keep only the copy from the highest-priority indexer. Note: even identical uploads may have different articles across indexers.</div>
                    </label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        id="indexer-priority-dedup"
                        checked={indexerPriorityDedup}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          setIndexerPriorityDedup(enabled);
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
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                  </div>

                  {indexerPriorityDedup && indexerPriority.length > 0 && (
                    <div className="space-y-1.5">
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
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="easynews-timeout-enabled" className="flex-1 cursor-pointer">
                          <span className="text-xs text-slate-400">Request timeout</span>
                          <span className="text-[10px] text-slate-500 ml-1.5">Limit how long to wait for EasyNews responses</span>
                        </label>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            id="easynews-timeout-enabled"
                            checked={easynewsTimeoutEnabled}
                            onChange={(e) => setEasynewsTimeoutEnabled(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                        </label>
                      </div>
                      {easynewsTimeoutEnabled && (
                        <div className="pl-6">
                          <TimeoutStepper
                            value={easynewsTimeout}
                            defaultValue={DEFAULT_INDEXER_TIMEOUT_SECONDS}
                            decProps={easynewsTimeoutDec}
                            incProps={easynewsTimeoutInc}
                            onChange={setEasynewsTimeout}
                            inputId="easynews-timeout-seconds"
                          />
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="easynews-pagination" className="flex-1 cursor-pointer">
                          <span className="text-xs text-slate-400">Paginated search</span>
                          <span className="text-[10px] text-slate-500 ml-1.5">Fetch additional pages of results (250 results/page)</span>
                        </label>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            id="easynews-pagination"
                            checked={easynewsPagination}
                            onChange={(e) => setEasynewsPagination(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                        </label>
                      </div>
                      {easynewsPagination && (
                        <div className="pl-6">
                          <TimeoutStepper
                            value={easynewsMaxPages}
                            defaultValue={1}
                            min={1}
                            max={10}
                            decProps={easynewsPagesDec}
                            incProps={easynewsPagesInc}
                            onChange={setEasynewsMaxPages}
                            unit="pages"
                            ariaLabel="additional pages"
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
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="prowlarr-timeout-enabled" className="flex-1 cursor-pointer">
                        <span className="text-sm text-slate-300">Request timeout</span>
                        <span className="text-xs text-slate-500 ml-2">Limit how long to wait for Prowlarr responses</span>
                      </label>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          id="prowlarr-timeout-enabled"
                          checked={prowlarrTimeoutEnabled}
                          onChange={(e) => setProwlarrTimeoutEnabled(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                      </label>
                    </div>
                    {prowlarrTimeoutEnabled && (
                      <div className="pl-6">
                        <TimeoutStepper
                          value={prowlarrTimeout}
                          defaultValue={DEFAULT_INDEXER_TIMEOUT_SECONDS}
                          decProps={prowlarrTimeoutDec}
                          incProps={prowlarrTimeoutInc}
                          onChange={setProwlarrTimeout}
                          inputId="prowlarr-timeout-seconds"
                        />
                      </div>
                    )}
                  </div>

                  <button
                    data-prowlarr-sync
                    onClick={async () => {
                      setSyncStatus('syncing');
                      setSyncMessage('');
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
                        setTimeout(() => document.querySelector('[data-prowlarr-sync]')?.closest('.overflow-y-auto')?.scrollTo({ top: 999999, behavior: 'smooth' }), 50);
                      } catch (e: any) {
                        setSyncedIndexers([]);
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
                              onClick={() => { const opening = selectedSyncedIndexer !== indexer.id; setSelectedSyncedIndexer(opening ? indexer.id : null); if (opening) setTimeout(() => document.querySelector('[data-indexer-detail]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); }}
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
                          <div data-indexer-detail className="p-3 bg-slate-800/70 rounded-lg border border-slate-600 space-y-3">
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
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Anime Movie Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableAnimeMovieMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(indexer.animeMovieSearchMethod || ['text']).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = indexer.animeMovieSearchMethod || ['text'];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ animeMovieSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Anime TV Shows Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableAnimeTvMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(indexer.animeTvSearchMethod || ['text']).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = indexer.animeTvSearchMethod || ['text'];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ animeTvSearchMethod: updated as any });
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
                                <div className="pl-6">
                                  <PagesStepper
                                    value={indexer.additionalPages ?? 3}
                                    onChange={(v) => updateSynced({ additionalPages: v })}
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

                  {/* Collapsible credentials — needed when stats API access is disabled in NZBHydra */}
                  <div>
                    <button
                      type="button"
                      onClick={() => { setShowNzbhydraAdvanced(v => { if (!v) setTimeout(() => document.querySelector('[data-nzbhydra-sync]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); return !v; }); }}
                      className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      <ChevronDown className={clsx('w-4 h-4 transition-transform', showNzbhydraAdvanced && 'rotate-180')} />
                      Stats Access Disabled
                    </button>
                    {showNzbhydraAdvanced && (
                      <div className="mt-3 space-y-3 pl-6 border-l border-slate-700/50">
                        <p className="text-xs text-slate-500">Only needed if <code className="bg-slate-700/50 px-1 rounded text-slate-400">Allow access to stats via external API = Off</code> in NZBHydra. Works with both Form and Basic auth types.</p>
                        <div>
                          <label className="block text-sm font-medium text-slate-300 mb-2">Username</label>
                          <input type="text" value={nzbhydraUsername} onChange={(e) => { setNzbhydraUsername(e.target.value); resetSyncState(); }} placeholder="NZBHydra2 username" className="input" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-300 mb-2">Password</label>
                          <div className="relative">
                            <input type={showNzbhydraPassword ? 'text' : 'password'} value={nzbhydraPassword} onChange={(e) => { setNzbhydraPassword(e.target.value); resetSyncState(); }} placeholder="NZBHydra2 password" className="input pr-9" />
                            {nzbhydraPassword && (
                              <button
                                type="button"
                                onClick={() => setShowNzbhydraPassword(v => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                              >
                                {showNzbhydraPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="nzbhydra-timeout-enabled" className="flex-1 cursor-pointer">
                        <span className="text-sm text-slate-300">Request timeout</span>
                        <span className="text-xs text-slate-500 ml-2">Limit how long to wait for NZBHydra responses</span>
                      </label>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          id="nzbhydra-timeout-enabled"
                          checked={nzbhydraTimeoutEnabled}
                          onChange={(e) => setNzbhydraTimeoutEnabled(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                      </label>
                    </div>
                    {nzbhydraTimeoutEnabled && (
                      <div className="pl-6">
                        <TimeoutStepper
                          value={nzbhydraTimeout}
                          defaultValue={DEFAULT_INDEXER_TIMEOUT_SECONDS}
                          decProps={nzbhydraTimeoutDec}
                          incProps={nzbhydraTimeoutInc}
                          onChange={setNzbhydraTimeout}
                          inputId="nzbhydra-timeout-seconds"
                        />
                      </div>
                    )}
                  </div>

                  <button
                    data-nzbhydra-sync
                    onClick={async () => {
                      setSyncStatus('syncing');
                      setSyncMessage('');
                      setSelectedSyncedIndexer(null);
                      try {
                        const resp = await apiFetch('/api/nzbhydra/sync', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url: nzbhydraUrl, apiKey: nzbhydraApiKey, username: nzbhydraUsername, password: nzbhydraPassword }),
                        });
                        const data = await resp.json();
                        if (!resp.ok || data.error) throw new Error(data.error || data.message || `Server error (${resp.status})`);
                        setSyncedIndexers(data.indexers || []);
                        setSyncStatus('success');
                        setSyncMessage(`Synced ${data.total} indexer(s)`);
                        setTimeout(() => document.querySelector('[data-nzbhydra-sync]')?.closest('.overflow-y-auto')?.scrollTo({ top: 999999, behavior: 'smooth' }), 50);
                      } catch (e: any) {
                        setSyncedIndexers([]);
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
                              onClick={() => { const opening = selectedSyncedIndexer !== indexer.id; setSelectedSyncedIndexer(opening ? indexer.id : null); if (opening) setTimeout(() => document.querySelector('[data-indexer-detail]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); }}
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
                          <div data-indexer-detail className="p-3 bg-slate-800/70 rounded-lg border border-slate-600 space-y-3">
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
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Anime Movie Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableAnimeMovieMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(indexer.animeMovieSearchMethod || ['text']).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = indexer.animeMovieSearchMethod || ['text'];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ animeMovieSearchMethod: updated as any });
                                        }}
                                        className="accent-blue-500"
                                      />
                                      {renderMethodLabel(m)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Anime TV Shows Search</label>
                                <div className="flex flex-wrap gap-2">
                                  {getAvailableAnimeTvMethods(indexer.capabilities || null).map(m => (
                                    <label key={m.value} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={(indexer.animeTvSearchMethod || ['text']).includes(m.value as any)}
                                        onChange={(e) => {
                                          const current = indexer.animeTvSearchMethod || ['text'];
                                          const updated = e.target.checked
                                            ? [...current, m.value]
                                            : current.filter(v => v !== m.value);
                                          if (updated.length > 0) updateSynced({ animeTvSearchMethod: updated as any });
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
                                <div className="pl-6">
                                  <PagesStepper
                                    value={indexer.additionalPages ?? 3}
                                    onChange={(v) => updateSynced({ additionalPages: v })}
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
                                indexer.zyclops?.enabled
                                  ? 'bg-violet-400 shadow-lg shadow-violet-400/50 animate-pulse'
                                  : indexer.enabled ? 'bg-green-400 shadow-lg shadow-green-400/50 animate-pulse' : 'bg-slate-600'
                              )} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-slate-200 truncate">{indexer.name}</div>
                              <div className="text-xs text-slate-400 truncate">{indexer.url}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              disabled={!!indexer.zyclops?.enabled}
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
                                'px-3 py-1 rounded-full text-xs font-medium flex-shrink-0 transition-colors',
                                indexer.zyclops?.enabled
                                  ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30 cursor-not-allowed opacity-60'
                                  : indexer.enabled
                                    ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 cursor-pointer'
                                    : 'bg-slate-600/20 text-slate-400 border border-slate-600/30 hover:bg-slate-600/30 cursor-pointer'
                              )}
                              title={indexer.zyclops?.enabled ? `${indexer.name} — managed by Zyclops 🤖` : undefined}
                              aria-label={indexer.zyclops?.enabled ? `${indexer.name} is managed by Zyclops` : `Toggle ${indexer.name} ${indexer.enabled ? 'off' : 'on'}`}
                            >
                              {indexer.zyclops?.enabled ? 'Zyclops 🤖' : indexer.enabled ? 'Active' : 'Inactive'}
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

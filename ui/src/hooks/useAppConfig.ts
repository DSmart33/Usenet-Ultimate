// What this does:
//   Custom React hook that manages all configuration-related state, fetching,
//   and auto-save effects for the Usenet Ultimate UI.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  Config,
  SyncedIndexer,
  StreamDisplayConfig,
  HealthChecksState,
  AutoPlayState,
  FiltersState,
  OverlayType,
  Tab,
  IndexerCaps,
  NewIndexerForm,
  EditIndexerForm,
  ElementDragState,
  ElementDragOverState,
  UserAgents,
} from '../types';
import {
  DEFAULT_STREAM_DISPLAY,
  DEFAULT_HEALTH_CHECKS,
  DEFAULT_FILTERS,
  DEFAULT_CARD_ORDER,
} from '../constants';
import { normalizeLineGroups } from '../utils/streamPreview';
import { formatTTL, decomposeTTL, composeTTL } from '../utils/ttl';

// Re-export TTL utilities so consumers don't need to import separately
export { formatTTL, decomposeTTL, composeTTL };

// Re-export types so consumers of this hook can access them
export type { IndexerCaps, NewIndexerForm, EditIndexerForm, ElementDragState, ElementDragOverState, UserAgents };

import type { ApiFetch } from '../types';

const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_NEW_INDEXER: NewIndexerForm = {
  name: '', url: '', apiKey: '', website: '', logo: '',
  movieSearchMethod: ['text'], tvSearchMethod: ['text'],
  caps: null, pagination: false, maxPages: 3,
};

const DEFAULT_EDIT_FORM: EditIndexerForm = {
  name: '', url: '', apiKey: '', enabled: true, website: '', logo: '',
  movieSearchMethod: ['text'], tvSearchMethod: ['text'],
  caps: null, pagination: false, maxPages: 3,
};

export function useAppConfig(apiFetch: ApiFetch, _authStatus: string) {
  // ─── Config & general UI state ──────────────────────────────────────
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [addonEnabled, setAddonEnabled] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [showAddIndexer, setShowAddIndexer] = useState(false);
  const [newIndexer, setNewIndexer] = useState<NewIndexerForm>({ ...DEFAULT_NEW_INDEXER });
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [editForm, setEditForm] = useState<EditIndexerForm>({ ...DEFAULT_EDIT_FORM });
  const [capsLoading, setCapsLoading] = useState<'new' | 'edit' | null>(null);
  const [expandedIndexer, setExpandedIndexer] = useState<string | null>(null);
  const [draggedIndexer, setDraggedIndexer] = useState<string | null>(null);
  const [dragOverIndexer, setDragOverIndexer] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { loading: boolean; success?: boolean; message?: string; results?: number; titles?: string[] }>>({});
  const [testQuery, setTestQuery] = useState<Record<string, string>>({});
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ show: boolean; indexerName: string }>({ show: false, indexerName: '' });
  const [activeOverlay, setActiveOverlay] = useState<OverlayType>(null);
  const [failedLogos, setFailedLogos] = useState<Set<string>>(new Set());
  const [showApiKey, setShowApiKey] = useState<{ new: boolean; edit: boolean }>({ new: false, edit: false });

  // ─── Cache ──────────────────────────────────────────────────────────
  const [cacheTTL, setCacheTTL] = useState<number>(43200);

  // ─── Streaming & Index Manager ──────────────────────────────────────
  const [streamingMode, setStreamingMode] = useState<'nzbdav' | 'stremio'>('nzbdav');
  const [indexManager, setIndexManager] = useState<'newznab' | 'prowlarr' | 'nzbhydra'>('newznab');

  // ─── Proxy ──────────────────────────────────────────────────────────
  const [proxyMode, setProxyMode] = useState<'disabled' | 'http'>('disabled');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyStatus, setProxyStatus] = useState<'connected' | 'disconnected' | 'checking' | null>(null);
  const [proxyIp, setProxyIp] = useState<string>('');
  const [localIp, setLocalIp] = useState<string>('');
  const [proxyIndexers, setProxyIndexers] = useState<Record<string, boolean>>({});

  // ─── Search config ──────────────────────────────────────────────────
  const [tmdbApiKey, setTmdbApiKey] = useState('');
  const [tvdbApiKey, setTvdbApiKey] = useState('');
  const [includeSeasonPacks, setIncludeSeasonPacks] = useState(true);
  const [seasonPackPagination, setSeasonPackPagination] = useState(true);
  const [seasonPackAdditionalPages, setSeasonPackAdditionalPages] = useState(1);
  const [useTextSearchForAnime, setUseTextSearchForAnime] = useState(true);
  const [skipAnimeTitleResolve, setSkipAnimeTitleResolve] = useState(true);
  const [indexerPriorityDedup, setIndexerPriorityDedup] = useState(false);
  const [indexerPriority, setIndexerPriority] = useState<string[]>([]);
  const [dedupDraggedItem, setDedupDraggedItem] = useState<string | null>(null);
  const [dedupDragOverItem, setDedupDragOverItem] = useState<string | null>(null);
  const [tmdbKeyStatus, setTmdbKeyStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [tvdbKeyStatus, setTvdbKeyStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showTvdbKey, setShowTvdbKey] = useState(false);

  const [showProwlarrKey, setShowProwlarrKey] = useState(false);
  const [showNzbhydraKey, setShowNzbhydraKey] = useState(false);

  // ─── Prowlarr / NZBHydra ───────────────────────────────────────────
  const [prowlarrUrl, setProwlarrUrl] = useState('http://localhost:9696');
  const [prowlarrApiKey, setProwlarrApiKey] = useState('');
  const [nzbhydraUrl, setNzbhydraUrl] = useState('http://localhost:5076');
  const [nzbhydraApiKey, setNzbhydraApiKey] = useState('');

  // ─── NZBDav ─────────────────────────────────────────────────────────
  const [nzbdavUrl, setNzbdavUrl] = useState('http://localhost:3000');
  const [nzbdavApiKey, setNzbdavApiKey] = useState('');
  const [nzbdavWebdavUrl, setNzbdavWebdavUrl] = useState('http://localhost:3000');
  const [nzbdavWebdavUser, setNzbdavWebdavUser] = useState('');
  const [nzbdavWebdavPassword, setNzbdavWebdavPassword] = useState('');
  const [nzbdavMoviesCategory, setNzbdavMoviesCategory] = useState('Usenet-Ultimate-Movies');
  const [nzbdavTvCategory, setNzbdavTvCategory] = useState('Usenet-Ultimate-TV');
  const [nzbdavMaxFallbacks, setNzbdavMaxFallbacks] = useState(9);
  const [nzbdavStreamBufferMB, setNzbdavStreamBufferMB] = useState(64);
  const [nzbdavConnectionStatus, setNzbdavConnectionStatus] = useState<'connected' | 'disconnected' | 'unconfigured' | 'checking' | null>(null);
  const [nzbdavTestNzbStatus, setNzbdavTestNzbStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [nzbdavTestNzbMessage, setNzbdavTestNzbMessage] = useState('');

  // ─── EasyNews ───────────────────────────────────────────────────────
  const [easynewsEnabled, setEasynewsEnabled] = useState(false);
  const [easynewsUsername, setEasynewsUsername] = useState('');
  const [easynewsPassword, setEasynewsPassword] = useState('');
  const [easynewsPagination, setEasynewsPagination] = useState(false);
  const [easynewsMaxPages, setEasynewsMaxPages] = useState(3);
  const [easynewsMode, setEasynewsMode] = useState<'ddl' | 'nzb'>('nzb');
  const [easynewsHealthCheck, setEasynewsHealthCheck] = useState(false);
  const [showEasynewsPassword, setShowEasynewsPassword] = useState(false);
  const [easynewsTestStatus, setEasynewsTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [easynewsTestMessage, setEasynewsTestMessage] = useState('');

  // ─── Zyclops ────────────────────────────────────────────────────────
  const [zyclopsEndpoint, setZyclopsEndpoint] = useState('https://zyclops.elfhosted.com');
  const [zyclopsTestStatus, setZyclopsTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [zyclopsTestMessage, setZyclopsTestMessage] = useState('');
  const [zyclopsConfirmDialog, setZyclopsConfirmDialog] = useState<{ show: boolean; indexerName: string }>({ show: false, indexerName: '' });
  const [singleIpConfirmDialog, setSingleIpConfirmDialog] = useState<{ show: boolean; indexerName: string }>({ show: false, indexerName: '' });

  // ─── User-Agent ─────────────────────────────────────────────────────
  const defaultChromeUA = DEFAULT_CHROME_UA;
  const [userAgents, setUserAgents] = useState({
    indexerSearch: 'Prowlarr/2.3.0.5236 (alpine 3.22.2)',
    nzbDownload: 'SABnzbd/4.5.5',
    nzbdavOperations: 'SABnzbd/4.5.5',
    webdavOperations: 'SABnzbd/4.5.5',
    general: defaultChromeUA
  });

  // ─── Filters ────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<FiltersState>({ ...DEFAULT_FILTERS });
  const [movieFilters, setMovieFilters] = useState<FiltersState | null>(null);
  const [tvFilters, setTvFilters] = useState<FiltersState | null>(null);

  // ─── Stats ──────────────────────────────────────────────────────────
  const [statsData, setStatsData] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsSortBy, setStatsSortBy] = useState<'score' | 'successRate' | 'avgResponseTime' | 'avgResultsPerQuery' | 'totalGrabs'>('score');
  const [statsSortDir, setStatsSortDir] = useState<'asc' | 'desc'>('desc');
  const [statsExpandedIndexer, setStatsExpandedIndexer] = useState<string | null>(null);

  // ─── Health Checks ──────────────────────────────────────────────────
  const [healthChecks, setHealthChecks] = useState<HealthChecksState>({ ...DEFAULT_HEALTH_CHECKS });
  const [syncedIndexers, setSyncedIndexers] = useState<SyncedIndexer[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState('');
  const [selectedSyncedIndexer, setSelectedSyncedIndexer] = useState<string | null>(null);
  const [connectionTestStatus, setConnectionTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [connectionTestMessage, setConnectionTestMessage] = useState('');

  // ─── Auto Play ──────────────────────────────────────────────────────
  const [autoPlay, setAutoPlay] = useState<AutoPlayState>({
    enabled: true, method: 'firstFile', attributes: ['resolution', 'quality', 'edition']
  });

  // ─── Stream Display ─────────────────────────────────────────────────
  const [streamDisplayConfig, setStreamDisplayConfig] = useState<StreamDisplayConfig>(normalizeLineGroups(DEFAULT_STREAM_DISPLAY));
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<string | null>(null);
  const [emojiSearch, setEmojiSearch] = useState('');
  const [elementDrag, setElementDrag] = useState<ElementDragState | null>(null);
  const [elementDragOver, setElementDragOver] = useState<ElementDragOverState | null>(null);
  const [draggedLineGroup, setDraggedLineGroup] = useState<string | null>(null);
  const [dragOverLineGroup, setDragOverLineGroup] = useState<string | null>(null);

  // ─── Dashboard card order ───────────────────────────────────────────
  const [cardOrder, setCardOrder] = useState<string[]>([...DEFAULT_CARD_ORDER]);
  const [draggedCard, setDraggedCard] = useState<string | null>(null);
  const [dragOverCard, setDragOverCard] = useState<string | null>(null);

  // ─── Refs ───────────────────────────────────────────────────────────
  const initialLoadDone = useRef(false);
  const nzbdavFieldsChanged = useRef(false);
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;

  // ─── Segment cache convenience value ────────────────────────────────
  const segmentCacheMaxSizeMB = healthChecks.segmentCache?.maxSizeMB ?? 50;

  // ─── Internal auto-save helper ──────────────────────────────────────
  const saveSettings = useCallback(
    async (settings: Record<string, unknown>) => {
      try {
        const response = await apiFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        if (response.ok) {
          const data = await response.json();
          setConfig(data);
        }
      } catch (error) {
        console.error('Failed to auto-save settings:', error);
      }
    },
    [apiFetch]
  );

  // ═══════════════════════════════════════════════════════════════════
  // Auto-save effects
  // ═══════════════════════════════════════════════════════════════════

  // Auto-save: cache TTL
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ cacheTTL }), 500);
    return () => clearTimeout(timer);
  }, [cacheTTL, saveSettings]);

  // Auto-save: user agents
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ userAgents }), 500);
    return () => clearTimeout(timer);
  }, [userAgents, saveSettings]);

  // Auto-save: filters (global + per-type)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ filters, movieFilters, tvFilters }), 500);
    return () => clearTimeout(timer);
  }, [filters, movieFilters, tvFilters, saveSettings]);

  // Auto-save: stream display config
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ streamDisplayConfig }), 500);
    return () => clearTimeout(timer);
  }, [streamDisplayConfig, saveSettings]);

  // Auto-save: health check settings (excludes providers - they have their own CRUD endpoints)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const { providers: _, ...healthCheckSettings } = healthChecks;
    const timer = setTimeout(() => saveSettings({ healthChecks: { ...healthCheckSettings, providers: undefined } }), 500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthChecks.enabled, healthChecks.archiveInspection, healthChecks.sampleCount, healthChecks.nzbsToInspect, healthChecks.inspectionMethod, healthChecks.smartBatchSize, healthChecks.smartAdditionalRuns, healthChecks.maxConnections, healthChecks.autoQueueMode, healthChecks.hideBlocked, healthChecks.libraryPreCheck, healthChecks.healthCheckIndexers, healthChecks.segmentCache, saveSettings]);

  // Auto-save: addon enabled/disabled
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ addonEnabled }), 300);
    return () => clearTimeout(timer);
  }, [addonEnabled, saveSettings]);

  // Auto-save: streaming/nzbdav settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({
      streamingMode, nzbdavUrl, nzbdavApiKey, nzbdavWebdavUrl, nzbdavWebdavUser, nzbdavWebdavPassword, nzbdavMoviesCategory, nzbdavTvCategory, nzbdavMaxFallbacks, nzbdavStreamBufferMB
    }), 500);
    return () => clearTimeout(timer);
  }, [streamingMode, nzbdavUrl, nzbdavApiKey, nzbdavWebdavUrl, nzbdavWebdavUser, nzbdavWebdavPassword, nzbdavMoviesCategory, nzbdavTvCategory, nzbdavMaxFallbacks, nzbdavStreamBufferMB, saveSettings]);

  // Auto-save: index manager type
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ indexManager }), 300);
    return () => clearTimeout(timer);
  }, [indexManager, saveSettings]);

  // Auto-save: easynews settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ easynewsEnabled, easynewsUsername, easynewsPassword, easynewsPagination, easynewsMaxPages: easynewsPagination ? easynewsMaxPages : undefined, easynewsMode, easynewsHealthCheck }), 500);
    return () => clearTimeout(timer);
  }, [easynewsEnabled, easynewsUsername, easynewsPassword, easynewsPagination, easynewsMaxPages, easynewsMode, easynewsHealthCheck, saveSettings]);

  // Auto-save: zyclops endpoint
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ zyclopsEndpoint }), 500);
    return () => clearTimeout(timer);
  }, [zyclopsEndpoint, saveSettings]);

  // Auto-save: search config (API keys, season packs - methods are now per-indexer)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({
      searchConfig: {
        tmdbApiKey: tmdbApiKey || undefined,
        tvdbApiKey: tvdbApiKey || undefined,
        includeSeasonPacks,
        seasonPackPagination: includeSeasonPacks ? seasonPackPagination : undefined,
        seasonPackAdditionalPages: includeSeasonPacks && seasonPackPagination ? seasonPackAdditionalPages : undefined,
        useTextSearchForAnime,
        skipAnimeTitleResolve,
        indexerPriorityDedup,
      },
      indexerPriority: indexerPriorityDedup ? indexerPriority : undefined,
    }), 300);
    return () => clearTimeout(timer);
  }, [tmdbApiKey, tvdbApiKey, includeSeasonPacks, seasonPackPagination, seasonPackAdditionalPages, useTextSearchForAnime, skipAnimeTitleResolve, indexerPriorityDedup, indexerPriority, saveSettings]);

  // Keep indexer priority list in sync when indexers or EasyNews change
  useEffect(() => {
    if (!initialLoadDone.current || !indexerPriorityDedup) return;
    const activeNames = new Set<string>();
    if (indexManager === 'newznab') {
      config?.indexers.filter(i => i.enabled).forEach(i => activeNames.add(i.name));
    } else {
      syncedIndexers.filter(i => i.enabledForSearch).forEach(i => activeNames.add(i.name));
    }
    if (easynewsEnabled) activeNames.add('EasyNews');

    const updated = [...indexerPriority];
    let changed = false;
    for (const name of activeNames) {
      if (!updated.includes(name)) {
        updated.push(name);
        changed = true;
      }
    }
    const filtered = updated.filter(name => activeNames.has(name));
    if (filtered.length !== updated.length) changed = true;

    if (changed) setIndexerPriority(filtered.length > 0 ? filtered : [...activeNames]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexerPriorityDedup, config?.indexers, syncedIndexers, easynewsEnabled, indexManager]);

  // Auto-save: proxy settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ proxyMode, proxyUrl, proxyIndexers }), 300);
    return () => clearTimeout(timer);
  }, [proxyMode, proxyUrl, proxyIndexers, saveSettings]);

  // Auto-save: auto-play / binge group settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ autoPlay }), 500);
    return () => clearTimeout(timer);
  }, [autoPlay, saveSettings]);

  // Auto-save: prowlarr settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ indexManager, prowlarrUrl, prowlarrApiKey }), 500);
    return () => clearTimeout(timer);
  }, [indexManager, prowlarrUrl, prowlarrApiKey, saveSettings]);

  // Auto-save: nzbhydra settings
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ indexManager, nzbhydraUrl, nzbhydraApiKey }), 500);
    return () => clearTimeout(timer);
  }, [indexManager, nzbhydraUrl, nzbhydraApiKey, saveSettings]);

  // Auto-save: synced indexers (Prowlarr/NZBHydra per-indexer settings)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const timer = setTimeout(() => saveSettings({ syncedIndexers }), 500);
    return () => clearTimeout(timer);
  }, [syncedIndexers, saveSettings]);

  // Auto-save: indexer edit form
  useEffect(() => {
    if (!expandedIndexer || !initialLoadDone.current) return;
    const savedName = expandedIndexer;
    const timer = setTimeout(async () => {
      const updates: Partial<typeof editFormRef.current> = { ...editFormRef.current };
      if (!updates.apiKey) delete updates.apiKey;
      try {
        const response = await apiFetch(`/api/indexers/${encodeURIComponent(savedName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        if (response.ok) await fetchIndexers();
      } catch (error) {
        console.error('Failed to auto-save indexer:', error);
      }
    }, 500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editForm.name, editForm.url, editForm.apiKey, editForm.enabled, JSON.stringify(editForm.movieSearchMethod), JSON.stringify(editForm.tvSearchMethod), editForm.caps, editForm.website, editForm.logo, editForm.pagination, editForm.maxPages, expandedIndexer]);

  // Reset NZBDav connection status when fields change after initial load
  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (!nzbdavFieldsChanged.current) {
      nzbdavFieldsChanged.current = true;
      return;
    }
    setNzbdavConnectionStatus(null);
  }, [streamingMode, nzbdavUrl, nzbdavApiKey, nzbdavWebdavUrl, nzbdavWebdavUser, nzbdavWebdavPassword]);

  // Check proxy when proxy mode changes
  useEffect(() => {
    if (proxyMode === 'http') checkProxyStatus();
    else { setProxyStatus(null); setProxyIp(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyMode]);

  // ═══════════════════════════════════════════════════════════════════
  // Fetch functions
  // ═══════════════════════════════════════════════════════════════════

  const fetchIndexers = async () => {
    try {
      const response = await apiFetch('/api/indexers');
      const indexers = await response.json();
      setConfig(prev => prev ? { ...prev, indexers } : null);
    } catch (error) {
      console.error('Failed to fetch indexers:', error);
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await apiFetch('/api/config');
      const data = await response.json();
      setConfig(data);
      setAddonEnabled(data.addonEnabled !== false);
      setCacheTTL(data.cacheTTL ?? 43200);
      setStreamingMode(data.streamingMode || 'nzbdav');
      setIndexManager(data.indexManager || 'newznab');
      setProxyMode(data.proxyMode || 'disabled');
      setProxyUrl(data.proxyUrl || '');
      setProxyIndexers(data.proxyIndexers || {});
      const sc = data.searchConfig;
      setTmdbApiKey(sc?.tmdbApiKey || '');
      setTvdbApiKey(sc?.tvdbApiKey || '');
      setIncludeSeasonPacks(sc?.includeSeasonPacks ?? data.includeSeasonPacks ?? true);
      setSeasonPackPagination(sc?.seasonPackPagination ?? true);
      setSeasonPackAdditionalPages(sc?.seasonPackAdditionalPages || 1);
      setUseTextSearchForAnime(sc?.useTextSearchForAnime !== false);
      setSkipAnimeTitleResolve(sc?.skipAnimeTitleResolve !== false);
      setIndexerPriorityDedup(sc?.indexerPriorityDedup ?? false);
      setIndexerPriority(data.indexerPriority || []);
      setEasynewsEnabled(data.easynewsEnabled || false);
      setEasynewsUsername(data.easynewsUsername || '');
      setEasynewsPassword(data.easynewsPassword || '');
      setEasynewsPagination(data.easynewsPagination || false);
      setEasynewsMaxPages(data.easynewsMaxPages || 3);
      setEasynewsMode(data.easynewsMode || 'nzb');
      setEasynewsHealthCheck(data.easynewsHealthCheck || false);
      setZyclopsEndpoint(data.zyclopsEndpoint || 'https://zyclops.elfhosted.com');

      // Ensure all cards are in cardOrder (backward compat)
      let order = data.cardOrder || [...DEFAULT_CARD_ORDER];
      if (!order.includes('userAgent')) {
        const cacheIndex = order.indexOf('cache');
        if (cacheIndex !== -1) {
          order = [...order.slice(0, cacheIndex + 1), 'userAgent', ...order.slice(cacheIndex + 1)];
        } else {
          order = [...order, 'userAgent'];
        }
      }
      if (!order.includes('filters')) {
        const userAgentIndex = order.indexOf('userAgent');
        if (userAgentIndex !== -1) {
          order = [...order.slice(0, userAgentIndex), 'filters', ...order.slice(userAgentIndex)];
        } else {
          order = [...order, 'filters'];
        }
      }
      if (!order.includes('healthChecks')) {
        const streamingIndex = order.indexOf('streaming');
        if (streamingIndex !== -1) {
          order = [...order.slice(0, streamingIndex + 1), 'healthChecks', ...order.slice(streamingIndex + 1)];
        } else {
          order = [...order, 'healthChecks'];
        }
      }
      if (!order.includes('proxy')) {
        const streamingIndex = order.indexOf('streaming');
        if (streamingIndex !== -1) {
          order = [...order.slice(0, streamingIndex + 1), 'proxy', ...order.slice(streamingIndex + 1)];
        } else {
          order = [...order, 'proxy'];
        }
      }
      if (!order.includes('power')) {
        order = [...order, 'power'];
      }
      if (!order.includes('autoPlay')) {
        const healthChecksIndex = order.indexOf('healthChecks');
        if (healthChecksIndex !== -1) {
          order = [...order.slice(0, healthChecksIndex + 1), 'autoPlay', ...order.slice(healthChecksIndex + 1)];
        } else {
          order = [...order, 'autoPlay'];
        }
      }
      if (!order.includes('streamDisplay')) {
        const autoPlayIndex = order.indexOf('autoPlay');
        if (autoPlayIndex !== -1) {
          order = [...order.slice(0, autoPlayIndex + 1), 'streamDisplay', ...order.slice(autoPlayIndex + 1)];
        } else {
          order = [...order, 'streamDisplay'];
        }
      }
      if (!order.includes('zyclops')) {
        const proxyIndex = order.indexOf('proxy');
        if (proxyIndex !== -1) {
          order = [...order.slice(0, proxyIndex + 1), 'zyclops', ...order.slice(proxyIndex + 1)];
        } else {
          order = [...order, 'zyclops'];
        }
      }
      setCardOrder(order);

      // Load auto-play settings
      setAutoPlay(data.autoPlay || { enabled: true, method: 'firstFile', attributes: ['resolution', 'quality', 'edition'] });

      // Load stream display config (normalize to always have MAX_TITLE_ROWS)
      setStreamDisplayConfig(normalizeLineGroups(data.streamDisplayConfig || DEFAULT_STREAM_DISPLAY));

      setUserAgents(data.userAgents || {
        indexerSearch: 'Prowlarr/2.3.0.5236 (alpine 3.22.2)',
        nzbDownload: 'SABnzbd/4.5.5',
        nzbdavOperations: 'SABnzbd/4.5.5',
        webdavOperations: 'SABnzbd/4.5.5',
        general: defaultChromeUA
      });

      // Handle backward compatibility: convert old sortBy to sortOrder
      let filterConfig = data.filters || {
        sortOrder: ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag', 'language'],
        enabledSorts: {
          quality: true,
          videoTag: true,
          size: true,
          encode: true,
          visualTag: true,
          audioTag: true,
          language: false
        },
        enabledPriorities: {
          resolution: {},
          video: {},
          encode: {},
          visualTag: {},
          audioTag: {},
          language: {}
        },
        maxFileSize: undefined,
        maxStreamsPerQuality: undefined,
        resolutionPriority: ['2160p', '1440p', '1080p', '720p', 'Unknown', '576p', '480p', '360p', '240p', '144p'],
        videoPriority: ['BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDRip', 'HC HD-Rip', 'DVDRip', 'HDTV', 'Unknown'],
        encodePriority: ['AV1', 'HEVC', 'AVC', 'Unknown'],
        visualTagPriority: ['DV', 'HDR+DV', 'HDR10+', 'IMAX', 'HDR10', 'HDR', '10bit', 'AI', 'SDR', 'Unknown'],
        audioTagPriority: ['Atmos', 'DTS:X', 'DTS-HD MA', 'TrueHD', 'DTS-HD', 'DD+', 'DD'],
        languagePriority: ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'],
        editionPriority: ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard']
      };

      // If old config has sortBy but not sortOrder, convert it
      if ((filterConfig as any).sortBy && !filterConfig.sortOrder) {
        const oldSortBy = (filterConfig as any).sortBy;
        if (oldSortBy === 'quality') {
          filterConfig.sortOrder = ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag'];
        } else if (oldSortBy === 'size') {
          filterConfig.sortOrder = ['size', 'quality', 'videoTag', 'encode', 'visualTag', 'audioTag'];
        } else if (oldSortBy === 'videoTag') {
          filterConfig.sortOrder = ['videoTag', 'quality', 'size', 'encode', 'visualTag', 'audioTag'];
        } else {
          filterConfig.sortOrder = ['quality', 'videoTag', 'size', 'encode', 'visualTag', 'audioTag'];
        }
      }

      // Ensure language is in sortOrder for existing configs
      if (filterConfig.sortOrder && !filterConfig.sortOrder.includes('language')) {
        filterConfig.sortOrder = [...filterConfig.sortOrder, 'language'];
      }
      if (filterConfig.enabledSorts && filterConfig.enabledSorts.language === undefined) {
        filterConfig.enabledSorts.language = false;
      }
      if (!filterConfig.languagePriority) {
        filterConfig.languagePriority = ['English', 'Multi', 'Dual Audio', 'Dubbed', 'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Latino', 'Latvian', 'Lithuanian', 'Malay', 'Malayalam', 'Marathi', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'];
      }

      // Ensure edition is in sortOrder for existing configs
      if (filterConfig.sortOrder && !filterConfig.sortOrder.includes('edition')) {
        filterConfig.sortOrder = [...filterConfig.sortOrder, 'edition'];
      }
      if (filterConfig.enabledSorts && filterConfig.enabledSorts.edition === undefined) {
        filterConfig.enabledSorts.edition = false;
      }
      if (!filterConfig.editionPriority) {
        filterConfig.editionPriority = ['Extended', 'Superfan', "Director's Cut", 'Unrated', 'Uncut', 'Theatrical', 'Special Edition', "Collector's Edition", 'Remastered', 'IMAX Edition', 'Standard'];
      }
      // Ensure Collector's Edition is in editionPriority for existing configs
      if (filterConfig.editionPriority && !filterConfig.editionPriority.includes("Collector's Edition")) {
        filterConfig.editionPriority = [...filterConfig.editionPriority, "Collector's Edition"];
      }

      setFilters(filterConfig);
      setMovieFilters(data.movieFilters || null);
      // Default TV filters: edition sort at #1 and enabled
      // Only create defaults on first-time setup (undefined), not when
      // the user has explicitly chosen "use global" (null)
      if (data.tvFilters === undefined) {
        const tvDefaults = JSON.parse(JSON.stringify(filterConfig));
        const edIdx = tvDefaults.sortOrder.indexOf('edition');
        if (edIdx > 0) {
          tvDefaults.sortOrder.splice(edIdx, 1);
          tvDefaults.sortOrder.unshift('edition');
        }
        tvDefaults.enabledSorts = { ...tvDefaults.enabledSorts, edition: true };
        tvDefaults.preferNonStandardEdition = true;
        tvDefaults.enabledPriorities = {
          ...tvDefaults.enabledPriorities,
          edition: {
            ...tvDefaults.enabledPriorities?.edition,
            'IMAX Edition': true,
            'Theatrical': true,
            'Remastered': true,
          }
        };
        tvDefaults.maxStreams = 10;
        setTvFilters(tvDefaults);
      } else {
        setTvFilters(data.tvFilters);
      }

      setHealthChecks({
        ...DEFAULT_HEALTH_CHECKS,
        ...(data.healthChecks || {})
      });

      // Load synced indexers from config
      setSyncedIndexers(data.syncedIndexers || []);

      setProwlarrUrl(data.prowlarrUrl || 'http://localhost:9696');
      setProwlarrApiKey(data.prowlarrApiKey || '');
      setNzbhydraUrl(data.nzbhydraUrl || 'http://localhost:5076');
      setNzbhydraApiKey(data.nzbhydraApiKey || '');
      setNzbdavUrl(data.nzbdavUrl || 'http://localhost:3000');
      setNzbdavApiKey(data.nzbdavApiKey || '');
      setNzbdavWebdavUrl(data.nzbdavWebdavUrl || 'http://localhost:3000');
      setNzbdavWebdavUser(data.nzbdavWebdavUser || '');
      setNzbdavWebdavPassword(data.nzbdavWebdavPassword || '');
      setNzbdavMoviesCategory(data.nzbdavMoviesCategory || 'Usenet-Ultimate-Movies');
      setNzbdavTvCategory(data.nzbdavTvCategory || 'Usenet-Ultimate-TV');
      setNzbdavMaxFallbacks(data.nzbdavMaxFallbacks ?? 9);
      setNzbdavStreamBufferMB(data.nzbdavStreamBufferMB ?? 64);
      // Mark initial load as done so auto-save hooks don't fire on load
      // Also auto-test NZBDav connection on startup (inline to avoid stale closure)
      setTimeout(async () => {
        initialLoadDone.current = true;
        if ((data.streamingMode || 'nzbdav') === 'nzbdav' && data.nzbdavUrl) {
          setNzbdavConnectionStatus('checking');
          try {
            const testResp = await apiFetch('/api/nzbdav/test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: data.nzbdavUrl,
                apiKey: data.nzbdavApiKey || '',
                webdavUrl: data.nzbdavWebdavUrl || '',
                webdavUser: data.nzbdavWebdavUser || '',
                webdavPassword: data.nzbdavWebdavPassword || '',
              })
            });
            setNzbdavConnectionStatus(testResp.ok ? 'connected' : 'disconnected');
          } catch {
            setNzbdavConnectionStatus('disconnected');
          }
        }
      }, 100);
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const response = await apiFetch('/api/stats');
      const data = await response.json();
      setStatsData(data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Handler functions
  // ═══════════════════════════════════════════════════════════════════

  const fetchLocalIp = async () => {
    try {
      const res = await apiFetch('/api/ip/local');
      const data = await res.json();
      if (data.ip) setLocalIp(data.ip);
    } catch { /* ignore */ }
  };

  const checkProxyStatus = async () => {
    setProxyStatus('checking');
    fetchLocalIp();
    try {
      const res = await apiFetch(`/api/proxy/status?url=${encodeURIComponent(proxyUrl)}`);
      const data = await res.json();
      if (data.connected) {
        setProxyStatus('connected');
        setProxyIp(data.ip || '');
      } else {
        setProxyStatus('disconnected');
        setProxyIp('');
      }
    } catch {
      setProxyStatus('disconnected');
      setProxyIp('');
    }
  };

  const checkNzbdavConnection = async () => {
    if (streamingMode !== 'nzbdav') {
      setNzbdavConnectionStatus(null);
      return;
    }

    if (!nzbdavUrl) {
      setNzbdavConnectionStatus('unconfigured');
      return;
    }

    setNzbdavConnectionStatus('checking');
    try {
      const response = await apiFetch('/api/nzbdav/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: nzbdavUrl,
          apiKey: nzbdavApiKey,
          webdavUrl: nzbdavWebdavUrl,
          webdavUser: nzbdavWebdavUser,
          webdavPassword: nzbdavWebdavPassword
        })
      });

      setNzbdavConnectionStatus(response.ok ? 'connected' : 'disconnected');
    } catch {
      setNzbdavConnectionStatus('disconnected');
    }
  };

  const sendNzbdavTestNzb = async () => {
    setNzbdavTestNzbStatus('sending');
    setNzbdavTestNzbMessage('');
    try {
      const response = await apiFetch('/api/nzbdav/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: nzbdavUrl,
          apiKey: nzbdavApiKey,
          webdavUrl: nzbdavWebdavUrl,
          webdavUser: nzbdavWebdavUser,
          webdavPassword: nzbdavWebdavPassword,
          moviesCategory: nzbdavMoviesCategory,
          sendTestNzb: true
        })
      });
      const data = await response.json();
      if (response.ok) {
        setNzbdavTestNzbStatus('success');
        setNzbdavTestNzbMessage(data.message || 'Test NZB accepted');
      } else {
        setNzbdavTestNzbStatus('error');
        setNzbdavTestNzbMessage(data.message || 'Test NZB failed');
      }
    } catch (error) {
      setNzbdavTestNzbStatus('error');
      setNzbdavTestNzbMessage(`Failed: ${(error as Error).message}`);
    }
  };

  const testTmdbKey = async () => {
    if (!tmdbApiKey) return;
    setTmdbKeyStatus('testing');
    try {
      const response = await apiFetch('/api/search-config/test-tmdb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: tmdbApiKey })
      });
      const data = await response.json();
      setTmdbKeyStatus(data.success ? 'valid' : 'invalid');
    } catch {
      setTmdbKeyStatus('invalid');
    }
  };

  const testTvdbKey = async () => {
    if (!tvdbApiKey) return;
    setTvdbKeyStatus('testing');
    try {
      const response = await apiFetch('/api/search-config/test-tvdb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: tvdbApiKey })
      });
      const data = await response.json();
      setTvdbKeyStatus(data.success ? 'valid' : 'invalid');
    } catch {
      setTvdbKeyStatus('invalid');
    }
  };

  // Handle element drop for unified drag-and-drop (move elements between name column and title rows)
  const handleElementDrop = (overrideDragOver?: typeof elementDragOver) => {
    const dragOver = overrideDragOver || elementDragOver;
    if (!elementDrag || !dragOver) return;
    const { elementId, sourceType, sourceGroupId } = elementDrag;
    const { targetType, targetGroupId, targetElementId, position } = dragOver;

    setStreamDisplayConfig(prev => {
      const next = { ...prev, nameElements: [...prev.nameElements], lineGroups: prev.lineGroups.map(g => ({ ...g, elementIds: [...g.elementIds] })) };

      // 1. Remove from source
      if (sourceType === 'name') {
        next.nameElements = next.nameElements.filter(id => id !== elementId);
      } else if (sourceGroupId) {
        next.lineGroups = next.lineGroups.map(g =>
          g.id === sourceGroupId ? { ...g, elementIds: g.elementIds.filter(id => id !== elementId) } : g
        );
      }

      // 2. Insert into target
      if (targetType === 'name') {
        if (targetElementId) {
          const idx = next.nameElements.indexOf(targetElementId);
          const insertIdx = position === 'after' ? idx + 1 : Math.max(0, idx);
          next.nameElements.splice(insertIdx, 0, elementId);
        } else {
          next.nameElements.push(elementId);
        }
      } else if (targetType === 'title' && targetGroupId) {
        next.lineGroups = next.lineGroups.map(g => {
          if (g.id !== targetGroupId) return g;
          const newIds = [...g.elementIds];
          if (targetElementId) {
            const idx = newIds.indexOf(targetElementId);
            const insertIdx = position === 'after' ? idx + 1 : Math.max(0, idx);
            newIds.splice(insertIdx, 0, elementId);
          } else {
            newIds.push(elementId);
          }
          return { ...g, elementIds: newIds };
        });
      }

      return next;
    });

    setElementDrag(null);
    setElementDragOver(null);
  };

  // Card drag handlers
  const handleCardDragStart = (cardId: string) => {
    setDraggedCard(cardId);
  };

  const handleCardDragOver = (e: React.DragEvent, cardId: string) => {
    e.preventDefault();
    if (draggedCard && draggedCard !== cardId) {
      setDragOverCard(cardId);
    }
  };

  const handleCardDrop = async (e: React.DragEvent, dropCardId: string) => {
    e.preventDefault();

    if (!draggedCard || draggedCard === dropCardId) {
      setDraggedCard(null);
      setDragOverCard(null);
      return;
    }

    const newOrder = [...cardOrder];
    const draggedIndex = newOrder.indexOf(draggedCard);
    const dropIndex = newOrder.indexOf(dropCardId);

    newOrder.splice(draggedIndex, 1);
    newOrder.splice(dropIndex, 0, draggedCard);

    setCardOrder(newOrder);
    setDraggedCard(null);
    setDragOverCard(null);

    // Save to backend
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardOrder: newOrder })
      });
    } catch (error) {
      console.error('Failed to save card order:', error);
    }
  };

  const handleCardDragEnd = () => {
    setDraggedCard(null);
    setDragOverCard(null);
  };

  // ═══════════════════════════════════════════════════════════════════
  // Computed values (useMemo)
  // ═══════════════════════════════════════════════════════════════════

  // Compute ranked indexers for stats comparison dashboard
  const rankedIndexers = useMemo(() => {
    if (!statsData?.indexers) return [];
    const allIndexers = Object.values(statsData.indexers) as any[];
    if (allIndexers.length === 0) return [];

    const qualified = allIndexers.filter((i: any) => i.totalQueries >= 5);
    const unqualified = allIndexers.filter((i: any) => i.totalQueries < 5);

    if (qualified.length === 0) {
      const simple = allIndexers.map((i: any) => ({
        ...i,
        score: 0,
        successRate: i.totalQueries > 0 ? Math.round((i.successfulQueries / i.totalQueries) * 100) : 0,
        avgResultsPerQuery: i.totalQueries > 0 ? Math.round(i.totalResults / i.totalQueries) : 0,
        qualified: false,
      }));
      return simple.sort((a: any, b: any) => b.totalQueries - a.totalQueries).map((i: any, idx: number) => ({ ...i, rank: idx + 1 }));
    }

    const maxAvgResults = Math.max(...qualified.map((i: any) => i.totalResults / i.totalQueries), 1);
    const minResponseTime = Math.min(...qualified.map((i: any) => i.avgResponseTime || Infinity));
    const maxGrabs = Math.max(...qualified.map((i: any) => i.totalGrabs || 0), 1);

    const scored = qualified.map((i: any) => {
      const successRate = i.successfulQueries / i.totalQueries;
      const avgResults = i.totalResults / i.totalQueries;
      const score = Math.round(
        successRate * 40 +
        (maxAvgResults > 0 ? (avgResults / maxAvgResults) * 25 : 0) +
        (i.avgResponseTime > 0 ? (minResponseTime / i.avgResponseTime) * 20 : 0) +
        (maxGrabs > 0 ? ((i.totalGrabs || 0) / maxGrabs) * 15 : 0)
      );
      return {
        ...i,
        score,
        successRate: Math.round(successRate * 100),
        avgResultsPerQuery: Math.round(avgResults),
        qualified: true,
      };
    });

    const unscored = unqualified.map((i: any) => ({
      ...i,
      score: -1,
      successRate: i.totalQueries > 0 ? Math.round((i.successfulQueries / i.totalQueries) * 100) : 0,
      avgResultsPerQuery: i.totalQueries > 0 ? Math.round(i.totalResults / i.totalQueries) : 0,
      qualified: false,
    }));

    const sortKey = statsSortBy;
    const dir = statsSortDir === 'desc' ? 1 : -1;
    scored.sort((a: any, b: any) => {
      if (sortKey === 'avgResponseTime') {
        return dir * ((a[sortKey] || 0) - (b[sortKey] || 0));
      }
      return dir * ((b[sortKey] || 0) - (a[sortKey] || 0));
    });

    const ranked = scored.map((i: any, idx: number) => ({ ...i, rank: idx + 1 }));
    const unranked = unscored.map((i: any) => ({ ...i, rank: null }));

    return [...ranked, ...unranked];
  }, [statsData, statsSortBy, statsSortDir]);

  // Category award winners
  const categoryAwards = useMemo(() => {
    const qualified = rankedIndexers.filter((i: any) => i.qualified);
    if (qualified.length === 0) return null;
    return {
      fastest: qualified.reduce((best: any, i: any) => (!best || i.avgResponseTime < best.avgResponseTime) ? i : best, null),
      mostReliable: qualified.reduce((best: any, i: any) => (!best || i.successRate > best.successRate) ? i : best, null),
      mostResults: qualified.reduce((best: any, i: any) => (!best || i.avgResultsPerQuery > best.avgResultsPerQuery) ? i : best, null),
      mostPopular: qualified.reduce((best: any, i: any) => (!best || (i.totalGrabs || 0) > (best.totalGrabs || 0)) ? i : best, null),
    };
  }, [rankedIndexers]);

  // ═══════════════════════════════════════════════════════════════════
  // Return everything the UI needs
  // ═══════════════════════════════════════════════════════════════════

  return {
    // Config & loading
    config, setConfig,
    loading, setLoading,
    addonEnabled, setAddonEnabled,
    activeTab, setActiveTab,

    // Indexer management
    showAddIndexer, setShowAddIndexer,
    newIndexer, setNewIndexer,
    selectedPreset, setSelectedPreset,
    editForm, setEditForm,
    capsLoading, setCapsLoading,
    expandedIndexer, setExpandedIndexer,
    draggedIndexer, setDraggedIndexer,
    dragOverIndexer, setDragOverIndexer,
    pendingSave, setPendingSave,
    testResults, setTestResults,
    testQuery, setTestQuery,
    deleteConfirmation, setDeleteConfirmation,
    activeOverlay, setActiveOverlay,
    failedLogos, setFailedLogos,
    showApiKey, setShowApiKey,

    // Cache
    cacheTTL, setCacheTTL,

    // Streaming & index manager
    streamingMode, setStreamingMode,
    indexManager, setIndexManager,

    // Proxy
    proxyMode, setProxyMode,
    proxyUrl, setProxyUrl,
    proxyStatus, setProxyStatus,
    proxyIp, setProxyIp,
    localIp, setLocalIp,
    proxyIndexers, setProxyIndexers,

    // Search config
    tmdbApiKey, setTmdbApiKey,
    tvdbApiKey, setTvdbApiKey,
    includeSeasonPacks, setIncludeSeasonPacks,
    seasonPackPagination, setSeasonPackPagination,
    seasonPackAdditionalPages, setSeasonPackAdditionalPages,
    useTextSearchForAnime, setUseTextSearchForAnime,
    skipAnimeTitleResolve, setSkipAnimeTitleResolve,
    indexerPriorityDedup, setIndexerPriorityDedup,
    indexerPriority, setIndexerPriority,
    dedupDraggedItem, setDedupDraggedItem,
    dedupDragOverItem, setDedupDragOverItem,
    tmdbKeyStatus, setTmdbKeyStatus,
    tvdbKeyStatus, setTvdbKeyStatus,
    showTmdbKey, setShowTmdbKey,
    showTvdbKey, setShowTvdbKey,
    showProwlarrKey, setShowProwlarrKey,
    showNzbhydraKey, setShowNzbhydraKey,

    // Prowlarr / NZBHydra
    prowlarrUrl, setProwlarrUrl,
    prowlarrApiKey, setProwlarrApiKey,
    nzbhydraUrl, setNzbhydraUrl,
    nzbhydraApiKey, setNzbhydraApiKey,

    // NZBDav
    nzbdavUrl, setNzbdavUrl,
    nzbdavApiKey, setNzbdavApiKey,
    nzbdavWebdavUrl, setNzbdavWebdavUrl,
    nzbdavWebdavUser, setNzbdavWebdavUser,
    nzbdavWebdavPassword, setNzbdavWebdavPassword,
    nzbdavMoviesCategory, setNzbdavMoviesCategory,
    nzbdavTvCategory, setNzbdavTvCategory,
    nzbdavMaxFallbacks, setNzbdavMaxFallbacks,
    nzbdavStreamBufferMB, setNzbdavStreamBufferMB,
    nzbdavConnectionStatus, setNzbdavConnectionStatus,
    nzbdavTestNzbStatus, setNzbdavTestNzbStatus,
    nzbdavTestNzbMessage, setNzbdavTestNzbMessage,

    // EasyNews
    easynewsEnabled, setEasynewsEnabled,
    easynewsUsername, setEasynewsUsername,
    easynewsPassword, setEasynewsPassword,
    easynewsPagination, setEasynewsPagination,
    easynewsMaxPages, setEasynewsMaxPages,
    easynewsMode, setEasynewsMode,
    easynewsHealthCheck, setEasynewsHealthCheck,
    showEasynewsPassword, setShowEasynewsPassword,
    easynewsTestStatus, setEasynewsTestStatus,
    easynewsTestMessage, setEasynewsTestMessage,

    // Zyclops
    zyclopsEndpoint, setZyclopsEndpoint,
    zyclopsTestStatus, setZyclopsTestStatus,
    zyclopsTestMessage, setZyclopsTestMessage,
    zyclopsConfirmDialog, setZyclopsConfirmDialog,
    singleIpConfirmDialog, setSingleIpConfirmDialog,

    // User agents
    defaultChromeUA,
    userAgents, setUserAgents,

    // Filters
    filters, setFilters,
    movieFilters, setMovieFilters,
    tvFilters, setTvFilters,

    // Stats
    statsData, setStatsData,
    statsLoading, setStatsLoading,
    statsSortBy, setStatsSortBy,
    statsSortDir, setStatsSortDir,
    statsExpandedIndexer, setStatsExpandedIndexer,

    // Health checks
    healthChecks, setHealthChecks,
    syncedIndexers, setSyncedIndexers,
    syncStatus, setSyncStatus,
    syncMessage, setSyncMessage,
    selectedSyncedIndexer, setSelectedSyncedIndexer,
    connectionTestStatus, setConnectionTestStatus,
    connectionTestMessage, setConnectionTestMessage,

    // Auto play
    autoPlay, setAutoPlay,

    // Stream display
    streamDisplayConfig, setStreamDisplayConfig,
    emojiPickerTarget, setEmojiPickerTarget,
    emojiSearch, setEmojiSearch,
    elementDrag, setElementDrag,
    elementDragOver, setElementDragOver,
    draggedLineGroup, setDraggedLineGroup,
    dragOverLineGroup, setDragOverLineGroup,

    // Dashboard card order
    cardOrder, setCardOrder,
    draggedCard, setDraggedCard,
    dragOverCard, setDragOverCard,

    // Computed
    segmentCacheMaxSizeMB,
    rankedIndexers,
    categoryAwards,

    // Refs
    initialLoadDone,

    // Functions
    fetchConfig,
    fetchStats,
    fetchIndexers,
    fetchLocalIp,
    checkProxyStatus,
    checkNzbdavConnection,
    sendNzbdavTestNzb,
    testTmdbKey,
    testTvdbKey,
    handleElementDrop,
    handleCardDragStart,
    handleCardDragOver,
    handleCardDrop,
    handleCardDragEnd,
    saveSettings,

    // Utilities re-exported for convenience
    formatTTL,
    decomposeTTL,
    composeTTL,
  };
}

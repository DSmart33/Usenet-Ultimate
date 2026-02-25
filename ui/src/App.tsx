// What this does:
//   Thin shell that composes the Usenet Ultimate UI from extracted hooks and components.
//   Owns the apiFetch instance, auth flow, inline indexer/provider handlers, and layout chrome.

import { useEffect, useMemo, useCallback, useRef } from 'react';
import { LayoutDashboard, Download, Crown, LogOut } from 'lucide-react';
import clsx from 'clsx';
import indexerPresets from './indexerPresets.json';
import type { Tab, IndexerPreset, Indexer, IndexerCaps } from './types';

// Hooks
import { useAuth } from './hooks/useAuth';
import { useAppConfig } from './hooks/useAppConfig';
import { createApiFetch } from './utils/api';

// Components
import AuthScreens from './components/AuthScreens';
import { DashboardTab } from './components/DashboardTab';
import { InstallTab } from './components/InstallTab';

// Overlays
import { IndexManagerOverlay } from './components/overlays/IndexManagerOverlay';
import { ProxyOverlay } from './components/overlays/ProxyOverlay';
import { CacheTTLOverlay } from './components/overlays/CacheTTLOverlay';
import { UserAgentOverlay } from './components/overlays/UserAgentOverlay';
import { StreamingOverlay } from './components/overlays/StreamingOverlay';
import { AutoPlayOverlay } from './components/overlays/AutoPlayOverlay';
import { StatsOverlay } from './components/overlays/StatsOverlay';
import FiltersOverlay from './components/overlays/FiltersOverlay';
import HealthChecksOverlay from './components/overlays/HealthChecksOverlay';
import { StreamDisplayOverlay } from './components/overlays/StreamDisplayOverlay';
import { ZyclopsOverlay } from './components/overlays/ZyclopsOverlay';
import { LogsOverlay } from './components/overlays/LogsOverlay';

// Modals
import { DeleteConfirmModal } from './components/modals/DeleteConfirmModal';
import { AddIndexerModal } from './components/modals/AddIndexerModal';
import { EditIndexerModal } from './components/modals/EditIndexerModal';

// ── Constants ───────────────────────────────────────────────────────────────
const INDEXER_PRESETS: IndexerPreset[] = indexerPresets;

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  // ── 401 handler (stable ref so apiFetch doesn't re-create) ─────────────
  const authSettersRef = useRef<null | ((s: 'login_required') => void)>(null);
  const handle401 = useCallback(() => {
    authSettersRef.current?.('login_required');
  }, []);

  // ── Stable no-op callbacks for useAuth (avoid re-creating checkAuth) ──
  const noopAuth = useCallback(() => {}, []);

  // ── API fetch ───────────────────────────────────────────────────────────
  const apiFetch = useMemo(() => createApiFetch(handle401), [handle401]);

  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = useAuth({
    apiFetch,
    onAuthenticated: noopAuth,
    onUnauthenticated: noopAuth,
    onLogout: noopAuth,
  });

  // Wire up the 401 handler to auth's setAuthStatus
  authSettersRef.current = auth.setAuthStatus;

  // ── App config ──────────────────────────────────────────────────────────
  const ac = useAppConfig(apiFetch, auth.authStatus);

  // ── Fetch config & stats once authenticated ─────────────────────────────
  useEffect(() => {
    if (auth.authStatus === 'authenticated') {
      ac.fetchConfig();
      ac.fetchStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.authStatus]);

  // ── PWA back button handling — prevent back from exiting the app ───────
  // Use a ref so the popstate handler always reads the latest state without
  // needing to tear down / re-register (which caused stale-closure bugs and
  // extra history entries that broke multi-level back navigation).
  const pwaStateRef = useRef({
    deleteConfirmation: ac.deleteConfirmation,
    zyclopsConfirmDialog: ac.zyclopsConfirmDialog,
    singleIpConfirmDialog: ac.singleIpConfirmDialog,
    showAddIndexer: ac.showAddIndexer,
    expandedIndexer: ac.expandedIndexer,
    selectedSyncedIndexer: ac.selectedSyncedIndexer,
    activeOverlay: ac.activeOverlay,
    activeTab: ac.activeTab,
  });
  pwaStateRef.current = {
    deleteConfirmation: ac.deleteConfirmation,
    zyclopsConfirmDialog: ac.zyclopsConfirmDialog,
    singleIpConfirmDialog: ac.singleIpConfirmDialog,
    showAddIndexer: ac.showAddIndexer,
    expandedIndexer: ac.expandedIndexer,
    selectedSyncedIndexer: ac.selectedSyncedIndexer,
    activeOverlay: ac.activeOverlay,
    activeTab: ac.activeTab,
  };

  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    if (!isStandalone) return;

    window.history.pushState({ pwa: true }, '');

    const handlePopState = () => {
      const s = pwaStateRef.current;
      if (s.deleteConfirmation.show) {
        ac.setDeleteConfirmation({ show: false, indexerName: '' });
      } else if (s.zyclopsConfirmDialog.show) {
        ac.setZyclopsConfirmDialog({ show: false, indexerName: '' });
      } else if (s.singleIpConfirmDialog.show) {
        ac.setSingleIpConfirmDialog({ show: false, indexerName: '' });
      } else if (s.showAddIndexer) {
        ac.setShowAddIndexer(false);
      } else if (s.expandedIndexer) {
        ac.setExpandedIndexer(null);
      } else if (s.selectedSyncedIndexer) {
        ac.setSelectedSyncedIndexer(null);
      } else if (s.activeOverlay) {
        ac.setActiveOverlay(null);
      } else if (s.activeTab !== 'dashboard') {
        ac.setActiveTab('dashboard');
      }
      window.history.pushState({ pwa: true }, '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Inline handler: renderMethodLabel ──────────────────────────────────
  const renderMethodLabel = (m: { value: string; label: string }) => {
    if (m.value === 'text') {
      return (
        <span className="bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent font-semibold">{m.label}</span>
      );
    }
    return m.label;
  };

  // ── Inline handler: selectBestMethod ──────────────────────────────────
  const selectBestMethod = (params: string[], searchType: 'movie' | 'tv'): string => {
    if (!params || params.length === 0) return 'imdb';
    if (params.includes('imdbid')) return 'imdb';
    if (searchType === 'movie' && params.includes('tmdbid')) return 'tmdb';
    if (params.includes('tvdbid')) return 'tvdb';
    if (searchType === 'tv' && params.includes('tvmazeid')) return 'tvmaze';
    return 'text';
  };

  // ── Inline handler: getAvailableMovieMethods ──────────────────────────
  const getAvailableMovieMethods = (caps: IndexerCaps | null): { value: string; label: string }[] => {
    const methods: { value: string; label: string }[] = [];
    if (!caps || caps.movieSearchParams.includes('imdbid')) methods.push({ value: 'imdb', label: 'IMDB' });
    if (caps?.movieSearchParams.includes('tmdbid')) methods.push({ value: 'tmdb', label: 'TMDB' });
    if (caps?.movieSearchParams.includes('tvdbid')) methods.push({ value: 'tvdb', label: 'TVDB' });
    methods.push({ value: 'text', label: 'Ultimate Text Search' });
    return methods;
  };

  // ── Inline handler: getAvailableTvMethods ─────────────────────────────
  const getAvailableTvMethods = (caps: IndexerCaps | null): { value: string; label: string }[] => {
    const methods: { value: string; label: string }[] = [];
    if (!caps || caps.tvSearchParams.includes('imdbid')) methods.push({ value: 'imdb', label: 'IMDB' });
    if (caps?.tvSearchParams.includes('tvdbid')) methods.push({ value: 'tvdb', label: 'TVDB' });
    if (caps?.tvSearchParams.includes('tvmazeid')) methods.push({ value: 'tvmaze', label: 'TVmaze' });
    methods.push({ value: 'text', label: 'Ultimate Text Search' });
    return methods;
  };

  // ── Inline handler: discoverCaps ──────────────────────────────────────
  const discoverCaps = async (url: string, apiKey: string, target: 'new' | 'edit') => {
    if (!url || !apiKey) return;
    ac.setCapsLoading(target);
    try {
      const res = await apiFetch('/api/indexers/caps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apiKey }),
      });
      if (res.ok) {
        const caps: IndexerCaps = await res.json();
        const bestMovie = selectBestMethod(caps.movieSearchParams, 'movie');
        const bestTv = selectBestMethod(caps.tvSearchParams, 'tv');
        const availableMovieValues = getAvailableMovieMethods(caps).map(m => m.value);
        const availableTvValues = getAvailableTvMethods(caps).map(m => m.value);
        if (target === 'new') {
          ac.setNewIndexer(prev => {
            const movieFiltered = prev.movieSearchMethod.filter(m => availableMovieValues.includes(m));
            const tvFiltered = prev.tvSearchMethod.filter(m => availableTvValues.includes(m));
            return { ...prev, caps, movieSearchMethod: movieFiltered.length > 0 ? movieFiltered : [bestMovie], tvSearchMethod: tvFiltered.length > 0 ? tvFiltered : [bestTv] };
          });
        } else {
          ac.setEditForm(prev => {
            const movieFiltered = prev.movieSearchMethod.filter(m => availableMovieValues.includes(m));
            const tvFiltered = prev.tvSearchMethod.filter(m => availableTvValues.includes(m));
            return { ...prev, caps, movieSearchMethod: movieFiltered.length > 0 ? movieFiltered : [bestMovie], tvSearchMethod: tvFiltered.length > 0 ? tvFiltered : [bestTv] };
          });
        }
      }
    } catch {
      // Caps discovery failed - user can still manually select methods
    }
    ac.setCapsLoading(null);
  };

  // ── Inline handler: handlePresetChange ────────────────────────────────
  const handlePresetChange = (presetName: string) => {
    ac.setSelectedPreset(presetName);
    const preset = INDEXER_PRESETS.find(p => p.name === presetName);
    if (preset) {
      ac.setNewIndexer({
        name: preset.name === 'Custom' ? '' : preset.name,
        url: preset.url,
        apiKey: '',
        website: preset.website,
        logo: preset.logo,
        movieSearchMethod: ['text'],
        tvSearchMethod: ['text'],
        caps: null,
        pagination: false,
        maxPages: 3,
      });
    }
  };

  // ── Inline handler: handleDeleteIndexer ───────────────────────────────
  const handleDeleteIndexer = async (name: string) => {
    ac.setDeleteConfirmation({ show: false, indexerName: '' });
    try {
      const response = await apiFetch(`/api/indexers/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (response.ok) {
        await ac.fetchIndexers();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to delete indexer');
      }
    } catch (error) {
      console.error('Failed to delete indexer:', error);
      alert('Failed to delete indexer');
    }
  };

  // ── Inline handler: handleAddIndexer ──────────────────────────────────
  const handleAddIndexer = async () => {
    try {
      const response = await apiFetch('/api/indexers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ac.newIndexer),
      });
      if (response.ok) {
        ac.setNewIndexer({ name: '', url: '', apiKey: '', website: '', logo: '', movieSearchMethod: ['text'], tvSearchMethod: ['text'], caps: null, pagination: false, maxPages: 3 });
        ac.setShowAddIndexer(false);
        await ac.fetchIndexers();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to add indexer');
      }
    } catch (error) {
      console.error('Failed to add indexer:', error);
      alert('Failed to add indexer');
    }
  };

  // ── Inline handler: startEdit ─────────────────────────────────────────
  const startEdit = (indexer: Indexer) => {
    ac.setEditForm({
      name: indexer.name,
      url: indexer.url,
      apiKey: indexer.apiKey || '',
      enabled: indexer.enabled,
      website: indexer.website || '',
      logo: indexer.logo || '',
      movieSearchMethod: Array.isArray(indexer.movieSearchMethod) ? indexer.movieSearchMethod : [indexer.movieSearchMethod || 'text'],
      tvSearchMethod: Array.isArray(indexer.tvSearchMethod) ? indexer.tvSearchMethod : [indexer.tvSearchMethod || 'text'],
      caps: indexer.caps || null,
      pagination: indexer.pagination === true,
      maxPages: indexer.maxPages ?? 3,
    });
  };

  // ── Inline handler: handleReorderIndexer ──────────────────────────────
  const handleReorderIndexer = async (name: string, direction: 'up' | 'down') => {
    if (!ac.config) return;
    const currentIndex = ac.config.indexers.findIndex(i => i.name === name);
    if (currentIndex === -1) return;
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= ac.config.indexers.length) return;
    const newIndexers = [...ac.config.indexers];
    [newIndexers[currentIndex], newIndexers[newIndex]] = [newIndexers[newIndex], newIndexers[currentIndex]];
    try {
      const response = await apiFetch('/api/indexers/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexers: newIndexers }),
      });
      if (response.ok) {
        await ac.fetchIndexers();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to reorder indexers');
      }
    } catch (error) {
      console.error('Error reordering indexers:', error);
      alert('Failed to reorder indexers');
    }
  };

  // ── Inline handler: handleDragReorder ─────────────────────────────────
  const handleDragReorder = (draggedName: string, targetName: string): Indexer[] | null => {
    if (!ac.config || draggedName === targetName) return null;
    const newIndexers = [...ac.config.indexers];
    const draggedIndex = newIndexers.findIndex(i => i.name === draggedName);
    const targetIndex = newIndexers.findIndex(i => i.name === targetName);
    if (draggedIndex === -1 || targetIndex === -1) return null;
    const [draggedItem] = newIndexers.splice(draggedIndex, 1);
    newIndexers.splice(targetIndex, 0, draggedItem);
    ac.setConfig(prev => prev ? { ...prev, indexers: newIndexers } : null);
    return newIndexers;
  };

  // ── Inline handler: saveIndexerOrder ──────────────────────────────────
  const saveIndexerOrder = async (indexers: Indexer[]) => {
    if (ac.pendingSave) return;
    ac.setPendingSave(true);
    try {
      const response = await apiFetch('/api/indexers/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexers }),
      });
      if (!response.ok) {
        await ac.fetchIndexers();
        const error = await response.json();
        alert(error.error || 'Failed to save indexer order');
      }
    } catch (error) {
      await ac.fetchIndexers();
      console.error('Error saving indexer order:', error);
      alert('Failed to save indexer order');
    } finally {
      ac.setPendingSave(false);
    }
  };

  // ── Inline handler: handleReorderSyncedIndexer ────────────────────────
  const handleReorderSyncedIndexer = async (id: string, direction: 'up' | 'down') => {
    const currentIndex = ac.syncedIndexers.findIndex(i => i.id === id);
    if (currentIndex === -1) return;
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= ac.syncedIndexers.length) return;
    const newOrder = [...ac.syncedIndexers];
    [newOrder[currentIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[currentIndex]];
    ac.setSyncedIndexers(newOrder);
    try {
      const response = await apiFetch('/api/synced-indexers/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncedIndexers: newOrder }),
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(error.error || 'Failed to reorder synced indexers');
      }
    } catch (error) {
      console.error('Error reordering synced indexers:', error);
    }
  };

  // ── Inline handler: handleTestIndexer ─────────────────────────────────
  const handleTestIndexer = async (indexerName: string) => {
    const query = ac.testQuery[indexerName] || 'test';
    ac.setTestResults(prev => ({ ...prev, [indexerName]: { loading: true } }));
    try {
      const isNewIndexer = indexerName === '__new__';
      let response;
      if (isNewIndexer) {
        response = await apiFetch('/api/indexers/test-new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ac.newIndexer.name,
            url: ac.newIndexer.url,
            apiKey: ac.newIndexer.apiKey,
            query,
          }),
        });
      } else {
        response = await apiFetch(`/api/indexers/${encodeURIComponent(indexerName)}/test?q=${encodeURIComponent(query)}`, {
          method: 'POST',
        });
      }
      const result = await response.json();
      if (response.ok) {
        ac.setTestResults(prev => ({
          ...prev,
          [indexerName]: { loading: false, success: true, message: result.message || 'Test successful', results: result.results, titles: result.titles || [] },
        }));
      } else {
        ac.setTestResults(prev => ({
          ...prev,
          [indexerName]: { loading: false, success: false, message: result.error || 'Test failed' },
        }));
      }
    } catch {
      ac.setTestResults(prev => ({
        ...prev,
        [indexerName]: { loading: false, success: false, message: 'Connection error' },
      }));
    }
  };

  // NOTE: Provider handlers (add, update, delete, toggle, drag) are managed
  // internally by HealthChecksOverlay — no need to define them here.

  // ── Auth screens (return early if not authenticated) ──────────────────
  if (auth.authStatus !== 'authenticated') {
    return (
      <AuthScreens
        authStatus={auth.authStatus}
        loginUsername={auth.loginUsername}
        loginPassword={auth.loginPassword}
        loginConfirmPassword={auth.loginConfirmPassword}
        loginError={auth.loginError}
        loginLoading={auth.loginLoading}
        setLoginUsername={auth.setLoginUsername}
        setLoginPassword={auth.setLoginPassword}
        setLoginConfirmPassword={auth.setLoginConfirmPassword}
        handleSetup={auth.handleSetup}
        handleLogin={auth.handleLogin}
        loading={ac.loading}
      />
    );
  }

  if (ac.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  // ── Computed values ───────────────────────────────────────────────────
  const hasIndexers = ac.config && (
    ac.config.indexers.length > 0 ||
    ac.syncedIndexers.length > 0 ||
    ac.easynewsEnabled
  );
  const enabledIndexersCount = ac.config ? ac.config.indexers.filter(i => i.enabled).length : 0;

  // ── Main render ───────────────────────────────────────────────────────
  return (
    <div className="h-screen h-[100dvh] flex flex-col overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 animate-gradient relative" style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}>

      {/* Delete Confirmation Modal */}
      {ac.deleteConfirmation.show && (
        <DeleteConfirmModal
          deleteConfirmation={ac.deleteConfirmation}
          setDeleteConfirmation={ac.setDeleteConfirmation}
          handleDeleteIndexer={handleDeleteIndexer}
        />
      )}

      {/* Add Indexer Modal */}
      {ac.showAddIndexer && (
        <AddIndexerModal
          onClose={() => ac.setShowAddIndexer(false)}
          newIndexer={ac.newIndexer}
          setNewIndexer={ac.setNewIndexer}
          selectedPreset={ac.selectedPreset}
          setSelectedPreset={ac.setSelectedPreset}
          failedLogos={ac.failedLogos}
          setFailedLogos={ac.setFailedLogos}
          showApiKey={ac.showApiKey}
          setShowApiKey={ac.setShowApiKey}
          capsLoading={ac.capsLoading}
          testResults={ac.testResults}
          testQuery={ac.testQuery}
          setTestQuery={ac.setTestQuery}
          handlePresetChange={handlePresetChange}
          discoverCaps={discoverCaps}
          getAvailableMovieMethods={getAvailableMovieMethods}
          getAvailableTvMethods={getAvailableTvMethods}
          renderMethodLabel={renderMethodLabel}
          handleTestIndexer={handleTestIndexer}
          handleAddIndexer={handleAddIndexer}
        />
      )}

      {/* Edit Indexer Modal */}
      {ac.expandedIndexer && (
        <EditIndexerModal
          onClose={() => ac.setExpandedIndexer(null)}
          expandedIndexer={ac.expandedIndexer}
          editForm={ac.editForm}
          setEditForm={ac.setEditForm}
          showApiKey={ac.showApiKey}
          setShowApiKey={ac.setShowApiKey}
          capsLoading={ac.capsLoading}
          config={ac.config}
          testResults={ac.testResults}
          testQuery={ac.testQuery}
          setTestQuery={ac.setTestQuery}
          discoverCaps={discoverCaps}
          getAvailableMovieMethods={getAvailableMovieMethods}
          getAvailableTvMethods={getAvailableTvMethods}
          renderMethodLabel={renderMethodLabel}
          handleTestIndexer={handleTestIndexer}
          setDeleteConfirmation={ac.setDeleteConfirmation}
          setExpandedIndexer={ac.setExpandedIndexer}
        />
      )}

      {/* Indexer Manager Overlay */}
      {ac.activeOverlay === 'indexManager' && (
        <IndexManagerOverlay
          onClose={() => ac.setActiveOverlay(null)}
          config={ac.config}
          setConfig={ac.setConfig}
          indexManager={ac.indexManager}
          setIndexManager={ac.setIndexManager}
          apiFetch={apiFetch}
          tmdbApiKey={ac.tmdbApiKey}
          setTmdbApiKey={ac.setTmdbApiKey}
          tvdbApiKey={ac.tvdbApiKey}
          setTvdbApiKey={ac.setTvdbApiKey}
          showTmdbKey={ac.showTmdbKey}
          setShowTmdbKey={ac.setShowTmdbKey}
          showTvdbKey={ac.showTvdbKey}
          setShowTvdbKey={ac.setShowTvdbKey}
          tmdbKeyStatus={ac.tmdbKeyStatus}
          setTmdbKeyStatus={ac.setTmdbKeyStatus}
          tvdbKeyStatus={ac.tvdbKeyStatus}
          setTvdbKeyStatus={ac.setTvdbKeyStatus}
          testTmdbKey={ac.testTmdbKey}
          testTvdbKey={ac.testTvdbKey}
          includeSeasonPacks={ac.includeSeasonPacks}
          setIncludeSeasonPacks={ac.setIncludeSeasonPacks}
          seasonPackPagination={ac.seasonPackPagination}
          setSeasonPackPagination={ac.setSeasonPackPagination}
          seasonPackAdditionalPages={ac.seasonPackAdditionalPages}
          setSeasonPackAdditionalPages={ac.setSeasonPackAdditionalPages}
          useTextSearchForAnime={ac.useTextSearchForAnime}
          setUseTextSearchForAnime={ac.setUseTextSearchForAnime}
          skipAnimeTitleResolve={ac.skipAnimeTitleResolve}
          setSkipAnimeTitleResolve={ac.setSkipAnimeTitleResolve}
          indexerPriorityDedup={ac.indexerPriorityDedup}
          setIndexerPriorityDedup={ac.setIndexerPriorityDedup}
          indexerPriority={ac.indexerPriority}
          setIndexerPriority={ac.setIndexerPriority}
          dedupDraggedItem={ac.dedupDraggedItem}
          setDedupDraggedItem={ac.setDedupDraggedItem}
          dedupDragOverItem={ac.dedupDragOverItem}
          setDedupDragOverItem={ac.setDedupDragOverItem}
          easynewsEnabled={ac.easynewsEnabled}
          setEasynewsEnabled={ac.setEasynewsEnabled}
          easynewsUsername={ac.easynewsUsername}
          setEasynewsUsername={ac.setEasynewsUsername}
          easynewsPassword={ac.easynewsPassword}
          setEasynewsPassword={ac.setEasynewsPassword}
          easynewsPagination={ac.easynewsPagination}
          setEasynewsPagination={ac.setEasynewsPagination}
          easynewsMaxPages={ac.easynewsMaxPages}
          setEasynewsMaxPages={ac.setEasynewsMaxPages}
          easynewsMode={ac.easynewsMode}
          setEasynewsMode={ac.setEasynewsMode}
          easynewsHealthCheck={ac.easynewsHealthCheck}
          setEasynewsHealthCheck={ac.setEasynewsHealthCheck}
          showEasynewsPassword={ac.showEasynewsPassword}
          setShowEasynewsPassword={ac.setShowEasynewsPassword}
          easynewsTestStatus={ac.easynewsTestStatus}
          setEasynewsTestStatus={ac.setEasynewsTestStatus}
          easynewsTestMessage={ac.easynewsTestMessage}
          setEasynewsTestMessage={ac.setEasynewsTestMessage}
          prowlarrUrl={ac.prowlarrUrl}
          setProwlarrUrl={ac.setProwlarrUrl}
          prowlarrApiKey={ac.prowlarrApiKey}
          setProwlarrApiKey={ac.setProwlarrApiKey}
          showProwlarrKey={ac.showProwlarrKey}
          setShowProwlarrKey={ac.setShowProwlarrKey}
          nzbhydraUrl={ac.nzbhydraUrl}
          setNzbhydraUrl={ac.setNzbhydraUrl}
          nzbhydraApiKey={ac.nzbhydraApiKey}
          setNzbhydraApiKey={ac.setNzbhydraApiKey}
          showNzbhydraKey={ac.showNzbhydraKey}
          setShowNzbhydraKey={ac.setShowNzbhydraKey}
          syncedIndexers={ac.syncedIndexers}
          setSyncedIndexers={ac.setSyncedIndexers}
          syncStatus={ac.syncStatus}
          setSyncStatus={ac.setSyncStatus}
          syncMessage={ac.syncMessage}
          setSyncMessage={ac.setSyncMessage}
          selectedSyncedIndexer={ac.selectedSyncedIndexer}
          setSelectedSyncedIndexer={ac.setSelectedSyncedIndexer}
          connectionTestStatus={ac.connectionTestStatus}
          setConnectionTestStatus={ac.setConnectionTestStatus}
          connectionTestMessage={ac.connectionTestMessage}
          setConnectionTestMessage={ac.setConnectionTestMessage}
          handleReorderSyncedIndexer={handleReorderSyncedIndexer}
          failedLogos={ac.failedLogos}
          setFailedLogos={ac.setFailedLogos}
          getAvailableMovieMethods={getAvailableMovieMethods}
          getAvailableTvMethods={getAvailableTvMethods}
          renderMethodLabel={renderMethodLabel}
          setShowAddIndexer={ac.setShowAddIndexer}
          expandedIndexer={ac.expandedIndexer}
          setExpandedIndexer={ac.setExpandedIndexer}
          draggedIndexer={ac.draggedIndexer}
          setDraggedIndexer={ac.setDraggedIndexer}
          dragOverIndexer={ac.dragOverIndexer}
          setDragOverIndexer={ac.setDragOverIndexer}
          pendingSave={ac.pendingSave}
          testResults={ac.testResults}
          handleDragReorder={handleDragReorder}
          saveIndexerOrder={saveIndexerOrder}
          startEdit={startEdit}
          handleReorderIndexer={handleReorderIndexer}
          fetchIndexers={ac.fetchIndexers}
        />
      )}

      {/* Streaming Overlay */}
      {ac.activeOverlay === 'streaming' && (
        <StreamingOverlay
          onClose={() => ac.setActiveOverlay(null)}
          config={ac.config}
          setConfig={ac.setConfig}
          streamingMode={ac.streamingMode}
          setStreamingMode={ac.setStreamingMode}
          nzbdavUrl={ac.nzbdavUrl}
          setNzbdavUrl={ac.setNzbdavUrl}
          nzbdavApiKey={ac.nzbdavApiKey}
          setNzbdavApiKey={ac.setNzbdavApiKey}
          nzbdavWebdavUrl={ac.nzbdavWebdavUrl}
          setNzbdavWebdavUrl={ac.setNzbdavWebdavUrl}
          nzbdavWebdavUser={ac.nzbdavWebdavUser}
          setNzbdavWebdavUser={ac.setNzbdavWebdavUser}
          nzbdavWebdavPassword={ac.nzbdavWebdavPassword}
          setNzbdavWebdavPassword={ac.setNzbdavWebdavPassword}
          nzbdavMoviesCategory={ac.nzbdavMoviesCategory}
          setNzbdavMoviesCategory={ac.setNzbdavMoviesCategory}
          nzbdavTvCategory={ac.nzbdavTvCategory}
          setNzbdavTvCategory={ac.setNzbdavTvCategory}
          nzbdavMaxFallbacks={ac.nzbdavMaxFallbacks}
          setNzbdavMaxFallbacks={ac.setNzbdavMaxFallbacks}
          nzbdavStreamBufferMB={ac.nzbdavStreamBufferMB}
          setNzbdavStreamBufferMB={ac.setNzbdavStreamBufferMB}
          nzbdavConnectionStatus={ac.nzbdavConnectionStatus}
          nzbdavTestNzbStatus={ac.nzbdavTestNzbStatus}
          nzbdavTestNzbMessage={ac.nzbdavTestNzbMessage}
          checkNzbdavConnection={ac.checkNzbdavConnection}
          sendNzbdavTestNzb={ac.sendNzbdavTestNzb}
        />
      )}

      {/* Cache TTL Overlay */}
      {ac.activeOverlay === 'cache' && (
        <CacheTTLOverlay
          onClose={() => ac.setActiveOverlay(null)}
          cacheTTL={ac.cacheTTL}
          setCacheTTL={ac.setCacheTTL}
          apiFetch={apiFetch}
        />
      )}

      {/* Stats Overlay */}
      {ac.activeOverlay === 'stats' && (
        <StatsOverlay
          onClose={() => ac.setActiveOverlay(null)}
          statsData={ac.statsData}
          statsLoading={ac.statsLoading}
          statsSortBy={ac.statsSortBy}
          setStatsSortBy={ac.setStatsSortBy}
          statsSortDir={ac.statsSortDir}
          setStatsSortDir={ac.setStatsSortDir}
          statsExpandedIndexer={ac.statsExpandedIndexer}
          setStatsExpandedIndexer={ac.setStatsExpandedIndexer}
          rankedIndexers={ac.rankedIndexers}
          categoryAwards={ac.categoryAwards}
          apiFetch={apiFetch}
          fetchStats={ac.fetchStats}
        />
      )}

      {/* User Agent Overlay */}
      {ac.activeOverlay === 'userAgent' && (
        <UserAgentOverlay
          onClose={() => ac.setActiveOverlay(null)}
          userAgents={ac.userAgents}
          setUserAgents={ac.setUserAgents}
          apiFetch={apiFetch}
        />
      )}

      {/* Filters Overlay */}
      {ac.activeOverlay === 'filters' && (
        <FiltersOverlay
          onClose={() => ac.setActiveOverlay(null)}
          filters={ac.filters}
          setFilters={ac.setFilters}
          movieFilters={ac.movieFilters}
          setMovieFilters={ac.setMovieFilters}
          tvFilters={ac.tvFilters}
          setTvFilters={ac.setTvFilters}
        />
      )}

      {/* Health Checks Overlay */}
      {ac.activeOverlay === 'healthChecks' && (
        <HealthChecksOverlay
          onClose={() => ac.setActiveOverlay(null)}
          config={ac.config}
          healthChecks={ac.healthChecks}
          setHealthChecks={ac.setHealthChecks}
          indexManager={ac.indexManager}
          syncedIndexers={ac.syncedIndexers}
          setSyncedIndexers={ac.setSyncedIndexers}
          failedLogos={ac.failedLogos}
          setFailedLogos={ac.setFailedLogos}
          apiFetch={apiFetch}
        />
      )}

      {/* Proxy Overlay */}
      {ac.activeOverlay === 'proxy' && (
        <ProxyOverlay
          onClose={() => ac.setActiveOverlay(null)}
          config={ac.config}
          setConfig={ac.setConfig}
          proxyMode={ac.proxyMode}
          setProxyMode={ac.setProxyMode}
          proxyUrl={ac.proxyUrl}
          setProxyUrl={ac.setProxyUrl}
          proxyStatus={ac.proxyStatus}
          proxyIp={ac.proxyIp}
          localIp={ac.localIp}
          proxyIndexers={ac.proxyIndexers}
          setProxyIndexers={ac.setProxyIndexers}
          indexManager={ac.indexManager}
          syncedIndexers={ac.syncedIndexers}
          failedLogos={ac.failedLogos}
          setFailedLogos={ac.setFailedLogos}
          checkProxyStatus={ac.checkProxyStatus}
        />
      )}

      {/* Auto Play Overlay */}
      {ac.activeOverlay === 'autoPlay' && (
        <AutoPlayOverlay
          onClose={() => ac.setActiveOverlay(null)}
          autoPlay={ac.autoPlay}
          setAutoPlay={ac.setAutoPlay}
        />
      )}

      {/* Stream Display Overlay */}
      {ac.activeOverlay === 'streamDisplay' && (
        <StreamDisplayOverlay
          onClose={() => ac.setActiveOverlay(null)}
          streamDisplayConfig={ac.streamDisplayConfig}
          setStreamDisplayConfig={ac.setStreamDisplayConfig}
          emojiPickerTarget={ac.emojiPickerTarget}
          setEmojiPickerTarget={ac.setEmojiPickerTarget}
          emojiSearch={ac.emojiSearch}
          setEmojiSearch={ac.setEmojiSearch}
          elementDrag={ac.elementDrag}
          setElementDrag={ac.setElementDrag}
          elementDragOver={ac.elementDragOver}
          setElementDragOver={ac.setElementDragOver}
          draggedLineGroup={ac.draggedLineGroup}
          setDraggedLineGroup={ac.setDraggedLineGroup}
          dragOverLineGroup={ac.dragOverLineGroup}
          setDragOverLineGroup={ac.setDragOverLineGroup}
          handleElementDrop={ac.handleElementDrop}
        />
      )}

      {/* Zyclops Overlay */}
      {ac.activeOverlay === 'zyclops' && (
        <ZyclopsOverlay
          onClose={() => ac.setActiveOverlay(null)}
          apiFetch={apiFetch}
          config={ac.config}
          setConfig={ac.setConfig}
          failedLogos={ac.failedLogos}
          setFailedLogos={ac.setFailedLogos}
          zyclopsEndpoint={ac.zyclopsEndpoint}
          setZyclopsEndpoint={ac.setZyclopsEndpoint}
          zyclopsTestStatus={ac.zyclopsTestStatus}
          setZyclopsTestStatus={ac.setZyclopsTestStatus}
          zyclopsTestMessage={ac.zyclopsTestMessage}
          setZyclopsTestMessage={ac.setZyclopsTestMessage}
          zyclopsConfirmDialog={ac.zyclopsConfirmDialog}
          setZyclopsConfirmDialog={ac.setZyclopsConfirmDialog}
          singleIpConfirmDialog={ac.singleIpConfirmDialog}
          setSingleIpConfirmDialog={ac.setSingleIpConfirmDialog}
          setProxyIndexers={ac.setProxyIndexers}
          setHealthChecks={ac.setHealthChecks}
        />
      )}

      {/* Logs Overlay */}
      {ac.activeOverlay === 'logs' && (
        <LogsOverlay onClose={() => ac.setActiveOverlay(null)} apiFetch={apiFetch} />
      )}

      {/* Animated background grid */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: 'linear-gradient(rgba(14, 165, 233, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(14, 165, 233, 0.1) 1px, transparent 1px)',
          backgroundSize: '50px 50px'
        }} />
      </div>

      <div className="flex-1 flex flex-col max-w-6xl mx-auto w-full relative z-10 min-h-0">
        {/* Header */}
        <div className="relative flex-shrink-0 sticky top-0 z-30">
          {/* Gradient accent line */}
          <div className="h-[3px] bg-gradient-to-r from-amber-600 via-yellow-500 to-amber-600" />

          {/* Ambient glow */}
          <div className="absolute top-0 left-1/4 w-80 h-20 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute top-0 right-1/4 w-80 h-20 bg-yellow-500/5 rounded-full blur-3xl pointer-events-none" />

          {/* Brand Row */}
          <div className="relative flex items-center px-4 md:px-6 pt-4 pb-3 bg-gradient-to-b from-slate-900/95 to-slate-900/80 backdrop-blur-xl">
            <div className="flex items-center gap-3 md:gap-4">
              {/* Icon Mark */}
              <div className="relative group">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500 to-yellow-600 rounded-xl blur-lg opacity-40 group-hover:opacity-60 transition-opacity" />
                <div className="relative w-10 h-10 md:w-11 md:h-11 rounded-xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25 group-hover:scale-105 transition-transform">
                  <Crown className="w-5 h-5 md:w-6 md:h-6 text-white" />
                </div>
              </div>
              {/* Title & Version */}
              <div>
                <div className="flex items-baseline gap-2">
                  <h1 className="text-lg md:text-xl font-bold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">Usenet Ultimate</h1>
                  <span className="text-[10px] text-amber-400 font-mono bg-slate-800/80 px-1.5 py-0.5 rounded-md border border-amber-500/30">v{__APP_VERSION__}</span>
                </div>
                <p className="text-[11px] text-white mt-0.5 hidden sm:block tracking-wide">The Ultimate Usenet Streaming Experience</p>
              </div>
            </div>
          </div>

          {/* Navigation Row */}
          <div className="flex items-center justify-between px-3 md:px-5 py-2 bg-slate-900/60 backdrop-blur-sm border-b border-slate-700/50">
            <div className="flex items-center gap-1">
              {[
                { id: 'dashboard' as Tab, icon: LayoutDashboard, label: 'Dashboard' },
                { id: 'install' as Tab, icon: Download, label: 'Install' }
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => ac.setActiveTab(tab.id)}
                  className={clsx(
                    'flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
                    ac.activeTab === tab.id
                      ? 'bg-gradient-to-r from-amber-500/15 to-yellow-500/15 text-white border border-amber-500/25 shadow-sm shadow-amber-500/10'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  )}
                >
                  <tab.icon className={clsx(
                    'w-4 h-4 transition-all',
                    ac.activeTab === tab.id && 'text-amber-400 drop-shadow-[0_0_6px_rgba(245,158,11,0.6)]'
                  )} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            <button
              onClick={auth.handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/40 hover:bg-slate-700/50 border border-slate-700/40 rounded-lg transition-all duration-200"
              title={`Signed in as ${auth.authUsername}`}
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>

        {/* Tab Content - Dashboard */}
        {ac.activeTab === 'dashboard' && ac.config && (
          <DashboardTab
            config={ac.config}
            addonEnabled={ac.addonEnabled}
            setAddonEnabled={ac.setAddonEnabled}
            setActiveOverlay={ac.setActiveOverlay}
            indexManager={ac.indexManager}
            easynewsEnabled={ac.easynewsEnabled}
            enabledIndexersCount={enabledIndexersCount}
            syncedIndexers={ac.syncedIndexers}
            nzbdavConnectionStatus={ac.nzbdavConnectionStatus}
            proxyMode={ac.proxyMode}
            proxyStatus={ac.proxyStatus}
            userAgents={ac.userAgents}
            filters={ac.filters}
            autoPlay={ac.autoPlay}
            streamDisplayConfig={ac.streamDisplayConfig}
            healthChecks={ac.healthChecks}
            statsData={ac.statsData}
            fetchStats={ac.fetchStats}
            hasIndexers={!!hasIndexers}
            cardOrder={ac.cardOrder}
            draggedCard={ac.draggedCard}
            dragOverCard={ac.dragOverCard}
            handleCardDragStart={ac.handleCardDragStart}
            handleCardDragOver={ac.handleCardDragOver}
            handleCardDrop={ac.handleCardDrop}
            handleCardDragEnd={ac.handleCardDragEnd}
          />
        )}

        {/* Tab Content - Install */}
        {ac.activeTab === 'install' && ac.config && (
          <InstallTab
            manifestKey={auth.manifestKey}
            hasIndexers={!!hasIndexers}
          />
        )}
      </div>
    </div>
  );
}

export default App;

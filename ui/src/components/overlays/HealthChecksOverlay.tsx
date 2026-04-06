// What this does:
//   Health checks overlay for configuring NNTP health check providers, inspection settings,
//   per-indexer toggles, and stream status options

import { useState } from 'react';
import { Heart, X, Plus, Server, GripVertical, Activity, Trash2, Save } from 'lucide-react';
import clsx from 'clsx';
import type { Config, HealthChecksState, UsenetProvider, Indexer, SyncedIndexer } from '../../types';
interface HealthChecksOverlayProps {
  onClose: () => void;
  config: Config | null;
  healthChecks: HealthChecksState;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  syncedIndexers: SyncedIndexer[];
  setSyncedIndexers: React.Dispatch<React.SetStateAction<SyncedIndexer[]>>;
  failedLogos: Set<string>;
  setFailedLogos: React.Dispatch<React.SetStateAction<Set<string>>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  easynewsHealthCheck: boolean;
  setEasynewsHealthCheck: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function HealthChecksOverlay({
  onClose,
  config,
  healthChecks,
  setHealthChecks,
  indexManager,
  syncedIndexers,
  setSyncedIndexers,
  failedLogos,
  setFailedLogos,
  apiFetch,
  easynewsHealthCheck,
  setEasynewsHealthCheck,
}: HealthChecksOverlayProps) {
  // Local state for provider management
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState<Omit<UsenetProvider, 'id'>>({
    name: '', host: '', port: 563, useTLS: true, username: '', password: '',
    enabled: true, type: 'pool'
  });
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerEditForm, setProviderEditForm] = useState<UsenetProvider | null>(null);
  const [providerTestStatus, setProviderTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({});
  const [providerTestMessage, setProviderTestMessage] = useState<Record<string, string>>({});
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [dragOverProvider, setDragOverProvider] = useState<string | null>(null);
  const [deleteProviderConfirm, setDeleteProviderConfirm] = useState<{ show: boolean; providerId: string }>({ show: false, providerId: '' });

  // Provider handlers
  const testProviderConnection = async (provider: { host: string; port: number; useTLS: boolean; username: string; password: string }, id: string) => {
    setProviderTestStatus(prev => ({ ...prev, [id]: 'testing' }));
    setProviderTestMessage(prev => ({ ...prev, [id]: '' }));
    try {
      const response = await apiFetch('/api/health-check/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: provider.host,
          port: provider.port,
          useTLS: provider.useTLS,
          username: provider.username,
          password: provider.password
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setProviderTestStatus(prev => ({ ...prev, [id]: 'success' }));
        setProviderTestMessage(prev => ({ ...prev, [id]: data.message || 'Connected' }));
      } else {
        setProviderTestStatus(prev => ({ ...prev, [id]: 'error' }));
        setProviderTestMessage(prev => ({ ...prev, [id]: data.message || 'Connection failed' }));
      }
    } catch {
      setProviderTestStatus(prev => ({ ...prev, [id]: 'error' }));
      setProviderTestMessage(prev => ({ ...prev, [id]: 'Failed to connect' }));
    }
  };

  const handleAddProvider = async () => {
    try {
      const response = await apiFetch('/api/health-check/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProvider),
      });
      if (response.ok) {
        const provider = await response.json();
        setHealthChecks(prev => ({ ...prev, providers: [...prev.providers, provider] }));
        setNewProvider({ name: '', host: '', port: 563, useTLS: true, username: '', password: '', enabled: true, type: 'pool' });
        setShowAddProvider(false);
        // Carry over test status from the 'new' form if user already tested
        const existingStatus = providerTestStatus['new'];
        if (existingStatus === 'success' || existingStatus === 'error') {
          setProviderTestStatus(prev => ({ ...prev, [provider.id]: existingStatus, new: 'idle' }));
          setProviderTestMessage(prev => ({ ...prev, [provider.id]: providerTestMessage['new'] || '', new: '' }));
        }
        // Always run a fresh connection test
        testProviderConnection(provider, provider.id);
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to add provider');
      }
    } catch (error) {
      console.error('Failed to add provider:', error);
      alert('Failed to add provider');
    }
  };

  const handleUpdateProvider = async (id: string) => {
    if (!providerEditForm) return;
    try {
      const response = await apiFetch(`/api/health-check/providers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerEditForm),
      });
      if (response.ok) {
        const updated = await response.json();
        setHealthChecks(prev => ({
          ...prev,
          providers: prev.providers.map(p => p.id === id ? updated : p)
        }));
        setExpandedProvider(null);
        setProviderEditForm(null);
      }
    } catch (error) {
      console.error('Failed to update provider:', error);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    setDeleteProviderConfirm({ show: false, providerId: '' });
    try {
      const response = await apiFetch(`/api/health-check/providers/${id}`, { method: 'DELETE' });
      if (response.ok) {
        setHealthChecks(prev => ({
          ...prev,
          providers: prev.providers.filter(p => p.id !== id)
        }));
        if (expandedProvider === id) {
          setExpandedProvider(null);
          setProviderEditForm(null);
        }
      }
    } catch (error) {
      console.error('Failed to delete provider:', error);
    }
  };

  const handleToggleProvider = async (id: string, enabled: boolean) => {
    try {
      const response = await apiFetch(`/api/health-check/providers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (response.ok) {
        const updated = await response.json();
        setHealthChecks(prev => ({
          ...prev,
          providers: prev.providers.map(p => p.id === id ? updated : p)
        }));
      }
    } catch (error) {
      console.error('Failed to toggle provider:', error);
    }
  };

  const handleProviderDragStart = (id: string) => {
    setDraggedProvider(id);
  };

  const handleProviderDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (draggedProvider && draggedProvider !== id) {
      setDragOverProvider(id);
    }
  };

  const handleProviderDrop = async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedProvider || draggedProvider === targetId) return;

    const providers = [...healthChecks.providers];
    const dragIdx = providers.findIndex(p => p.id === draggedProvider);
    const targetIdx = providers.findIndex(p => p.id === targetId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [moved] = providers.splice(dragIdx, 1);
    providers.splice(targetIdx, 0, moved);

    setHealthChecks(prev => ({ ...prev, providers }));
    setDraggedProvider(null);
    setDragOverProvider(null);

    try {
      await apiFetch('/api/health-check/providers/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: providers.map(p => p.id) }),
      });
    } catch (error) {
      console.error('Failed to reorder providers:', error);
    }
  };

  const handleProviderDragEnd = () => {
    setDraggedProvider(null);
    setDragOverProvider(null);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
          <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Heart className="w-6 h-6 text-pink-400" />
                <h3 className="text-xl font-semibold text-slate-200">Health Checks</h3>
              </div>
              <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          <div className="p-4 md:p-6 space-y-6">
            {/* Enable/Disable */}
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={healthChecks.enabled}
                  onChange={(e) => setHealthChecks({ ...healthChecks, enabled: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                />
                <span className="text-sm font-medium text-slate-300">Enable Health Checks</span>
              </label>
              <p className="text-xs text-slate-500 mt-2 ml-8">Verify NZB availability before displaying streams</p>
            </div>

            {/* Health Check Options */}
            <div className={clsx("p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4 transition-opacity", !healthChecks.enabled && "opacity-40 pointer-events-none")}>
              <h4 className="text-sm font-semibold text-slate-300">Health Check Options</h4>

              {/* Archive Inspection toggle */}
              <div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={healthChecks.archiveInspection}
                    onChange={(e) => setHealthChecks({ ...healthChecks, archiveInspection: e.target.checked })}
                    className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                  />
                  <span className="text-sm font-medium text-slate-300">Archive Header Inspection</span>
                </label>
                <p className="text-xs text-slate-500 mt-2 ml-8">
                  Downloads and inspects archive headers (RAR, 7z, ZIP) to detect encryption, nested archives, and verify video content is present. Disable for faster checks that only verify segment availability.
                </p>
              </div>

              {/* Articles to Sample selector */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Articles to Sample</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setHealthChecks({ ...healthChecks, sampleCount: 3 })}
                    className={clsx(
                      "px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                      healthChecks.sampleCount === 3
                        ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                        : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                    )}
                  >
                    3 Samples
                  </button>
                  <button
                    onClick={() => setHealthChecks({ ...healthChecks, sampleCount: 7 })}
                    className={clsx(
                      "px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                      healthChecks.sampleCount === 7
                        ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                        : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                    )}
                  >
                    7 Samples
                  </button>
                </div>
              </div>

              {/* Sub-options */}
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Auto-queue to NZBDav</label>
                  <select
                    value={healthChecks.autoQueueMode}
                    onChange={(e) => setHealthChecks({ ...healthChecks, autoQueueMode: e.target.value as 'off' | 'top' | 'all' })}
                    className="input max-w-xs"
                  >
                    <option value="off">Off</option>
                    <option value="top">Top Result</option>
                    <option value="all">All Healthy</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-1">
                    Automatically queue verified results to NZBDav for caching. Uses cached NZB data from health checks to save indexer grabs. (NZBDav streaming mode only)
                  </p>
                </div>
                {config?.easynewsEnabled && config?.easynewsMode === 'nzb' && (
                  <div>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={easynewsHealthCheck}
                        onChange={(e) => setEasynewsHealthCheck(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                      />
                      <span className="text-sm font-medium text-slate-300">Include EasyNews in Health Checks</span>
                    </label>
                    <p className="text-xs text-slate-500 mt-1 ml-7">
                      Enabled: EasyNews NZBs will be verified via health checks.
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 ml-7">
                      Disabled: EasyNews results auto-marked as healthy.
                    </p>
                    <p className="text-xs text-amber-400 mt-1 ml-7">
                      ⚠️ With EasyNews bypassing health checks and auto-queue set to "All Results", this will queue all EasyNews results to NZBDav. In this case, consider "Top Result" to avoid flooding your download client.
                    </p>
                  </div>
                )}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={healthChecks.hideBlocked}
                      onChange={(e) => setHealthChecks({ ...healthChecks, hideBlocked: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-300">Hide blocked/error NZBs</span>
                  </label>
                  <p className="text-xs text-slate-500 mt-1 ml-7">
                    Remove blocked and errored results so only verified healthy streams are shown
                  </p>
                </div>
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={healthChecks.libraryPreCheck}
                      onChange={(e) => setHealthChecks({ ...healthChecks, libraryPreCheck: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-300">Library Pre-Check</span>
                  </label>
                  <p className="text-xs text-slate-500 mt-1 ml-7">
                    Check the NZBDav library before running NNTP health checks. Content already downloaded is instantly marked as verified, skipping expensive segment checks. (NZBDav streaming mode only)
                  </p>
                </div>
              </div>
            </div>

            {/* Stream Status Legend */}
            <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              <h4 className="text-sm font-semibold text-slate-300 mb-3">Stream Status Legend</h4>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">✅</span>
                  <div>
                    <div className="font-medium text-green-400">Healthy</div>
                    <div className="text-slate-400 text-xs">Articles confirmed available on usenet. Expected to play.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">📚</span>
                  <div>
                    <div className="font-medium text-blue-400">In Library</div>
                    <div className="text-slate-400 text-xs">Already downloaded and available in your NZBDav library. Skipped NNTP health check.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🚫</span>
                  <div>
                    <div className="font-medium text-red-400">Blocked</div>
                    <div className="text-slate-400 text-xs">Missing articles on usenet, unsupported format (ISO/IMG), or no video content. Will not play.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">❌</span>
                  <div>
                    <div className="font-medium text-red-300">Error</div>
                    <div className="text-slate-400 text-xs">Health check failed due to a network error, provider failure, or VPN change.</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Usenet Providers */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-300">Usenet Providers</h4>
                <button
                  onClick={() => setShowAddProvider(true)}
                  className="btn text-sm flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  Add Provider
                </button>
              </div>
              <p className="text-xs text-slate-500">
                All pool providers are checked simultaneously. If segments are still missing, all backup providers are checked simultaneously. Providers where articles are found are listed in results.
              </p>

              {/* Provider list */}
              {healthChecks.providers.length === 0 && !showAddProvider && (
                <div className="p-6 text-center text-slate-500 border border-dashed border-slate-700 rounded-lg">
                  <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No providers configured</p>
                  <p className="text-xs mt-1">Add a Usenet provider to enable health checking</p>
                </div>
              )}

              {healthChecks.providers.map((provider) => {
                const isExpanded = expandedProvider === provider.id;
                const testStatus = providerTestStatus[provider.id] || 'idle';
                const testMsg = providerTestMessage[provider.id] || '';
                const isDragging = draggedProvider === provider.id;
                const isOver = dragOverProvider === provider.id;

                return (
                  <div key={provider.id}>
                    <div
                      draggable
                      onDragStart={() => handleProviderDragStart(provider.id)}
                      onDragOver={(e) => handleProviderDragOver(e, provider.id)}
                      onDrop={(e) => handleProviderDrop(e, provider.id)}
                      onDragEnd={handleProviderDragEnd}
                      className={clsx(
                        "p-4 bg-slate-800/50 rounded-lg border border-slate-700 cursor-move transition-all",
                        isDragging && "opacity-50 scale-95",
                        isOver && "ring-2 ring-pink-400 scale-[1.02]",
                        !provider.enabled && "opacity-60"
                      )}
                      onClick={() => {
                        if (draggedProvider) return;
                        if (isExpanded) {
                          setExpandedProvider(null);
                          setProviderEditForm(null);
                        } else {
                          setExpandedProvider(provider.id);
                          setProviderEditForm({ ...provider });
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <GripVertical className="w-4 h-4 text-slate-600" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-200">{provider.name}</span>
                              <span className={clsx(
                                "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider",
                                provider.type === 'pool'
                                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                  : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                              )}>
                                {provider.type}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500">{provider.host}:{provider.port}{provider.useTLS ? ' (TLS)' : ''}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          {/* Connection status dot */}
                          <div className={clsx(
                            "w-2.5 h-2.5 rounded-full",
                            testStatus === 'success' && "bg-green-400",
                            testStatus === 'error' && "bg-red-400",
                            testStatus === 'testing' && "bg-yellow-400 animate-pulse",
                            testStatus === 'idle' && "bg-slate-600"
                          )} />
                          <input
                            type="checkbox"
                            checked={provider.enabled}
                            onChange={(e) => handleToggleProvider(provider.id, e.target.checked)}
                            className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Expanded edit form */}
                    {isExpanded && providerEditForm && (
                      <div className="mt-2 p-4 bg-slate-800/80 rounded-lg border border-slate-600 space-y-4" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="col-span-2">
                            <label className="block text-sm font-medium text-slate-300 mb-1">Name</label>
                            <input type="text" value={providerEditForm.name} onChange={(e) => setProviderEditForm({ ...providerEditForm, name: e.target.value })} className="input w-full" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1">Host</label>
                            <input type="text" value={providerEditForm.host} onChange={(e) => setProviderEditForm({ ...providerEditForm, host: e.target.value })} placeholder="news.provider.com" className="input w-full" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1">Port</label>
                            <input type="number" value={providerEditForm.port} onChange={(e) => setProviderEditForm({ ...providerEditForm, port: parseInt(e.target.value) || 563 })} className="input w-full" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                            <input type="text" value={providerEditForm.username} onChange={(e) => setProviderEditForm({ ...providerEditForm, username: e.target.value })} className="input w-full" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1">Password</label>
                            <input type="password" value={providerEditForm.password} onChange={(e) => setProviderEditForm({ ...providerEditForm, password: e.target.value })} className="input w-full" />
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={providerEditForm.useTLS} onChange={(e) => setProviderEditForm({ ...providerEditForm, useTLS: e.target.checked })} className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800" />
                            <span className="text-sm text-slate-300">SSL/TLS</span>
                          </label>
                          <div className="flex items-center gap-2">
                            <label className="text-sm text-slate-300">Type:</label>
                            <select
                              value={providerEditForm.type}
                              onChange={(e) => setProviderEditForm({ ...providerEditForm, type: e.target.value as 'pool' | 'backup' })}
                              className="input text-sm py-1"
                            >
                              <option value="pool">Pool</option>
                              <option value="backup">Backup Only</option>
                            </select>
                          </div>
                        </div>

                        {/* Connection test */}
                        <div className={clsx(
                          "flex items-center justify-between p-3 rounded-lg border",
                          testStatus === 'success' && "bg-green-500/10 border-green-500/30",
                          testStatus === 'error' && "bg-red-500/10 border-red-500/30",
                          (testStatus === 'idle' || testStatus === 'testing') && "bg-purple-500/10 border-purple-500/30"
                        )}>
                          <div className="flex items-center gap-2">
                            <Activity className={clsx(
                              "w-4 h-4",
                              testStatus === 'success' && "text-green-400",
                              testStatus === 'error' && "text-red-400",
                              (testStatus === 'idle' || testStatus === 'testing') && "text-purple-400"
                            )} />
                            <span className={clsx(
                              "text-sm",
                              testStatus === 'success' && "text-green-400",
                              testStatus === 'error' && "text-red-400",
                              (testStatus === 'idle' || testStatus === 'testing') && "text-slate-400"
                            )}>
                              {testStatus === 'idle' && 'Not tested'}
                              {testStatus === 'testing' && 'Checking...'}
                              {testStatus === 'success' && (testMsg || 'Connected')}
                              {testStatus === 'error' && (testMsg || 'Failed')}
                            </span>
                          </div>
                          <button
                            onClick={() => testProviderConnection(providerEditForm, provider.id)}
                            disabled={testStatus === 'testing' || !providerEditForm.host}
                            className="btn text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Test
                          </button>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-2">
                          <button
                            onClick={() => setDeleteProviderConfirm({ show: true, providerId: provider.id })}
                            className="text-red-400 hover:text-red-300 text-sm flex items-center gap-1"
                          >
                            <Trash2 className="w-4 h-4" />
                            Delete
                          </button>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { setExpandedProvider(null); setProviderEditForm(null); }}
                              className="btn-secondary text-sm"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleUpdateProvider(provider.id)}
                              className="btn text-sm flex items-center gap-1"
                            >
                              <Save className="w-4 h-4" />
                              Save
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add provider form */}
              {showAddProvider && (
                <div className="p-4 bg-slate-800/80 rounded-lg border border-pink-500/30 space-y-4">
                  <h4 className="text-sm font-semibold text-slate-300">Add Usenet Provider</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-1">Name</label>
                      <input type="text" value={newProvider.name} onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })} placeholder="My Provider" className="input w-full" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Host</label>
                      <input type="text" value={newProvider.host} onChange={(e) => setNewProvider({ ...newProvider, host: e.target.value })} placeholder="news.provider.com" className="input w-full" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Port</label>
                      <input type="number" value={newProvider.port} onChange={(e) => setNewProvider({ ...newProvider, port: parseInt(e.target.value) || 563 })} className="input w-full" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                      <input type="text" value={newProvider.username} onChange={(e) => setNewProvider({ ...newProvider, username: e.target.value })} className="input w-full" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Password</label>
                      <input type="password" value={newProvider.password} onChange={(e) => setNewProvider({ ...newProvider, password: e.target.value })} className="input w-full" />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={newProvider.useTLS} onChange={(e) => setNewProvider({ ...newProvider, useTLS: e.target.checked })} className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-pink-500 focus:ring-pink-500 focus:ring-offset-slate-800" />
                      <span className="text-sm text-slate-300">SSL/TLS</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-slate-300">Type:</label>
                      <select
                        value={newProvider.type}
                        onChange={(e) => setNewProvider({ ...newProvider, type: e.target.value as 'pool' | 'backup' })}
                        className="input text-sm py-1"
                      >
                        <option value="pool">Pool</option>
                        <option value="backup">Backup Only</option>
                      </select>
                    </div>
                  </div>

                  {/* Test connection for new provider */}
                  <div className={clsx(
                    "flex items-center justify-between p-3 rounded-lg border",
                    providerTestStatus['new'] === 'success' && "bg-green-500/10 border-green-500/30",
                    providerTestStatus['new'] === 'error' && "bg-red-500/10 border-red-500/30",
                    (!providerTestStatus['new'] || providerTestStatus['new'] === 'idle' || providerTestStatus['new'] === 'testing') && "bg-purple-500/10 border-purple-500/30"
                  )}>
                    <div className="flex items-center gap-2">
                      <Activity className={clsx(
                        "w-4 h-4",
                        providerTestStatus['new'] === 'success' && "text-green-400",
                        providerTestStatus['new'] === 'error' && "text-red-400",
                        (!providerTestStatus['new'] || providerTestStatus['new'] === 'idle' || providerTestStatus['new'] === 'testing') && "text-purple-400"
                      )} />
                      <span className={clsx(
                        "text-sm",
                        providerTestStatus['new'] === 'success' && "text-green-400",
                        providerTestStatus['new'] === 'error' && "text-red-400",
                        (!providerTestStatus['new'] || providerTestStatus['new'] === 'idle' || providerTestStatus['new'] === 'testing') && "text-slate-400"
                      )}>
                        {(!providerTestStatus['new'] || providerTestStatus['new'] === 'idle') && 'Not tested'}
                        {providerTestStatus['new'] === 'testing' && 'Checking...'}
                        {providerTestStatus['new'] === 'success' && (providerTestMessage['new'] || 'Connected')}
                        {providerTestStatus['new'] === 'error' && (providerTestMessage['new'] || 'Failed')}
                      </span>
                    </div>
                    <button
                      onClick={() => testProviderConnection(newProvider, 'new')}
                      disabled={providerTestStatus['new'] === 'testing' || !newProvider.host}
                      className="btn text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Test
                    </button>
                  </div>

                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setShowAddProvider(false); setNewProvider({ name: '', host: '', port: 563, useTLS: true, username: '', password: '', enabled: true, type: 'pool' }); }} className="btn-secondary text-sm">Cancel</button>
                    <button onClick={handleAddProvider} disabled={!newProvider.name || !newProvider.host} className="btn text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1">
                      <Plus className="w-4 h-4" />
                      Add Provider
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Health Check Settings */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-300">Settings</h4>

              {/* Inspection Method */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Inspection Method</label>
                <select
                  value={healthChecks.inspectionMethod}
                  onChange={(e) => setHealthChecks({ ...healthChecks, inspectionMethod: e.target.value as 'fixed' | 'smart' })}
                  className="input max-w-xs"
                >
                  <option value="fixed">Fixed Count</option>
                  <option value="smart">Smart (Stop on Healthy)</option>
                </select>
                <div className="mt-2 text-xs text-slate-500">
                  {healthChecks.inspectionMethod === 'fixed'
                    ? 'Inspect a fixed number of top results.'
                    : 'Check NZBs in small batches. Stop as soon as a healthy result is found.'}
                </div>
              </div>

              {/* Fixed Count: NZBs to Inspect */}
              {healthChecks.inspectionMethod === 'fixed' && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Number of NZBs to Inspect</label>
                  <input
                    type="number"
                    value={healthChecks.nzbsToInspect ?? ''}
                    onChange={(e) => setHealthChecks({ ...healthChecks, nzbsToInspect: e.target.value === '' ? ('' as any) : parseInt(e.target.value) || 0 })}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => { if (e.target.value === '' || parseInt(e.target.value) < 1) setHealthChecks(prev => ({ ...prev, nzbsToInspect: 6 })); }}
                    min="1"
                    max="20"
                    className="input w-full"
                  />
                  <p className="text-xs text-slate-500 mt-1">How many top results to health check (1-20)</p>
                </div>
              )}

              {/* Smart: Batch Size + Additional Runs */}
              {healthChecks.inspectionMethod === 'smart' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Batch Size</label>
                    <select
                      value={healthChecks.smartBatchSize}
                      onChange={(e) => {
                        const newBatchSize = parseInt(e.target.value);
                        setHealthChecks(prev => ({
                          ...prev,
                          smartBatchSize: newBatchSize,
                        }));
                      }}
                      className="input max-w-xs"
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">NZBs to check per batch</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Additional Runs</label>
                    <input
                      type="number"
                      value={healthChecks.smartAdditionalRuns ?? ''}
                      onChange={(e) => setHealthChecks({ ...healthChecks, smartAdditionalRuns: e.target.value === '' ? ('' as any) : parseInt(e.target.value) || 0 })}
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => { if (e.target.value === '' || parseInt(e.target.value) < 0) setHealthChecks(prev => ({ ...prev, smartAdditionalRuns: 1 })); }}
                      min="0"
                      max="5"
                      className="input w-full"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Additional batches to try if no healthy result found (0-5).{' '}
                      <span className="text-pink-400 font-medium">
                        ({healthChecks.smartBatchSize * (1 + (healthChecks.smartAdditionalRuns || 0))} max NZB checks)
                      </span>
                    </p>
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Connections</label>
                <div className="input w-full cursor-default opacity-70">
                  {healthChecks.inspectionMethod === 'smart'
                    ? healthChecks.smartBatchSize
                    : (healthChecks.nzbsToInspect || 6)}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {healthChecks.inspectionMethod === 'smart'
                    ? 'Auto-set to match batch size.'
                    : 'Auto-set to match NZBs to inspect.'}
                  {' '}<span className="text-amber-400/80">These connections plus any NZBDav connections must not exceed your provider's maximum allowed connections.</span>
                </p>
              </div>
            </div>

            {/* Per-Indexer Health Check Toggles */}
            {config && ((indexManager === 'newznab' && config.indexers.length > 0) || ((indexManager === 'prowlarr' || indexManager === 'nzbhydra') && syncedIndexers.length > 0)) && (
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-3">
                <h4 className="text-sm font-semibold text-slate-300">Indexer Health Checks</h4>
                <p className="text-xs text-slate-500">Click to toggle. Disable for free-tier indexers to save grabs.</p>
                <div className="flex flex-wrap gap-3">
                  {(indexManager === 'newznab' ? config.indexers : syncedIndexers).map((indexer) => {
                    const isZyclopsEnabled = 'zyclops' in indexer && (indexer as Indexer).zyclops?.enabled;
                    const isEnabled = isZyclopsEnabled ? false : (indexManager === 'newznab'
                      ? healthChecks.healthCheckIndexers[indexer.name] !== false
                      : ('enabledForHealthCheck' in indexer ? indexer.enabledForHealthCheck : true));
                    return (
                      <button
                        key={indexer.name}
                        disabled={!!isZyclopsEnabled}
                        onClick={() => {
                          if (isZyclopsEnabled) return;
                          if (indexManager === 'newznab') {
                            setHealthChecks({
                              ...healthChecks,
                              healthCheckIndexers: { ...healthChecks.healthCheckIndexers, [indexer.name]: !isEnabled }
                            });
                          } else {
                            setSyncedIndexers(prev => prev.map(i =>
                              i.name === indexer.name ? { ...i, enabledForHealthCheck: !isEnabled } : i
                            ));
                          }
                        }}
                        className={clsx(
                          'relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all w-16',
                          isZyclopsEnabled
                            ? 'border-violet-500/20 bg-violet-500/5 opacity-60 cursor-not-allowed'
                            : isEnabled
                              ? 'border-slate-600 bg-slate-700/50 hover:bg-slate-700'
                              : 'border-slate-700/50 bg-slate-800/80 hover:bg-slate-800 opacity-60'
                        )}
                        title={isZyclopsEnabled ? `${indexer.name} — verified by Zyclops 🤖` : `${indexer.name} — health checks ${isEnabled ? 'enabled' : 'disabled'}`}
                      >
                        <div className="relative w-10 h-10 flex items-center justify-center">
                          {indexer.logo && !failedLogos.has(indexer.logo) ? (
                            <img
                              src={indexer.logo}
                              alt={indexer.name}
                              className={clsx(
                                'w-10 h-10 rounded-lg object-contain bg-slate-700/30 p-1 transition-all',
                                !isEnabled && !isZyclopsEnabled && 'grayscale'
                              )}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                setFailedLogos(prev => new Set(prev).add(indexer.logo!));
                              }}
                            />
                          ) : (
                            <div className={clsx(
                              'w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all',
                              isZyclopsEnabled ? 'bg-violet-700/30 text-violet-300' : isEnabled ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-500'
                            )}>
                              {indexer.name.substring(0, 2).toUpperCase()}
                            </div>
                          )}
                          {isZyclopsEnabled ? (
                            <div className="absolute -bottom-0.5 -right-0.5 text-[10px]" title="Verified by Zyclops">🤖</div>
                          ) : (
                            <div className={clsx(
                              'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 transition-all',
                              isEnabled
                                ? 'bg-green-400 shadow-lg shadow-green-400/50'
                                : 'bg-red-400 shadow-lg shadow-red-400/50'
                            )} />
                          )}
                        </div>
                        <span className={clsx(
                          'text-[10px] leading-tight text-center truncate w-full',
                          isZyclopsEnabled ? 'text-violet-400' : isEnabled ? 'text-slate-300' : 'text-slate-500'
                        )}>
                          {indexer.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Reset Button */}
            <div className="pt-4 border-t border-slate-700">
              <button
                onClick={() => {
                  setHealthChecks(prev => ({
                    enabled: false,
                    archiveInspection: true,
                    sampleCount: 3,
                    providers: prev.providers,
                    nzbsToInspect: 6,
                    inspectionMethod: 'smart',
                    smartBatchSize: 3,
                    smartAdditionalRuns: 1,
                    maxConnections: 12,
                    autoQueueMode: 'all',
                    hideBlocked: true,
                    libraryPreCheck: true,
                    healthCheckIndexers: {},
                  }));
                  setProviderTestStatus({});
                  setProviderTestMessage({});
                }}
                className="btn-secondary w-full"
              >
                Reset to Default
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Provider Confirmation */}
      {deleteProviderConfirm.show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setDeleteProviderConfirm({ show: false, providerId: '' })}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-red-500/30 shadow-2xl max-w-sm w-full p-4 md:p-6 animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-red-400 mb-2">Delete Provider</h3>
            <p className="text-sm text-slate-400 mb-4">
              Are you sure you want to delete "{healthChecks.providers.find(p => p.id === deleteProviderConfirm.providerId)?.name}"?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteProviderConfirm({ show: false, providerId: '' })} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => handleDeleteProvider(deleteProviderConfirm.providerId)} className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

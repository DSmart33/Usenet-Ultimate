// What this does:
//   Shared Usenet provider management component used by Health Checks and Ultimate-Fallback overlays.
//   Handles add/edit/delete/reorder/test providers via CRUD API endpoints.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Server, GripVertical, Activity, Trash2, Save } from 'lucide-react';
import clsx from 'clsx';
import type { UsenetProvider } from '../../types';

const ACCENT = {
  pink: { ring: 'ring-pink-400', checkbox: 'text-pink-500 focus:ring-pink-500', border: 'border-pink-500/30', toggleOn: 'bg-pink-500', addBtn: 'bg-pink-500/20 hover:bg-pink-500/30 border border-pink-500/40 text-pink-300' },
  amber: { ring: 'ring-amber-400', checkbox: 'text-amber-500 focus:ring-amber-500', border: 'border-amber-500/30', toggleOn: 'bg-amber-500', addBtn: 'bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300' },
};

interface ProviderManagerProps {
  providers: UsenetProvider[];
  onProvidersChange: (providers: UsenetProvider[]) => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  accentColor: 'pink' | 'amber';
}

export function ProviderManager({ providers, onProvidersChange, apiFetch, accentColor }: ProviderManagerProps) {
  const colors = ACCENT[accentColor];

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
        onProvidersChange([...providers, provider]);
        setNewProvider({ name: '', host: '', port: 563, useTLS: true, username: '', password: '', enabled: true, type: 'pool' });
        setShowAddProvider(false);
        const existingStatus = providerTestStatus['new'];
        if (existingStatus === 'success' || existingStatus === 'error') {
          setProviderTestStatus(prev => ({ ...prev, [provider.id]: existingStatus, new: 'idle' }));
          setProviderTestMessage(prev => ({ ...prev, [provider.id]: providerTestMessage['new'] || '', new: '' }));
        }
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
        onProvidersChange(providers.map(p => p.id === id ? updated : p));
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
        onProvidersChange(providers.filter(p => p.id !== id));
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
        onProvidersChange(providers.map(p => p.id === id ? updated : p));
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

    const reordered = [...providers];
    const dragIdx = reordered.findIndex(p => p.id === draggedProvider);
    const targetIdx = reordered.findIndex(p => p.id === targetId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(targetIdx, 0, moved);

    onProvidersChange(reordered);
    setDraggedProvider(null);
    setDragOverProvider(null);

    try {
      await apiFetch('/api/health-check/providers/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: reordered.map(p => p.id) }),
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
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-300">Usenet Providers</h4>
          <button
            onClick={() => setShowAddProvider(true)}
            className={clsx("px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5", colors.addBtn)}
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </button>
        </div>
        <ul className="text-xs text-slate-500 list-disc list-inside space-y-1">
          <li>Pool providers check articles in parallel for speed.</li>
          <li>Backup providers retry any articles the pool couldn't find.</li>
        </ul>

        {/* Provider list */}
        {providers.length === 0 && !showAddProvider && (
          <div className="p-6 text-center text-slate-500 border border-dashed border-slate-700 rounded-lg">
            <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No providers configured</p>
            <p className="text-xs mt-1">Add a Usenet provider to enable health checking</p>
          </div>
        )}

        {providers.map((provider) => {
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
                  isOver && `ring-2 ${colors.ring} scale-[1.02]`,
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
                  <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                    <button
                      aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name || 'provider'}`}
                      aria-pressed={provider.enabled}
                      onClick={() => handleToggleProvider(provider.id, !provider.enabled)}
                      className={clsx(
                        "relative w-8 h-4 rounded-full transition-colors flex-shrink-0",
                        provider.enabled ? colors.toggleOn : "bg-slate-600"
                      )}
                    >
                      <div className={clsx(
                        "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                        provider.enabled ? "left-4" : "left-0.5"
                      )} />
                    </button>
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
                      <input type="checkbox" checked={providerEditForm.useTLS} onChange={(e) => setProviderEditForm({ ...providerEditForm, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />
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
          <div className={`p-4 bg-slate-800/80 rounded-lg border ${colors.border} space-y-4`}>
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
                <input type="checkbox" checked={newProvider.useTLS} onChange={(e) => setNewProvider({ ...newProvider, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />
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

      {/* Delete Provider Confirmation — portaled to body so the parent overlay's transform doesn't trap `fixed` positioning */}
      {deleteProviderConfirm.show && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setDeleteProviderConfirm({ show: false, providerId: '' })}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-red-500/30 shadow-2xl max-w-sm w-full p-4 md:p-6 animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-red-400 mb-2">Delete Provider</h3>
            <p className="text-sm text-slate-400 mb-4">
              Are you sure you want to delete "{providers.find(p => p.id === deleteProviderConfirm.providerId)?.name}"?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteProviderConfirm({ show: false, providerId: '' })} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => handleDeleteProvider(deleteProviderConfirm.providerId)} className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

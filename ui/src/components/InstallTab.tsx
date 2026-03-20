// What this does:
//   Install Manager — manage multiple Stremio manifest installations (add, rename, regenerate, delete)

import { useState, useCallback, useRef, useEffect } from 'react';
import { Download, Copy, ExternalLink, XCircle, Plus, RefreshCw, Trash2, X, Check, Pencil } from 'lucide-react';
import clsx from 'clsx';
import type { Manifest, ApiFetch } from '../types';

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();
  if (date.getFullYear() === new Date().getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${date.getFullYear()}`;
}

interface InstallTabProps {
  manifests: Manifest[];
  setManifests: React.Dispatch<React.SetStateAction<Manifest[]>>;
  hasIndexers: boolean;
  apiFetch: ApiFetch;
}

export function InstallTab({ manifests, setManifests, hasIndexers, apiFetch }: InstallTabProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmAction, setConfirmAction] = useState<{ type: 'regenerate' | 'delete'; id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const getManifestUrl = (id: string) => `${window.location.origin}/${id}/manifest.json`;
  const getStremioUrl = (id: string) => getManifestUrl(id).replace(/^https?:\/\//, 'stremio://');

  const copyUrl = useCallback(async (id: string) => {
    try {
      await navigator.clipboard.writeText(getManifestUrl(id));
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  }, []);

  const addInstall = useCallback(async () => {
    if (!newName.trim() || adding) return;
    setAdding(true);
    try {
      const res = await apiFetch('/api/manifests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setManifests(prev => [...prev, data.manifest]);
        setNewName('');
        setShowAdd(false);
      }
    } catch {}
    setAdding(false);
  }, [newName, adding, apiFetch, setManifests]);

  const handleRegenerate = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/manifests/${id}/regenerate`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setManifests(prev => prev.map(m => m.id === id ? data.manifest : m));
      }
    } catch {}
    setConfirmAction(null);
  }, [apiFetch, setManifests]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/manifests/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setManifests(prev => prev.filter(m => m.id !== id));
      }
    } catch {}
    setConfirmAction(null);
  }, [apiFetch, setManifests]);

  const handleRename = useCallback(async (id: string, name: string) => {
    if (!name.trim()) return;
    try {
      const res = await apiFetch(`/api/manifests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setManifests(prev => prev.map(m => m.id === id ? data.manifest : m));
      }
    } catch {}
    setEditingId(null);
  }, [apiFetch, setManifests]);

  if (!hasIndexers) {
    return (
      <div className="flex-1 overflow-y-auto p-4 md:p-6 animate-fade-in-up">
        <div className="space-y-4">
          <div className="card p-4 md:p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-6 h-6 text-amber-400" />
            </div>
            <h3 className="text-lg font-semibold text-amber-400 mb-2">Configuration Required</h3>
            <p className="text-slate-300">Configure indexers before installation</p>
          </div>
          <DiscordLink />
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="flex-1 overflow-y-auto p-4 md:p-6 animate-fade-in-up">
      <div className="space-y-4">
        {/* Header */}
        <div className="card p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
                <Download className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-lg font-bold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">Your Installs</h3>
                <p className="text-xs text-slate-400">{manifests.length}/25 installs</p>
              </div>
            </div>
          </div>

          {/* Install Cards */}
          <div className="space-y-3">
            {manifests.map(manifest => (
              <InstallCard
                key={manifest.id}
                manifest={manifest}
                copiedId={copiedId}
                isOnly={manifests.length === 1}
                isEditing={editingId === manifest.id}
                onCopy={copyUrl}
                onRegenerate={() => setConfirmAction({ type: 'regenerate', id: manifest.id, name: manifest.name })}
                onDelete={() => setConfirmAction({ type: 'delete', id: manifest.id, name: manifest.name })}
                onEdit={() => setEditingId(manifest.id)}
                onRename={handleRename}
                onCancelEdit={() => setEditingId(null)}
                getStremioUrl={getStremioUrl}
              />
            ))}
          </div>

          {/* Add Install */}
          {showAdd ? (
            <div className="mt-4 p-4 rounded-lg bg-slate-800/50 border border-slate-700/30 space-y-3 animate-fade-in-up">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-300">New Install</span>
                <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-200">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addInstall(); }}
                  placeholder="Install name (e.g., Jax)"
                  className="input flex-1"
                  maxLength={50}
                  autoFocus
                />
                <button
                  onClick={addInstall}
                  disabled={!newName.trim() || adding}
                  className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  Create
                </button>
              </div>
            </div>
          ) : manifests.length < 25 && (
            <button
              onClick={() => setShowAdd(true)}
              className="mt-4 flex items-center justify-center gap-1.5 w-full px-3 py-2 text-sm font-medium bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white rounded-lg transition-all shadow-lg shadow-green-500/20"
            >
              <Plus className="w-4 h-4" />
              Add Install
            </button>
          )}
        </div>

        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4">
          <h4 className="font-medium text-amber-400 mb-2 text-sm">Installation Steps:</h4>
          <ol className="text-sm text-slate-300 space-y-1 list-decimal list-inside">
            <li>Click "Open in Stremio" or copy the manifest URL</li>
            <li>Paste URL in Stremio if needed</li>
            <li>Click "Install" in Stremio</li>
            <li>Start streaming with Usenet Ultimate!</li>
          </ol>
        </div>

        <DiscordLink />
      </div>
    </div>

    {/* Confirmation Modal — outside scrollable container for correct fixed positioning on mobile */}
    {confirmAction && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setConfirmAction(null)}>
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-sm w-full p-6 space-y-4 animate-fade-in-up" onClick={e => e.stopPropagation()}>
          <h3 className="text-lg font-semibold text-slate-200">
            {confirmAction.type === 'regenerate' ? 'Regenerate Key?' : 'Delete Install?'}
          </h3>
          <p className="text-sm text-slate-400">
            {confirmAction.type === 'regenerate'
              ? `This will generate a new URL for "${confirmAction.name}". The current Stremio installation will stop working until you reinstall with the new URL.`
              : `This will permanently remove "${confirmAction.name}". Any Stremio installation using this install will stop working.`
            }
          </p>
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setConfirmAction(null)}
              className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => confirmAction.type === 'regenerate'
                ? handleRegenerate(confirmAction.id)
                : handleDelete(confirmAction.id)
              }
              className={clsx(
                "px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors",
                confirmAction.type === 'delete'
                  ? "bg-red-600 hover:bg-red-500"
                  : "bg-amber-600 hover:bg-amber-500"
              )}
            >
              {confirmAction.type === 'regenerate' ? 'Regenerate' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ── Install Card ─────────────────────────────────────────────────────

function InstallCard({
  manifest,
  copiedId,
  isOnly,
  isEditing,
  onCopy,
  onRegenerate,
  onDelete,
  onEdit,
  onRename,
  onCancelEdit,
  getStremioUrl,
}: {
  manifest: Manifest;
  copiedId: string | null;
  isOnly: boolean;
  isEditing: boolean;
  onCopy: (id: string) => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRename: (id: string, name: string) => void;
  onCancelEdit: () => void;
  getStremioUrl: (id: string) => string;
}) {
  const manifestUrl = `${window.location.origin}/${manifest.id}/manifest.json`;
  const isActive = manifest.lastUsedAt && (Date.now() - new Date(manifest.lastUsedAt).getTime()) < 24 * 60 * 60 * 1000;
  const [editName, setEditName] = useState(manifest.name);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditName(manifest.name);
      setTimeout(() => editRef.current?.focus(), 0);
    }
  }, [isEditing, manifest.name]);

  return (
    <div className="rounded-lg bg-slate-800/40 border border-slate-700/20 p-4 space-y-3">
      {/* Name + activity + actions */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              ref={editRef}
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onRename(manifest.id, editName);
                if (e.key === 'Escape') onCancelEdit();
              }}
              onBlur={() => editName.trim() ? onRename(manifest.id, editName) : onCancelEdit()}
              className="input text-sm font-semibold w-full"
              maxLength={50}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-semibold truncate bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">{manifest.name}</span>
            </div>
          )}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[11px] text-slate-500">Created {timeAgo(manifest.createdAt)}</span>
            {manifest.lastUsedAt ? (
              <span className="flex items-center gap-1 text-[11px]">
                <span className={clsx("w-1.5 h-1.5 rounded-full", isActive ? "bg-green-400 animate-pulse" : "bg-slate-600")} />
                <span className={isActive ? "text-green-400/70" : "text-slate-500"}>
                  {timeAgo(manifest.lastUsedAt)}
                </span>
              </span>
            ) : (
              <span className="text-[11px] text-slate-600">Never used</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onEdit}
            title="Rename install"
            className="p-1.5 rounded-md text-blue-400/70 hover:text-blue-400 hover:bg-blue-400/10 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRegenerate}
            title="Regenerate key"
            className="p-1.5 rounded-md text-amber-400/70 hover:text-amber-400 hover:bg-amber-400/10 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            disabled={isOnly}
            title={isOnly ? "Can't delete the only install" : "Delete install"}
            className={clsx(
              "p-1.5 rounded-md transition-colors",
              isOnly
                ? "text-slate-700 cursor-not-allowed"
                : "text-red-400/70 hover:text-red-400 hover:bg-red-400/10"
            )}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Manifest URL — always visible */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Addon Manifest URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={manifestUrl}
            readOnly
            onClick={e => (e.target as HTMLInputElement).select()}
            className="input flex-1 font-mono text-xs"
          />
          <button
            onClick={() => onCopy(manifest.id)}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap',
              copiedId === manifest.id
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-slate-700/50 hover:bg-slate-700 text-slate-300 border border-slate-600/50'
            )}
          >
            {copiedId === manifest.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{copiedId === manifest.id ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* Install buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <a
          href={getStremioUrl(manifest.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-white rounded-lg transition-all shadow-sm"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open in Stremio
        </a>
        <button
          onClick={() => window.open(manifestUrl, '_blank', 'noopener,noreferrer')}
          className="flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium bg-slate-700/50 hover:bg-slate-700 text-slate-300 border border-slate-600/50 rounded-lg transition-all"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          View Manifest
        </button>
      </div>
    </div>
  );
}

// ── Discord Link ─────────────────────────────────────────────────────

function DiscordLink() {
  return (
    <a
      href="https://discord.gg/6RPVSeg56v"
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-4 p-4 rounded-lg bg-[#5865F2]/10 border border-[#5865F2]/30 hover:bg-[#5865F2]/20 hover:border-[#5865F2]/50 transition-all"
    >
      <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center shadow-lg shadow-[#5865F2]/20 shrink-0">
        <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold text-[#5865F2] group-hover:text-[#7289DA] transition-colors">Join the Discord</h4>
        <p className="text-xs text-slate-400">Get help, share feedback, and connect with the community</p>
      </div>
      <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-[#5865F2] transition-colors shrink-0" />
    </a>
  );
}

export default InstallTab;

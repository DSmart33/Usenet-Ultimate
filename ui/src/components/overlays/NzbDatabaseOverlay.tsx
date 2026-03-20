// What this does:
//   NZB Database management overlay with independent settings for healthy streams and dead NZBs.
//   Each database can be configured as time-based (TTL sliders) or storage-based (MB limit with FIFO eviction).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, X, CheckCircle, XCircle, ChevronDown, Trash2, HardDrive, Clock, FileVideo, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { decomposeTTL, composeTTL } from '../../utils/ttl';

interface CacheEntryReady { key: string; title: string; indexerName?: string; videoPath: string; videoSize: number; expiresAt: number }
interface CacheEntryFailed { key: string; title: string; indexerName?: string; error: string; expiresAt: number }

function formatBytes(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatExpiry(expiresAt: number): string {
  if (!Number.isFinite(expiresAt)) return 'No expiry';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'Expired';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface NzbDatabaseOverlayProps {
  onClose: () => void;
  healthyNzbDbMode: 'time' | 'storage';
  setHealthyNzbDbMode: React.Dispatch<React.SetStateAction<'time' | 'storage'>>;
  healthyNzbDbTTL: number;
  setHealthyNzbDbTTL: React.Dispatch<React.SetStateAction<number>>;
  healthyNzbDbMaxSizeMB: number;
  setHealthyNzbDbMaxSizeMB: React.Dispatch<React.SetStateAction<number>>;
  deadNzbDbMode: 'time' | 'storage';
  setDeadNzbDbMode: React.Dispatch<React.SetStateAction<'time' | 'storage'>>;
  deadNzbDbTTL: number;
  setDeadNzbDbTTL: React.Dispatch<React.SetStateAction<number>>;
  deadNzbDbMaxSizeMB: number;
  setDeadNzbDbMaxSizeMB: React.Dispatch<React.SetStateAction<number>>;
  nzbdavCacheTimeouts: boolean;
  setNzbdavCacheTimeouts: React.Dispatch<React.SetStateAction<boolean>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

function TTLSliders({ ttl, setTTL }: { ttl: number; setTTL: (v: number) => void }) {
  const { days, hours, minutes, seconds } = decomposeTTL(ttl);
  const updateUnit = (unit: 'days' | 'hours' | 'minutes' | 'seconds', value: number) => {
    const d = unit === 'days' ? value : days;
    const h = unit === 'hours' ? value : hours;
    const m = unit === 'minutes' ? value : minutes;
    const s = unit === 'seconds' ? value : seconds;
    setTTL(Math.min(345600, Math.max(15, composeTTL(d, h, m, s))));
  };

  const units = [
    { key: 'days' as const, label: 'Days', value: days, max: 4 },
    { key: 'hours' as const, label: 'Hours', value: hours, max: 23 },
    { key: 'minutes' as const, label: 'Minutes', value: minutes, max: 59 },
    { key: 'seconds' as const, label: 'Seconds', value: seconds, max: 59 },
  ];

  return (
    <div className="space-y-3">
      {units.map(({ key, label, value, max }) => (
        <div key={key} className="flex items-center gap-3">
          <span className="text-xs text-slate-400 w-16">{label}</span>
          <input
            type="range"
            min={0}
            max={max}
            value={value}
            onChange={(e) => updateUnit(key, parseInt(e.target.value, 10))}
            className="flex-1 accent-amber-400"
          />
          <input
            type="number"
            min={0}
            max={max}
            value={value}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) updateUnit(key, Math.min(max, Math.max(0, v)));
            }}
            className="w-14 bg-slate-700/50 border border-slate-600/30 rounded px-2 py-1 text-sm text-slate-200 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>
      ))}
    </div>
  );
}

function StorageSlider({ sizeMB, setSizeMB }: { sizeMB: number; setSizeMB: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={1}
        max={50}
        value={sizeMB}
        onChange={(e) => setSizeMB(parseInt(e.target.value, 10))}
        className="flex-1 accent-amber-400"
      />
      <input
        type="number"
        min={1}
        max={50}
        value={sizeMB}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) setSizeMB(Math.min(50, Math.max(1, v)));
        }}
        className="w-20 bg-slate-700/50 border border-slate-600/30 rounded px-2 py-1 text-sm text-slate-200 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-xs text-slate-400">MB</span>
    </div>
  );
}

export function NzbDatabaseOverlay({
  onClose,
  healthyNzbDbMode, setHealthyNzbDbMode,
  healthyNzbDbTTL, setHealthyNzbDbTTL,
  healthyNzbDbMaxSizeMB, setHealthyNzbDbMaxSizeMB,
  deadNzbDbMode, setDeadNzbDbMode,
  deadNzbDbTTL, setDeadNzbDbTTL,
  deadNzbDbMaxSizeMB, setDeadNzbDbMaxSizeMB,
  nzbdavCacheTimeouts, setNzbdavCacheTimeouts,
  apiFetch,
}: NzbDatabaseOverlayProps) {
  const [readyEntries, setReadyEntries] = useState<CacheEntryReady[]>([]);
  const [failedEntries, setFailedEntries] = useState<CacheEntryFailed[]>([]);
  const [readyExpanded, setReadyExpanded] = useState(false);
  const [failedExpanded, setFailedExpanded] = useState(false);
  const [readySizeMB, setReadySizeMB] = useState(0);
  const [deadSizeMB, setDeadSizeMB] = useState(0);
  const readyListRef = useRef<HTMLDivElement>(null);
  const failedListRef = useRef<HTMLDivElement>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const [entriesRes, statsRes] = await Promise.all([
        apiFetch('/api/nzbdav/cache/entries'),
        apiFetch('/api/nzbdav/cache'),
      ]);
      if (entriesRes.ok) {
        const data = await entriesRes.json();
        setReadyEntries(data.ready || []);
        setFailedEntries(data.failed || []);
      }
      if (statsRes.ok) {
        const stats = await statsRes.json();
        setReadySizeMB(stats.readySizeMB ?? 0);
        setDeadSizeMB(stats.deadSizeMB ?? 0);
      }
    } catch {}
  }, [apiFetch]);

  const mountedRef = useRef(false);
  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  // Refetch after mode/TTL/size changes (debounced past the 500ms auto-save)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    const timer = setTimeout(() => fetchEntries(), 600);
    return () => clearTimeout(timer);
  }, [healthyNzbDbMode, healthyNzbDbTTL, healthyNzbDbMaxSizeMB, deadNzbDbMode, deadNzbDbTTL, deadNzbDbMaxSizeMB, fetchEntries]);

  const deleteEntry = async (key: string) => {
    try {
      await apiFetch(`/api/nzbdav/cache/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      setReadyEntries(prev => prev.filter(e => e.key !== key));
      setFailedEntries(prev => prev.filter(e => e.key !== key));
      // Refresh size stats
      const statsRes = await apiFetch('/api/nzbdav/cache');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        setReadySizeMB(stats.readySizeMB ?? 0);
        setDeadSizeMB(stats.deadSizeMB ?? 0);
      }
    } catch {}
  };

  const clearReady = async () => {
    try {
      await apiFetch('/api/nzbdav/cache/ready', { method: 'DELETE' });
      setReadyEntries([]);
      setReadySizeMB(0);
    } catch {}
  };

  const clearFailed = async () => {
    try {
      await apiFetch('/api/nzbdav/cache/failed', { method: 'DELETE' });
      setFailedEntries([]);
      setDeadSizeMB(0);
    } catch {}
  };

  const clearTimeouts = async () => {
    try {
      await apiFetch('/api/nzbdav/cache/timeouts', { method: 'DELETE' });
      fetchEntries();
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
                <Database className="w-5 h-5 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-slate-200">NZB Database</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          <div className="text-xs text-slate-500 space-y-1">
            <p>Storage: oldest entries are evicted when the size limit is exceeded.</p>
            <p>Time TTL: expired entries are cleaned up on new stream requests.</p>
          </div>

          {/* ── Healthy NZBs Section ──────────────────────────── */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-md shadow-emerald-500/20">
                <CheckCircle className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-semibold text-slate-200">Healthy NZBs</span>
            </div>
            <p className="text-xs text-slate-500">
              Successful streams are cached to speed up repeat requests.
              <br />
              Clearing this database won't affect streaming — the next request will simply re-verify the stream.
            </p>

            {/* Mode Toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setHealthyNzbDbMode('storage')}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  healthyNzbDbMode === 'storage'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Storage Limit
              </button>
              <button
                onClick={() => setHealthyNzbDbMode('time')}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  healthyNzbDbMode === 'time'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Time TTL
              </button>
            </div>

            {healthyNzbDbMode === 'storage' ? (
              <StorageSlider sizeMB={healthyNzbDbMaxSizeMB} setSizeMB={setHealthyNzbDbMaxSizeMB} />
            ) : (
              <>
                <TTLSliders ttl={healthyNzbDbTTL} setTTL={setHealthyNzbDbTTL} />
                <p className="text-xs text-slate-500">Minimum 15 seconds — lower values cause duplicate downloads from concurrent player requests.</p>
              </>
            )}

            {/* Expandable entry list */}
            <button
              onClick={() => setReadyExpanded(v => {
                if (!v) setTimeout(() => readyListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 320);
                return !v;
              })}
              aria-expanded={readyExpanded}
              className="flex items-center justify-between w-full text-left pt-1 px-2 py-1.5 -mx-2 rounded-lg hover:bg-slate-800/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Healthy NZBs</span>
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-400/15 text-emerald-400 border border-emerald-400/20">
                  {readyEntries.length}
                </span>
                <span className="text-[10px] text-slate-500">~{readySizeMB} MB</span>
                {healthyNzbDbMode === 'storage' && (
                  <div className="w-16 bg-slate-800 rounded-full h-1 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-green-500 transition-all duration-500"
                      style={{ width: `${Math.min((readySizeMB / healthyNzbDbMaxSizeMB) * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <ChevronDown className={clsx("w-4 h-4 text-slate-500 transition-transform duration-200", readyExpanded && "rotate-180")} />
            </button>
            <div ref={readyListRef} className={clsx(
              "overflow-hidden transition-all duration-300 ease-in-out",
              readyExpanded ? "max-h-[300px] opacity-100" : "max-h-0 opacity-0 pointer-events-none"
            )}>
              <div className="space-y-2 pt-1">
                {readyEntries.length > 0 ? (
                  <div className="bg-slate-800/40 rounded-lg border border-slate-700/20 max-h-48 overflow-y-auto p-1 space-y-0.5">
                    {readyEntries.map((entry) => (
                      <div key={entry.key} className="group flex items-start gap-2.5 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 transition-colors">
                        <div className="mt-1.5 w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-300 break-words">{entry.title}</div>
                          <div className="text-xs text-slate-500 truncate">{entry.videoPath}</div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="flex items-center gap-1 text-[10px] text-slate-500">
                              <HardDrive className="w-3 h-3" />
                              {formatBytes(entry.videoSize)}
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-slate-500">
                              <Clock className="w-3 h-3" />
                              {formatExpiry(entry.expiresAt)}
                            </span>
                          </div>
                          {entry.indexerName && (
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-700/80 text-slate-300 mt-0.5 max-w-full truncate">
                              {entry.indexerName}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => deleteEntry(entry.key)}
                          aria-label="Remove entry"
                          className="flex-shrink-0 p-1.5 rounded-md text-red-400/70 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <FileVideo className="w-8 h-8 text-slate-700 mb-2" />
                    <p className="text-xs text-slate-500">No cached streams</p>
                    <p className="text-[10px] text-slate-600 mt-0.5">Streams will appear here after playback</p>
                  </div>
                )}
                <button
                  onClick={clearReady}
                  disabled={readyEntries.length === 0}
                  className={clsx(
                    "flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    "border border-red-500/25 text-red-400 hover:bg-red-500/10 hover:border-red-500/40",
                    readyEntries.length === 0 && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All Healthy
                </button>
              </div>
            </div>
          </div>

          {/* ── Dead NZBs Section ──────────────────────────────────── */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center shadow-md shadow-red-500/20">
                <XCircle className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-semibold text-slate-200">Dead NZBs</span>
            </div>
            <p className="text-xs text-slate-500">
              Known-bad NZBs that are skipped instantly on retry to avoid wasted time.
            </p>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={nzbdavCacheTimeouts}
                onChange={(e) => setNzbdavCacheTimeouts(e.target.checked)}
                className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800"
              />
              <div>
                <span className="text-sm font-medium text-slate-300">Include Timed-Out NZBs</span>
                <p className="text-xs text-slate-500 mt-1">
                  Adds timed-out NZBs to the Dead Database to skip them in future searches. Disable this to allow retries.
                </p>
              </div>
            </label>

            <button
              onClick={clearTimeouts}
              disabled={failedEntries.length === 0}
              className={clsx(
                "flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                "border border-red-500/25 text-red-400 hover:bg-red-500/10 hover:border-red-500/40",
                failedEntries.length === 0 && "opacity-40 cursor-not-allowed"
              )}
            >
              <Trash2 className="w-3 h-3" />
              Clear Timed-Out Entries
            </button>

            {/* Mode Toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setDeadNzbDbMode('storage')}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  deadNzbDbMode === 'storage'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Storage Limit
              </button>
              <button
                onClick={() => setDeadNzbDbMode('time')}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  deadNzbDbMode === 'time'
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Time TTL
              </button>
            </div>

            {deadNzbDbMode === 'storage' ? (
              <StorageSlider sizeMB={deadNzbDbMaxSizeMB} setSizeMB={setDeadNzbDbMaxSizeMB} />
            ) : (
              <>
                <TTLSliders ttl={deadNzbDbTTL} setTTL={setDeadNzbDbTTL} />
                <p className="text-xs text-slate-500">Minimum 15 seconds — lower values cause duplicate downloads from concurrent player requests.</p>
              </>
            )}

            {/* Expandable entry list */}
            <button
              onClick={() => setFailedExpanded(v => {
                if (!v) setTimeout(() => failedListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 320);
                return !v;
              })}
              aria-expanded={failedExpanded}
              className="flex items-center justify-between w-full text-left pt-1 px-2 py-1.5 -mx-2 rounded-lg hover:bg-slate-800/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Dead NZBs</span>
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-400/15 text-red-400 border border-red-400/20">
                  {failedEntries.length}
                </span>
                <span className="text-[10px] text-slate-500">~{deadSizeMB} MB</span>
                {deadNzbDbMode === 'storage' && (
                  <div className="w-16 bg-slate-800 rounded-full h-1 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-red-400 to-orange-500 transition-all duration-500"
                      style={{ width: `${Math.min((deadSizeMB / deadNzbDbMaxSizeMB) * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <ChevronDown className={clsx("w-4 h-4 text-slate-500 transition-transform duration-200", failedExpanded && "rotate-180")} />
            </button>
            <div ref={failedListRef} className={clsx(
              "overflow-hidden transition-all duration-300 ease-in-out",
              failedExpanded ? "max-h-[300px] opacity-100" : "max-h-0 opacity-0 pointer-events-none"
            )}>
              <div className="space-y-2 pt-1">
                {failedEntries.length > 0 ? (
                  <div className="bg-slate-800/40 rounded-lg border border-slate-700/20 max-h-48 overflow-y-auto p-1 space-y-0.5">
                    {failedEntries.map((entry) => (
                      <div key={entry.key} className="group flex items-start gap-2.5 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 transition-colors">
                        <div className="mt-1.5 w-2 h-2 rounded-full bg-red-400 shadow-sm shadow-red-400/50 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-300 break-words">{entry.title}</div>
                          <div className="flex items-center gap-1 text-xs text-red-400/60">
                            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                            <span className="break-words">{entry.error}</span>
                          </div>
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-slate-500">
                            <Clock className="w-3 h-3" />
                            {formatExpiry(entry.expiresAt)}
                          </div>
                          {entry.indexerName && (
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-700/80 text-slate-300 mt-0.5 max-w-full truncate">
                              {entry.indexerName}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => deleteEntry(entry.key)}
                          aria-label="Remove entry"
                          className="flex-shrink-0 p-1.5 rounded-md text-red-400/70 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <AlertTriangle className="w-8 h-8 text-slate-700 mb-2" />
                    <p className="text-xs text-slate-500">No dead NZBs</p>
                    <p className="text-[10px] text-slate-600 mt-0.5">Failed NZBs are tracked here to skip on retry</p>
                  </div>
                )}
                <button
                  onClick={clearFailed}
                  disabled={failedEntries.length === 0}
                  className={clsx(
                    "flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    "border border-red-500/25 text-red-400 hover:bg-red-500/10 hover:border-red-500/40",
                    failedEntries.length === 0 && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All Dead
                </button>
              </div>
            </div>
          </div>

          {/* Reset All */}
          <div className="pt-2">
            <button
              onClick={() => {
                setHealthyNzbDbMode('time');
                setHealthyNzbDbTTL(259200);
                setHealthyNzbDbMaxSizeMB(50);
                setDeadNzbDbMode('storage');
                setDeadNzbDbTTL(86400);
                setDeadNzbDbMaxSizeMB(50);
              }}
              className="btn-secondary w-full"
            >
              Reset to Default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// What this does:
//   NZB Database management overlay with independent settings for healthy streams and dead NZBs.
//   Each database can be configured as time-based (TTL sliders) or storage-based (MB limit with FIFO eviction).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, X, CheckCircle, XCircle, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { decomposeTTL, composeTTL } from '../../utils/ttl';

interface CacheEntryReady { key: string; title: string; videoPath: string; videoSize: number; expiresAt: number }
interface CacheEntryFailed { key: string; title: string; error: string; expiresAt: number }

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
  apiFetch,
}: NzbDatabaseOverlayProps) {
  const [readyEntries, setReadyEntries] = useState<CacheEntryReady[]>([]);
  const [failedEntries, setFailedEntries] = useState<CacheEntryFailed[]>([]);
  const [readyExpanded, setReadyExpanded] = useState(false);
  const [failedExpanded, setFailedExpanded] = useState(false);
  const [readySizeMB, setReadySizeMB] = useState(0);
  const [deadSizeMB, setDeadSizeMB] = useState(0);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="w-6 h-6 text-amber-400" />
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
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-slate-300">Healthy NZBs</span>
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
              onClick={() => setReadyExpanded(v => !v)}
              className="flex items-center justify-between w-full text-left pt-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">
                  {readyEntries.length} {readyEntries.length === 1 ? 'entry' : 'entries'} · ~{readySizeMB} MB
                </span>
              </div>
              <ChevronDown className={clsx("w-4 h-4 text-slate-500 transition-transform", readyExpanded && "rotate-180")} />
            </button>
            {readyExpanded && (
              <div className="space-y-2">
                {readyEntries.length > 0 ? (
                  <div className="bg-slate-800/40 rounded-lg border border-slate-700/20 max-h-48 overflow-y-auto">
                    {readyEntries.map((entry, i) => (
                      <div key={entry.key} className={clsx("flex items-center gap-2 px-3 py-2", i < readyEntries.length - 1 && "border-b border-slate-700/20")}>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-300 truncate">{entry.title}</div>
                          <div className="text-xs text-slate-500 truncate">{entry.videoPath}</div>
                        </div>
                        <button
                          onClick={() => deleteEntry(entry.key)}
                          className="flex-shrink-0 p-1 text-slate-500 hover:text-red-400 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">No streams in database</p>
                )}
                <button
                  onClick={clearReady}
                  disabled={readyEntries.length === 0}
                  className={clsx("btn-secondary w-full !border-red-500/30 !text-red-400 hover:!bg-red-500/10", readyEntries.length === 0 && "opacity-40 cursor-not-allowed")}
                >
                  Clear All Successful
                </button>
              </div>
            )}
          </div>

          {/* ── Dead NZBs Section ──────────────────────────────────── */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-slate-300">Dead NZBs</span>
            </div>
            <p className="text-xs text-slate-500">
              Known-bad NZBs that are skipped instantly on retry to avoid wasted time.
            </p>

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
              onClick={() => setFailedExpanded(v => !v)}
              className="flex items-center justify-between w-full text-left pt-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">
                  {failedEntries.length} {failedEntries.length === 1 ? 'entry' : 'entries'} · ~{deadSizeMB} MB
                </span>
              </div>
              <ChevronDown className={clsx("w-4 h-4 text-slate-500 transition-transform", failedExpanded && "rotate-180")} />
            </button>
            {failedExpanded && (
              <div className="space-y-2">
                {failedEntries.length > 0 ? (
                  <div className="bg-slate-800/40 rounded-lg border border-slate-700/20 max-h-48 overflow-y-auto">
                    {failedEntries.map((entry, i) => (
                      <div key={entry.key} className={clsx("flex items-center gap-2 px-3 py-2", i < failedEntries.length - 1 && "border-b border-slate-700/20")}>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-300 truncate">{entry.title}</div>
                          <div className="text-xs text-red-400/60 truncate">{entry.error}</div>
                        </div>
                        <button
                          onClick={() => deleteEntry(entry.key)}
                          className="flex-shrink-0 p-1 text-slate-500 hover:text-red-400 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">No dead NZBs in database</p>
                )}
                <button
                  onClick={clearFailed}
                  disabled={failedEntries.length === 0}
                  className={clsx("btn-secondary w-full !border-red-500/30 !text-red-400 hover:!bg-red-500/10", failedEntries.length === 0 && "opacity-40 cursor-not-allowed")}
                >
                  Clear All Dead
                </button>
              </div>
            )}
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

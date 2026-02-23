// What this does:
//   Segment cache statistics display with clear button

import { useState, useEffect } from 'react';

interface SegmentCacheStatsProps {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  maxSizeMB: number;
}

export function SegmentCacheStats({ apiFetch, maxSizeMB }: SegmentCacheStatsProps) {
  const [stats, setStats] = useState<{ entries: number; estimatedMB: number; hits: number } | null>(null);
  const [error, setError] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    apiFetch('/api/health-check/segment-cache/stats')
      .then(r => r.json())
      .then(setStats)
      .catch(() => setError(true));
  }, [apiFetch]);

  return (
    <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
      <span>
        {error
          ? 'Cache stats unavailable'
          : stats
            ? `${stats.entries.toLocaleString()} segments (~${stats.estimatedMB.toFixed(1)} MB / ${maxSizeMB} MB) · ${stats.hits.toLocaleString()} cache hits`
            : 'Loading...'}
      </span>
      <button
        onClick={async () => {
          setClearing(true);
          try {
            await apiFetch('/api/health-check/segment-cache/clear', { method: 'POST' });
            setStats({ entries: 0, estimatedMB: 0, hits: 0 });
            setError(false);
          } catch { /* ignore */ }
          setClearing(false);
        }}
        disabled={clearing || !stats?.entries}
        className="text-xs text-pink-400 hover:text-pink-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {clearing ? 'Clearing...' : 'Clear Cache'}
      </button>
    </div>
  );
}

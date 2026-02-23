// What this does:
//   Live log viewer overlay with filtering, IP masking, and auto-scroll

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ScrollText, X, Scissors, ShieldOff, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import type { LogEntry, ApiFetch } from '../../types';
import { IP_REGEX } from '../../constants';

export function LogsOverlay({ onClose, apiFetch }: { onClose: () => void; apiFetch: ApiFetch }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [showFiltered, setShowFiltered] = useState(() => localStorage.getItem('logs_showFiltered') === 'true');
  const [showIPs, setShowIPs] = useState(() => localStorage.getItem('logs_showIPs') === 'true');
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch('/api/logs').then(r => r.json()).then((data: LogEntry[]) => setLogs(data));

    // EventSource can't send custom headers, so pass token via query param
    const token = localStorage.getItem('auth_token');
    const es = new EventSource(`/api/logs/stream${token ? `?token=${token}` : ''}`);
    es.onmessage = (event) => {
      const entry: LogEntry = JSON.parse(event.data);
      setLogs(prev => {
        const next = [...prev, entry];
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    autoScroll.current = atBottom;
  };

  const toggleShowFiltered = useCallback(() => {
    setShowFiltered(prev => { const next = !prev; localStorage.setItem('logs_showFiltered', String(next)); return next; });
  }, []);

  const toggleShowIPs = useCallback(() => {
    setShowIPs(prev => { const next = !prev; localStorage.setItem('logs_showIPs', String(next)); return next; });
  }, []);

  const filtered = useMemo(() => {
    let result = filter === 'all' ? logs : logs.filter(l => l.level === filter);
    if (!showFiltered) {
      result = result.filter(l => !l.message.includes('✂️'));
    }
    return result;
  }, [logs, filter, showFiltered]);

  const formatMessage = useCallback((msg: string) => {
    if (!showIPs) return msg.replace(IP_REGEX, '•••.•••.•••.•••');
    return msg;
  }, [showIPs]);

  const levelColor = (level: string) => {
    if (level === 'error') return 'text-red-400';
    if (level === 'warn') return 'text-yellow-400';
    return 'text-slate-300';
  };

  const levelBadge = (level: string) => {
    if (level === 'error') return 'bg-red-500/20 text-red-400';
    if (level === 'warn') return 'bg-yellow-500/20 text-yellow-400';
    return 'bg-slate-500/20 text-slate-400';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 md:p-4 border-b border-slate-700/50 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              <ScrollText className="w-5 h-5 md:w-6 md:h-6 text-emerald-400 shrink-0" />
              <h3 className="text-base md:text-xl font-semibold text-slate-200 truncate">Live Logs</h3>
              <span className="text-xs text-slate-500 shrink-0">{filtered.length}</span>
            </div>
            <button onClick={onClose} className="ml-2 text-slate-400 hover:text-slate-200 transition-colors shrink-0">
              <X className="w-5 h-5 md:w-6 md:h-6" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
            {(['all', 'info', 'warn', 'error'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "px-2 py-1 text-xs rounded-md transition-colors",
                  filter === f ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-slate-200"
                )}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            <div className="w-px h-4 bg-slate-700/50 mx-1 hidden md:block" />
            <button
              onClick={toggleShowFiltered}
              title={showFiltered ? 'Hide filtered titles' : 'Show filtered titles'}
              className={clsx(
                "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                showFiltered ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "text-slate-500 hover:text-slate-300"
              )}
            >
              <Scissors className="w-3 h-3" />
              <span className="hidden md:inline">Filtered</span>
            </button>
            <button
              onClick={toggleShowIPs}
              title={showIPs ? 'Hide IP addresses' : 'Show IP addresses'}
              className={clsx(
                "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                showIPs ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "text-slate-500 hover:text-slate-300"
              )}
            >
              {showIPs ? <ShieldOff className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
              <span className="hidden md:inline">IPs</span>
            </button>
          </div>
        </div>
        <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2 md:p-4 font-mono text-xs space-y-0.5 bg-slate-950/50">
          {filtered.length === 0 && (
            <div className="text-slate-500 text-center py-8">No log entries yet</div>
          )}
          {filtered.map((entry, i) =>
            entry.message === '' ? (
              <div key={i} className="h-3" />
            ) : (
              <div key={i} className={clsx("flex gap-2 py-0.5 px-2 rounded hover:bg-slate-800/50", levelColor(entry.level))}>
                <span className="text-slate-600 shrink-0 text-[9px] md:text-xs"><span className="md:hidden">{new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false})}</span><span className="hidden md:inline">{new Date(entry.timestamp).toLocaleTimeString()}</span></span>
                <span className={clsx("shrink-0 px-1 rounded text-[10px] uppercase font-bold", levelBadge(entry.level))}>{entry.level}</span>
                <span className="whitespace-pre-wrap break-all">{formatMessage(entry.message)}</span>
              </div>
            )
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

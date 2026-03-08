// What this does:
//   Search cache TTL configuration overlay with day/hour/minute/second sliders

import { Zap, X } from 'lucide-react';
import { formatTTL, decomposeTTL, composeTTL } from '../../utils/ttl';

interface CacheTTLOverlayProps {
  onClose: () => void;
  cacheTTL: number;
  setCacheTTL: React.Dispatch<React.SetStateAction<number>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function CacheTTLOverlay({
  onClose,
  cacheTTL,
  setCacheTTL,
  apiFetch,
}: CacheTTLOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-md w-full animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 md:p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Zap className="w-6 h-6 text-yellow-400" />
              <h3 className="text-xl font-semibold text-slate-200">Search Cache Configuration</h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-3">Search Cache TTL (Time To Live)</label>
              {(() => {
                const { days, hours, minutes, seconds } = decomposeTTL(cacheTTL);
                const updateUnit = (unit: 'days' | 'hours' | 'minutes' | 'seconds', value: number) => {
                  const d = unit === 'days' ? value : days;
                  const h = unit === 'hours' ? value : hours;
                  const m = unit === 'minutes' ? value : minutes;
                  const s = unit === 'seconds' ? value : seconds;
                  setCacheTTL(composeTTL(d, h, m, s));
                };
                return (
                  <div className="space-y-3">
                    {[
                      { label: 'Days', unit: 'days' as const, value: days, max: 3, step: 1 },
                      { label: 'Hours', unit: 'hours' as const, value: hours, max: 23, step: 1 },
                      { label: 'Minutes', unit: 'minutes' as const, value: minutes, max: 59, step: 1 },
                      { label: 'Seconds', unit: 'seconds' as const, value: seconds, max: 59, step: 1 },
                    ].map(({ label, unit, value, max, step }) => (
                      <div key={unit} className="flex items-center gap-3">
                        <span className="text-sm text-slate-400 w-16">{label}</span>
                        <input
                          type="range"
                          min="0"
                          max={max}
                          step={step}
                          value={value}
                          onChange={(e) => updateUnit(unit, Number(e.target.value))}
                          className="flex-1"
                        />
                        <input
                          type="number"
                          min="0"
                          max={max}
                          value={value}
                          onChange={(e) => updateUnit(unit, Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
                          className="input w-16 text-center text-yellow-400 font-bold"
                        />
                      </div>
                    ))}
                  </div>
                );
              })()}
              <div className="text-sm font-medium text-yellow-400 mt-3">{formatTTL(cacheTTL)}</div>
              <p className="text-xs text-slate-500 mt-1">
                How long to cache search results. Set all values to 0 to disable caching. Maximum 4 days.
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Fallback groups also expire with this TTL. When caching is disabled, fallback groups persist for 2 hours.
              </p>
            </div>
            <div className="pt-4 border-t border-slate-700 space-y-2">
              <button
                onClick={() => setCacheTTL(0)}
                className="btn-secondary w-full"
              >
                Reset to Default (Disabled)
              </button>
              <button
                onClick={async () => {
                  try {
                    await apiFetch('/api/search-cache', { method: 'DELETE' });
                  } catch {}
                }}
                className="btn-secondary w-full !border-red-500/30 !text-red-400 hover:!bg-red-500/10"
              >
                Clear Search Cache
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

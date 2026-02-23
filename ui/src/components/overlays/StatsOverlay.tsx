// What this does:
//   Indexer performance metrics overlay — podium, rankings table, visual comparison bars,
//   category awards, and per-indexer detail with sparkline activity graphs.

import {
  X,
  Trophy,
  Activity,
  Database,
  Download,
  Zap,
  Crown,
  Medal,
  Shield,
  Heart,
  TrendingUp,
  Clock,
  ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';

interface StatsOverlayProps {
  onClose: () => void;
  statsData: any;
  statsLoading: boolean;
  statsSortBy: 'score' | 'successRate' | 'avgResponseTime' | 'avgResultsPerQuery' | 'totalGrabs';
  setStatsSortBy: React.Dispatch<React.SetStateAction<'score' | 'successRate' | 'avgResponseTime' | 'avgResultsPerQuery' | 'totalGrabs'>>;
  statsSortDir: 'asc' | 'desc';
  setStatsSortDir: React.Dispatch<React.SetStateAction<'asc' | 'desc'>>;
  statsExpandedIndexer: string | null;
  setStatsExpandedIndexer: React.Dispatch<React.SetStateAction<string | null>>;
  rankedIndexers: any[];
  categoryAwards: any;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  fetchStats: () => void;
}

export function StatsOverlay({
  onClose,
  statsData,
  statsLoading,
  statsSortBy,
  setStatsSortBy,
  statsSortDir,
  setStatsSortDir,
  statsExpandedIndexer,
  setStatsExpandedIndexer,
  rankedIndexers,
  categoryAwards,
  apiFetch,
  fetchStats,
}: StatsOverlayProps) {
  return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
          <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-6xl w-full max-h-[90vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex-shrink-0 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50 rounded-t-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Trophy className="w-6 h-6 text-amber-400" />
                  <h3 className="text-xl font-semibold text-slate-200">Indexer Performance Metrics</h3>
                </div>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
                    <X className="w-6 h-6" />
                  </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
              {statsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-amber-400 border-t-transparent" />
                </div>
              ) : rankedIndexers.length > 0 ? (
                <>
                  {/* Global Stats Summary Bar */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center gap-2 mb-1">
                        <Activity className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-xs text-slate-500">Total Queries</span>
                      </div>
                      <div className="text-xl font-bold text-slate-200">{statsData.globalStats?.totalQueries || 0}</div>
                    </div>
                    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center gap-2 mb-1">
                        <Database className="w-3.5 h-3.5 text-green-400" />
                        <span className="text-xs text-slate-500">Total Results</span>
                      </div>
                      <div className="text-xl font-bold text-slate-200">{statsData.globalStats?.totalResults || 0}</div>
                    </div>
                    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center gap-2 mb-1">
                        <Download className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-xs text-slate-500">Total Grabs</span>
                      </div>
                      <div className="text-xl font-bold text-slate-200">{statsData.globalStats?.totalGrabs || 0}</div>
                    </div>
                    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center gap-2 mb-1">
                        <Zap className="w-3.5 h-3.5 text-yellow-400" />
                        <span className="text-xs text-slate-500">Avg Response</span>
                      </div>
                      <div className="text-xl font-bold text-slate-200">{statsData.globalStats?.avgResponseTime || 0}ms</div>
                    </div>
                  </div>

                  {/* Podium - Top 3 */}
                  {(() => {
                    const qualified = rankedIndexers.filter((i: any) => i.qualified);
                    if (qualified.length < 2) return null;
                    const top3 = qualified.slice(0, 3);
                    // Reorder for podium display: [#2, #1, #3]
                    const podiumOrder = top3.length >= 3
                      ? [top3[1], top3[0], top3[2]]
                      : top3.length === 2
                        ? [top3[1], top3[0]]
                        : [top3[0]];
                    const podiumConfig: Record<number, { color: string; borderColor: string; glowColor: string; height: string; icon: any; label: string }> = {
                      1: { color: 'text-amber-400', borderColor: 'border-amber-400/50', glowColor: 'shadow-amber-400/20', height: 'h-36 md:h-44', icon: Crown, label: '1st' },
                      2: { color: 'text-slate-300', borderColor: 'border-slate-400/40', glowColor: 'shadow-slate-400/10', height: 'h-28 md:h-36', icon: Medal, label: '2nd' },
                      3: { color: 'text-orange-400', borderColor: 'border-orange-400/40', glowColor: 'shadow-orange-400/10', height: 'h-24 md:h-32', icon: Medal, label: '3rd' },
                    };

                    return (
                      <div className="flex items-end justify-center gap-3 md:gap-4">
                        {podiumOrder.map((indexer: any) => {
                          const cfg = podiumConfig[indexer.rank] || podiumConfig[3];
                          const IconComp = cfg.icon;
                          return (
                            <div
                              key={indexer.indexerName}
                              className={clsx(
                                "flex-1 max-w-[240px] rounded-xl border p-3 md:p-4 flex flex-col items-center justify-end bg-slate-800/60 backdrop-blur-sm transition-all",
                                cfg.borderColor, cfg.height, `shadow-lg ${cfg.glowColor}`
                              )}
                            >
                              <IconComp className={clsx("w-5 h-5 md:w-6 md:h-6 mb-1", cfg.color)} />
                              <div className={clsx("text-xs font-bold mb-1", cfg.color)}>#{indexer.rank}</div>
                              <div className="w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center mb-2 relative" style={{
                                background: `conic-gradient(${indexer.score >= 70 ? '#4ade80' : indexer.score >= 40 ? '#facc15' : '#f87171'} ${indexer.score * 3.6}deg, #1e293b ${indexer.score * 3.6}deg)`
                              }}>
                                <div className="w-9 h-9 md:w-11 md:h-11 rounded-full bg-slate-900 flex items-center justify-center">
                                  <span className={clsx("text-sm md:text-base font-bold", cfg.color)}>{indexer.score}</span>
                                </div>
                              </div>
                              <div className="text-xs md:text-sm font-semibold text-slate-200 text-center break-words w-full leading-tight">{indexer.indexerName}</div>
                              <div className="text-[10px] text-slate-500 mt-1">{indexer.successRate}% success</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* Category Awards */}
                  {categoryAwards && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <div className="bg-slate-800/40 rounded-lg p-2.5 border border-cyan-500/20 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
                          <Zap className="w-3.5 h-3.5 text-cyan-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] text-cyan-400 font-medium">Fastest</div>
                          <div className="text-xs text-slate-300 truncate">{categoryAwards.fastest?.indexerName}</div>
                          <div className="text-[10px] text-slate-500">{categoryAwards.fastest?.avgResponseTime}ms</div>
                        </div>
                      </div>
                      <div className="bg-slate-800/40 rounded-lg p-2.5 border border-green-500/20 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0">
                          <Shield className="w-3.5 h-3.5 text-green-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] text-green-400 font-medium">Most Reliable</div>
                          <div className="text-xs text-slate-300 truncate">{categoryAwards.mostReliable?.indexerName}</div>
                          <div className="text-[10px] text-slate-500">{categoryAwards.mostReliable?.successRate}%</div>
                        </div>
                      </div>
                      <div className="bg-slate-800/40 rounded-lg p-2.5 border border-purple-500/20 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                          <Database className="w-3.5 h-3.5 text-purple-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] text-purple-400 font-medium">Most Results</div>
                          <div className="text-xs text-slate-300 truncate">{categoryAwards.mostResults?.indexerName}</div>
                          <div className="text-[10px] text-slate-500">{categoryAwards.mostResults?.avgResultsPerQuery}/query</div>
                        </div>
                      </div>
                      <div className="bg-slate-800/40 rounded-lg p-2.5 border border-pink-500/20 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-pink-500/10 flex items-center justify-center flex-shrink-0">
                          <Heart className="w-3.5 h-3.5 text-pink-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] text-pink-400 font-medium">Most Popular</div>
                          <div className="text-xs text-slate-300 truncate">{categoryAwards.mostPopular?.indexerName}</div>
                          <div className="text-[10px] text-slate-500">{categoryAwards.mostPopular?.totalGrabs || 0} grabs</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Rankings Table */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-cyan-400" />
                        Rankings
                      </h4>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-slate-500">Sort:</span>
                        {([
                          { key: 'score', label: 'Score' },
                          { key: 'successRate', label: 'Reliability' },
                          { key: 'avgResponseTime', label: 'Speed' },
                          { key: 'avgResultsPerQuery', label: 'Results' },
                          { key: 'totalGrabs', label: 'Grabs' },
                        ] as const).map(({ key, label }) => (
                          <button
                            key={key}
                            onClick={() => {
                              if (statsSortBy === key) {
                                setStatsSortDir(d => d === 'desc' ? 'asc' : 'desc');
                              } else {
                                setStatsSortBy(key);
                                setStatsSortDir(key === 'avgResponseTime' ? 'asc' : 'desc');
                              }
                            }}
                            className={clsx(
                              "text-[10px] px-2 py-0.5 rounded-full transition-colors",
                              statsSortBy === key
                                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                                : "text-slate-500 hover:text-slate-300 border border-transparent"
                            )}
                          >
                            {label}
                            {statsSortBy === key && (
                              <span className="ml-0.5">{statsSortDir === 'desc' ? '\u2193' : '\u2191'}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Table Header */}
                    <div className="hidden md:grid grid-cols-[40px_1fr_70px_70px_80px_70px_60px_80px_40px] gap-2 px-3 py-2 text-[10px] text-slate-500 font-medium uppercase tracking-wider">
                      <div>#</div>
                      <div>Indexer</div>
                      <div className="text-center">Score</div>
                      <div className="text-center">Queries</div>
                      <div className="text-center">Success</div>
                      <div className="text-center">Res/Query</div>
                      <div className="text-center">Grabs</div>
                      <div className="text-center">Speed</div>
                      <div></div>
                    </div>

                    {/* Table Rows */}
                    <div className="space-y-1">
                      {rankedIndexers.map((indexer: any) => {
                        const isExpanded = statsExpandedIndexer === indexer.indexerName;
                        const rankColors: Record<number, string> = { 1: 'text-amber-400 bg-amber-400/10 border-amber-400/30', 2: 'text-slate-300 bg-slate-400/10 border-slate-400/30', 3: 'text-orange-400 bg-orange-400/10 border-orange-400/30' };
                        const speedColor = indexer.avgResponseTime < 500 ? 'text-green-400' : indexer.avgResponseTime < 1500 ? 'text-yellow-400' : 'text-red-400';
                        const successColor = indexer.successRate >= 80 ? 'text-green-400' : indexer.successRate >= 50 ? 'text-yellow-400' : 'text-red-400';
                        const successBarColor = indexer.successRate >= 80 ? 'bg-green-400' : indexer.successRate >= 50 ? 'bg-yellow-400' : 'bg-red-400';

                        return (
                          <div key={indexer.indexerName}>
                            {/* Main Row */}
                            <div
                              className={clsx(
                                "grid grid-cols-[30px_1fr_28px] md:grid-cols-[40px_1fr_70px_70px_80px_70px_60px_80px_40px] gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all items-center",
                                isExpanded ? "bg-slate-700/50 border border-slate-600/50" : "bg-slate-800/40 border border-slate-700/20 hover:bg-slate-700/30",
                                !indexer.qualified && "opacity-60"
                              )}
                              onClick={() => setStatsExpandedIndexer(isExpanded ? null : indexer.indexerName)}
                            >
                              {/* Rank */}
                              <div>
                                {indexer.rank && indexer.rank <= 3 ? (
                                  <span className={clsx("inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border", rankColors[indexer.rank])}>
                                    {indexer.rank}
                                  </span>
                                ) : indexer.rank ? (
                                  <span className="text-sm text-slate-500 font-medium pl-1.5">{indexer.rank}</span>
                                ) : (
                                  <span className="text-xs text-slate-600">--</span>
                                )}
                              </div>

                              {/* Indexer Name */}
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-200 truncate">{indexer.indexerName}</div>
                                <div className="text-[10px] text-slate-500 md:hidden">
                                  {indexer.qualified ? `Score: ${indexer.score}` : `${indexer.totalQueries} queries (needs 5+)`}
                                </div>
                              </div>

                              {/* Score Circle */}
                              <div className="hidden md:flex justify-center">
                                {indexer.qualified ? (
                                  <div className="w-9 h-9 rounded-full flex items-center justify-center relative" style={{
                                    background: `conic-gradient(${indexer.score >= 70 ? '#4ade80' : indexer.score >= 40 ? '#facc15' : '#f87171'} ${indexer.score * 3.6}deg, #1e293b ${indexer.score * 3.6}deg)`
                                  }}>
                                    <div className="w-7 h-7 rounded-full bg-slate-900 flex items-center justify-center">
                                      <span className="text-xs font-bold text-slate-200">{indexer.score}</span>
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-600">N/A</span>
                                )}
                              </div>

                              {/* Queries */}
                              <div className="hidden md:block text-center text-sm text-slate-300">{indexer.totalQueries}</div>

                              {/* Success Rate with mini bar */}
                              <div className="hidden md:block text-center">
                                <div className={clsx("text-sm font-medium", successColor)}>{indexer.successRate}%</div>
                                <div className="w-full bg-slate-800 rounded-full h-1 mt-0.5 overflow-hidden">
                                  <div className={clsx("h-full transition-all duration-500 rounded-full", successBarColor)} style={{ width: `${indexer.successRate}%` }} />
                                </div>
                              </div>

                              {/* Avg Results/Query */}
                              <div className="hidden md:block text-center text-sm text-slate-300">{indexer.avgResultsPerQuery}</div>

                              {/* Grabs */}
                              <div className="hidden md:block text-center text-sm text-purple-400">{indexer.totalGrabs || 0}</div>

                              {/* Speed */}
                              <div className="hidden md:block text-center">
                                <span className={clsx("text-sm font-medium", speedColor)}>{indexer.avgResponseTime}ms</span>
                              </div>

                              {/* Expand Arrow */}
                              <div className="flex justify-center">
                                <ChevronRight className={clsx("w-4 h-4 text-slate-500 transition-transform", isExpanded && "rotate-90")} />
                              </div>
                            </div>

                            {/* Mobile stats row (visible only on small screens when not expanded) */}
                            {!isExpanded && (
                              <div className="md:hidden grid grid-cols-4 gap-2 px-3 py-1.5 text-[10px]">
                                <div><span className="text-slate-500">Queries:</span> <span className="text-slate-300">{indexer.totalQueries}</span></div>
                                <div><span className="text-slate-500">Success:</span> <span className={successColor}>{indexer.successRate}%</span></div>
                                <div><span className="text-slate-500">Grabs:</span> <span className="text-purple-400">{indexer.totalGrabs || 0}</span></div>
                                <div><span className="text-slate-500">Speed:</span> <span className={speedColor}>{indexer.avgResponseTime}ms</span></div>
                              </div>
                            )}

                            {/* Expanded Detail */}
                            {isExpanded && (
                              <div className="bg-slate-800/30 border border-slate-700/20 border-t-0 rounded-b-lg px-4 py-3 space-y-4 -mt-1">
                                {/* Detail Stats Grid (mobile-friendly) */}
                                <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                                  <div>
                                    <p className="text-[10px] text-slate-500">Queries</p>
                                    <p className="text-sm font-semibold text-slate-300">{indexer.totalQueries}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500">Successful</p>
                                    <p className="text-sm font-semibold text-green-400">{indexer.successfulQueries}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500">Failed</p>
                                    <p className="text-sm font-semibold text-red-400">{indexer.failedQueries}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500">Total Results</p>
                                    <p className="text-sm font-semibold text-slate-300">{indexer.totalResults}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500">Avg/Query</p>
                                    <p className="text-sm font-semibold text-slate-300">{indexer.avgResultsPerQuery}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500">Last Queried</p>
                                    <p className="text-[10px] font-medium text-slate-400">{indexer.lastQueried ? new Date(indexer.lastQueried).toLocaleString() : 'Never'}</p>
                                  </div>
                                </div>

                                {/* Success Rate Bar */}
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-[10px] text-slate-500">Success Rate</span>
                                    <span className="text-[10px] text-slate-400">{indexer.successfulQueries} / {indexer.totalQueries}</span>
                                  </div>
                                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                                    <div
                                      className={clsx("h-full transition-all duration-500 rounded-full", successBarColor)}
                                      style={{ width: `${indexer.successRate}%` }}
                                    />
                                  </div>
                                </div>

                                {/* Recent Activity Sparkline */}
                                {indexer.queryHistory && indexer.queryHistory.length > 0 && (
                                  <div>
                                    <p className="text-[10px] text-slate-500 mb-2">Recent Activity (last {Math.min(indexer.queryHistory.length, 20)} queries)</p>
                                    <div className="flex items-end gap-0.5 h-12">
                                      {indexer.queryHistory.slice(-20).map((query: any, idx: number) => {
                                        const maxTime = Math.max(...indexer.queryHistory.slice(-20).map((q: any) => q.responseTime));
                                        const height = maxTime > 0 ? (query.responseTime / maxTime) * 100 : 0;
                                        return (
                                          <div
                                            key={idx}
                                            className="flex-1 relative group"
                                            title={`${new Date(query.timestamp).toLocaleString()}\n${query.success ? 'Success' : 'Failed'}\n${query.responseTime}ms\n${query.resultCount} results`}
                                          >
                                            <div className="w-full bg-slate-800 rounded-sm overflow-hidden flex flex-col justify-end h-full">
                                              <div
                                                className={clsx("w-full rounded-t-sm", query.success ? "bg-green-400" : "bg-red-400")}
                                                style={{ height: `${height}%`, minHeight: '2px' }}
                                              />
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <div className="flex justify-between mt-0.5">
                                      <span className="text-[10px] text-slate-600">Oldest</span>
                                      <span className="text-[10px] text-slate-600">Recent</span>
                                    </div>
                                  </div>
                                )}

                                {/* Recent Grabs */}
                                {indexer.grabHistory && indexer.grabHistory.length > 0 && (
                                  <div>
                                    <p className="text-[10px] text-slate-500 mb-1.5">Recent Grabs (last {Math.min(indexer.grabHistory.length, 5)})</p>
                                    <div className="space-y-1">
                                      {indexer.grabHistory.slice(-5).reverse().map((grab: any, idx: number) => (
                                        <div key={idx} className="flex items-start gap-2 p-1.5 bg-slate-800/50 rounded text-xs">
                                          <Download className="w-3 h-3 text-purple-400 mt-0.5 flex-shrink-0" />
                                          <div className="flex-1 min-w-0">
                                            <p className="text-slate-300 break-words text-[11px]">{grab.title}</p>
                                            <p className="text-slate-500 text-[10px]">{new Date(grab.timestamp).toLocaleString()}</p>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Reset button */}
                                <div className="flex justify-end">
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (confirm(`Reset stats for ${indexer.indexerName}?`)) {
                                        try {
                                          await apiFetch(`/api/stats/${encodeURIComponent(indexer.indexerName)}`, { method: 'DELETE' });
                                          setStatsExpandedIndexer(null);
                                          fetchStats();
                                        } catch (error) {
                                          console.error('Failed to reset stats:', error);
                                        }
                                      }
                                    }}
                                    className="text-[10px] text-slate-500 hover:text-red-400 transition-colors"
                                  >
                                    Reset Stats for {indexer.indexerName}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Visual Comparison Bars */}
                  {(() => {
                    const qualified = rankedIndexers.filter((i: any) => i.qualified);
                    if (qualified.length < 2) return null;
                    const maxResponse = Math.max(...qualified.map((i: any) => i.avgResponseTime || 0));
                    const totalGrabs = qualified.reduce((sum: number, i: any) => sum + (i.totalGrabs || 0), 0);
                    const maxGrabs = Math.max(...qualified.map((i: any) => i.totalGrabs || 0));

                    // Sort each category independently for visual comparison
                    const bySpeed = [...qualified].sort((a: any, b: any) => a.avgResponseTime - b.avgResponseTime);
                    const bySuccess = [...qualified].sort((a: any, b: any) => b.successRate - a.successRate);
                    const byGrabs = [...qualified].sort((a: any, b: any) => (b.totalGrabs || 0) - (a.totalGrabs || 0));

                    return (
                      <div className="space-y-5">
                        {/* Response Time Comparison */}
                        <div>
                          <h5 className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-cyan-400" />
                            Response Time Comparison
                          </h5>
                          <div className="space-y-1.5">
                            {bySpeed.map((indexer: any) => {
                              const pct = maxResponse > 0 ? (indexer.avgResponseTime / maxResponse) * 100 : 0;
                              const barColor = indexer.avgResponseTime < 500 ? 'bg-green-400' : indexer.avgResponseTime < 1500 ? 'bg-yellow-400' : 'bg-red-400';
                              return (
                                <div key={indexer.indexerName} className="flex items-center gap-2">
                                  <div className="w-24 md:w-32 text-xs text-slate-400 truncate text-right flex-shrink-0">{indexer.indexerName}</div>
                                  <div className="flex-1 bg-slate-800 rounded-full h-4 overflow-hidden">
                                    <div className={clsx("h-full rounded-full transition-all duration-700", barColor)} style={{ width: `${Math.max(pct, 3)}%` }} />
                                  </div>
                                  <div className="w-16 text-xs text-slate-400 text-right flex-shrink-0">{indexer.avgResponseTime}ms</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Success Rate Comparison */}
                        <div>
                          <h5 className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1.5">
                            <Shield className="w-3.5 h-3.5 text-green-400" />
                            Success Rate Comparison
                          </h5>
                          <div className="space-y-1.5">
                            {bySuccess.map((indexer: any) => {
                              const barColor = indexer.successRate >= 80 ? 'bg-green-400' : indexer.successRate >= 50 ? 'bg-yellow-400' : 'bg-red-400';
                              return (
                                <div key={indexer.indexerName} className="flex items-center gap-2">
                                  <div className="w-24 md:w-32 text-xs text-slate-400 truncate text-right flex-shrink-0">{indexer.indexerName}</div>
                                  <div className="flex-1 bg-slate-800 rounded-full h-4 overflow-hidden">
                                    <div className={clsx("h-full rounded-full transition-all duration-700", barColor)} style={{ width: `${Math.max(indexer.successRate, 3)}%` }} />
                                  </div>
                                  <div className="w-10 text-xs text-slate-400 text-right flex-shrink-0">{indexer.successRate}%</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Grabs Distribution */}
                        {totalGrabs > 0 && (
                          <div>
                            <h5 className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1.5">
                              <Download className="w-3.5 h-3.5 text-purple-400" />
                              Grabs Distribution
                            </h5>
                            <div className="space-y-1.5">
                              {byGrabs.map((indexer: any) => {
                                const grabs = indexer.totalGrabs || 0;
                                const pct = maxGrabs > 0 ? (grabs / maxGrabs) * 100 : 0;
                                const share = totalGrabs > 0 ? Math.round((grabs / totalGrabs) * 100) : 0;
                                return (
                                  <div key={indexer.indexerName} className="flex items-center gap-2">
                                    <div className="w-24 md:w-32 text-xs text-slate-400 truncate text-right flex-shrink-0">{indexer.indexerName}</div>
                                    <div className="flex-1 bg-slate-800 rounded-full h-4 overflow-hidden">
                                      <div className="h-full rounded-full bg-purple-400 transition-all duration-700" style={{ width: `${Math.max(pct, 3)}%` }} />
                                    </div>
                                    <div className="w-20 text-xs text-slate-400 text-right flex-shrink-0">{grabs} ({share}%)</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div className="text-center py-12">
                  <Trophy className="w-16 h-16 text-slate-600 mx-auto mb-4" />
                  <h4 className="text-lg font-semibold text-slate-300 mb-2">No Statistics Yet</h4>
                  <p className="text-slate-400">Stats will appear here once you start searching for content</p>
                </div>
              )}

              {/* Reset All Performance Metrics */}
              {!statsLoading && rankedIndexers.length > 0 && (
                <div className="pt-4 border-t border-slate-700/30">
                  <button
                    onClick={async () => {
                      if (confirm('Reset all performance metrics?')) {
                        try {
                          await apiFetch('/api/stats', { method: 'DELETE' });
                          fetchStats();
                        } catch (error) {
                          console.error('Failed to reset stats:', error);
                        }
                      }
                    }}
                    className="w-full text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 py-2.5 rounded-lg border border-red-500/20 hover:border-red-500/40 transition-all"
                  >
                    Reset All Performance Metrics
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
  );
}

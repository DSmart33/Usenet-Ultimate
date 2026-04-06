// What this does:
//   Renders the Dashboard tab content: a grid of draggable cards for addon controls,
//   indexer management, streaming, proxy, cache, filters, health checks, stats, and more.

import React, { useState, useEffect, useRef } from 'react';
import {
  Power,
  Database,
  Play,
  Shield,
  Zap,
  Globe,
  Filter,
  FastForward,
  Monitor,
  ScrollText,
  Bot,
  Trophy,
  Heart,
  RotateCcw,
  GripVertical,
} from 'lucide-react';
import clsx from 'clsx';

import type {
  Config,
  SyncedIndexer,
  StreamDisplayConfig,
  OverlayType,
  HealthChecksState,
  AutoPlayState,
  FiltersState,
} from '../types';
import { MOCK_STREAM_DATA } from '../constants';
import { formatTTL } from '../utils/ttl';
import { renderStreamPreview } from '../utils/streamPreview';

export interface DashboardTabProps {
  config: Config;
  addonEnabled: boolean;
  setAddonEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  activeOverlay: OverlayType;
  setActiveOverlay: (overlay: OverlayType) => void;
  indexManager: 'newznab' | 'prowlarr' | 'nzbhydra';
  easynewsEnabled: boolean;
  enabledIndexersCount: number;
  syncedIndexers: SyncedIndexer[];
  nzbdavConnectionStatus: 'connected' | 'disconnected' | 'unconfigured' | 'checking' | null;
  nzbdavFallbackEnabled: boolean;
  nzbdavFallbackOrder: 'selected' | 'top';
  autoResolveOnSearch: boolean;
  nzbdavMaxFallbacks: number;
  streamingMode: 'nzbdav' | 'stremio';
  proxyMode: 'disabled' | 'http';
  proxyStatus: 'connected' | 'disconnected' | 'checking' | null;
  userAgents: {
    indexerSearch: string;
    nzbDownload: string;
    nzbdavOperations: string;
    webdavOperations: string;
    general: string;
  };
  filters: FiltersState;
  autoPlay: AutoPlayState;
  streamDisplayConfig: StreamDisplayConfig;
  healthChecks: HealthChecksState;
  statsData: any;
  fetchStats: () => void;
  hasIndexers: boolean;
  cardOrder: string[];
  draggedCard: string | null;
  dragOverCard: string | null;
  handleCardDragStart: (cardId: string) => void;
  handleCardDragOver: (e: React.DragEvent, cardId: string) => void;
  handleCardDrop: (e: React.DragEvent, cardId: string) => void;
  handleCardDragEnd: () => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function DashboardTab({
  config,
  addonEnabled,
  setAddonEnabled,
  activeOverlay,
  setActiveOverlay,
  indexManager,
  easynewsEnabled,
  enabledIndexersCount,
  syncedIndexers,
  nzbdavConnectionStatus,
  nzbdavFallbackEnabled,
  nzbdavFallbackOrder,
  autoResolveOnSearch,
  nzbdavMaxFallbacks,
  streamingMode,
  proxyMode,
  proxyStatus,
  userAgents,
  filters,
  autoPlay,
  streamDisplayConfig,
  healthChecks,
  statsData,
  fetchStats,
  hasIndexers,
  cardOrder,
  draggedCard,
  dragOverCard,
  handleCardDragStart,
  handleCardDragOver,
  handleCardDrop,
  handleCardDragEnd,
  apiFetch,
}: DashboardTabProps) {
  const [nzbDbReady, setNzbDbReady] = useState(0);
  const [nzbDbFailed, setNzbDbFailed] = useState(0);
  const prevOverlayRef = useRef<typeof activeOverlay | undefined>(undefined);

  useEffect(() => {
    if (streamingMode !== 'nzbdav') return;
    const prev = prevOverlayRef.current;
    prevOverlayRef.current = activeOverlay;
    // Only refetch on mount or when the nzbDatabase overlay closes
    if (prev !== undefined && !(prev === 'nzbDatabase' && activeOverlay !== 'nzbDatabase')) return;
    apiFetch('/api/nzbdav/cache').then(r => r.ok ? r.json() : null).then(stats => {
      if (stats) {
        setNzbDbReady(stats.ready ?? 0);
        setNzbDbFailed(stats.failed ?? 0);
      }
    }).catch(() => {
    });
  }, [streamingMode, activeOverlay, apiFetch]);
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 animate-fade-in-up">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Stats Grid */}
        {hasIndexers ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cardOrder.map((cardId) => {
              const isDragging = draggedCard === cardId;
              const isOver = dragOverCard === cardId;

              const cardComponents: Record<string, JSX.Element> = {
                power: (
                  <div
                    key="power"
                    draggable
                    onDragStart={() => handleCardDragStart('power')}
                    onDragOver={(e) => handleCardDragOver(e, 'power')}
                    onDrop={(e) => handleCardDrop(e, 'power')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group transition-all",
                      addonEnabled
                        ? "hover:!border-green-400/50 hover:!shadow-green-400/30 active:!border-green-400/50 active:!shadow-green-400/30"
                        : "hover:!border-red-400/50 hover:!shadow-red-400/30 active:!border-red-400/50 active:!shadow-red-400/30",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-green-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setAddonEnabled(prev => !prev);
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Power className={clsx("w-5 h-5 transition-colors", addonEnabled ? "text-green-400 group-hover:scale-110 group-active:scale-110" : "text-red-400 group-hover:scale-110 group-active:scale-110")} />
                      <span className="text-slate-400 text-sm">Addon</span>
                    </div>
                    <div className={clsx("text-3xl font-bold transition-colors", addonEnabled ? "text-green-400 group-hover:text-green-300 group-active:text-green-300" : "text-red-400 group-hover:text-red-300 group-active:text-red-300")}>
                      {addonEnabled ? 'Enabled' : 'Disabled'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to {addonEnabled ? 'disable' : 'enable'} &rarr;</div>
                  </div>
                ),
                indexManager: (
                  <div
                    key="indexManager"
                    draggable
                    onDragStart={() => handleCardDragStart('indexManager')}
                    onDragOver={(e) => handleCardDragOver(e, 'indexManager')}
                    onDrop={(e) => handleCardDrop(e, 'indexManager')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-blue-400/50 hover:!shadow-blue-400/30 active:!border-blue-400/50 active:!shadow-blue-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-blue-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('indexManager');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Database className="w-5 h-5 text-blue-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Index Manager</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-blue-400 group-active:text-blue-400 transition-colors">
                      {indexManager === 'newznab' && 'Newznab'}
                      {indexManager === 'prowlarr' && 'Prowlarr'}
                      {indexManager === 'nzbhydra' && 'NZBHydra2'}
                      {easynewsEnabled && <span className="text-lg font-normal text-blue-400 ml-2">+ EasyNews</span>}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                      {indexManager === 'newznab' && (() => {
                        const total = config.indexers.length;
                        const enabled = enabledIndexersCount;
                        const disabled = total - enabled;
                        const parts = [`${enabled} active`];
                        if (disabled > 0) parts.push(`${disabled} disabled`);
                        return `${parts.join(', ')} of ${total} indexer${total !== 1 ? 's' : ''}`;
                      })()}
                      {indexManager === 'prowlarr' && (syncedIndexers.length > 0
                        ? `${syncedIndexers.filter(i => i.enabledForSearch).length} of ${syncedIndexers.length} indexer(s) via Prowlarr`
                        : 'Prowlarr — not synced')}
                      {indexManager === 'nzbhydra' && (syncedIndexers.length > 0
                        ? `${syncedIndexers.filter(i => i.enabledForSearch).length} of ${syncedIndexers.length} indexer(s) via NZBHydra`
                        : 'NZBHydra — not synced')}
                    </div>
                  </div>
                ),
                streaming: (
                  <div
                    key="streaming"
                    draggable
                    onDragStart={() => handleCardDragStart('streaming')}
                    onDragOver={(e) => handleCardDragOver(e, 'streaming')}
                    onDrop={(e) => handleCardDrop(e, 'streaming')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-purple-400/50 hover:!shadow-purple-400/30 active:!border-purple-400/50 active:!shadow-purple-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-purple-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('streaming');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Play className="w-5 h-5 text-purple-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Streaming Mode</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-purple-400 group-active:text-purple-400 transition-colors">{config.streamingMode === 'nzbdav' ? 'NZBDav' : 'Native'}</div>
                    <div className="flex items-center gap-2 mt-1">
                      {config.streamingMode === 'nzbdav' && nzbdavConnectionStatus && (
                        <>
                          {nzbdavConnectionStatus === 'checking' && (
                            <div className="flex items-center gap-1.5">
                              <div className="animate-spin rounded-full h-3 w-3 border-2 border-slate-400 border-t-transparent" />
                              <span className="text-xs text-slate-400">Checking...</span>
                            </div>
                          )}
                          {nzbdavConnectionStatus === 'connected' && (
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                              <span className="text-xs text-green-400">Connected</span>
                            </div>
                          )}
                          {nzbdavConnectionStatus === 'disconnected' && (
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full bg-red-400" />
                              <span className="text-xs text-red-400">Disconnected</span>
                            </div>
                          )}
                          {nzbdavConnectionStatus === 'unconfigured' && (
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full bg-yellow-400" />
                              <span className="text-xs text-yellow-400">Not Configured</span>
                            </div>
                          )}
                        </>
                      )}
                      {config.streamingMode === 'stremio' && (
                        <span className="text-xs text-slate-500 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</span>
                      )}
                    </div>
                  </div>
                ),
                fallback: (
                  <div
                    key="fallback"
                    draggable
                    onDragStart={() => handleCardDragStart('fallback')}
                    onDragOver={(e) => handleCardDragOver(e, 'fallback')}
                    onDrop={(e) => handleCardDrop(e, 'fallback')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-amber-400/50 hover:!shadow-amber-400/30 active:!border-amber-400/50 active:!shadow-amber-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-amber-400 scale-105",
                      streamingMode !== 'nzbdav' && "opacity-50 pointer-events-none"
                    )}
                    onClick={() => {
                      if (!draggedCard && streamingMode === 'nzbdav') setActiveOverlay('fallback');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <RotateCcw className="w-5 h-5 text-amber-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">NZB Fallback</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-amber-400 group-active:text-amber-400 transition-colors">
                      {nzbdavFallbackEnabled ? 'Enabled' : 'Disabled'}
                      {autoResolveOnSearch && nzbdavFallbackEnabled && nzbdavFallbackOrder === 'top' && (
                        <span className="text-lg font-normal text-amber-400 ml-2">+ Auto-Resolve</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-500 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                        {!nzbdavFallbackEnabled
                          ? 'Click to configure \u2192'
                          : nzbdavMaxFallbacks === 0
                            ? 'All fallbacks enabled'
                            : `Up to ${nzbdavMaxFallbacks} fallback${nzbdavMaxFallbacks > 1 ? 's' : ''}`}
                      </span>
                    </div>
                    {streamingMode !== 'nzbdav' && (
                      <span className="text-xs text-slate-600 mt-1">NZB Fallback is only available in NZBDav streaming mode</span>
                    )}
                  </div>
                ),
                nzbDatabase: (
                  <div
                    key="nzbDatabase"
                    draggable
                    onDragStart={() => handleCardDragStart('nzbDatabase')}
                    onDragOver={(e) => handleCardDragOver(e, 'nzbDatabase')}
                    onDrop={(e) => handleCardDrop(e, 'nzbDatabase')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-amber-400/50 hover:!shadow-amber-400/30 active:!border-amber-400/50 active:!shadow-amber-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-amber-400 scale-105",
                      streamingMode !== 'nzbdav' && "opacity-50 pointer-events-none"
                    )}
                    onClick={() => {
                      if (!draggedCard && streamingMode === 'nzbdav') setActiveOverlay('nzbDatabase');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Database className="w-5 h-5 text-amber-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">NZB Database</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-amber-400 group-active:text-amber-400 transition-colors">
                      <span className="text-emerald-400">{nzbDbReady}</span>
                      <span className="text-slate-300 text-2xl mx-1">Healthy</span>
                      <span className="text-slate-600 text-2xl">·</span>
                      <span className="text-red-400 ml-1">{nzbDbFailed}</span>
                      <span className="text-slate-300 text-2xl ml-1">Dead</span>
                    </div>
                    {streamingMode !== 'nzbdav' && (
                      <span className="text-xs text-slate-600 mt-1">NZB Database is only available in NZBDav streaming mode</span>
                    )}
                  </div>
                ),
                proxy: (
                  <div
                    key="proxy"
                    draggable
                    onDragStart={() => handleCardDragStart('proxy')}
                    onDragOver={(e) => handleCardDragOver(e, 'proxy')}
                    onDrop={(e) => handleCardDrop(e, 'proxy')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 group transition-all",
                      indexManager !== 'newznab'
                        ? "opacity-50 cursor-not-allowed"
                        : "cursor-move hover:!border-teal-400/50 hover:!shadow-teal-400/30 active:!border-teal-400/50 active:!shadow-teal-400/30",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-teal-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard && indexManager === 'newznab') setActiveOverlay('proxy');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Shield className="w-5 h-5 text-teal-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Proxy</span>
                    </div>
                    {indexManager !== 'newznab' ? (
                      <>
                        <div className="text-3xl font-bold text-slate-500">
                          Unavailable
                        </div>
                        <div className="mt-1">
                          <span className="text-xs text-amber-400/80">Proxied requests are only supported with Newznab searches</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-3xl font-bold group-hover:text-teal-400 group-active:text-teal-400 transition-colors">
                          {proxyMode === 'disabled' && 'Disabled'}
                          {proxyMode === 'http' && 'HTTP Proxy'}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {proxyMode === 'http' && (
                            <>
                              {proxyStatus === 'connected' && (
                                <div className="flex items-center gap-1.5">
                                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                                  <span className="text-xs text-green-400">Connected</span>
                                </div>
                              )}
                              {proxyStatus === 'disconnected' && (
                                <div className="flex items-center gap-1.5">
                                  <div className="w-2 h-2 rounded-full bg-red-400" />
                                  <span className="text-xs text-red-400">Disconnected</span>
                                </div>
                              )}
                              {(proxyStatus === 'checking' || !proxyStatus) && (
                                <span className="text-xs text-slate-500 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</span>
                              )}
                            </>
                          )}
                          {proxyMode === 'disabled' && (
                            <span className="text-xs text-slate-500 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ),
                cache: (
                  <div
                    key="cache"
                    draggable
                    onDragStart={() => handleCardDragStart('cache')}
                    onDragOver={(e) => handleCardDragOver(e, 'cache')}
                    onDrop={(e) => handleCardDrop(e, 'cache')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-yellow-400/50 hover:!shadow-yellow-400/30 active:!border-yellow-400/50 active:!shadow-yellow-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-yellow-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('cache');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Zap className="w-5 h-5 text-yellow-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Search Cache TTL</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-yellow-400 group-active:text-yellow-400 transition-colors">{formatTTL(config.cacheTTL)}</div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</div>
                  </div>
                ),
                userAgent: (
                  <div
                    key="userAgent"
                    draggable
                    onDragStart={() => handleCardDragStart('userAgent')}
                    onDragOver={(e) => handleCardDragOver(e, 'userAgent')}
                    onDrop={(e) => handleCardDrop(e, 'userAgent')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-indigo-400/50 hover:!shadow-indigo-400/30 active:!border-indigo-400/50 active:!shadow-indigo-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-indigo-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('userAgent');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Globe className="w-5 h-5 text-indigo-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">User-Agent</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-indigo-400 group-active:text-indigo-400 transition-colors">
                      {userAgents.indexerSearch?.split('/')[0] || 'Default'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</div>
                  </div>
                ),
                filters: (
                  <div
                    key="filters"
                    draggable
                    onDragStart={() => handleCardDragStart('filters')}
                    onDragOver={(e) => handleCardDragOver(e, 'filters')}
                    onDrop={(e) => handleCardDrop(e, 'filters')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-purple-400/50 hover:!shadow-purple-400/30 active:!border-purple-400/50 active:!shadow-purple-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-purple-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('filters');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Filter className="w-5 h-5 text-purple-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Filters & Sorting</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-purple-400 group-active:text-purple-400 transition-colors">
                      {filters.sortOrder?.[0] === 'quality' ? 'Resolution First' : filters.sortOrder?.[0] === 'size' ? 'Size First' : filters.sortOrder?.[0] === 'videoTag' ? 'Quality First' : 'Resolution First'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to configure &rarr;</div>
                  </div>
                ),
                autoPlay: (
                  <div
                    key="autoPlay"
                    draggable
                    onDragStart={() => handleCardDragStart('autoPlay')}
                    onDragOver={(e) => handleCardDragOver(e, 'autoPlay')}
                    onDrop={(e) => handleCardDrop(e, 'autoPlay')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-orange-400/50 hover:!shadow-orange-400/30 active:!border-orange-400/50 active:!shadow-orange-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-orange-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('autoPlay');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <FastForward className="w-5 h-5 text-orange-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Auto Play</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-orange-400 group-active:text-orange-400 transition-colors">
                      {autoPlay.enabled ? 'Enabled' : 'Disabled'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                      {autoPlay.enabled
                        ? autoPlay.method === 'matchingFile' ? 'Matching File' : autoPlay.method === 'matchingIndex' ? 'Matching Index' : 'First File'
                        : 'Click to configure →'}
                    </div>
                  </div>
                ),
                streamDisplay: (() => {
                  const preview = renderStreamPreview(MOCK_STREAM_DATA.regular, streamDisplayConfig);
                  return (
                    <div
                      key="streamDisplay"
                      draggable
                      onDragStart={() => handleCardDragStart('streamDisplay')}
                      onDragOver={(e) => handleCardDragOver(e, 'streamDisplay')}
                      onDrop={(e) => handleCardDrop(e, 'streamDisplay')}
                      onDragEnd={handleCardDragEnd}
                      className={clsx(
                        "card p-4 cursor-move group hover:!border-indigo-400/50 hover:!shadow-indigo-400/30 active:!border-indigo-400/50 active:!shadow-indigo-400/30 transition-all",
                        isDragging && "opacity-50 scale-95",
                        isOver && "ring-2 ring-indigo-400 scale-105"
                      )}
                      onClick={() => {
                        if (!draggedCard) setActiveOverlay('streamDisplay');
                      }}
                    >
                      <div className="flex items-center gap-3 mb-2">
                        <GripVertical className="w-4 h-4 text-slate-600" />
                        <Monitor className="w-5 h-5 text-indigo-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                        <span className="text-slate-400 text-sm">Stream Display</span>
                      </div>
                      {/* Miniature Stremio-like preview */}
                      <div className="bg-slate-950/60 rounded-lg border border-slate-700/30 p-2 mt-1 font-mono">
                        <div className="flex gap-2">
                          <div className="text-[9px] leading-tight text-slate-300 border-r border-slate-700/50 pr-2 whitespace-nowrap min-w-[48px]">
                            {preview.nameLines.map((line, i) => (
                              <div key={i}>{line}</div>
                            ))}
                          </div>
                          <div className="text-[9px] leading-tight text-slate-400 min-w-0 overflow-hidden">
                            {preview.titleLines.map((line, i) => (
                              <div key={i} className={clsx("truncate", i === 0 && "text-slate-200")}>{line}</div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-slate-500 mt-1.5 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                        Click to customize &rarr;
                      </div>
                    </div>
                  );
                })(),
                status: (
                  <div
                    key="status"
                    draggable
                    onDragStart={() => handleCardDragStart('status')}
                    onDragOver={(e) => handleCardDragOver(e, 'status')}
                    onDrop={(e) => handleCardDrop(e, 'status')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-emerald-400/50 hover:!shadow-emerald-400/30 active:!border-emerald-400/50 active:!shadow-emerald-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-emerald-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('logs');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <ScrollText className="w-5 h-5 text-emerald-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Logs</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-emerald-400 group-active:text-emerald-400 transition-colors">Live View</div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to view logs &rarr;</div>
                  </div>
                ),
                zyclops: (
                  <div
                    key="zyclops"
                    draggable
                    onDragStart={() => handleCardDragStart('zyclops')}
                    onDragOver={(e) => handleCardDragOver(e, 'zyclops')}
                    onDrop={(e) => handleCardDrop(e, 'zyclops')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 group transition-all",
                      indexManager !== 'newznab'
                        ? "opacity-50 cursor-not-allowed"
                        : "cursor-move hover:!border-violet-400/50 hover:!shadow-violet-400/30 active:!border-violet-400/50 active:!shadow-violet-400/30",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-violet-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard && indexManager === 'newznab') setActiveOverlay('zyclops');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Bot className="w-5 h-5 text-violet-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Zyclops</span>
                    </div>
                    {indexManager !== 'newznab' ? (
                      <>
                        <div className="text-3xl font-bold text-slate-500">Unavailable</div>
                        <div className="mt-1">
                          <span className="text-xs text-amber-400/80">Zyclops is only supported with Newznab</span>
                        </div>
                      </>
                    ) : (() => {
                      const zyclopsCount = config?.indexers.filter(i => i.zyclops?.enabled).length || 0;
                      return (
                        <>
                          <div className="text-3xl font-bold group-hover:text-violet-400 group-active:text-violet-400 transition-colors">
                            {zyclopsCount > 0 ? `${zyclopsCount} Active` : 'Disabled'}
                          </div>
                          <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                            {zyclopsCount > 0
                              ? `${zyclopsCount} indexer${zyclopsCount !== 1 ? 's' : ''} via Zyclops proxy`
                              : 'Click to configure →'}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ),
                stats: (
                  <div
                    key="stats"
                    draggable
                    onDragStart={() => handleCardDragStart('stats')}
                    onDragOver={(e) => handleCardDragOver(e, 'stats')}
                    onDrop={(e) => handleCardDrop(e, 'stats')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-amber-400/50 hover:!shadow-amber-400/30 active:!border-amber-400/50 active:!shadow-amber-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-amber-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) {
                        setActiveOverlay('stats');
                        fetchStats();
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Trophy className="w-5 h-5 text-amber-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Indexer Performance Metrics</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-amber-400 group-active:text-amber-400 transition-colors">
                      {statsData ? `${Object.keys(statsData.indexers || {}).length} Indexers` : '-'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">Click to view analytics &rarr;</div>
                  </div>
                ),
                healthChecks: (
                  <div
                    key="healthChecks"
                    draggable
                    onDragStart={() => handleCardDragStart('healthChecks')}
                    onDragOver={(e) => handleCardDragOver(e, 'healthChecks')}
                    onDrop={(e) => handleCardDrop(e, 'healthChecks')}
                    onDragEnd={handleCardDragEnd}
                    className={clsx(
                      "card p-4 cursor-move group hover:!border-pink-400/50 hover:!shadow-pink-400/30 active:!border-pink-400/50 active:!shadow-pink-400/30 transition-all",
                      isDragging && "opacity-50 scale-95",
                      isOver && "ring-2 ring-pink-400 scale-105"
                    )}
                    onClick={() => {
                      if (!draggedCard) setActiveOverlay('healthChecks');
                    }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <GripVertical className="w-4 h-4 text-slate-600" />
                      <Heart className="w-5 h-5 text-pink-400 group-hover:scale-110 group-active:scale-110 transition-transform" />
                      <span className="text-slate-400 text-sm">Health Checks</span>
                    </div>
                    <div className="text-3xl font-bold group-hover:text-pink-400 group-active:text-pink-400 transition-colors">
                      {healthChecks.enabled ? 'Enabled' : 'Disabled'}
                      {healthChecks.enabled && healthChecks.autoQueueMode !== 'off' && (
                        <span className="text-lg font-normal text-pink-400 ml-2">
                          + {healthChecks.autoQueueMode === 'top' ? 'Top Result' : 'All Healthy'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-slate-400 group-active:text-slate-400 transition-colors">
                      {healthChecks.enabled
                        ? (() => {
                            const total = healthChecks.providers.length;
                            const enabled = healthChecks.providers.filter(p => p.enabled).length;
                            const disabled = total - enabled;
                            const parts = [`${enabled} active`];
                            if (disabled > 0) parts.push(`${disabled} disabled`);
                            const inspectionSummary = healthChecks.inspectionMethod === 'smart'
                              ? `Smart ${healthChecks.smartBatchSize * (1 + (healthChecks.smartAdditionalRuns || 0))} max`
                              : `${healthChecks.nzbsToInspect} NZBs`;
                            const modeSummary = `${healthChecks.sampleCount} samples${healthChecks.archiveInspection ? ' · inspection' : ''}`;
                            return `${parts.join(', ')} of ${total} provider${total !== 1 ? 's' : ''} · ${inspectionSummary} · ${modeSummary}`;
                          })()
                        : 'Click to configure →'}
                    </div>
                  </div>
                ),
              };

              return cardComponents[cardId] || null;
            })}
          </div>
        ) : (
          <div className="card p-8 text-center">
            <Database className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-300 mb-2">No Indexers Configured</h3>
            <p className="text-slate-400 mb-4">Add your first Usenet indexer to get started</p>
            <button
              onClick={() => setActiveOverlay('indexManager')}
              className="btn-primary mx-auto"
            >
              Configure Index Manager
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

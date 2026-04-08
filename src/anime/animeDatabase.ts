/**
 * Anime Database Manager
 *
 * Downloads, caches, and indexes 6 offline anime mapping databases at startup.
 * Provides O(1) lookup by any anime ID type (Kitsu, MAL, AniList, AniDB).
 * Refreshes daily in the background using atomic index swap (no mid-request disruption).
 *
 * Databases:
 *  1. Fribb anime-lists     — Primary cross-reference (MAL↔Kitsu↔AniDB↔AniList↔IMDB↔TMDB↔TVDB)
 *  2. Manami DB              — Titles, synonyms, year
 *  3. Kitsu-IMDB Mapping     — Kitsu→IMDB with season/episode offsets
 *  4. Anitrakt Movies        — MAL→Trakt movie mappings with TMDB/IMDB
 *  5. Anitrakt TV            — MAL→Trakt TV with season info, split-cour
 *  6. Anime Lists XML        — AniDB→TVDB/TMDB season/episode offsets
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { parseStringPromise } from 'xml2js';
import type {
  FribbEntry, KitsuImdbEntry, ManamiEntry,
  AnitraktMovieEntry, AnitraktTvEntry, AnimeListEntry,
  AnimeDatabaseStatus
} from './types.js';

const CACHE_DIR = path.join(__dirname, '..', '..', 'config', 'anime-db');
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DOWNLOAD_TIMEOUT = 60000; // 60 seconds

// Database source URLs
const SOURCES = {
  fribb: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  kitsuImdb: 'https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/master/static/data/imdb_mapping.json',
  anitraktMovies: 'https://raw.githubusercontent.com/rensetsu/db.trakt.extended-anitrakt/main/json/output/movies_ex.json',
  anitraktTv: 'https://raw.githubusercontent.com/rensetsu/db.trakt.extended-anitrakt/main/json/output/tv_ex.json',
  animeLists: 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml',
} as const;

// Manami uses GitHub releases, URL includes a dated tag
const MANAMI_RELEASES_API = 'https://api.github.com/repos/manami-project/anime-offline-database/releases/latest';

// ─── In-memory indexes (keyed by ID for O(1) lookup) ───────────────────────
// Wrapped in a single object for atomic swap during daily refresh.
// Requests in-flight continue reading the old reference while a new one is built.

interface AnimeIndexes {
  fribbByKitsu: Map<number, FribbEntry>;
  fribbByMal: Map<number, FribbEntry>;
  fribbByAnilist: Map<number, FribbEntry>;
  fribbByAnidb: Map<number, FribbEntry>;
  fribbByImdb: Map<string, FribbEntry>;
  fribbByTmdb: Map<number, FribbEntry>;
  fribbByTvdb: Map<number, FribbEntry>;
  kitsuImdbByKitsu: Map<number, KitsuImdbEntry[]>;
  manamiByMal: Map<number, ManamiEntry>;
  manamiByKitsu: Map<number, ManamiEntry>;
  manamiByAnilist: Map<number, ManamiEntry>;
  anitraktMoviesByMal: Map<number, AnitraktMovieEntry>;
  anitraktTvByMal: Map<number, AnitraktTvEntry[]>;
  animeListsByAnidb: Map<number, AnimeListEntry>;
}

function createEmptyIndexes(): AnimeIndexes {
  return {
    fribbByKitsu: new Map(), fribbByMal: new Map(), fribbByAnilist: new Map(),
    fribbByAnidb: new Map(), fribbByImdb: new Map(), fribbByTmdb: new Map(), fribbByTvdb: new Map(),
    kitsuImdbByKitsu: new Map(),
    manamiByMal: new Map(), manamiByKitsu: new Map(), manamiByAnilist: new Map(),
    anitraktMoviesByMal: new Map(), anitraktTvByMal: new Map(),
    animeListsByAnidb: new Map(),
  };
}

// Active indexes — swapped atomically after refresh completes
let db: AnimeIndexes = createEmptyIndexes();

// ─── Status tracking ────────────────────────────────────────────────────────

let loaded = false;
let lastRefresh: Date | undefined;
let totalMappings = 0;
let currentSourceStatus: AnimeDatabaseStatus['sources'] = {
  fribb: false, manami: false, kitsuImdb: false,
  anitraktMovies: false, anitraktTv: false, animeLists: false,
};
let currentFailures: string[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;

// ─── Download & Parse ───────────────────────────────────────────────────────

async function downloadJson<T>(url: string, name: string): Promise<T | null> {
  try {
    const res = await axios.get(url, {
      timeout: DOWNLOAD_TIMEOUT,
      maxContentLength: MAX_FILE_SIZE,
      responseType: 'text',
    });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return data as T;
  } catch (err) {
    console.warn(`⚠️  Failed to download ${name}: ${(err as Error).message}`);
    return null;
  }
}

async function downloadXml(url: string, name: string): Promise<any | null> {
  try {
    const res = await axios.get(url, {
      timeout: DOWNLOAD_TIMEOUT,
      maxContentLength: MAX_FILE_SIZE,
      responseType: 'text',
    });
    return await parseStringPromise(res.data, { explicitArray: false, mergeAttrs: true });
  } catch (err) {
    console.warn(`⚠️  Failed to download ${name}: ${(err as Error).message}`);
    return null;
  }
}

function loadFromDisk<T>(filename: string): T | null {
  const filepath = path.join(CACHE_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try {
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function saveToDisk(filename: string, data: any): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(CACHE_DIR, filename), JSON.stringify(data));
  } catch (err) {
    console.warn(`⚠️  Failed to cache ${filename}: ${(err as Error).message}`);
  }
}

// ─── Indexing (all write to a new indexes object, not the active one) ───────

function indexFribb(entries: FribbEntry[], idx: AnimeIndexes): number {
  for (const e of entries) {
    if (e.kitsu_id) idx.fribbByKitsu.set(e.kitsu_id, e);
    if (e.mal_id) idx.fribbByMal.set(e.mal_id, e);
    if (e.anilist_id) idx.fribbByAnilist.set(e.anilist_id, e);
    if (e.anidb_id) idx.fribbByAnidb.set(e.anidb_id, e);
    if (e.imdb_id) idx.fribbByImdb.set(e.imdb_id, e);
    if (e.themoviedb_id) idx.fribbByTmdb.set(e.themoviedb_id, e);
    if (e.thetvdb_id) idx.fribbByTvdb.set(e.thetvdb_id, e);
  }
  return entries.length;
}

function indexKitsuImdb(entries: KitsuImdbEntry[], idx: AnimeIndexes): number {
  for (const e of entries) {
    const existing = idx.kitsuImdbByKitsu.get(e.kitsu_id) || [];
    existing.push(e);
    idx.kitsuImdbByKitsu.set(e.kitsu_id, existing);
  }
  return entries.length;
}

function extractIdFromUrl(url: string, service: string): number | undefined {
  const match = url.match(new RegExp(`${service}[^/]*/anime/(\\d+)`));
  return match ? parseInt(match[1], 10) : undefined;
}

function indexManami(entries: ManamiEntry[], idx: AnimeIndexes): number {
  for (const e of entries) {
    for (const src of e.sources) {
      const malId = extractIdFromUrl(src, 'myanimelist');
      if (malId) idx.manamiByMal.set(malId, e);
      const kitsuId = extractIdFromUrl(src, 'kitsu');
      if (kitsuId) idx.manamiByKitsu.set(kitsuId, e);
      const anilistId = extractIdFromUrl(src, 'anilist');
      if (anilistId) idx.manamiByAnilist.set(anilistId, e);
    }
  }
  return entries.length;
}

function indexAnitraktMovies(entries: AnitraktMovieEntry[], idx: AnimeIndexes): number {
  for (const e of entries) {
    if (e.myanimelist?.id) idx.anitraktMoviesByMal.set(e.myanimelist.id, e);
  }
  return entries.length;
}

function indexAnitraktTv(entries: AnitraktTvEntry[], idx: AnimeIndexes): number {
  for (const e of entries) {
    if (e.myanimelist?.id) {
      const existing = idx.anitraktTvByMal.get(e.myanimelist.id) || [];
      existing.push(e);
      idx.anitraktTvByMal.set(e.myanimelist.id, existing);
    }
  }
  return entries.length;
}

function indexAnimeLists(raw: any, idx: AnimeIndexes): number {
  const list = raw?.['anime-list']?.anime;
  if (!list) return 0;
  const entries = Array.isArray(list) ? list : [list];
  for (const e of entries) {
    const anidbId = parseInt(e.anidbid, 10);
    if (!anidbId) continue;
    idx.animeListsByAnidb.set(anidbId, {
      anidbId,
      tvdbId: e.tvdbid ? parseInt(e.tvdbid, 10) : undefined,
      defaultTvdbSeason: e.defaulttvdbseason !== undefined ? parseInt(e.defaulttvdbseason, 10) : undefined,
      episodeOffset: e.episodeoffset ? parseInt(e.episodeoffset, 10) : undefined,
      tmdbTv: e.tmdbtv ? parseInt(e.tmdbtv, 10) : undefined,
      tmdbSeason: e.tmdbseason !== undefined ? parseInt(e.tmdbseason, 10) : undefined,
      tmdbOffset: e.tmdboffset ? parseInt(e.tmdboffset, 10) : undefined,
      tmdbId: e.tmdbid ? parseInt(e.tmdbid, 10) : undefined,
      imdbId: e.imdbid || undefined,
      name: e.name || undefined,
    });
  }
  return idx.animeListsByAnidb.size;
}

// ─── Load databases (download or from disk cache) ───────────────────────────

interface LoadResult {
  sourceKey: keyof AnimeDatabaseStatus['sources'];
  count: number;
  name: string;
  failed?: string;
}

async function loadAndIndex<T>(
  name: string,
  filename: string,
  download: () => Promise<T | null>,
  index: (data: T, idx: AnimeIndexes) => number,
  sourceKey: keyof AnimeDatabaseStatus['sources'],
  idx: AnimeIndexes,
): Promise<LoadResult> {
  let data: any = await download();
  if (data) {
    saveToDisk(filename, data);
  } else {
    data = loadFromDisk(filename);
    if (data) {
      console.log(`   📦 ${name}: loaded from disk cache`);
    } else {
      return { sourceKey, count: 0, name, failed: `${name}: no data available` };
    }
  }

  try {
    const count = index(data, idx);
    console.log(`   ✅ ${name}: ${count.toLocaleString()} entries`);
    return { sourceKey, count, name };
  } catch (err) {
    const msg = `${name}: indexing failed — ${(err as Error).message}`;
    console.warn(`   ❌ ${msg}`);
    return { sourceKey, count: 0, name, failed: msg };
  }
}

async function getManamiUrl(): Promise<string | null> {
  try {
    const res = await axios.get(MANAMI_RELEASES_API, { timeout: 10000 });
    const asset = res.data?.assets?.find((a: any) => a.name === 'anime-offline-database-minified.json');
    return asset?.browser_download_url || null;
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initAnimeDatabase(): Promise<void> {
  console.log('🎌 Loading anime databases...');

  // Build into a fresh indexes object — active `db` is untouched until swap
  const newDb = createEmptyIndexes();

  const results = await Promise.all([
    loadAndIndex('Fribb', 'fribb.json',
      () => downloadJson<FribbEntry[]>(SOURCES.fribb, 'Fribb'),
      indexFribb, 'fribb', newDb),

    loadAndIndex('Manami', 'manami.json',
      async () => {
        const url = await getManamiUrl();
        if (!url) return loadFromDisk<{ data: ManamiEntry[] }>('manami.json') as any;
        const raw = await downloadJson<{ data: ManamiEntry[] }>(url, 'Manami');
        return raw?.data || null;
      },
      (data: any, idx) => indexManami(Array.isArray(data) ? data : data, idx),
      'manami', newDb),

    loadAndIndex('Kitsu-IMDB', 'kitsu-imdb.json',
      () => downloadJson<KitsuImdbEntry[]>(SOURCES.kitsuImdb, 'Kitsu-IMDB'),
      indexKitsuImdb, 'kitsuImdb', newDb),

    loadAndIndex('Anitrakt Movies', 'anitrakt-movies.json',
      () => downloadJson<AnitraktMovieEntry[]>(SOURCES.anitraktMovies, 'Anitrakt Movies'),
      indexAnitraktMovies, 'anitraktMovies', newDb),

    loadAndIndex('Anitrakt TV', 'anitrakt-tv.json',
      () => downloadJson<AnitraktTvEntry[]>(SOURCES.anitraktTv, 'Anitrakt TV'),
      indexAnitraktTv, 'anitraktTv', newDb),

    loadAndIndex('Anime Lists', 'anime-lists.json',
      async () => {
        const xml = await downloadXml(SOURCES.animeLists, 'Anime Lists');
        return xml;
      },
      indexAnimeLists, 'animeLists', newDb),
  ]);

  // Atomic swap — all lookups now use the new indexes
  db = newDb;

  // Update status
  const failures: string[] = [];
  const sourceStatus: AnimeDatabaseStatus['sources'] = {
    fribb: false, manami: false, kitsuImdb: false,
    anitraktMovies: false, anitraktTv: false, animeLists: false,
  };
  let mappings = 0;
  for (const r of results) {
    if (r.failed) {
      failures.push(r.failed);
    } else {
      sourceStatus[r.sourceKey] = true;
    }
    mappings += r.count;
  }
  totalMappings = mappings;
  currentSourceStatus = sourceStatus;
  currentFailures = failures;
  loaded = true;
  lastRefresh = new Date();

  console.log(`🎌 Anime databases loaded: ${totalMappings.toLocaleString()} total entries`);
  if (failures.length > 0) {
    console.warn(`⚠️  ${failures.length} source(s) failed: ${failures.join(', ')}`);
  }
}

export function startDailyRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    console.log('🔄 Daily anime database refresh...');
    try {
      await initAnimeDatabase();
    } catch (err) {
      console.error('❌ Anime database refresh failed:', (err as Error).message);
    }
  }, REFRESH_INTERVAL);
}

export function stopDailyRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
}

// ─── Lookup functions (read from active `db` reference) ─────────────────────

export function lookupByKitsuId(id: number): FribbEntry | undefined {
  return db.fribbByKitsu.get(id);
}

export function lookupByMalId(id: number): FribbEntry | undefined {
  return db.fribbByMal.get(id);
}

export function lookupByAnilistId(id: number): FribbEntry | undefined {
  return db.fribbByAnilist.get(id);
}

export function lookupByAnidbId(id: number): FribbEntry | undefined {
  return db.fribbByAnidb.get(id);
}

export function lookupByImdbId(imdbId: string): FribbEntry | undefined {
  return db.fribbByImdb.get(imdbId);
}

export function getKitsuImdbEntries(kitsuId: number): KitsuImdbEntry[] {
  return db.kitsuImdbByKitsu.get(kitsuId) || [];
}

export function getManamiByMalId(malId: number): ManamiEntry | undefined {
  return db.manamiByMal.get(malId);
}

export function getManamiByKitsuId(kitsuId: number): ManamiEntry | undefined {
  return db.manamiByKitsu.get(kitsuId);
}

export function getAnitraktMovieByMalId(malId: number): AnitraktMovieEntry | undefined {
  return db.anitraktMoviesByMal.get(malId);
}

export function getAnitraktTvByMalId(malId: number): AnitraktTvEntry[] {
  return db.anitraktTvByMal.get(malId) || [];
}

export function getAnimeListByAnidbId(anidbId: number): AnimeListEntry | undefined {
  return db.animeListsByAnidb.get(anidbId);
}

export function isAnimeByImdbId(imdbId: string): boolean {
  return db.fribbByImdb.has(imdbId);
}

export function isDatabaseLoaded(): boolean {
  return loaded;
}

export function getDatabaseStatus(): AnimeDatabaseStatus {
  return {
    loaded,
    lastRefresh: lastRefresh?.toISOString(),
    totalMappings,
    sources: { ...currentSourceStatus },
    failures: [...currentFailures],
  };
}

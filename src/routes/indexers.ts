/**
 * Indexer routes — /api/indexers/*
 *
 * CRUD, testing, reordering, and capability fetching for manual (Newznab) indexers.
 */

import { Router } from 'express';
import type { Config, UsenetIndexer } from '../types.js';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';

/**
 * Validate timeoutEnabled/timeout fields on an indexer payload.
 * Returns an error message string, or null when valid. Shared by POST and PUT
 * so creating and updating enforce identical bounds.
 */
function validateIndexerTimeoutFields(body: { timeout?: unknown; timeoutEnabled?: unknown }): string | null {
  if (body.timeout !== undefined) {
    if (typeof body.timeout !== 'number' || !Number.isFinite(body.timeout) || body.timeout < 1 || body.timeout > 45) {
      return 'Timeout must be a number between 1 and 45 seconds';
    }
  }
  if (body.timeoutEnabled !== undefined && typeof body.timeoutEnabled !== 'boolean') {
    return 'timeoutEnabled must be a boolean';
  }
  return null;
}

/**
 * Ensure a Newznab URL ends with /api (the standard endpoint).
 * Users often paste just the base URL (e.g. https://indexer.example.com)
 * when they mean https://indexer.example.com/api.
 */
function normalizeNewznabUrl(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.replace(/\/+$/, '');
  // Already ends with /api — nothing to do
  if (/\/api$/i.test(trimmed)) return trimmed;
  // Has a deeper path (e.g. /torznab/foo, /custom/v1) — leave it alone
  try {
    const { pathname } = new URL(trimmed);
    if (pathname !== '/' && pathname !== '') return trimmed;
  } catch {
    return trimmed;
  }
  return `${trimmed}/api`;
}

interface IndexerDeps {
  config: Config;
  getIndexers: () => UsenetIndexer[];
  addIndexer: (indexer: Omit<UsenetIndexer, 'enabled'>) => UsenetIndexer;
  updateIndexer: (name: string, updates: Partial<UsenetIndexer>) => UsenetIndexer;
  deleteIndexer: (name: string) => void;
  reorderIndexers: (indexers: UsenetIndexer[]) => void;
  fetchIndexerCaps: (url: string, apiKey: string, indexerName?: string) => Promise<any>;
  proxyFetch: (url: string, options?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; body?: any }, indexerName?: string) => Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any>; headers: Map<string, string> }>;
  getLatestVersions: () => { chrome: string; prowlarr: string };
}

export function createIndexerRoutes(deps: IndexerDeps): Router {
  const router = Router();
  const { config, getIndexers, addIndexer, updateIndexer, deleteIndexer, reorderIndexers, fetchIndexerCaps, proxyFetch, getLatestVersions } = deps;

  router.get('/', (req, res) => {
    res.json(getIndexers());
  });

  router.post('/', (req, res) => {
    try {
      const { name, url: rawUrl, apiKey, website, logo, movieSearchMethod, tvSearchMethod, animeMovieSearchMethod, animeTvSearchMethod, caps, pagination, maxPages, timeoutEnabled, timeout } = req.body;

      if (!name || !rawUrl || !apiKey) {
        return res.status(400).json({ error: 'Name, URL, and API key are required' });
      }

      const timeoutErr = validateIndexerTimeoutFields({ timeout, timeoutEnabled });
      if (timeoutErr) {
        return res.status(400).json({ error: timeoutErr });
      }

      const url = normalizeNewznabUrl(rawUrl);

      const indexer = addIndexer({ name, url, apiKey, website, logo, movieSearchMethod, tvSearchMethod, animeMovieSearchMethod, animeTvSearchMethod, caps, pagination, maxPages, timeoutEnabled, timeout });
      res.status(201).json(indexer);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.put('/:name', (req, res) => {
    try {
      const { name } = req.params;
      const updates = req.body;

      if (updates.name !== undefined && !updates.name.trim()) {
        return res.status(400).json({ error: 'Name cannot be empty' });
      }

      // Normalize URL if provided
      if (updates.url) {
        updates.url = normalizeNewznabUrl(updates.url);
      }

      const timeoutErr = validateIndexerTimeoutFields(updates);
      if (timeoutErr) {
        return res.status(400).json({ error: timeoutErr });
      }

      // Zyclops support was removed; ignore the field if an older UI still sends it
      delete updates.zyclops;

      // Log timeout state changes (audit trail for "why did searches start timing out?")
      // Compare effective values so PUTs that resend default-equal values don't spam.
      if (updates.timeoutEnabled !== undefined || updates.timeout !== undefined) {
        const prev = getIndexers().find(i => i.name === name);
        const effPrevEnabled = prev?.timeoutEnabled ?? true;
        const effNextEnabled = updates.timeoutEnabled ?? effPrevEnabled;
        const effPrevSeconds = prev?.timeout ?? DEFAULT_INDEXER_TIMEOUT_SECONDS;
        const effNextSeconds = updates.timeout ?? effPrevSeconds;
        if (effPrevEnabled !== effNextEnabled || effPrevSeconds !== effNextSeconds) {
          if (effNextEnabled === false) {
            console.log(`⏱️  Indexer "${name}" timeout disabled`);
          } else {
            console.log(`⏱️  Indexer "${name}" timeout updated: enabled=true, timeout=${effNextSeconds}s`);
          }
        }
      }

      const indexer = updateIndexer(name, updates);
      // Include proxy/healthCheck state so frontend can stay in sync
      res.json({
        ...indexer,
        _proxyEnabled: config.proxyIndexers?.[indexer.name] ?? true,
        _healthCheckEnabled: config.healthChecks?.healthCheckIndexers?.[indexer.name] ?? true,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.delete('/:name', (req, res) => {
    try {
      const { name } = req.params;
      deleteIndexer(name);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/:name/test', async (req, res) => {
    try {
      const { name } = req.params;
      const query = req.query.q as string || 'test';
      const indexers = getIndexers();
      const indexer = indexers.find(i => i.name === name);

      if (!indexer) {
        return res.status(404).json({ error: 'Indexer not found' });
      }

      const searchUrl = `${indexer.url}?t=search&apikey=${indexer.apiKey}&q=${encodeURIComponent(query)}&limit=50`;

      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;
      const headers = { 'User-Agent': userAgent };
      console.log('\u{1F4E4} Request to test indexer:', { url: searchUrl, headers });
      const response = await proxyFetch(searchUrl, { headers }, indexer.name);

      if (!response.ok) {
        return res.status(400).json({
          error: `Indexer returned ${response.status}: ${response.statusText}`
        });
      }

      const text = await response.text();

      // Parse XML to extract titles from within <item> tags only
      const titles: string[] = [];
      const itemMatches = text.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g);

      for (const itemMatch of itemMatches) {
        const itemContent = itemMatch[1];
        const titleMatch = itemContent.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titles.length < 5) {
          titles.push(titleMatch[1].trim());
        }
      }

      // Count total results
      const resultCount = (text.match(/<item[^>]*>/g) || []).length;

      res.json({
        success: true,
        message: resultCount > 0 ? `Found ${resultCount} result${resultCount !== 1 ? 's' : ''}` : 'No results found',
        results: resultCount,
        titles: titles
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Test failed'
      });
    }
  });

  router.post('/test-new', async (req, res) => {
    try {
      const { name, url: rawUrl, apiKey, query = 'test' } = req.body;

      if (!name || !rawUrl || !apiKey) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const url = normalizeNewznabUrl(rawUrl);

      // Test search with user query
      const searchUrl = `${url}?t=search&apikey=${apiKey}&q=${encodeURIComponent(query)}&limit=50`;

      const userAgent5 = config.userAgents?.indexerSearch || getLatestVersions().chrome;
      const headers = { 'User-Agent': userAgent5 };
      console.log('\u{1F4E4} Request to test new indexer:', { url: searchUrl, headers });
      const response = await proxyFetch(searchUrl, { headers }, name);

      if (!response.ok) {
        return res.status(400).json({
          error: `Indexer returned ${response.status}: ${response.statusText}`
        });
      }

      const text = await response.text();

      // Parse XML to extract titles from within <item> tags only
      const titles: string[] = [];
      const itemMatches = text.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g);

      for (const itemMatch of itemMatches) {
        const itemContent = itemMatch[1];
        const titleMatch = itemContent.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titles.length < 5) {
          titles.push(titleMatch[1].trim());
        }
      }

      // Count total results
      const resultCount = (text.match(/<item[^>]*>/g) || []).length;

      res.json({
        success: true,
        message: resultCount > 0 ? `Found ${resultCount} result${resultCount !== 1 ? 's' : ''}` : 'No results found',
        results: resultCount,
        titles: titles
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Test failed'
      });
    }
  });

  router.post('/reorder', (req, res) => {
    try {
      const { indexers } = req.body;

      if (!Array.isArray(indexers)) {
        return res.status(400).json({ error: 'Indexers must be an array' });
      }

      // Update the indexers order in config
      reorderIndexers(indexers);

      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/caps', async (req, res) => {
    try {
      const { url: rawUrl, apiKey, indexerName } = req.body;

      if (!rawUrl || !apiKey) {
        return res.status(400).json({ error: 'URL and API key are required' });
      }

      const url = normalizeNewznabUrl(rawUrl);
      const caps = await fetchIndexerCaps(url, apiKey, indexerName);
      res.json(caps);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch capabilities' });
    }
  });

  return router;
}

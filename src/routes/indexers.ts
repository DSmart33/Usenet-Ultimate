/**
 * Indexer routes — /api/indexers/*
 *
 * CRUD, testing, reordering, and capability fetching for manual (Newznab) indexers.
 */

import { Router } from 'express';
import type { Config, UsenetIndexer } from '../types.js';
import { checkZyclopsUrlConflict } from '../utils/indexerHelpers.js';

/**
 * Ensure a Newznab URL ends with /api (the standard endpoint).
 * Users often paste just the base URL (e.g. https://indexer.example.com)
 * when they mean https://indexer.example.com/api.
 */
function normalizeNewznabUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  // Already ends with /api — nothing to do
  if (/\/api$/i.test(trimmed)) return trimmed;
  // Has a deeper path (e.g. /torznab/foo, /custom/v1) — leave it alone
  const { pathname } = new URL(trimmed);
  if (pathname !== '/' && pathname !== '') return trimmed;
  return `${trimmed}/api`;
}

interface IndexerDeps {
  config: Config;
  getIndexers: () => UsenetIndexer[];
  addIndexer: (indexer: Omit<UsenetIndexer, 'enabled'>) => UsenetIndexer;
  updateIndexer: (name: string, updates: Partial<UsenetIndexer>) => UsenetIndexer;
  deleteIndexer: (name: string) => void;
  reorderIndexers: (indexers: UsenetIndexer[]) => void;
  fetchIndexerCaps: (url: string, apiKey: string, indexerName?: string, zyclops?: any) => Promise<any>;
  proxyFetch: (url: string, options?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; body?: any }) => Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any>; headers: Map<string, string> }>;
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
      const { name, url: rawUrl, apiKey, website, logo, movieSearchMethod, tvSearchMethod, caps, zyclops } = req.body;

      if (!name || !rawUrl || !apiKey) {
        return res.status(400).json({ error: 'Name, URL, and API key are required' });
      }

      const url = normalizeNewznabUrl(rawUrl);

      // SAFETY: Check for duplicate indexer URLs when Zyclops is involved
      const conflict = checkZyclopsUrlConflict(url, !!zyclops?.enabled, getIndexers());
      if (conflict) {
        console.warn(`\u{1F916} Zyclops URL conflict blocked: ${name} (${url}) \u2014 ${conflict}`);
        return res.status(400).json({ error: conflict });
      }

      if (zyclops?.enabled) {
        console.log(`\u{1F916} Adding indexer ${name} with Zyclops enabled (backbone: ${zyclops.backbone?.join(',') || 'none'}, provider_host: ${zyclops.providerHosts || 'none'})`);
      }
      const indexer = addIndexer({ name, url, apiKey, website, logo, movieSearchMethod, tvSearchMethod, caps, zyclops });
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

      // SAFETY: Check for duplicate indexer URLs when Zyclops is toggled
      if (updates.zyclops !== undefined || updates.url !== undefined) {
        const currentIndexer = getIndexers().find(i => i.name === name);
        if (currentIndexer) {
          const effectiveUrl = updates.url || currentIndexer.url;
          const effectiveZyclops = updates.zyclops !== undefined ? updates.zyclops?.enabled : currentIndexer.zyclops?.enabled;
          const conflict = checkZyclopsUrlConflict(effectiveUrl, !!effectiveZyclops, getIndexers(), name);
          if (conflict) {
            console.warn(`\u{1F916} Zyclops URL conflict blocked on update: ${name} \u2014 ${conflict}`);
            return res.status(400).json({ error: conflict });
          }
        }
      }

      // Validate and strip preZyclopsState to known fields only
      if (updates.zyclops?.preZyclopsState != null) {
        const pzs = updates.zyclops.preZyclopsState;
        if (typeof pzs.enabled !== 'boolean' || typeof pzs.proxy !== 'boolean' || typeof pzs.healthCheck !== 'boolean') {
          return res.status(400).json({ error: 'Invalid preZyclopsState: expected { enabled: boolean, proxy: boolean, healthCheck: boolean }' });
        }
        updates.zyclops.preZyclopsState = { enabled: pzs.enabled, proxy: pzs.proxy, healthCheck: pzs.healthCheck };
      }

      // Log Zyclops state changes
      if (updates.zyclops !== undefined) {
        const wasEnabled = getIndexers().find(i => i.name === name)?.zyclops?.enabled;
        const willBeEnabled = updates.zyclops?.enabled;
        if (willBeEnabled && !wasEnabled) {
          console.log(`\u{1F916} Zyclops enabled for ${name} (backbone: ${updates.zyclops.backbone?.join(',') || 'none'}, provider_host: ${updates.zyclops.providerHosts || 'none'})`);
        } else if (!willBeEnabled && wasEnabled) {
          console.log(`\u{1F916} Zyclops disabled for ${name}`);
        } else if (willBeEnabled) {
          console.log(`\u{1F916} Zyclops config updated for ${name}: backbone=${updates.zyclops.backbone?.join(',') || 'none'}, provider_host=${updates.zyclops.providerHosts || 'none'}, show_unknown=${updates.zyclops.showUnknown ?? 'default'}, single_ip=${updates.zyclops.singleIp ?? 'default'}`);
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

      // Build test URL — route through Zyclops if enabled (SAFETY: never query indexer directly when Zyclops is on)
      let searchUrl: string;
      if (indexer.zyclops?.enabled) {
        const zyclopsBase = (config.zyclopsEndpoint || 'https://zyclops.elfhosted.com').replace(/\/$/, '');
        const zyclopsParams = new URLSearchParams({
          t: 'search',
          apikey: indexer.apiKey,
          q: query,
          limit: '50',
          target: indexer.url,
        });
        if (indexer.zyclops.backbone?.length) zyclopsParams.set('backbone', indexer.zyclops.backbone.join(','));
        if (indexer.zyclops.providerHosts) zyclopsParams.set('provider_host', indexer.zyclops.providerHosts);
        if (indexer.zyclops.showUnknown === true) zyclopsParams.set('show_unknown', 'true');
        if (indexer.zyclops.singleIp === false) zyclopsParams.set('single_ip', 'false');
        // Replace %2C back to commas — URLSearchParams encodes them but Zyclops expects raw commas
        searchUrl = `${zyclopsBase}/api?${zyclopsParams.toString().replace(/%2C/gi, ',')}`;
      } else {
        searchUrl = `${indexer.url}?t=search&apikey=${indexer.apiKey}&q=${encodeURIComponent(query)}&limit=50`;
      }

      const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;
      const headers = { 'User-Agent': userAgent };
      console.log('\u{1F4E4} Request to test indexer:', { url: indexer.zyclops?.enabled ? '(via Zyclops)' : searchUrl, headers });
      // SAFETY: Skip proxy when going through Zyclops
      const response = indexer.zyclops?.enabled
        ? await fetch(searchUrl, { headers })
        : await proxyFetch(searchUrl, { headers });

      if (!response.ok) {
        return res.status(400).json({
          error: `Indexer returned ${response.status}: ${response.statusText}`
        });
      }

      const text = await response.text();

      // Parse XML to extract titles from within <item> tags only
      const titles: string[] = [];
      const itemMatches = text.matchAll(/<item>([\s\S]*?)<\/item>/g);

      for (const itemMatch of itemMatches) {
        const itemContent = itemMatch[1];
        const titleMatch = itemContent.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titles.length < 5) {
          titles.push(titleMatch[1].trim());
        }
      }

      // Count total results
      const resultCount = (text.match(/<item>/g) || []).length;

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
      const response = await proxyFetch(searchUrl, { headers });

      if (!response.ok) {
        return res.status(400).json({
          error: `Indexer returned ${response.status}: ${response.statusText}`
        });
      }

      const text = await response.text();

      // Parse XML to extract titles from within <item> tags only
      const titles: string[] = [];
      const itemMatches = text.matchAll(/<item>([\s\S]*?)<\/item>/g);

      for (const itemMatch of itemMatches) {
        const itemContent = itemMatch[1];
        const titleMatch = itemContent.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titles.length < 5) {
          titles.push(titleMatch[1].trim());
        }
      }

      // Count total results
      const resultCount = (text.match(/<item>/g) || []).length;

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
      const { url: rawUrl, apiKey, indexerName, zyclops } = req.body;

      if (!rawUrl || !apiKey) {
        return res.status(400).json({ error: 'URL and API key are required' });
      }

      const url = normalizeNewznabUrl(rawUrl);
      const caps = await fetchIndexerCaps(url, apiKey, indexerName, zyclops);
      res.json(caps);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch capabilities' });
    }
  });

  return router;
}

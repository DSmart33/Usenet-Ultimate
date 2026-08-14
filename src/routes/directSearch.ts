import { Router } from 'express';
import { directTextSearch } from '../addon/searchOrchestrator.js';

const MAX_QUERIES = 12;
const MAX_QUERY_LENGTH = 200;

/**
 * Manifest-key protected search API for metadata addons which already know
 * the desired title but do not have a media-database ID (notably live sports).
 */
export function createDirectSearchRoutes(): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input: unknown[] = Array.isArray(req.body?.queries) ? req.body.queries : [];
    const queries: string[] = [];
    const seen = new Set<string>();
    for (const value of input) {
      if (typeof value !== 'string') continue;
      const query = value.trim();
      if (!query || seen.has(query)) continue;
      seen.add(query);
      queries.push(query);
      if (queries.length >= MAX_QUERIES) break;
    }

    if (queries.length === 0 || queries.some(query => query.length > MAX_QUERY_LENGTH)) {
      res.status(400).json({ error: 'queries must contain 1-12 strings of at most 200 characters' });
      return;
    }

    try {
      console.log(`\u{1F50D} Direct title search: ${queries.map(query => `"${query}"`).join(', ')}`);
      const results = await directTextSearch(queries);
      res.json({ version: 1, results, count: results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown search error';
      console.error('\u274C Direct title search failed:', message);
      res.status(502).json({ error: message });
    }
  });

  return router;
}

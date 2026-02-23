/**
 * Stats routes — /api/stats/*
 *
 * Indexer grab statistics:
 *   GET    /api/stats              — Get all indexer stats
 *   GET    /api/stats/:indexerName — Get stats for a single indexer
 *   DELETE /api/stats/:indexerName — Reset stats for a single indexer
 *   DELETE /api/stats              — Reset all stats
 */

import { Router } from 'express';

interface StatsDeps {
  getAllStats: () => any;
  getIndexerStats: (name: string) => any;
  resetIndexerStats: (name: string) => void;
  resetAllStats: () => void;
}

export function createStatsRoutes(deps: StatsDeps): Router {
  const router = Router();
  const { getAllStats, getIndexerStats, resetIndexerStats, resetAllStats } = deps;

  router.get('/', (req, res) => {
    try {
      const stats = getAllStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/:indexerName', (req, res) => {
    try {
      const stats = getIndexerStats(req.params.indexerName);
      if (!stats) {
        return res.status(404).json({ error: 'Indexer not found' });
      }
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete('/:indexerName', (req, res) => {
    try {
      resetIndexerStats(req.params.indexerName);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete('/', (req, res) => {
    try {
      resetAllStats();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

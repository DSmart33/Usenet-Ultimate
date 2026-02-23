/**
 * Log routes — /api/logs/*
 *
 * Log buffer and SSE stream:
 *   GET /api/logs        — Get buffered log entries
 *   GET /api/logs/stream — SSE stream of live log entries
 */

import { Router } from 'express';

interface LogDeps {
  getLogBuffer: () => any[];
  subscribeToLogs: (callback: (entry: any) => void) => () => void;
}

export function createLogRoutes(deps: LogDeps): Router {
  const router = Router();
  const { getLogBuffer, subscribeToLogs } = deps;

  router.get('/', (req, res) => {
    res.json(getLogBuffer());
  });

  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const unsubscribe = subscribeToLogs((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on('close', unsubscribe);
  });

  return router;
}

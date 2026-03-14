/**
 * Health check routes — /api/health-check/*
 *
 * NNTP connection test and usenet provider CRUD:
 *   POST   /api/health-check/test                   — Test NNTP connection
 *   GET    /api/health-check/providers               — List providers
 *   POST   /api/health-check/providers               — Add provider
 *   PUT    /api/health-check/providers/:id           — Update provider
 *   DELETE /api/health-check/providers/:id           — Delete provider
 *   POST   /api/health-check/providers/reorder       — Reorder providers
 */

import { Router } from 'express';
import type { UsenetProvider } from '../types.js';
import { requireAuth } from '../auth/authMiddleware.js';

interface HealthCheckDeps {
  getProviders: () => UsenetProvider[];
  addProvider: (provider: Omit<UsenetProvider, 'id'>) => UsenetProvider;
  updateProvider: (id: string, updates: Partial<UsenetProvider>) => UsenetProvider;
  deleteProvider: (id: string) => void;
  reorderProviders: (orderedIds: string[]) => void;
}

export function createHealthCheckRoutes(deps: HealthCheckDeps): Router {
  const router = Router();
  const { getProviders, addProvider, updateProvider, deleteProvider, reorderProviders } = deps;

  // Usenet provider connection test endpoint
  router.post('/test', async (req, res) => {
    try {
      const { host, port, useTLS, username, password } = req.body;

      if (!host || !port) {
        return res.status(400).json({ success: false, message: 'Host and port are required' });
      }

      const netModule = await import('net');
      const tlsModule = await import('tls');

      return new Promise<void>((resolve) => {
        let socket: any;

        const timeout = setTimeout(() => {
          if (socket) socket.destroy();
          res.status(500).json({ success: false, message: 'Connection timeout' });
          resolve();
        }, 10000);

        let authenticated = false;
        let buffer = '';

        socket = useTLS
          ? tlsModule.connect({ host, port, rejectUnauthorized: false })
          : netModule.connect({ host, port });

        socket.on('data', (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split('\r\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            console.log(`\u{1F4E1} NNTP: ${line}`);

            if (line.startsWith('200') || line.startsWith('201')) {
              if (username && password) {
                socket.write(`AUTHINFO USER ${username}\r\n`);
              } else {
                clearTimeout(timeout);
                socket.destroy();
                res.json({ success: true, message: 'Connected successfully (no authentication)' });
                resolve();
              }
            }
            else if (line.startsWith('381')) {
              socket.write(`AUTHINFO PASS ${password}\r\n`);
            }
            else if (line.startsWith('281')) {
              authenticated = true;
              clearTimeout(timeout);
              socket.destroy();
              res.json({ success: true, message: 'Connected and authenticated successfully' });
              resolve();
            }
            else if (line.startsWith('481') || line.startsWith('482')) {
              clearTimeout(timeout);
              socket.destroy();
              res.status(502).json({ success: false, message: 'Authentication failed: Invalid username or password' });
              resolve();
            }
            else if (line.startsWith('4') || line.startsWith('5')) {
              clearTimeout(timeout);
              socket.destroy();
              res.status(500).json({ success: false, message: `Server error: ${line}` });
              resolve();
            }
          }
        });

        socket.on('error', (error: Error) => {
          clearTimeout(timeout);
          res.status(500).json({
            success: false,
            message: `Connection error: ${error.message}`
          });
          resolve();
        });

        socket.on('end', () => {
          clearTimeout(timeout);
          if (!authenticated && username) {
            res.status(500).json({ success: false, message: 'Connection closed unexpectedly' });
            resolve();
          }
        });
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Test failed: ${(error as Error).message}`
      });
    }
  });

  // Usenet provider CRUD endpoints
  router.get('/providers', (req, res) => {
    res.json(getProviders());
  });

  router.post('/providers', (req, res) => {
    try {
      const { name, host, port, useTLS, username, password, enabled, type } = req.body;

      if (!name || !host) {
        return res.status(400).json({ error: 'Name and host are required' });
      }

      const provider = addProvider({
        name,
        host,
        port: port || 563,
        useTLS: useTLS ?? true,
        username: username || '',
        password: password || '',
        enabled: enabled ?? true,
        type: type || 'pool'
      });
      res.status(201).json(provider);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.put('/providers/:id', (req, res) => {
    try {
      const provider = updateProvider(req.params.id, req.body);
      res.json(provider);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.delete('/providers/:id', (req, res) => {
    try {
      deleteProvider(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/providers/reorder', (req, res) => {
    try {
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds must be an array of provider IDs' });
      }
      reorderProviders(orderedIds);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}

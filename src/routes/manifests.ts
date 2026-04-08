/**
 * Manifest routes — /api/manifests
 *
 * CRUD for install manifests (Stremio installation keys).
 * All endpoints require JWT authentication.
 */

import { Router } from 'express';
import type { Manifest } from '../types.js';

interface ManifestDeps {
  getManifests: (userId: string) => Manifest[];
  createManifest: (userId: string, name: string) => Manifest | null;
  updateManifest: (userId: string, manifestId: string, updates: { name?: string }) => Manifest | null;
  regenerateManifest: (userId: string, manifestId: string) => Manifest | null;
  deleteManifest: (userId: string, manifestId: string) => boolean;
}

export function createManifestRoutes(deps: ManifestDeps): Router {
  const router = Router();
  const { getManifests, createManifest, updateManifest, regenerateManifest, deleteManifest } = deps;

  router.get('/', (req, res) => {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ manifests: getManifests(userId) });
  });

  router.post('/', (req, res) => {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const manifest = createManifest(userId, name.trim());
    if (!manifest) {
      return res.status(400).json({ error: 'Maximum 25 installs allowed' });
    }
    res.json({ manifest });
  });

  router.put('/:id', (req, res) => {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name } = req.body;
    const updates: { name?: string } = {};
    if (name !== undefined) updates.name = String(name).trim();

    const manifest = updateManifest(userId, req.params.id, updates);
    if (!manifest) {
      return res.status(404).json({ error: 'Manifest not found' });
    }
    res.json({ manifest });
  });

  router.post('/:id/regenerate', (req, res) => {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const manifest = regenerateManifest(userId, req.params.id);
    if (!manifest) {
      return res.status(404).json({ error: 'Manifest not found' });
    }
    res.json({ manifest });
  });

  router.delete('/:id', (req, res) => {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const success = deleteManifest(userId, req.params.id);
    if (!success) {
      return res.status(400).json({ error: 'Cannot delete the last install' });
    }
    res.json({ success: true });
  });

  return router;
}

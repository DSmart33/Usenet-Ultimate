/**
 * Authentication Middleware
 *
 * requireAuth - Protects API routes with JWT verification
 * validateManifestKey - Validates manifest key in Stremio URL paths
 */

import { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserByManifestKey, getUserById, updateManifestLastUsed } from './auth.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Check Authorization header first, then fall back to query param (for SSE)
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query.token as string | undefined);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const user = getUserById(payload.userId);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  // Attach user info to request for downstream handlers
  (req as any).user = { userId: payload.userId, username: payload.username };
  next();
}

export function validateManifestKey(req: Request, res: Response, next: NextFunction): void {
  const { manifestKey } = req.params;
  if (!manifestKey || !getUserByManifestKey(manifestKey)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  updateManifestLastUsed(manifestKey);
  next();
}

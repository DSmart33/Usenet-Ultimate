/**
 * Auth routes — /api/auth/*
 *
 * Public endpoints (no auth middleware):
 *   GET  /api/auth/status — Check auth state (setup_required, login_required, authenticated)
 *   POST /api/auth/setup  — Create first user account
 *   POST /api/auth/login  — Authenticate and receive JWT
 *   GET  /api/favicon      — Proxy external favicons (loaded by <img> tags, can't send JWT)
 */

import { Router } from 'express';
import type { Config, User } from '../types.js';

interface AuthDeps {
  config: Config;
  hasAnyUsers: () => boolean;
  createUser: (username: string, password: string) => Promise<User>;
  authenticateUser: (username: string, password: string) => Promise<User | null>;
  generateToken: (user: User) => string;
  verifyToken: (token: string) => { userId: string; username: string } | null;
  getUserById: (id: string) => { username: string; manifestKey: string } | null;
  getLatestVersions: () => { chrome: string };
}

export function createAuthRoutes(deps: AuthDeps): Router {
  const router = Router();
  const { config, hasAnyUsers, createUser, authenticateUser, generateToken, verifyToken, getUserById, getLatestVersions } = deps;

  router.get('/auth/status', (req, res) => {
    if (!hasAnyUsers()) {
      return res.json({ status: 'setup_required' });
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) {
      return res.json({ status: 'login_required' });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.json({ status: 'login_required' });
    }

    const user = getUserById(payload.userId);
    if (!user) {
      return res.json({ status: 'login_required' });
    }

    res.json({ status: 'authenticated', username: user.username, manifestKey: user.manifestKey });
  });

  router.post('/auth/setup', async (req, res) => {
    if (hasAnyUsers()) {
      return res.status(403).json({ error: 'Setup already completed. Use login instead.' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    try {
      const user = await createUser(username, password);
      const token = generateToken(user);
      res.json({ token, username: user.username, manifestKey: user.manifestKey });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const user = await authenticateUser(username, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const token = generateToken(user);
      res.json({ token, username: user.username, manifestKey: user.manifestKey });
    } catch (error) {
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Favicon proxy endpoint — public (no auth), loaded by <img> tags which can't send JWT
  router.get('/favicon', async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
      }

      // SSRF protection: only allow https URLs and block private/internal hosts
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL' });
      }
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only HTTPS URLs are allowed' });
      }
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('10.')
        || hostname.startsWith('192.168.') || hostname === '169.254.169.254'
        || hostname.startsWith('0.') || hostname === '[::1]'
        || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
        return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
      }

      const userAgent = config.userAgents?.general || getLatestVersions().chrome;
      const headers = { 'User-Agent': userAgent };
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Failed to fetch favicon' });
      }

      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || 'image/x-icon';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.send(Buffer.from(buffer));
    } catch (error) {
      res.status(500).json({ error: 'Failed to proxy favicon' });
    }
  });

  return router;
}

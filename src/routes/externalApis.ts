/**
 * External API routes — /api/search-config/*
 *
 * TMDB and TVDB API key testing:
 *   POST /api/search-config/test-tmdb — Test TMDB API key (v3 or v4 Read Access Token)
 *   POST /api/search-config/test-tvdb — Test TVDB API key
 */

import { Router } from 'express';

export function createExternalApiRoutes(): Router {
  const router = Router();

  // TMDB API key test endpoint (supports both v3 API key and v4 Read Access Token)
  router.post('/test-tmdb', async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ success: false, message: 'API key is required' });
      }

      // Detect v4 Read Access Token (JWT format, long) vs v3 API key (short hex)
      const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');
      const url = isReadAccessToken
        ? 'https://api.themoviedb.org/3/configuration'
        : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`;
      const headers: Record<string, string> = {};
      if (isReadAccessToken) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      const keyType = isReadAccessToken ? 'Read Access Token' : 'API key';
      if (response.ok) {
        res.json({ success: true, message: `TMDB ${keyType} is valid` });
      } else if (response.status === 401) {
        res.json({ success: false, message: `Invalid ${keyType}` });
      } else {
        res.json({ success: false, message: `TMDB returned ${response.status}` });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: error instanceof Error ? error.message : 'Test failed' });
    }
  });

  // TVDB API key test endpoint
  router.post('/test-tvdb', async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ success: false, message: 'API key is required' });
      }

      const loginResponse = await fetch('https://api4.thetvdb.com/v4/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: apiKey }),
        signal: AbortSignal.timeout(5000),
      });

      if (loginResponse.ok) {
        const data = await loginResponse.json() as any;
        if (data?.data?.token) {
          res.json({ success: true, message: 'TVDB API key is valid' });
        } else {
          res.json({ success: false, message: 'Unexpected response from TVDB' });
        }
      } else if (loginResponse.status === 401) {
        res.json({ success: false, message: 'Invalid API key' });
      } else {
        res.json({ success: false, message: `TVDB returned ${loginResponse.status}` });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: error instanceof Error ? error.message : 'Test failed' });
    }
  });

  return router;
}

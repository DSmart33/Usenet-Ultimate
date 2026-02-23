/**
 * EasyNews proxy routes — /:manifestKey/easynews/*
 *
 * Key-protected endpoints for EasyNews direct download and NZB proxy:
 *   GET /:manifestKey/easynews/resolve — Resolve CDN URL and redirect
 *   GET /:manifestKey/easynews/nzb     — Download NZB via dl-nzb API
 */

import { Router } from 'express';
import axios from 'axios';
import type { Config } from '../types.js';

interface EasynewsProxyDeps {
  config: Config;
}

export function createEasynewsProxyRoutes(deps: EasynewsProxyDeps): Router {
  const router = Router({ mergeParams: true });
  const { config } = deps;

  // EasyNews direct download resolve endpoint (key-protected)
  // Resolves CDN URL with auth server-side and redirects client to it
  router.get('/resolve', async (req, res) => {
    try {
      const { hash, filename, ext, dlFarm, dlPort, downURL } = req.query as Record<string, string>;
      if (!hash || !filename || !ext) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }

      const username = config.easynewsUsername;
      const password = config.easynewsPassword;
      if (!username || !password) {
        return res.status(500).json({ error: 'EasyNews credentials not configured' });
      }

      // Construct direct download URL
      const baseUrl = downURL || 'https://members.easynews.com/dl';
      const farm = dlFarm || 'news.easynews.com';
      const port = dlPort || '443';
      const directUrl = `${baseUrl}/${farm}/${port}/${hash}.${ext}/${encodeURIComponent(filename)}.${ext}`;
      const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

      // GET with maxRedirects:0 to capture the CDN redirect (some servers don't redirect on HEAD)
      try {
        const resolveResp = await axios.get(directUrl, {
          headers: {
            Authorization: authHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          maxRedirects: 0,
          timeout: 15000,
          responseType: 'stream',
          validateStatus: (status) => status < 400 || status === 301 || status === 302 || status === 303 || status === 307,
        });

        // If redirect, send client to the CDN URL
        const location = resolveResp.headers.location;
        if (location && (resolveResp.status === 301 || resolveResp.status === 302 || resolveResp.status === 303 || resolveResp.status === 307)) {
          // Destroy the response stream since we only needed the redirect
          resolveResp.data.destroy();
          console.log(`\u{1F517} EasyNews CDN redirect: ${location.substring(0, 60)}...`);
          return res.redirect(302, location);
        }

        // No redirect — pipe content directly
        if (resolveResp.headers['content-type']) res.setHeader('Content-Type', resolveResp.headers['content-type']);
        if (resolveResp.headers['content-length']) res.setHeader('Content-Length', resolveResp.headers['content-length']);
        if (resolveResp.headers['accept-ranges']) res.setHeader('Accept-Ranges', resolveResp.headers['accept-ranges']);
        resolveResp.data.pipe(res);
      } catch (err: any) {
        // axios throws on redirect statuses even with validateStatus when maxRedirects is 0 in some versions
        if (err.response?.status === 301 || err.response?.status === 302 || err.response?.status === 303 || err.response?.status === 307) {
          const location = err.response.headers.location;
          if (location) {
            console.log(`\u{1F517} EasyNews CDN redirect (from error): ${location.substring(0, 60)}...`);
            return res.redirect(302, location);
          }
        }
        // Fallback: proxy through server with auth (never expose auth-required URL)
        console.warn(`\u26A0\uFE0F  EasyNews resolve fallback for ${hash}: ${err.message}`);
        const streamResp = await axios.get(directUrl, {
          headers: {
            Authorization: authHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          responseType: 'stream',
          maxRedirects: 5,
          timeout: 30000,
        });
        if (streamResp.headers['content-type']) res.setHeader('Content-Type', streamResp.headers['content-type']);
        if (streamResp.headers['content-length']) res.setHeader('Content-Length', streamResp.headers['content-length']);
        if (streamResp.headers['accept-ranges']) res.setHeader('Accept-Ranges', streamResp.headers['accept-ranges']);
        streamResp.data.pipe(res);
      }
    } catch (error: any) {
      console.error('\u274C EasyNews resolve error:', error.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to resolve EasyNews download' });
      }
    }
  });

  // EasyNews NZB proxy endpoint (key-protected)
  // Downloads NZB file from EasyNews via dl-nzb API and returns it to the caller
  router.get('/nzb', async (req, res) => {
    try {
      const { hash, filename, ext, sig } = req.query as Record<string, string>;
      if (!hash || !filename) {
        return res.status(400).json({ error: 'Missing required parameters (hash, filename)' });
      }

      const username = config.easynewsUsername;
      const password = config.easynewsPassword;
      if (!username || !password) {
        return res.status(500).json({ error: 'EasyNews credentials not configured' });
      }

      const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

      // Build the dl-nzb POST payload
      // Format: autoNZB=1&{index}&sig={sig}={hash}|{filename_b64}:{ext_b64}
      const fileExt = ext || '';
      const fnB64 = Buffer.from(filename).toString('base64').replace(/=/g, '');
      const extB64 = Buffer.from(fileExt).toString('base64').replace(/=/g, '');
      const valueToken = `${hash}|${fnB64}:${extB64}`;
      const sigValue = sig || '';
      const body = `autoNZB=1&${encodeURIComponent(`0&sig=${sigValue}`)}=${encodeURIComponent(valueToken)}`;

      console.log(`\u{1F4E5} EasyNews NZB download: ${filename}.${fileExt}`);

      const nzbResp = await axios.post('https://members.easynews.com/2.0/api/dl-nzb', body, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      res.setHeader('Content-Type', 'application/x-nzb');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.nzb"`);
      if (nzbResp.headers['content-length']) res.setHeader('Content-Length', nzbResp.headers['content-length']);
      res.send(Buffer.from(nzbResp.data));
    } catch (error: any) {
      console.error('\u274C EasyNews NZB download error:', error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}, Body: ${Buffer.from(error.response.data || '').toString().substring(0, 200)}`);
      }
      res.status(500).json({ error: 'Failed to download EasyNews NZB' });
    }
  });

  return router;
}

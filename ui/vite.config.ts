
/**
 * What this does:
 *    Configures Vite with React plugin and PWA support
 *    Dev server runs on port 3000
 *    Proxies API calls to backend on port 1337
 *    Builds output to dist/ folder
 *    Generates service worker and web app manifest for PWA installability
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Usenet Ultimate',
        short_name: 'Usenet Ultimate',
        description: 'Modern Usenet addon for Stremio',
        theme_color: '#d97706',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Disable precaching — this app doesn't need offline support and
        // precaching causes stale content on normal refresh
        globPatterns: [],
        // Activate new service worker immediately on install (don't wait for tabs to close)
        skipWaiting: true,
        // Take control of all open pages immediately (serve new assets right away)
        clientsClaim: true,
        // Don't intercept API routes or Stremio addon routes
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/health/,
          /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        ],
        navigateFallback: null,
      },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      // Forward API calls to backend during development
      '/api': 'http://localhost:1337',
      '/health': 'http://localhost:1337',
      // Proxy manifest key routes (UUID format) for Stremio addon + NZBDav stream
      '^/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}': 'http://localhost:1337',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 700,
  },
});
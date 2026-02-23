/**
 * Indexer helper utilities
 *
 * Shared logic for normalizing indexer URLs, detecting Zyclops conflicts,
 * and matching indexer names to known logo presets.
 */

import type { UsenetIndexer } from '../types.js';

// Known indexer presets for logo matching (name -> logo URL)
export const INDEXER_LOGO_MAP: Record<string, string> = {
  'abnzb': '/api/favicon?url=https://abnzb.com/favicon.ico',
  'althub': '/api/favicon?url=https://althub.co.za/templates/Dark/images/icons/favicon.png',
  'digitalcarnage': '/api/favicon?url=https://digitalcarnage.info/favicon.ico',
  'drunkenslug': '/api/favicon?url=https://drunkenslug.com/favicon.ico',
  'miatrix': '/api/favicon?url=https://www.miatrix.com/favicon.ico',
  'ninjacentral': '/api/favicon?url=https://ninjacentral.co.za/favicon.ico',
  'nzbfinder': '/api/favicon?url=https://nzbfinder.ws/favicon.ico',
  'nzbgeek': '/api/favicon?url=https://nzbgeek.info/favicon.ico',
  'nzbplanet': '/api/favicon?url=https://nzbplanet.net/views/images/favicon.ico',
  'scenenzbs': '/api/favicon?url=https://scenenzbs.com/favicon.ico',
  'squareeyed': '/api/favicon?url=https://squareeyed.org/templates/square/assets/images/se.png',
  'tabularasa': '/api/favicon?url=https://www.tabula-rasa.pw/favicon.ico',
  'usenetcrawler': '/api/favicon?url=https://www.usenet-crawler.com/templates/dark/images/favicon.ico',
};

/** Normalize indexer URL for duplicate comparison (strip protocol, trailing slashes, /api suffix) */
export function normalizeIndexerUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/api$/, '').toLowerCase();
}

/**
 * Check for duplicate indexer URLs when Zyclops is involved (SAFETY: prevents multi-IP bans).
 * Returns an error message string if a conflict is found, or null if safe.
 */
export function checkZyclopsUrlConflict(
  url: string,
  zyclopsEnabled: boolean,
  existingIndexers: UsenetIndexer[],
  excludeName?: string,
): string | null {
  const normalized = normalizeIndexerUrl(url);
  const existing = existingIndexers.filter(i => i.name !== excludeName);
  const match = existing.find(i => normalizeIndexerUrl(i.url) === normalized);
  if (!match) return null;
  if (zyclopsEnabled && !match.zyclops?.enabled) {
    return `Another instance of this indexer (${match.name}) exists without Zyclops. Having two instances — one with and one without Zyclops — would expose multiple IPs and risk a ban. Enable Zyclops on both or remove the duplicate.`;
  }
  if (!zyclopsEnabled && match.zyclops?.enabled) {
    return `This indexer URL is already configured with Zyclops (${match.name}). Adding a non-Zyclops instance would expose multiple IPs and risk a ban.`;
  }
  return null;
}

export function matchIndexerLogo(name: string, baseUrl?: string): string | undefined {
  // Normalize: lowercase, strip spaces/hyphens/dots
  const normalized = name.toLowerCase().replace(/[\s\-_.]/g, '');

  // Try exact match first, then substring/contains match
  for (const [key, logo] of Object.entries(INDEXER_LOGO_MAP)) {
    if (normalized === key || normalized.includes(key) || key.includes(normalized)) {
      return logo;
    }
  }

  // Fall back to favicon from baseUrl
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      return `/api/favicon?url=https://${host}/favicon.ico`;
    } catch {}
  }
  return undefined;
}

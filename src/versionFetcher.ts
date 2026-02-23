import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '..', 'config', 'version-cache.json');

interface VersionCache {
  prowlarr: string;
  sabnzbd: string;
  chrome: string;
  alpineVersion: string;
  lastFetched: number;
}

const HARDCODED_DEFAULTS: VersionCache = {
  prowlarr: 'Prowlarr/2.3.0.5236 (alpine 3.22.2)',
  sabnzbd: 'SABnzbd/4.5.5',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  alpineVersion: '3.22.2',
  lastFetched: 0
};

// Load persisted cache from disk, fall back to hardcoded defaults
function loadVersionCache(): VersionCache {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (data.prowlarr && data.sabnzbd && data.alpineVersion && data.chrome) {
        return data;
      }
    }
  } catch {
    // Fall through to defaults
  }
  return { ...HARDCODED_DEFAULTS };
}

function saveVersionCache(cache: VersionCache): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to persist version cache:', (error as Error).message);
  }
}

let versionCache: VersionCache = loadVersionCache();

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchLatestVersions(force = false): Promise<void> {
  const now = Date.now();
  
  // Skip if cache is still valid
  if (!force && now - versionCache.lastFetched < CACHE_DURATION) {
    return;
  }

  console.log('🔄 Fetching latest user-agent versions...');

  const fetchHeaders = { 'User-Agent': versionCache.chrome };

  // Fetch latest Alpine version first (used in Prowlarr user-agent)
  try {
    const alpineResponse = await fetch('https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml', {
      headers: fetchHeaders
    });

    if (alpineResponse.ok) {
      const yamlText = await alpineResponse.text();
      const versionMatch = yamlText.match(/version:\s*(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        versionCache.alpineVersion = versionMatch[1];
        console.log(`✅ Updated Alpine version: ${versionCache.alpineVersion}`);
      }
    }
  } catch (error) {
    console.error('Failed to fetch Alpine version:', (error as Error).message);
  }

  try {
    // Fetch Prowlarr version
    const prowlarrResponse = await fetch('https://api.github.com/repos/Prowlarr/Prowlarr/releases/latest', {
      headers: fetchHeaders
    });

    if (prowlarrResponse.ok) {
      const prowlarrData = await prowlarrResponse.json() as { tag_name?: string };
      const version = (prowlarrData.tag_name || '').replace(/^v/, '');
      if (version) {
        versionCache.prowlarr = `Prowlarr/${version} (alpine ${versionCache.alpineVersion})`;
        console.log(`✅ Updated Prowlarr user-agent: ${versionCache.prowlarr}`);
      }
    }
  } catch (error) {
    console.error('Failed to fetch Prowlarr version:', (error as Error).message);
  }

  try {
    // Fetch SABnzbd version
    const sabnzbdResponse = await fetch('https://api.github.com/repos/sabnzbd/sabnzbd/releases/latest', {
      headers: fetchHeaders
    });

    if (sabnzbdResponse.ok) {
      const sabnzbdData = await sabnzbdResponse.json() as { tag_name?: string };
      const version = (sabnzbdData.tag_name || '').replace(/^v/, '');
      if (version) {
        versionCache.sabnzbd = `SABnzbd/${version}`;
        console.log(`✅ Updated SABnzbd user-agent: ${versionCache.sabnzbd}`);
      }
    }
  } catch (error) {
    console.error('Failed to fetch SABnzbd version:', (error as Error).message);
  }

  try {
    // Fetch latest Chrome version
    const chromeResponse = await fetch('https://versionhistory.googleapis.com/v1/chrome/platforms/win64/channels/stable/versions', {
      headers: fetchHeaders
    });

    if (chromeResponse.ok) {
      const chromeData = await chromeResponse.json() as { versions?: Array<{ version?: string }> };
      const latestVersion = chromeData.versions?.[0]?.version;
      if (latestVersion) {
        versionCache.chrome = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${latestVersion} Safari/537.36`;
        console.log(`✅ Updated Chrome user-agent: Chrome/${latestVersion}`);
      }
    }
  } catch (error) {
    console.error('Failed to fetch Chrome version:', (error as Error).message);
  }

  versionCache.lastFetched = now;
  saveVersionCache(versionCache);
}

export function getLatestVersions(): { prowlarr: string; sabnzbd: string; chrome: string } {
  return {
    prowlarr: versionCache.prowlarr,
    sabnzbd: versionCache.sabnzbd,
    chrome: versionCache.chrome
  };
}

// Fetch on module load, then re-check every 24 hours
fetchLatestVersions();
setInterval(() => fetchLatestVersions(), CACHE_DURATION);

/**
 * WebDAV Client Singleton
 * Cached WebDAV client instance, reused for directory listing/stat operations.
 * Re-creates the client only when the configuration changes.
 */

import { createClient } from 'webdav';
import type { NZBDavConfig } from './types.js';

let cachedWebdavClient: ReturnType<typeof createClient> | null = null;
let cachedWebdavConfigKey = '';

export function getWebdavClient(config: NZBDavConfig): ReturnType<typeof createClient> {
  const webdavUrl = (config.webdavUrl || config.url).replace(/\/$/, '');
  const configKey = `${webdavUrl}::${config.webdavUser}::${config.webdavPassword}`;

  if (cachedWebdavClient && cachedWebdavConfigKey === configKey) {
    return cachedWebdavClient;
  }

  cachedWebdavClient = createClient(webdavUrl, {
    username: config.webdavUser,
    password: config.webdavPassword,
  });
  cachedWebdavConfigKey = configKey;
  return cachedWebdavClient;
}

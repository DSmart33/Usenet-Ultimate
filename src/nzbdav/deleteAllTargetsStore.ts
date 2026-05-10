/**
 * Delete-All Targets Store
 * In-memory map keyed by an opaque token that holds the list of WebDAV
 * paths a "Delete All Results" tile click should remove. The tile URL
 * carries only the token so the URL stays compact regardless of how many
 * results the library produced (large libraries blew past client URL
 * truncation limits when the targets list rode in the URL directly).
 *
 * No disk persistence: tiles are regenerated on each manifest fetch, so
 * a process restart just means the user re-opens the page to get a fresh
 * tile.
 */

import * as crypto from 'crypto';

interface DeleteAllTarget {
  path: string;
  scope: 'file' | 'pack';
}

interface DeleteAllEntry {
  targets: DeleteAllTarget[];
  createdAt: number;
}

const targetsByToken = new Map<string, DeleteAllEntry>();

// 30 minutes covers the typical "open page, scroll, click" window for a
// Stremio detail screen without growing memory unboundedly under heavy
// browsing.
const DELETE_ALL_TARGETS_TTL_MS = 30 * 60_000;

// 9 random bytes encode to 12 base64url chars; ample collision resistance
// at the expected map size.
const TOKEN_BYTES = 9;

export function registerDeleteAllTargets(targets: DeleteAllTarget[]): string {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  targetsByToken.set(token, { targets, createdAt: Date.now() });
  return token;
}

export function getDeleteAllTargets(token: string): DeleteAllTarget[] | null {
  const entry = targetsByToken.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > DELETE_ALL_TARGETS_TTL_MS) {
    targetsByToken.delete(token);
    return null;
  }
  return entry.targets;
}

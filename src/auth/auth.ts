/**
 * User Authentication Manager
 *
 * Manages user accounts with persistence to JSON file.
 * Handles password hashing, JWT tokens, and device manifest management.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { User, UsersData, Manifest } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_FILE = path.join(__dirname, '..', '..', 'config', 'users.json');

let usersData: UsersData = { jwtSecret: '', users: [] };

function loadUsersFile(): void {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      usersData = JSON.parse(raw);
    }
  } catch (error) {
    console.warn('⚠️  Failed to load users.json:', (error as Error).message);
  }

  if (!usersData.jwtSecret) {
    usersData.jwtSecret = crypto.randomBytes(64).toString('hex');
    saveUsersFile();
  }

  // Migrate legacy manifestKey → manifests array
  let migrated = false;
  for (const user of usersData.users) {
    if ((user as any).manifestKey && !user.manifests) {
      user.manifests = [{
        id: (user as any).manifestKey,
        name: 'Main',
        createdAt: user.createdAt,
      }];
      migrated = true;
    }
    if (!user.manifests) {
      user.manifests = [];
    }
  }
  if (migrated) {
    saveUsersFile();
    console.log('✅ Migrated users to multi-manifest format');
  }
}

function saveUsersFile(): void {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
}

// Debounced save for lastUsedAt updates (avoids excessive disk I/O from Stremio polling)
let lastUsedSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveUsersFileDebounced(): void {
  if (lastUsedSaveTimer) return; // already scheduled
  lastUsedSaveTimer = setTimeout(() => {
    lastUsedSaveTimer = null;
    saveUsersFile();
  }, 60_000);
}

// Load on module init
loadUsersFile();

// Password reset via env var — set RESET_PASSWORD=username:newpassword, restart, then remove it
// If only one user exists, username can be omitted: RESET_PASSWORD=newpassword
async function checkPasswordReset(): Promise<void> {
  const resetValue = process.env.RESET_PASSWORD;
  if (!resetValue) return;
  if (usersData.users.length === 0) return;

  let targetUsername: string;
  let newPassword: string;

  if (resetValue.includes(':')) {
    const colonIndex = resetValue.indexOf(':');
    targetUsername = resetValue.slice(0, colonIndex);
    newPassword = resetValue.slice(colonIndex + 1);
  } else {
    // Single user shorthand — reset the only user
    if (usersData.users.length > 1) {
      console.error(`\n❌ Multiple users exist. Specify which user: RESET_PASSWORD=username:newpassword\n`);
      return;
    }
    targetUsername = usersData.users[0].username;
    newPassword = resetValue;
  }

  const user = usersData.users.find(
    u => u.username.toLowerCase() === targetUsername.toLowerCase()
  );
  if (!user) {
    console.error(`\n❌ User "${targetUsername}" not found. Cannot reset password.\n`);
    return;
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsersFile();
  console.warn(`\n⚠️  Password for "${user.username}" has been reset via RESET_PASSWORD env var.`);
  console.warn(`⚠️  REMOVE the RESET_PASSWORD variable now and restart!\n`);
}
// Top-level await is supported in ESM — ensures reset completes before server accepts requests
await checkPasswordReset();

export function hasAnyUsers(): boolean {
  return usersData.users.length > 0;
}

export async function createUser(username: string, password: string): Promise<User> {
  const existing = usersData.users.find(
    u => u.username.toLowerCase() === username.toLowerCase()
  );
  if (existing) {
    throw new Error('Username already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    manifests: [{ id: uuidv4(), name: 'Default', createdAt: now }],
    createdAt: now,
  };

  usersData.users.push(user);
  saveUsersFile();
  console.log(`✅ User created: ${username}`);
  return user;
}

export async function authenticateUser(username: string, password: string): Promise<User | null> {
  const user = usersData.users.find(
    u => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  return valid ? user : null;
}

export function getUserByManifestKey(key: string): User | null {
  return usersData.users.find(u => u.manifests.some(m => m.id === key)) || null;
}

export function getUserById(id: string): User | null {
  return usersData.users.find(u => u.id === id) || null;
}

export function generateToken(user: User): string {
  return jwt.sign(
    { userId: user.id, username: user.username },
    usersData.jwtSecret,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token: string): { userId: string; username: string } | null {
  try {
    const payload = jwt.verify(token, usersData.jwtSecret) as { userId: string; username: string };
    return payload;
  } catch {
    return null;
  }
}

// ── Manifest CRUD ────────────────────────────────────────────────────

export function getManifests(userId: string): Manifest[] {
  const user = usersData.users.find(u => u.id === userId);
  return user?.manifests ?? [];
}

export function createManifest(userId: string, name: string): Manifest | null {
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return null;
  if (user.manifests.length >= 25) return null;

  const manifest: Manifest = {
    id: uuidv4(),
    name: name.slice(0, 50),
    createdAt: new Date().toISOString(),
  };

  user.manifests.push(manifest);
  saveUsersFile();
  return manifest;
}

export function updateManifest(userId: string, manifestId: string, updates: { name?: string }): Manifest | null {
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return null;

  const manifest = user.manifests.find(m => m.id === manifestId);
  if (!manifest) return null;

  if (updates.name !== undefined) manifest.name = updates.name.slice(0, 50);

  saveUsersFile();
  return manifest;
}

export function regenerateManifest(userId: string, manifestId: string): Manifest | null {
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return null;

  const manifest = user.manifests.find(m => m.id === manifestId);
  if (!manifest) return null;

  manifest.id = uuidv4();
  manifest.lastUsedAt = undefined;
  saveUsersFile();
  return manifest;
}

export function deleteManifest(userId: string, manifestId: string): boolean {
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return false;
  if (user.manifests.length <= 1) return false;

  const idx = user.manifests.findIndex(m => m.id === manifestId);
  if (idx === -1) return false;

  user.manifests.splice(idx, 1);
  saveUsersFile();
  return true;
}

export function updateManifestLastUsed(manifestKey: string): void {
  for (const user of usersData.users) {
    const manifest = user.manifests.find(m => m.id === manifestKey);
    if (manifest) {
      manifest.lastUsedAt = new Date().toISOString();
      saveUsersFileDebounced();
      return;
    }
  }
}

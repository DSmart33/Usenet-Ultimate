/**
 * User Authentication Manager
 *
 * Manages user accounts with persistence to JSON file.
 * Handles password hashing, JWT tokens, and manifest key generation.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { User, UsersData } from '../types.js';

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
}

function saveUsersFile(): void {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
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
  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    manifestKey: uuidv4(),
    createdAt: new Date().toISOString(),
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
  return usersData.users.find(u => u.manifestKey === key) || null;
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

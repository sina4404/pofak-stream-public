// Accounts: data/users.json (created by the first-run setup page or add-user.js),
// plus optional USERS env var ("name:scrypt.salt.hash,name2:...").
// Only scrypt hashes are stored, never passwords.
import crypto from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('.');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 32, SCRYPT).toString('base64url');
  const a = Buffer.from(actual);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fromEnv() {
  const map = new Map();
  for (const entry of (process.env.USERS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    if (i > 0) map.set(entry.slice(0, i).toLowerCase(), { name: entry.slice(0, i), hash: entry.slice(i + 1) });
  }
  return map;
}

function readFileUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// Re-read users.json only when it changes, so add-user.js works without a restart
let cache = null;
let cacheMtime = -1;

// username (lowercase) -> { name, hash }
export function getUsers() {
  let mtime = 0;
  try {
    mtime = statSync(USERS_FILE).mtimeMs;
  } catch { /* no file yet */ }
  if (!cache || mtime !== cacheMtime) {
    cache = fromEnv();
    for (const u of readFileUsers()) if (u.name && u.hash) cache.set(u.name.toLowerCase(), u);
    cacheMtime = mtime;
  }
  return cache;
}

export function validUsername(name) {
  return /^[\p{L}\p{N}._-]{2,32}$/u.test(String(name));
}

// Add a user or change their password
export function saveUser(name, password) {
  if (!validUsername(name)) throw new Error('Username: 2-32 letters, numbers, dots, dashes or underscores.');
  if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  const list = readFileUsers().filter((u) => u.name.toLowerCase() !== name.toLowerCase());
  list.push({ name, hash: hashPassword(password), created: new Date().toISOString() });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  cache = null;
}

export function removeUser(name) {
  const list = readFileUsers();
  const left = list.filter((u) => u.name.toLowerCase() !== String(name).toLowerCase());
  if (left.length === list.length) return false;
  writeFileSync(USERS_FILE, JSON.stringify(left, null, 2), { mode: 0o600 });
  cache = null;
  return true;
}

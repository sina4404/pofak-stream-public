// Login: signed session cookies, brute-force lockout, signed links for VLC,
// and a first-run setup page (home network only) to create the first account.
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, getUsers, verifyPassword, saveUser } from './users.js';

const COOKIE = 'ps_session';
const SESSION_DAYS = 30;
const STREAM_LINK_HOURS = 24;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

const needsSetup = () => getUsers().size === 0;

let secret;
// Signing key for cookies/links. Kept in DATA_DIR so logins survive restarts.
export async function initAuth() {
  if (process.env.SESSION_SECRET) {
    secret = process.env.SESSION_SECRET;
    return;
  }
  const file = path.join(DATA_DIR, 'session-secret');
  secret = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(file, secret, { mode: 0o600 });
  }
}

export function authStatus() {
  return needsSetup() ? 'no accounts yet: open the site from your home network to create one' : `${getUsers().size} account(s)`;
}

const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Requests from this machine / the home network (not through the internet tunnel)
function fromHomeNetwork(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false; // came through Cloudflare
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

// ---------- Sessions ----------

function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Cookie value: "<user>.<expires>.<signature>"
export function sessionUser(req) {
  const value = readCookie(req);
  if (!value) return null;
  const [user, expires, sig] = value.split('.');
  if (!user || !expires || !sig || Date.now() > Number(expires)) return null;
  if (!safeEqual(sig, sign(`${user}.${expires}`))) return null;
  return getUsers().get(user)?.name || null; // deleted users are logged out
}

function setSession(req, res, userKey) {
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  const value = `${userKey}.${expires}.${sign(`${userKey}.${expires}`)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // true behind an HTTPS tunnel/proxy
    maxAge: SESSION_DAYS * 86400_000,
    path: '/',
  });
}

// ---------- Signed stream links (for VLC, which has no cookie) ----------

export function signStreamPath(streamPath) {
  const expires = Date.now() + STREAM_LINK_HOURS * 3600_000;
  return `${streamPath}?exp=${expires}&sig=${sign(`${streamPath}|${expires}`)}`;
}

function validStreamLink(req) {
  const { exp, sig } = req.query;
  if (!exp || !sig || Date.now() > Number(exp)) return false;
  return safeEqual(sig, sign(`${req.path}|${exp}`));
}

// ---------- Brute-force protection ----------

const fails = new Map(); // ip -> { count, until }

function lockedOut(ip) {
  const f = fails.get(ip);
  return f && f.count >= MAX_FAILS && Date.now() < f.until;
}

function recordFail(ip) {
  const f = fails.get(ip);
  const fresh = !f || Date.now() > f.until;
  fails.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + LOCK_MS });
  if (fails.size > 10000) fails.clear();
}

// ---------- Routes & middleware ----------

const PUBLIC_PATHS = new Set([
  '/login', '/login.html', '/login.js', '/setup', '/setup.html', '/setup.js',
  '/style.css', '/manifest.webmanifest', '/api/login', '/api/setup', '/api/auth-state',
]);

export function authRoutes(app, publicDir) {
  app.get('/login', (_req, res) => (needsSetup() ? res.redirect('/setup') : res.sendFile(path.join(publicDir, 'login.html'))));
  app.get('/setup', (req, res) => {
    if (!needsSetup()) return res.redirect('/login');
    res.sendFile(path.join(publicDir, 'setup.html'));
  });
  app.get('/api/auth-state', (req, res) => res.json({ needsSetup: needsSetup(), homeNetwork: fromHomeNetwork(req) }));

  // First-run: create the first account. Only when there are no accounts, and
  // only from the home network, so nobody on the internet can claim it first.
  app.post('/api/setup', (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: 'Setup is already done. Please log in.' });
    if (!fromHomeNetwork(req)) {
      return res.status(403).json({ error: 'For safety, the first account can only be created from your home network (Wi-Fi), not over the internet.' });
    }
    const name = String(req.body?.username || '').trim();
    try {
      saveUser(name, String(req.body?.password || ''));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    console.log(`[setup] created first account "${name}"`);
    setSession(req, res, name.toLowerCase());
    res.json({ ok: true, user: name });
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (lockedOut(ip)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });

    const key = String(req.body?.username || '').trim().toLowerCase();
    const user = getUsers().get(key);
    // Always run scrypt so wrong usernames take as long as wrong passwords
    const ok = verifyPassword(req.body?.password || '', user?.hash || 'scrypt.AAAAAAAAAAAAAAAAAAAAAA.x');
    if (!user || !ok) {
      recordFail(ip);
      console.log(`[login] failed for "${key}" from ${ip}`);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    fails.delete(ip);
    setSession(req, res, key);
    console.log(`[login] ${user.name} from ${ip}`);
    res.json({ ok: true, user: user.name });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => res.json({ user: sessionUser(req) }));
}

export function requireLogin(req, res, next) {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/img/')) return next();
  if (sessionUser(req)) return next();
  if (req.path.startsWith('/stream/') && validStreamLink(req)) return next();

  const wantsPage = req.method === 'GET' && !req.path.startsWith('/api/') && (req.headers.accept || '').includes('text/html');
  if (wantsPage) return res.redirect(needsSetup() ? '/setup' : '/login');
  res.status(401).json({ error: 'Please log in.' });
}

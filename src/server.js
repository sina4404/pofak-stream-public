import express from 'express';
import compression from 'compression';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';
import path from 'node:path';
import { readdir, rm, statfs, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { searchArchive } from './search/archive.js';
import { searchTorznab, torznabEnabled } from './search/torznab.js';
import { searchProwlarr, prowlarrEnabled } from './search/prowlarr.js';
import { rankResults } from './search/rank.js';
import { suggestTitles } from './suggest.js';
import { initAuth, authRoutes, requireLogin, signStreamPath, authStatus } from './auth.js';
import {
  SUBTITLE_EXTS, onlineSubtitlesEnabled, parseReleaseName, movieHash,
  searchOpenSubtitles, downloadOpenSubtitle, readTorrentSubtitle, toVtt,
  releaseSimilarity, languageFromName, sameEpisode,
} from './subtitles.js';

const PORT = Number(process.env.PORT || 8080);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.resolve('downloads');
const TORRENT_PORT = Number(process.env.TORRENT_PORT || 6881);
const DHT_PORT = Number(process.env.DHT_PORT || TORRENT_PORT + 1);
const KEEP_DOWNLOADS = process.env.KEEP_DOWNLOADS === 'true';
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 30);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_TORRENTS || 3);
const METADATA_TIMEOUT_MS = 90_000;
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB || 2);

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
};
// Formats browsers can usually play directly, best first
const BROWSER_FRIENDLY = ['.mp4', '.m4v', '.webm', '.mkv'];

const client = new WebTorrent({ torrentPort: TORRENT_PORT, dhtPort: DHT_PORT });
client.on('error', (err) => console.error('[webtorrent]', err.message));

// infoHash -> { torrent, fileIndex, lastAccess, activeStreams }
const sessions = new Map();

const app = express();
// Behind a tunnel/reverse proxy on the local network: trust its X-Forwarded-* headers
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json());
// gzip pages/scripts/JSON (videos are skipped: they don't compress)
app.use(compression());
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Login first: everything below needs a session (or a signed stream link)
authRoutes(app, PUBLIC_DIR);
app.use(requireLogin);
// Images rarely change: let browsers keep them for a week
app.use('/img', express.static(path.join(PUBLIC_DIR, 'img'), { maxAge: '7d' }));
// Page, CSS and JS: cached, but re-checked each visit so updates show up right away
app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

// ---------- Search ----------
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], errors: [] });

  const providers = [searchArchive(q)];
  if (prowlarrEnabled()) providers.push(searchProwlarr(q));
  if (torznabEnabled()) providers.push(searchTorznab(q));

  const settled = await Promise.allSettled(providers);
  const raw = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  const errors = settled.filter((s) => s.status === 'rejected').map((s) => s.reason.message);
  const { type, results } = rankResults(filterByYear(raw, Number(req.query.year) || null));
  res.json({ type, results, errors });
});

// When the user picked "The Twilight Zone (1959)" from suggestions, drop releases
// that name a different year (the 2019 remake). Releases without a year stay.
function filterByYear(results, year) {
  if (!year) return results;
  return results.filter((r) => {
    const years = String(r.title).match(/\b(19[2-9]\d|20[0-4]\d)\b/g);
    return !years || years.some((y) => Math.abs(Number(y) - year) <= 1) || (r.year && Math.abs(r.year - year) <= 1);
  });
}

// Title suggestions while typing (most popular first)
app.get('/api/suggest', async (req, res) => {
  try {
    res.json(await suggestTitles(String(req.query.q || '')));
  } catch (err) {
    res.json([]); // suggestions are a nice-to-have; never break typing
  }
});

// ---------- Start playing ----------
app.post('/api/play', async (req, res) => {
  const source = String(req.body?.torrent || '').trim();
  if (!source) return res.status(400).json({ error: 'Missing "torrent" (magnet link or .torrent URL)' });

  try {
    const torrentId = await resolveTorrentId(source);
    const session = await addTorrent(torrentId);
    session.lastAccess = Date.now();
    touchViewer(session, req);
    res.json(describe(session));
  } catch (err) {
    console.error('[play]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Status ----------
app.get('/api/torrents', (_req, res) => {
  res.json([...sessions.values()].filter((s) => s.torrent.files[s.fileIndex]).map(describe));
});

app.get('/api/status/:infoHash', (req, res) => {
  const session = sessions.get(req.params.infoHash);
  if (!session || !session.torrent.files[session.fileIndex]) return res.status(404).json({ error: 'Not found' });
  session.lastAccess = Date.now();
  touchViewer(session, req);
  res.json(describe(session));
});

// ---------- Episodes ----------
// Switch to another episode of a season pack: stop downloading the old one
app.post('/api/select/:infoHash', (req, res) => {
  const session = sessions.get(req.params.infoHash);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const fileIndex = Number(req.body?.fileIndex);
  if (!session.episodes.some((e) => e.index === fileIndex)) return res.status(400).json({ error: 'Not an episode of this torrent' });

  if (fileIndex !== session.fileIndex) {
    const { torrent } = session;
    torrent.files[session.fileIndex].deselect();
    torrent.files[fileIndex].select();
    console.log(`[episode] ${torrent.name}: ${torrent.files[session.fileIndex].name} -> ${torrent.files[fileIndex].name}`);
    session.fileIndex = fileIndex;
    clearSubtitleCache(torrent.infoHash);
  }
  session.lastAccess = Date.now();
  touchViewer(session, req);
  res.json(describe(session));
});

// ---------- Viewers ----------
// Each browser tab sends an id. When a tab moves on (other show, closed player,
// closed page) the torrent stops, unless another tab is still watching it.
const VIEWER_TIMEOUT_MS = 30_000; // tabs check in every 2s while the player is open

function viewerId(req) {
  return String(req.get('X-Viewer') || req.query.viewer || '').slice(0, 64);
}

function touchViewer(session, req) {
  const id = viewerId(req);
  if (id) session.viewers.set(id, Date.now());
}

function hasOtherViewers(session) {
  const cutoff = Date.now() - VIEWER_TIMEOUT_MS;
  for (const [id, seen] of session.viewers) if (seen < cutoff) session.viewers.delete(id);
  return session.viewers.size > 0;
}

// Called by the page via fetch or navigator.sendBeacon (which can't set headers)
app.post('/api/release/:infoHash', (req, res) => {
  const session = sessions.get(req.params.infoHash);
  if (!session) return res.json({ ok: true });
  session.viewers.delete(viewerId(req));
  // Give the browser a moment to close its video connection first
  setTimeout(() => {
    if (sessions.get(session.torrent.infoHash) !== session) return;
    if (hasOtherViewers(session) || session.activeStreams > 0) {
      console.log(`[release] ${session.torrent.name}: still watched elsewhere, keeping it`);
      return;
    }
    removeSession(session, !KEEP_DOWNLOADS);
  }, 3000);
  res.json({ ok: true });
});

app.delete('/api/torrents/:infoHash', async (req, res) => {
  const session = sessions.get(req.params.infoHash);
  if (!session) return res.status(404).json({ error: 'Not found' });
  await removeSession(session, !KEEP_DOWNLOADS);
  res.json({ ok: true });
});

// ---------- Video stream (HTTP Range so the player can seek) ----------
app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const session = sessions.get(req.params.infoHash);
  const file = session?.torrent.files[Number(req.params.fileIndex)];
  if (!file) return res.status(404).send('Not found');

  const total = file.length;
  let start = 0;
  let end = total - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');

  if (range) {
    if (range[1] === '') {
      start = Math.max(0, total - Number(range[2])); // suffix range: last N bytes
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), total - 1);
    }
    if (start > end || start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Content-Type', VIDEO_TYPES[path.extname(file.name).toLowerCase()] || 'application/octet-stream');
  if (req.method === 'HEAD') return res.end();

  session.activeStreams++;
  session.lastAccess = Date.now();
  // webtorrent prioritises the pieces this stream needs, so playback starts
  // as soon as the first megabytes arrive.
  const stream = file.createReadStream({ start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => {
    session.activeStreams--;
    session.lastAccess = Date.now();
    stream.destroy();
  });
  stream.pipe(res);
});

// ---------- Subtitles ----------
// Converted WebVTT cached in memory: "infoHash:id:lang" -> text
const subtitleCache = new Map();

function clearSubtitleCache(infoHash) {
  for (const key of subtitleCache.keys()) if (key.startsWith(infoHash)) subtitleCache.delete(key);
}

app.get('/api/subtitles/:infoHash', async (req, res) => {
  const session = sessions.get(req.params.infoHash);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const lang = String(req.query.lang || 'en').toLowerCase();
  const video = session.torrent.files[session.fileIndex];

  // File names are sometimes just "Movie.mp4"; the torrent name often says more
  const release = [parseReleaseName(video.name), parseReleaseName(session.torrent.name)]
    .sort((a, b) => Boolean(b.episode) - Boolean(a.episode) || b.query.length - a.query.length)[0];
  const videoBase = path.basename(video.name, path.extname(video.name)).toLowerCase();

  // Subtitles shipped inside the torrent: only this episode's, in a matching or unknown language
  const local = session.torrent.files
    .map((f, i) => ({ id: `t${i}`, name: f.name, lang: languageFromName(f.name) }))
    .filter((s) => SUBTITLE_EXTS.includes(path.extname(s.name).toLowerCase()))
    .filter((s) => sameEpisode(s.name, release) && (!s.lang || s.lang === lang))
    .map((s) => ({
      ...s,
      sameName: path.basename(s.name).toLowerCase().startsWith(videoBase),
      similarity: releaseSimilarity(video.name, s.name),
    }))
    .sort((a, b) => b.sameName - a.sameName || Boolean(b.lang) - Boolean(a.lang) || b.similarity - a.similarity);

  let online = [];
  let error = null;
  if (onlineSubtitlesEnabled()) {
    try {
      const hash = await movieHash(video).catch(() => null);
      online = await searchOpenSubtitles({ ...release, hash, languages: lang });
      // Hash matches are rare for new releases; fall back to a name search
      if (!online.length && hash) online = await searchOpenSubtitles({ ...release, languages: lang });
      online = online
        .map((s) => ({ ...s, similarity: releaseSimilarity(video.name, s.name) }))
        .sort((a, b) => b.hashMatch - a.hashMatch || b.similarity - a.similarity || b.downloads - a.downloads);
    } catch (err) {
      error = err.message;
    }
  }

  // Auto-pick: exact file match > torrent sub in this language > closest online
  // release > torrent sub of unknown language (usually English)
  const best =
    online.find((s) => s.hashMatch) ||
    local.find((s) => s.lang === lang) ||
    online[0] ||
    (lang === 'en' ? local[0] : null) ||
    null;

  res.json({ local, online, best: best?.id || null, query: release, onlineEnabled: onlineSubtitlesEnabled(), error });
});

app.get('/subtitles/:infoHash/:id.vtt', async (req, res) => {
  const { infoHash, id } = req.params;
  const lang = String(req.query.lang || '').toLowerCase();
  const key = `${infoHash}:${id}:${lang}`;

  try {
    if (!subtitleCache.has(key)) {
      let raw;
      if (id.startsWith('t')) {
        const file = sessions.get(infoHash)?.torrent.files[Number(id.slice(1))];
        if (!file || !SUBTITLE_EXTS.includes(path.extname(file.name).toLowerCase())) return res.status(404).send('Not found');
        raw = await readTorrentSubtitle(file);
      } else if (id.startsWith('o') && onlineSubtitlesEnabled()) {
        raw = await downloadOpenSubtitle(id.slice(1));
      } else {
        return res.status(404).send('Not found');
      }
      subtitleCache.set(key, toVtt(raw, lang));
    }
    res.type('text/vtt; charset=utf-8').send(subtitleCache.get(key));
  } catch (err) {
    console.error('[subtitles]', err.message);
    res.status(502).type('text/plain').send(err.message);
  }
});

// ---------- Helpers ----------

// Indexers often hand out an http link that redirects to a magnet, so follow
// it ourselves and pass webtorrent either a magnet or the raw .torrent bytes.
async function resolveTorrentId(source) {
  if (source.startsWith('magnet:') || /^[a-f0-9]{40}$/i.test(source)) return source;
  if (!/^https?:\/\//i.test(source)) throw new Error('Expected a magnet link or a http(s) .torrent URL');

  let url = source;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (location.startsWith('magnet:')) return location;
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Could not download .torrent: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Too many redirects while fetching .torrent');
}

// Adds still waiting for peers, so pressing Watch twice doesn't start a second one
const pendingAdds = new Map();

async function addTorrent(torrentId) {
  // Work out the infoHash ourselves: webtorrent only knows it after an async parse
  const { infoHash } = await parseTorrent(torrentId).catch(() => {
    throw new Error('Not a valid magnet link or .torrent file');
  });
  // No await between these checks and pendingAdds.set, so concurrent clicks can't race
  if (sessions.has(infoHash)) return sessions.get(infoHash);
  if (pendingAdds.has(infoHash)) return pendingAdds.get(infoHash);

  const pending = connect(torrentId, infoHash);
  pendingAdds.set(infoHash, pending);
  try {
    return await pending;
  } finally {
    pendingAdds.delete(infoHash);
  }
}

async function connect(torrentId, infoHash) {
  const freeGb = await freeSpaceGb();
  if (freeGb < MIN_FREE_GB) {
    throw new Error(`The server's disk is full (${freeGb.toFixed(1)} GB free, needs ${MIN_FREE_GB} GB). Free up space and try again.`);
  }

  // Left over from a failed attempt: start clean
  const leftover = await client.get(infoHash);
  if (leftover) await new Promise((resolve) => leftover.destroy({ destroyStore: !KEEP_DOWNLOADS }, () => resolve()));

  while (sessions.size >= MAX_ACTIVE) {
    const oldest = [...sessions.values()]
      .filter((s) => s.activeStreams === 0)
      .sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (!oldest) throw new Error(`Server busy: ${MAX_ACTIVE} movies are being watched right now`);
    await removeSession(oldest, !KEEP_DOWNLOADS);
  }

  const torrent = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      t.destroy({ destroyStore: true });
      reject(new Error('Nobody is sharing this torrent right now (no peers found in 90 seconds). Try a result with more seeders.'));
    }, METADATA_TIMEOUT_MS);
    const t = client.add(torrentId, { path: DOWNLOAD_DIR, deselect: true }, (ready) => {
      clearTimeout(timer);
      resolve(ready);
    });
    t.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return startSession(torrent);
}

function startSession(torrent) {
  const episodes = listEpisodes(torrent.files);
  const fileIndex = episodes.length ? episodes[0].index : pickVideoFile(torrent.files);
  if (fileIndex === -1) {
    torrent.destroy({ destroyStore: true });
    throw new Error('No video file found in this torrent');
  }
  // Only download the movie itself, not samples/extras/subtitles
  torrent.files.forEach((f, i) => (i === fileIndex ? f.select() : f.deselect()));

  // viewers: browser tab id -> last time it checked in
  const session = { torrent, fileIndex, episodes, viewers: new Map(), lastAccess: Date.now(), activeStreams: 0 };
  sessions.set(torrent.infoHash, session);
  // If the torrent dies on its own (error, destroyed), forget it
  torrent.once('close', () => sessions.delete(torrent.infoHash));
  torrent.on('error', (err) => {
    console.error('[torrent]', torrent.name, err.message);
    removeSession(session, !KEEP_DOWNLOADS);
  });
  console.log(`[add] ${torrent.name} -> ${torrent.files[fileIndex].name}`);
  return session;
}

// Season packs: every episode file (SxxEyy), in order. Empty for single movies.
const EPISODE_RE = /S(\d{1,2})\s?E(\d{1,3})/i;
const MIN_EPISODE_BYTES = 30 * 1024 * 1024; // smaller files are samples/extras

function listEpisodes(files) {
  const byEpisode = new Map();
  files.forEach((f, index) => {
    const ext = path.extname(f.name).toLowerCase();
    const base = path.basename(f.name, ext);
    const m = EPISODE_RE.exec(base);
    if (!m || !VIDEO_TYPES[ext] || f.length < MIN_EPISODE_BYTES || /\bsample\b/i.test(base)) return;
    const ep = { index, season: Number(m[1]), episode: Number(m[2]), size: f.length, ext, title: episodeTitle(base, m) };
    // Same episode twice (e.g. mkv + mp4): keep the browser-friendly / bigger one
    const key = `${ep.season}x${ep.episode}`;
    const prev = byEpisode.get(key);
    if (!prev || formatRank(ep.ext) < formatRank(prev.ext) || (formatRank(ep.ext) === formatRank(prev.ext) && ep.size > prev.size)) {
      byEpisode.set(key, ep);
    }
  });
  if (byEpisode.size < 2) return [];
  return [...byEpisode.values()]
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .map(({ index, season, episode, size, title }) => ({
      index,
      size,
      label: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}${title ? ` · ${title}` : ''}`,
    }));
}

// "Friends S05E08 The One With All The Thanksgivings (1080p x265...)" -> "The One With All The Thanksgivings"
function episodeTitle(base, match) {
  return base
    .slice(match.index + match[0].length)
    .replace(/[._]+/g, ' ')
    .split(/[([]|\b(2160p|1080p|720p|480p|web|webrip|web-dl|bluray|hdtv|x264|x265|h 264|h 265|hevc)\b/i)[0]
    .replace(/\bia\s*$/i, '') // archive.org ".ia.mp4" copies
    .replace(/^[\s-]+|[\s-]+$/g, '')
    .trim();
}

function formatRank(ext) {
  const r = BROWSER_FRIENDLY.indexOf(ext);
  return r === -1 ? BROWSER_FRIENDLY.length : r;
}

// Prefer browser-playable formats; within a format pick the biggest file
// (skips samples and, on archive.org, the low-res derivative copies).
function pickVideoFile(files) {
  const candidates = files
    .map((f, i) => ({ i, ext: path.extname(f.name).toLowerCase(), length: f.length, name: f.name.toLowerCase() }))
    .filter((f) => VIDEO_TYPES[f.ext] && !/\bsample\b/.test(f.name));
  if (!candidates.length) return -1;

  candidates.sort((a, b) => formatRank(a.ext) - formatRank(b.ext) || b.length - a.length);
  return candidates[0].i;
}

function describe({ torrent, fileIndex, episodes, activeStreams }) {
  const file = torrent.files[fileIndex];
  const ext = path.extname(file.name).toLowerCase();
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    fileName: file.name,
    fileSize: file.length,
    browserPlayable: ['.mp4', '.m4v', '.webm'].includes(ext),
    // Signed so it also works in VLC / TVs that have no login cookie
    streamUrl: signStreamPath(`/stream/${torrent.infoHash}/${fileIndex}`),
    progress: file.progress,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    peers: torrent.numPeers,
    done: file.progress >= 1,
    watching: activeStreams,
    fileIndex,
    episodes,
  };
}

function removeSession(session, deleteFiles) {
  sessions.delete(session.torrent.infoHash);
  clearSubtitleCache(session.torrent.infoHash);
  console.log(`[remove] ${session.torrent.name}${deleteFiles ? ' (files deleted)' : ''}`);
  if (session.torrent.destroyed) return Promise.resolve();
  const { name } = session.torrent;
  return new Promise((resolve) => session.torrent.destroy({ destroyStore: deleteFiles }, () => resolve()))
    .then(async () => {
      // destroyStore deletes the files but leaves the torrent's (now empty) folder
      const dir = path.resolve(DOWNLOAD_DIR, name || '');
      if (deleteFiles && name && path.dirname(dir) === path.resolve(DOWNLOAD_DIR)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
}

async function freeSpaceGb() {
  const { bavail, bsize } = await statfs(DOWNLOAD_DIR);
  return (bavail * bsize) / 1024 ** 3;
}

// Active torrents only live in memory, so after a restart anything in the download
// folder is an orphan from the previous run. Clear it unless downloads are kept.
async function cleanOrphanedDownloads() {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  if (KEEP_DOWNLOADS) return;
  const entries = await readdir(DOWNLOAD_DIR);
  await Promise.all(entries.map((e) => rm(path.join(DOWNLOAD_DIR, e), { recursive: true, force: true })));
  if (entries.length) console.log(`[cleanup] removed ${entries.length} leftover download(s) from the previous run`);
}

// Stop torrents nobody has watched for a while
setInterval(() => {
  const cutoff = Date.now() - IDLE_MINUTES * 60_000;
  for (const session of sessions.values()) {
    if (session.activeStreams === 0 && session.lastAccess < cutoff) removeSession(session, !KEEP_DOWNLOADS);
  }
}, 60_000).unref();

await initAuth();
await cleanOrphanedDownloads().catch((err) => console.error('[cleanup]', err.message));

const server = app.listen(PORT, () => {
  console.log(`Pofak Stream on http://0.0.0.0:${PORT}  (downloads: ${DOWNLOAD_DIR}, torrent port: ${TORRENT_PORT})`);
  freeSpaceGb().then((gb) => console.log(`Free disk space: ${gb.toFixed(1)} GB`)).catch(() => {});
  console.log(`Online subtitles: ${onlineSubtitlesEnabled() ? 'OpenSubtitles' : 'off (set OPENSUBTITLES_API_KEY)'}`);
  console.log(`Accounts: ${authStatus()}`);
  console.log(`Search sources: Internet Archive${prowlarrEnabled() ? ', Prowlarr' : ''}${torznabEnabled() ? ', Torznab' : ''}`);
});

function shutdown() {
  console.log('Shutting down...');
  server.close();
  client.destroy(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

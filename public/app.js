const $ = (id) => document.getElementById(id);

// Session expired or logged out elsewhere: back to the login page
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);
  if (res.status === 401) location.replace('/login');
  return res;
};

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  if (current) closePlayer();
  await rawFetch('/api/logout', { method: 'POST' });
  location.replace('/login');
});
let statusTimer = null;
let current = null;

// Identifies this browser tab, so the server knows when nobody watches a torrent anymore
const viewer = sessionStorage.getItem('viewer') || Math.random().toString(36).slice(2) + Date.now().toString(36);
sessionStorage.setItem('viewer', viewer);
const api = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, 'X-Viewer': viewer } });

// Tell the server this tab stopped watching (works even while the page is closing)
function release(infoHash) {
  navigator.sendBeacon(`/api/release/${infoHash}?viewer=${viewer}`);
}
window.addEventListener('pagehide', () => { if (current) release(current.infoHash); });

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  // A new search means the viewer moved on: stop the video and show the list
  if (current) closePlayer();
  window.scrollTo({ top: 0 });
  setMessage('Searching…');
  $('results').innerHTML = '';
  try {
    // A picked suggestion carries its year, which tells remakes apart
    const year = picked && picked.title === q && picked.year ? `&year=${picked.year}` : '';
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${year}`);
    const { results, type, errors } = await res.json();
    setMessage([results.length ? '' : 'No results.', ...errors].filter(Boolean).join(' · '));
    renderResults(results, type);
  } catch (err) {
    setMessage('Search failed: ' + err.message);
  }
});

$('magnet-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('magnet').value.trim();
  if (value) play(value, e.submitter);
});

$('close-player').addEventListener('click', closePlayer);
$('copy-url').addEventListener('click', () => navigator.clipboard?.writeText($('vlc-url').textContent));

// Text-only list. Series are grouped by season (complete series, S1, S2...),
// each group already sorted by the server with the most seeders first.
function renderResults(results, type) {
  const container = $('results');
  let group = null;
  for (const r of results) {
    const heading = type === 'series' ? seasonHeading(r) : null;
    if (heading && heading !== group) {
      group = heading;
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = heading;
      container.appendChild(h);
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="info"><div class="name"></div><div class="meta"></div></div><button>▶ Watch</button>';
    const name = row.querySelector('.name');
    const badge = releaseBadge(r);
    if (badge) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = badge;
      name.appendChild(b);
    }
    name.append(r.title + (r.year && !String(r.title).includes(r.year) ? ` (${r.year})` : ''));
    row.querySelector('.meta').textContent = [
      r.quality,
      r.size && formatBytes(r.size),
      r.seeders != null && `${r.seeders} seeders`,
      r.seeders == null && r.popularity && `${r.popularity.toLocaleString()} views`,
      r.source,
    ].filter(Boolean).join(' · ');
    row.querySelector('button').addEventListener('click', (e) => play(r.torrent, e.currentTarget));
    container.appendChild(row);
  }
  updateLayout();
}

function seasonHeading(r) {
  if (r.kind === 'complete') return 'Complete series';
  if (r.kind === 'movie') return 'Other';
  return `Season ${r.season}`;
}

function releaseBadge(r) {
  const pad = (n) => String(n).padStart(2, '0');
  if (r.kind === 'episode') return `S${pad(r.season)}E${pad(r.episode)}`;
  if (r.kind === 'pack') return r.seasonEnd ? `Seasons ${r.season}-${r.seasonEnd}` : `Season ${r.season}`;
  if (r.kind === 'complete') return 'Complete';
  return null;
}

async function play(torrent, button) {
  if (current && current.source !== torrent) closePlayer();
  if (button) button.disabled = true;
  const started = Date.now();
  const tick = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    setMessage(`Finding people who share this video (peers)… ${secs}s` +
      (secs >= 20 ? ' · Few people are sharing it. Results with more seeders start faster.' : ''));
  };
  tick();
  const ticker = setInterval(tick, 1000);
  try {
    const res = await api('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setMessage('');
    openPlayer({ ...data, source: torrent });
  } catch (err) {
    setMessage('Could not start: ' + err.message);
  } finally {
    clearInterval(ticker);
    if (button) button.disabled = false;
  }
}

function openPlayer(info) {
  // History entry so the Back button returns to the list (not when switching episodes)
  if ($('player').hidden) history.pushState({ player: true }, '');
  current = info;
  clearSubtitles();
  $('sub-list').innerHTML = '';
  setSubMessage('');
  $('player').hidden = false;
  $('now-title').textContent = info.fileName;
  const fullUrl = new URL(info.streamUrl, location.href).toString();
  $('vlc-url').textContent = fullUrl;
  $('warn').hidden = info.browserPlayable;
  $('video').src = info.streamUrl;
  $('video').onerror = () => { $('warn').hidden = false; };
  renderEpisodes(info);
  updateLayout();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  clearInterval(statusTimer);
  updateStatus();
  statusTimer = setInterval(updateStatus, 2000);
  if ($('sub-auto').checked) findSubtitles({ auto: true });
}

async function updateStatus() {
  if (!current) return;
  try {
    const s = await (await api(`/api/status/${current.infoHash}`)).json();
    if (s.error) return;
    $('stats').textContent =
      `${(s.progress * 100).toFixed(1)}% of ${formatBytes(s.fileSize)} · ↓ ${formatBytes(s.downloadSpeed)}/s · ${s.peers} peers` +
      (s.done ? ' · fully downloaded' : '');
    $('bar-fill').style.width = `${s.progress * 100}%`;
  } catch { /* server restarting, try again next tick */ }
}

function closePlayer() {
  clearInterval(statusTimer);
  if (current) release(current.infoHash);
  current = null;
  clearSubtitles();
  const v = $('video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('player').hidden = true;
  updateLayout();
}

function setMessage(text) {
  $('message').textContent = text;
  updateLayout();
}

// Start page (big logo, centered search) until there's something to show
function updateLayout() {
  const empty = $('player').hidden && !$('results').children.length && !$('message').textContent;
  document.body.classList.toggle('home', empty);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ---------- Subtitles ----------
const subLang = $('sub-lang');
subLang.value = localStorage.getItem('subLang') || 'en';
subLang.addEventListener('change', () => {
  localStorage.setItem('subLang', subLang.value);
  if (current && $('sub-auto').checked) findSubtitles({ auto: true });
});

let subOffset = 0;
let subBlobUrl = null;

$('sub-search').addEventListener('click', () => findSubtitles());

const subAuto = $('sub-auto');
subAuto.checked = localStorage.getItem('subAuto') !== 'false';
subAuto.addEventListener('change', () => {
  localStorage.setItem('subAuto', subAuto.checked);
  if (subAuto.checked && current && !$('video').querySelector('track')) findSubtitles({ auto: true });
});
$('sub-off').addEventListener('click', clearSubtitles);
$('sub-earlier').addEventListener('click', () => shiftSubtitles(-0.5));
$('sub-later').addEventListener('click', () => shiftSubtitles(0.5));
$('sub-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const vtt = srtToVtt(decodeSubtitle(await file.arrayBuffer(), subLang.value));
  showSubtitle(vtt, file.name);
});

async function findSubtitles({ auto = false } = {}) {
  if (!current) return;
  const video = current;
  const button = $('sub-search');
  button.disabled = true;
  $('sub-list').innerHTML = '';
  setSubMessage(auto ? 'Finding the best subtitle for this video…' : 'Searching… (matching your exact video file first)');
  try {
    const res = await fetch(`/api/subtitles/${video.infoHash}?lang=${encodeURIComponent(subLang.value)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (current !== video) return; // user switched video meanwhile

    const notes = [];
    if (!data.onlineEnabled) notes.push('Online search is off. Add OPENSUBTITLES_API_KEY to docker-compose.yml.');
    if (data.error) notes.push(data.error);
    if (!data.local.length && !data.online.length) {
      const q = data.query;
      const what = q ? `"${q.query}"${q.episode ? ` S${q.season}E${q.episode}` : ''}${q.year ? ` (${q.year})` : ''}` : 'this video';
      notes.unshift(`No ${subLang.selectedOptions[0].text} subtitles found for ${what}. Try another language or load a .srt file.`);
    }
    setSubMessage(notes.join(' '));

    const items = {};
    for (const s of data.local) items[s.id] = addSubItem(s, s.id === data.best ? 'best match' : 'in torrent', [s.lang, 'in torrent'].filter(Boolean).join(' · '));
    for (const s of data.online) {
      const meta = [s.lang, `${s.downloads.toLocaleString()} downloads`, s.hearingImpaired && 'HI'].filter(Boolean).join(' · ');
      items[s.id] = addSubItem(s, s.hashMatch ? 'exact match' : s.id === data.best ? 'best match' : null, meta);
    }

    if (auto && data.best && items[data.best]) await loadSub(items[data.best].sub, items[data.best].li, true);
  } catch (err) {
    setSubMessage('Subtitle search failed: ' + err.message);
  } finally {
    button.disabled = false;
  }
}

function addSubItem(sub, tag, meta) {
  const li = document.createElement('li');
  li.textContent = sub.name;
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    li.appendChild(t);
  }
  if (meta) {
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = meta;
    li.appendChild(m);
  }
  li.addEventListener('click', () => loadSub(sub, li));
  $('sub-list').appendChild(li);
  return { sub, li };
}

async function loadSub(sub, li, auto = false) {
  const video = current;
  setSubMessage(auto ? `Loading best match: ${sub.name}…` : 'Loading subtitle…');
  try {
    const res = await fetch(`/subtitles/${video.infoHash}/${sub.id}.vtt?lang=${encodeURIComponent(sub.lang || subLang.value)}`);
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    if (current !== video) return;
    showSubtitle(text, sub.name);
    document.querySelectorAll('#sub-list li').forEach((el) => el.classList.toggle('active', el === li));
    setSubMessage(auto ? 'Subtitle loaded automatically. Pick another below if it is out of sync.' : '');
  } catch (err) {
    setSubMessage((auto ? 'Could not auto-load subtitle: ' : 'Could not load subtitle: ') + err.message);
  }
}

function showSubtitle(vtt, label) {
  clearSubtitles();
  subBlobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = label;
  track.srclang = subLang.value;
  track.src = subBlobUrl;
  track.default = true;
  $('video').appendChild(track);
  track.track.mode = 'showing';
  $('sub-current').textContent = '· ' + label;
}

function clearSubtitles() {
  $('video').querySelectorAll('track').forEach((t) => t.remove());
  if (subBlobUrl) URL.revokeObjectURL(subBlobUrl);
  subBlobUrl = null;
  subOffset = 0;
  $('sub-offset').textContent = '0.0s';
  $('sub-current').textContent = '';
  document.querySelectorAll('#sub-list li.active').forEach((el) => el.classList.remove('active'));
}

function shiftSubtitles(delta) {
  const track = [...$('video').textTracks].find((t) => t.mode === 'showing');
  if (!track?.cues) return;
  for (const cue of track.cues) {
    cue.startTime = Math.max(0, cue.startTime + delta);
    cue.endTime = Math.max(0, cue.endTime + delta);
  }
  subOffset += delta;
  $('sub-offset').textContent = `${subOffset > 0 ? '+' : ''}${subOffset.toFixed(1)}s`;
}

function setSubMessage(text) { $('sub-message').textContent = text; }

// Same conversion as the server, for files loaded from this device
const LEGACY_ENCODINGS = {
  fa: 'windows-1256', ar: 'windows-1256', ru: 'windows-1251', uk: 'windows-1251',
  el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255',
};
function decodeSubtitle(buf, lang) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder(LEGACY_ENCODINGS[lang.slice(0, 2)] || 'windows-1252').decode(buf);
  }
}
function srtToVtt(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('WEBVTT')) return text + '\n';
  return 'WEBVTT\n\n' + text.replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`).replace(/\{\[^}]*\}/g, '') + '\n';
}

// ---------- Episodes (season packs) ----------
$('episode-select').addEventListener('change', (e) => switchEpisode(Number(e.target.value)));
$('next-ep').addEventListener('click', () => nextEpisode());
$('video').addEventListener('ended', () => nextEpisode());

function renderEpisodes(info) {
  const eps = info.episodes || [];
  $('episodes').hidden = eps.length < 2;
  const select = $('episode-select');
  select.innerHTML = '';
  for (const ep of eps) {
    const opt = document.createElement('option');
    opt.value = ep.index;
    opt.textContent = `${ep.label}  (${formatBytes(ep.size)})`;
    select.appendChild(opt);
  }
  select.value = info.fileIndex;
  const pos = eps.findIndex((e) => e.index === info.fileIndex);
  $('next-ep').disabled = pos === -1 || pos === eps.length - 1;
}

function nextEpisode() {
  const eps = current?.episodes || [];
  const pos = eps.findIndex((e) => e.index === current.fileIndex);
  if (pos !== -1 && pos < eps.length - 1) switchEpisode(eps[pos + 1].index);
}

async function switchEpisode(fileIndex) {
  if (!current || fileIndex === current.fileIndex) return;
  const { source, infoHash } = current;
  setMessage('Switching episode…');
  try {
    const res = await api(`/api/select/${infoHash}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIndex }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setMessage('');
    openPlayer({ ...data, source });
    $('video').play().catch(() => {});
  } catch (err) {
    setMessage('Could not switch episode: ' + err.message);
    $('episode-select').value = current.fileIndex;
  }
}

// ---------- Suggestions while typing ----------
let suggestTimer = null;
let picked = null; // last suggestion the user chose: { title, year }
let suggestFor = '';
let activeSuggestion = -1;

$('q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (q.length < 2) return hideSuggestions();
  suggestTimer = setTimeout(() => loadSuggestions(q), 200);
});

$('q').addEventListener('keydown', (e) => {
  const items = [...$('suggestions').children];
  if ($('suggestions').hidden || !items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
  } else if (e.key === 'Enter' && activeSuggestion >= 0) {
    e.preventDefault();
    items[activeSuggestion].dispatchEvent(new Event('pick'));
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

$('q').addEventListener('blur', () => setTimeout(hideSuggestions, 150));
$('search-form').addEventListener('submit', hideSuggestions);

async function loadSuggestions(q) {
  suggestFor = q;
  try {
    const list = await (await fetch(`/api/suggest?q=${encodeURIComponent(q)}`)).json();
    if (q !== suggestFor || $('q').value.trim() !== q) return; // user kept typing
    renderSuggestions(list);
  } catch {
    hideSuggestions();
  }
}

function renderSuggestions(list) {
  const ul = $('suggestions');
  ul.innerHTML = '';
  activeSuggestion = -1;
  for (const s of list) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="s-title"></div><div class="s-meta"></div>';
    li.querySelector('.s-title').textContent = `${s.title}${s.years || s.year ? ` (${s.years || s.year})` : ''}`;
    li.querySelector('.s-meta').textContent = [s.type, s.cast].filter(Boolean).join(' · ');
    const pick = () => {
      $('q').value = s.title;
      picked = { title: s.title, year: s.year };
      hideSuggestions();
      $('search-form').requestSubmit();
    };
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(); });
    li.addEventListener('pick', pick);
    ul.appendChild(li);
  }
  ul.hidden = list.length === 0;
}

function hideSuggestions() {
  clearTimeout(suggestTimer);
  suggestFor = '';
  $('suggestions').hidden = true;
  activeSuggestion = -1;
}

// ---------- Navigation ----------
// Logo: back to the start page
$('home').addEventListener('click', (e) => {
  e.preventDefault();
  goHome();
});

// Back button while watching: close the player, keep the results
window.addEventListener('popstate', () => {
  if (current) closePlayer();
});

function goHome() {
  if (current) closePlayer();
  hideSuggestions();
  picked = null;
  $('q').value = '';
  $('results').innerHTML = '';
  setMessage(''); // also switches back to the start page layout
  window.scrollTo({ top: 0 });
  $('q').focus();
}

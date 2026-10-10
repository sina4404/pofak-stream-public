// Subtitles: files inside the torrent + online search on OpenSubtitles.com.
// Everything is converted to WebVTT, the only format browsers understand.
import path from 'node:path';

const OS_API = 'https://api.opensubtitles.com/api/v1';
const OS_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const OS_USER = process.env.OPENSUBTITLES_USERNAME || '';
const OS_PASS = process.env.OPENSUBTITLES_PASSWORD || '';
const USER_AGENT = 'MintStream v1.0.0';

export const SUBTITLE_EXTS = ['.srt', '.vtt'];
const MAX_SUB_BYTES = 5 * 1024 * 1024;

export function onlineSubtitlesEnabled() {
  return Boolean(OS_KEY);
}

// ---------- Release name -> search terms ----------

// "The.Movie.2010.1080p.BluRay.x264" -> { query: "The Movie", year: 2010 }
// "Show.Name.S02E05.720p"            -> { query: "Show Name", season: 2, episode: 5 }
export function parseReleaseName(name) {
  let base = path.basename(name, path.extname(name)).replace(/[._]+/g, ' ');
  base = base.replace(/^\[[^\]]*\]\s*/, ''); // leading [Group] tag

  const ep = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(base);
  // Last year-like number, so "Blade Runner 2049 2017" keeps 2049 in the title
  const year = [...base.matchAll(/\b(19\d{2}|20\d{2})\b/g)].filter((m) => m.index > 0).pop();
  const tag = /\b(2160p|1080p|720p|480p|4k|\d{3,4}x\d{3,4}|bluray|brrip|dvd|bdrip|web[- ]?dl|webrip|hdtv|dvdrip|x264|x265|hevc|h ?264|h ?265)\b/i.exec(base);
  const animeEp = /\s-\s\d{1,4}\b/.exec(base); // "Show - 1180"
  const seasonWord = /\b(season|complete|series)\b/i.exec(base); // "Show Season 5"

  const cut = Math.min(...[ep, year, tag, animeEp, seasonWord].filter(Boolean).map((m) => m.index), base.length);
  const query = base.slice(0, cut).replace(/[\[\]()-]+/g, ' ').replace(/\s+/g, ' ').trim() || base.trim();
  return {
    query,
    year: year && (!ep || year.index < ep.index) ? Number(year[1]) : null,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
  };
}

// ---------- OpenSubtitles movie hash ----------

// size + sum of the 64-bit little-endian words in the first and last 64 KB.
// Identifies the exact video file, so subtitles are perfectly in sync.
export async function movieHash(file, timeoutMs = 15000) {
  const CHUNK = 65536;
  if (file.length < CHUNK * 2) return null;
  const read = (start) => readRange(file, start, start + CHUNK - 1, timeoutMs);
  const [head, tail] = await Promise.all([read(0), read(file.length - CHUNK)]);

  let hash = BigInt(file.length);
  for (const buf of [head, tail]) {
    for (let i = 0; i < CHUNK; i += 8) hash += buf.readBigUInt64LE(i);
  }
  return (hash & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

export function readRange(file, start, end, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = file.createReadStream({ start, end });
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error('Timed out downloading from torrent'));
    }, timeoutMs);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function readTorrentSubtitle(file) {
  if (file.length > MAX_SUB_BYTES) throw new Error('Subtitle file too large');
  return readRange(file, 0, file.length - 1);
}

// ---------- OpenSubtitles API ----------

let token = null;
let tokenExpires = 0;

// Logging in is optional but raises the daily download limit (5 -> 20).
async function authHeaders() {
  const headers = { 'Api-Key': OS_KEY, 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (OS_USER && OS_PASS) {
    if (!token || Date.now() > tokenExpires) {
      const res = await fetch(`${OS_API}/login`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: OS_USER, password: OS_PASS }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`OpenSubtitles login failed: HTTP ${res.status}`);
      token = (await res.json()).token;
      tokenExpires = Date.now() + 23 * 3600_000;
    }
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function searchOpenSubtitles({ query, year, season, episode, hash, languages }) {
  const params = { languages };
  if (hash) params.moviehash = hash;
  if (query) params.query = query.toLowerCase();
  if (year) params.year = String(year);
  if (season) params.season_number = String(season);
  if (episode) params.episode_number = String(episode);

  // The API wants parameters sorted, otherwise it answers with a redirect
  const qs = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  const res = await fetch(`${OS_API}/subtitles?${qs}`, { headers: await authHeaders(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenSubtitles search failed: HTTP ${res.status}`);
  const { data = [] } = await res.json();

  // OpenSubtitles pads name searches with loose matches ("Dawn of the Dead" for
  // "Night of the Living Dead"); keep only titles containing every query word.
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const relevant = ({ attributes: a }) => {
    if (a.moviehash_match || !words.length) return true;
    const title = `${a.feature_details?.title || ''} ${a.feature_details?.parent_title || ''} ${a.release || ''}`
      .toLowerCase().replace(/[._]+/g, ' ');
    return words.every((w) => title.includes(w));
  };

  return data
    .filter((d) => d.attributes?.files?.length && relevant(d))
    .map(({ attributes: a }) => ({
      id: `o${a.files[0].file_id}`,
      name: a.release || a.files[0].file_name || a.feature_details?.title || 'Subtitle',
      lang: a.language,
      downloads: a.download_count || 0,
      hashMatch: Boolean(a.moviehash_match),
      hearingImpaired: Boolean(a.hearing_impaired),
    }))
    .sort((x, y) => y.hashMatch - x.hashMatch || y.downloads - x.downloads);
}

export async function downloadOpenSubtitle(fileId) {
  const res = await fetch(`${OS_API}/download`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: Number(fileId), sub_format: 'srt' }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.link) {
    if (/token/i.test(body.message || '') && !OS_USER) {
      throw new Error('OpenSubtitles needs a login to download. Turn on "Allow anonymous" for your API consumer on opensubtitles.com, or set OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD in docker-compose.yml.');
    }
    throw new Error(body.message || `OpenSubtitles download failed: HTTP ${res.status}`);
  }
  const file = await fetch(body.link, { signal: AbortSignal.timeout(20000) });
  if (!file.ok) throw new Error(`Subtitle download failed: HTTP ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------- SRT -> WebVTT ----------

// Old subtitles are often not UTF-8; guess the legacy encoding from the language.
const LEGACY_ENCODINGS = {
  fa: 'windows-1256', ar: 'windows-1256', ur: 'windows-1256',
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251',
  el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255',
  pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250',
};

function decode(buf, lang) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder(LEGACY_ENCODINGS[(lang || '').slice(0, 2)] || 'windows-1252').decode(buf);
  }
}

export function toVtt(buf, lang) {
  let text = decode(buf, lang).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('WEBVTT')) return text + '\n';
  text = text
    // 0:01:02,345 / 00:01:02,95 -> 00:01:02.345 / 00:01:02.950 (WebVTT is strict)
    .replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
    .replace(/\{\\[^}]*\}/g, ''); // {\an8} style codes
  return `WEBVTT\n\n${text}\n`;
}

// ---------- Picking the best subtitle ----------

// Words that say nothing about which release a subtitle was made for
const NOISE = new Set(['the', 'a', 'an', 'of', 'and', 'mkv', 'mp4', 'avi', 'srt', 'vtt', 'sub', 'subs', 'subtitle', 'subtitles']);

function tokens(name) {
  return new Set(
    String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t)),
  );
}

// How many release words (group, source, codec, episode...) two names share.
// Subtitles made for the same release are almost always in sync.
export function releaseSimilarity(a, b) {
  const ta = tokens(a);
  let shared = 0;
  for (const t of tokens(b)) if (ta.has(t)) shared++;
  return shared;
}

const LANG_HINTS = {
  en: ['en', 'eng', 'english'],
  fa: ['fa', 'per', 'fas', 'persian', 'farsi'],
  ar: ['ar', 'ara', 'arabic'],
  tr: ['tr', 'tur', 'turkish'],
  es: ['es', 'spa', 'spanish', 'espanol'],
  fr: ['fr', 'fre', 'fra', 'french'],
  de: ['de', 'ger', 'deu', 'german'],
  it: ['it', 'ita', 'italian'],
  'pt-br': ['pt', 'por', 'pob', 'portuguese', 'brazilian'],
  ru: ['ru', 'rus', 'russian'],
  'zh-cn': ['zh', 'chi', 'zho', 'chs', 'chinese'],
  ja: ['ja', 'jpn', 'japanese'],
  ko: ['ko', 'kor', 'korean'],
  hi: ['hi', 'hin', 'hindi'],
  nl: ['nl', 'dut', 'nld', 'dutch'],
};

// Language written in a subtitle file name ("Movie.en.srt", "Movie.Persian.srt"), or null
export function languageFromName(name) {
  const t = tokens(path.basename(name, path.extname(name)));
  for (const [code, hints] of Object.entries(LANG_HINTS)) if (hints.some((h) => t.has(h))) return code;
  return null;
}

// Same SxxEyy as the video, or no episode tag at all
export function sameEpisode(subName, release) {
  if (!release.episode) return true;
  const m = /S(\d{1,2})\s?E(\d{1,3})/i.exec(subName);
  return !m || (Number(m[1]) === release.season && Number(m[2]) === release.episode);
}

// Optional: Prowlarr (runs next to MintStream in docker-compose).
// Searches every indexer you've added in Prowlarr's web UI.
// The API key is read from Prowlarr's own config.xml, so there's nothing to copy.
import { torrentQuery } from './query.js';
import { readFile } from 'node:fs/promises';

const PROWLARR_URL = (process.env.PROWLARR_URL || '').replace(/\/+$/, '');
const PROWLARR_CONFIG = process.env.PROWLARR_CONFIG || '/prowlarr-config/config.xml';

export function prowlarrEnabled() {
  return Boolean(PROWLARR_URL);
}

async function apiKey() {
  if (process.env.PROWLARR_APIKEY) return process.env.PROWLARR_APIKEY;
  const xml = await readFile(PROWLARR_CONFIG, 'utf8').catch(() => '');
  const key = /<ApiKey>([^<]+)<\/ApiKey>/.exec(xml)?.[1];
  if (!key) throw new Error('Prowlarr is not set up yet (no API key found)');
  return key;
}

export async function searchProwlarr(query) {
  const url = new URL(`${PROWLARR_URL}/api/v1/search`);
  url.searchParams.set('query', torrentQuery(query));
  // No category filter: indexers file anime/TV under their own categories
  url.searchParams.set('type', 'search');

  const res = await fetch(url, { headers: { 'X-Api-Key': await apiKey() }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Prowlarr search failed: HTTP ${res.status}`);
  const items = await res.json();

  return items
    .map((item) => ({
      source: item.indexer || 'Prowlarr',
      title: item.title,
      year: item.year || null,
      size: item.size || null,
      seeders: item.seeders ?? null,
      popularity: item.seeders || 0,
      poster: item.posterUrl || null,
      description: '',
      torrent: item.magnetUrl || item.downloadUrl,
    }))
    // Don't drop 0-seeder results: some indexers never report seeders
    .filter((r) => r.torrent)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

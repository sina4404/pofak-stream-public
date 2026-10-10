// Optional: any Torznab indexer you run yourself (Jackett, Prowlarr, ...).
// Enabled when TORZNAB_URL is set.
import { torrentQuery } from './query.js';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

export function torznabEnabled() {
  return Boolean(process.env.TORZNAB_URL);
}

export async function searchTorznab(query) {
  const base = process.env.TORZNAB_URL.replace(/\/+$/, '');
  const url = new URL(base.endsWith('/api') ? base : `${base}/api`);
  url.searchParams.set('t', 'search');
  url.searchParams.set('q', torrentQuery(query));
  url.searchParams.set('cat', '2000'); // Movies
  if (process.env.TORZNAB_APIKEY) url.searchParams.set('apikey', process.env.TORZNAB_APIKEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Torznab search failed: HTTP ${res.status}`);
  const xml = parser.parse(await res.text());

  let items = xml?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = [items];

  return items.map((item) => {
    const attrs = {};
    for (const a of [].concat(item['torznab:attr'] || [])) attrs[a.name] = a.value;
    return {
      source: item.jackettindexer?.['#text'] || item.prowlarrindexer?.['#text'] || 'Torznab',
      title: item.title,
      year: null,
      size: Number(item.size || attrs.size) || null,
      seeders: attrs.seeders != null ? Number(attrs.seeders) : null,
      popularity: Number(attrs.seeders) || 0,
      poster: attrs.coverurl || null,
      description: '',
      torrent: attrs.magneturl || item.enclosure?.url || item.link,
    };
  }).filter((r) => r.torrent);
}

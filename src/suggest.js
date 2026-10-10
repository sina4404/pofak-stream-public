// Title suggestions while typing, from IMDb's public suggestion service.
// Sorted by IMDb popularity, so the best-known titles come first.

const TYPES = {
  movie: 'Movie',
  tvSeries: 'TV series',
  tvMiniSeries: 'Mini-series',
  tvMovie: 'TV movie',
};
const cache = new Map(); // query -> { at, results }
const CACHE_MS = 60 * 60 * 1000;

export async function suggestTitles(query) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  if (q.length < 2) return [];
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Suggestions failed: HTTP ${res.status}`);
  const { d = [] } = await res.json();

  const results = d
    .filter((x) => TYPES[x.qid]) // drop people, games, etc.
    .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
    .slice(0, 8)
    .map((x) => ({
      title: x.l,
      year: x.y || null,
      years: x.yr || null, // "2008-2013" for series
      type: TYPES[x.qid],
      series: x.qid === 'tvSeries' || x.qid === 'tvMiniSeries',
      cast: x.s || '',
    }));

  if (cache.size > 500) cache.clear();
  cache.set(q, { at: Date.now(), results });
  return results;
}

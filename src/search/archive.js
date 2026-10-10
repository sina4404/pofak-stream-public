// Internet Archive: curated public-domain film, TV and cartoon collections.
// Every item has a .torrent with archive.org web seeds, so downloads start
// fast even with no peers.

const SEARCH_URL = 'https://archive.org/advancedsearch.php';

// Curated collections only. The huge community-upload collections are mostly
// random clips and taken-down uploads that break mid-stream.
const COLLECTIONS = [
  'feature_films',
  'classic_tv',
  'animationandcartoons',
  'SciFi_Horror',
  'Film_Noir',
  'silent_films',
  'short_films',
  'vintage_cartoons',
  'classic_cartoons',
  'prelinger',
];

export async function searchArchive(query) {
  // Match every word against the title so results are actually relevant
  const words = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).join(' AND ');
  const q = `title:(${words}) AND mediatype:(movies) AND collection:(${COLLECTIONS.join(' OR ')})`;
  const params = new URLSearchParams({ q, rows: '40', page: '1', output: 'json', 'sort[]': 'downloads desc' });
  for (const f of ['identifier', 'title', 'year', 'downloads', 'description']) params.append('fl[]', f);

  const res = await fetch(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`archive.org search failed: HTTP ${res.status}`);
  const data = await res.json();

  return (data.response?.docs || []).map((doc) => ({
    source: 'Internet Archive',
    title: doc.title,
    year: doc.year || null,
    size: null,
    seeders: null,
    popularity: doc.downloads || 0,
    poster: `https://archive.org/services/img/${doc.identifier}`,
    description: stripHtml(Array.isArray(doc.description) ? doc.description[0] : doc.description).slice(0, 300),
    torrent: `https://archive.org/download/${doc.identifier}/${doc.identifier}_archive.torrent`,
  }));
}

function stripHtml(s = '') {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

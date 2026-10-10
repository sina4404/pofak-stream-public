// Turn raw search results into an ordered list:
// - series: complete series first, then S1 (season pack, E1, E2...), S2, ...
// - movies: most popular first
// Seeded torrents come first, then Internet Archive, then 0-seeder torrents.

const EPISODE = /\bS(\d{1,2})\s?E(\d{1,3})\b/i;
const SEASON_RANGE = /\bS(\d{1,2})\s?-\s?S?(\d{1,2})\b/i; // S01-S05
const SEASON = /\b(?:S|Season\s?)(\d{1,2})\b/i;
const COMPLETE = /\b(complete\s+series|the\s+complete|complete)\b/i;
const QUALITY = /\b(2160p|4k|1080p|720p|576p|480p)\b/i;

export function describeRelease(title) {
  const t = String(title).replace(/[._]+/g, ' ');
  const quality = QUALITY.exec(t)?.[1]?.toLowerCase().replace('4k', '2160p') || null;
  let m = EPISODE.exec(t);
  if (m) return { kind: 'episode', season: Number(m[1]), episode: Number(m[2]), quality };
  m = SEASON_RANGE.exec(t);
  if (m) return { kind: 'pack', season: Number(m[1]), seasonEnd: Number(m[2]), quality };
  if (COMPLETE.test(t) && !SEASON.test(t)) return { kind: 'complete', season: 0, quality };
  m = SEASON.exec(t);
  if (m) return { kind: 'pack', season: Number(m[1]), quality };
  return { kind: 'movie', quality };
}

export function rankResults(results) {
  const items = results.map((r) => ({ ...r, ...describeRelease(r.title) }));
  const isSeries = items.filter((r) => r.kind !== 'movie').length >= Math.max(2, items.length * 0.3);

  const popularity = (r) => (r.seeders != null ? r.seeders : r.popularity || 0);
  // Seeded torrents first, then Internet Archive (always works), then 0-seeder torrents (likely dead)
  const fromTorrentSite = (r) => (r.seeders > 0 ? 0 : r.seeders == null ? 1 : 2);

  if (!isSeries) {
    return {
      type: 'movie',
      results: items.sort((a, b) => fromTorrentSite(a) - fromTorrentSite(b) || popularity(b) - popularity(a)),
    };
  }

  // complete series = 0, packs before single episodes of the same season, movies/specials last
  const seasonKey = (r) => (r.kind === 'movie' ? 999 : r.season);
  const episodeKey = (r) => (r.kind === 'episode' ? r.episode : 0);
  return {
    type: 'series',
    results: items.sort((a, b) =>
      seasonKey(a) - seasonKey(b) ||
      episodeKey(a) - episodeKey(b) ||
      fromTorrentSite(a) - fromTorrentSite(b) ||
      popularity(b) - popularity(a)),
  };
}

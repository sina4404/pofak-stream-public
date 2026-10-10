// Torrent sites match release names like "The.Office.US.S01", and some return
// nothing for "The Office" or "Spider-Man: No Way Home". Search with the bare words.
export function torrentQuery(query) {
  return String(query)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/^\s*(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim() || query;
}

// Browser-local metadata only. No download grants and no station-wide likes.
export interface SavedTrack { id: string; title: string; artist: string; album: string; airedAt: string }
export const LIBRARY_EVENT = 'subwave:listener-library';
const BOOKMARKS = 'subwave-bookmarks-v1';
const MAX_BOOKMARKS = 500;

export function sameSavedTrack(a: SavedTrack, b: SavedTrack): boolean {
  return a.id === b.id && a.title === b.title && a.artist === b.artist;
}

function isSavedTrack(row: unknown): row is SavedTrack {
  if (!row || typeof row !== 'object') return false;
  const track = row as Partial<SavedTrack>;
  return typeof track.id === 'string' && !!track.id.trim()
    && typeof track.title === 'string' && !!track.title.trim()
    && typeof track.artist === 'string' && typeof track.album === 'string' && typeof track.airedAt === 'string';
}

export function savedTracks(): SavedTrack[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(BOOKMARKS) || '[]');
    return Array.isArray(rows) ? rows.filter(isSavedTrack).slice(0, MAX_BOOKMARKS) : [];
  } catch { return []; }
}

export function writeTracks(rows: SavedTrack[]): void {
  localStorage.setItem(BOOKMARKS, JSON.stringify(rows.slice(0, MAX_BOOKMARKS)));
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

export function readBookmarkExport(contents: string): unknown[] {
  const rows: unknown = JSON.parse(contents);
  if (!Array.isArray(rows)) throw new Error('Expected a bookmark list');
  return rows;
}

export function planBookmarkImport(current: SavedTrack[], imported: unknown[]) {
  const rows = [...current];
  const keyOf = (track: SavedTrack) => JSON.stringify([track.id, track.artist, track.title]);
  const seen = new Set(rows.map(keyOf));
  let duplicates = 0, invalid = 0, overflow = 0;
  for (const candidate of imported) {
    if (!isSavedTrack(candidate)) { invalid++; continue; }
    const key = keyOf(candidate);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    if (rows.length >= MAX_BOOKMARKS) { overflow++; continue; }
    const { id, title, artist, album, airedAt } = candidate;
    rows.push({ id, title, artist, album, airedAt });
  }
  return { rows, added: rows.length - current.length, duplicates, invalid, overflow };
}

function receiptKey(apiUrl: string): string {
  const issuer = new URL(apiUrl, window.location.origin).href.replace(/\/+$/, '');
  // The old global list has no issuer information and is never sent to any station.
  return `subwave-receipts-v2:${issuer}`;
}

export function receiptIds(apiUrl: string): string[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(receiptKey(apiUrl)) || '[]');
    return Array.isArray(rows) ? rows.filter((r): r is string => typeof r === 'string' && /^[\w-]{36}$/.test(r)).slice(0, 20) : [];
  } catch { return []; }
}

export function rememberReceipt(apiUrl: string, id: string): void {
  try {
    localStorage.setItem(receiptKey(apiUrl), JSON.stringify([id, ...receiptIds(apiUrl).filter(x => x !== id)].slice(0, 20)));
    window.dispatchEvent(new Event(LIBRARY_EVENT));
  } catch { /* The receipt remains available in the current request response. */ }
}

export function forgetReceipt(apiUrl: string, id: string): void {
  localStorage.setItem(receiptKey(apiUrl), JSON.stringify(receiptIds(apiUrl).filter(x => x !== id)));
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

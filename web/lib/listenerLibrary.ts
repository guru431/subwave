// Browser-local metadata only. No download grants and no station-wide likes.
export interface SavedTrack { id: string; title: string; artist: string; album: string; airedAt: string }
export const LIBRARY_EVENT = 'subwave:listener-library';
const BOOKMARKS = 'subwave-bookmarks-v1';
const RECEIPTS = 'subwave-receipts-v1';

export function savedTracks(): SavedTrack[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(BOOKMARKS) || '[]');
    return Array.isArray(rows) ? rows.filter((r): r is SavedTrack => r &&
      ['id', 'title', 'artist', 'album', 'airedAt'].every(k => typeof r[k] === 'string')).slice(0, 500) : [];
  } catch { return []; }
}

export function writeTracks(rows: SavedTrack[]): void {
  localStorage.setItem(BOOKMARKS, JSON.stringify(rows.slice(0, 500)));
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

export function receiptIds(): string[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(RECEIPTS) || '[]');
    return Array.isArray(rows) ? rows.filter((r): r is string => typeof r === 'string' && /^[\w-]{36}$/.test(r)).slice(0, 20) : [];
  } catch { return []; }
}

export function rememberReceipt(id: string): void {
  try {
    localStorage.setItem(RECEIPTS, JSON.stringify([id, ...receiptIds().filter(x => x !== id)].slice(0, 20)));
    window.dispatchEvent(new Event(LIBRARY_EVENT));
  } catch { /* The receipt remains available in the current request response. */ }
}

export function forgetReceipt(id: string): void {
  localStorage.setItem(RECEIPTS, JSON.stringify(receiptIds().filter(x => x !== id)));
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

// Folder genres — what a track WITHOUT a genre tag reads as its genre: the
// genres the operator assigned to its folder, or to the nearest assigned
// ancestor. show-filter.trackGenres falls back to it, so Genre and Any-tag
// block rules and genre shows all see it; a genre tag always wins.
//
// Persisted to <stateDir>/folder-genres.json, next to blocklist.json and for
// the same reason: NOT in library.db, so Library → Reset/Reconcile can't wipe
// it. Paths are ABSOLUTE — the real paths Navidrome reports to the station's
// player with Report Real Path on; a fake "Artist/Album/Track" path (the flag
// off) is never a path here.
//
// The path helpers are shared with the Folder block rule (blocklist-rules.ts)
// and the folder-tree route (routes/library.ts).
// Pinned by scripts/folder-genres.test.ts.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

export const FOLDER_GENRES_MAX = 200;       // folders in the table
export const FOLDER_GENRE_VALUES_MAX = 12;  // genres per folder — as block-rule values
export const FOLDER_GENRE_TEXT_MAX = 64;    // chars per genre — as block-rule values

export interface FolderGenresEntry {
  folder: string;
  genres: string[];
}

export interface FolderStat {
  path: string;
  total: number;     // tracks beneath, subfolders included
  untagged: number;  // of those, tracks without a genre tag
  genres: string[];  // genres assigned to exactly this folder
}

const FILE_PATH = `${config.stateDir}/folder-genres.json`;

let table = new Map<string, string[]>();

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ── Path helpers (pure) ─────────────────────────────────────────────────────

// An absolute path, or null — a fake relative path is no path at all.
export function absolutePath(p: unknown): string | null {
  return typeof p === 'string' && p.length > 1 && p.startsWith('/') ? p : null;
}

// A folder as stored: absolute, trailing slashes dropped, "/" itself refused.
// Deliberately NOT trimmed — a real folder name may end in a space.
export function normFolder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return absolutePath(raw.replace(/\/+$/, ''));
}

// The folder holding a path, or null at the top ("/a" has no folder row).
export function parentDir(p: string): string | null {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : null;
}

// Does `path` lie under `folder`? "/" boundary: .../Hits never covers .../Hits 2.
export function pathInFolder(folder: string, path: string | null | undefined): boolean {
  const p = absolutePath(path);
  return !!p && (p === folder || p.startsWith(`${folder}/`));
}

// The genres of a FILE path's own folder, or of its nearest assigned ancestor.
export function lookupFolderGenres(
  map: ReadonlyMap<string, string[]>,
  path: string | null | undefined,
): string[] {
  if (!map.size) return [];
  const p = absolutePath(path);
  if (!p) return [];
  for (let dir = parentDir(p); dir; dir = parentDir(dir)) {
    const genres = map.get(dir);
    if (genres?.length) return genres;
  }
  return [];
}

// ── Validation (pure) ───────────────────────────────────────────────────────

// PUT /library/folder-genres body → the table. Throws with a message naming the
// folder; an entry left with no genres means "unassigned" and is dropped.
export function validateFolderGenres(raw: unknown): Map<string, string[]> {
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  if (entries.length > FOLDER_GENRES_MAX) throw new Error(`at most ${FOLDER_GENRES_MAX} folders`);
  const out = new Map<string, string[]>();
  for (const entry of entries as Array<{ folder?: unknown; genres?: unknown } | null>) {
    const folder = normFolder(entry?.folder);
    if (!folder) throw new Error('entries[].folder must be an absolute folder path');
    if (!Array.isArray(entry?.genres)) throw new Error(`genres must be an array (${folder})`);
    const genres: string[] = [];
    const seen = new Set<string>();
    for (const g of entry.genres) {
      if (typeof g !== 'string') throw new Error(`genres must be strings (${folder})`);
      const name = g.trim();
      if (!name) continue;
      if (name.length > FOLDER_GENRE_TEXT_MAX) {
        throw new Error(`a genre is longer than ${FOLDER_GENRE_TEXT_MAX} chars (${folder})`);
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genres.push(name);
    }
    if (genres.length > FOLDER_GENRE_VALUES_MAX) {
      throw new Error(`at most ${FOLDER_GENRE_VALUES_MAX} genres per folder (${folder})`);
    }
    if (genres.length) out.set(folder, genres);
  }
  return out;
}

// ── Folder tree (pure) ──────────────────────────────────────────────────────

// Cumulative counts for the Blocked tab's tree: every folder holding a track
// and all its ancestors below "/", with how many tracks lie beneath and how
// many of those carry no genre tag. An assigned folder with no tracks any more
// (renamed, moved) is listed with zeros, so a stale entry stays visible and
// can be cleared. Rows without an absolute path are counted, not placed.
export function aggregateFolders(
  rows: Array<{ path: string | null; tagged: boolean }>,
  assigned: ReadonlyMap<string, string[]>,
): { folders: FolderStat[]; withoutPath: number } {
  const stats = new Map<string, FolderStat>();
  const statOf = (dir: string): FolderStat => {
    let s = stats.get(dir);
    if (!s) {
      s = { path: dir, total: 0, untagged: 0, genres: [...(assigned.get(dir) ?? [])] };
      stats.set(dir, s);
    }
    return s;
  };
  let withoutPath = 0;
  for (const row of rows) {
    const p = absolutePath(row.path);
    if (!p) {
      withoutPath += 1;
      continue;
    }
    for (let dir = parentDir(p); dir; dir = parentDir(dir)) {
      const s = statOf(dir);
      s.total += 1;
      if (!row.tagged) s.untagged += 1;
    }
  }
  for (const folder of assigned.keys()) {
    for (let dir: string | null = folder; dir; dir = parentDir(dir)) statOf(dir);
  }
  const folders = [...stats.values()].sort((a, b) => byString(a.path, b.path));
  return { folders, withoutPath };
}

// ── State ───────────────────────────────────────────────────────────────────

export function list(): FolderGenresEntry[] {
  return [...table]
    .map(([folder, genres]) => ({ folder, genres: [...genres] }))
    .sort((a, b) => byString(a.folder, b.folder));
}

export function assigned(): ReadonlyMap<string, string[]> {
  return table;
}

// In-memory swap with no persistence — for load()/save() and the tests.
export function setAll(next: ReadonlyMap<string, string[]>): void {
  table = new Map(next);
}

// The hot-path read behind show-filter.trackGenres: an empty table costs nothing.
export function genresForPath(path: string | null | undefined): string[] {
  return lookupFolderGenres(table, path);
}

// Never throws: a missing file is the normal first boot, a corrupt one starts
// empty (loudly) — the station keeps playing either way, as with blocklist.json.
export async function load(): Promise<void> {
  try {
    table = validateFolderGenres(JSON.parse(await readFile(FILE_PATH, 'utf8')));
    if (table.size) console.log(`[folder-genres] loaded ${table.size} folder(s)`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error('[folder-genres] load failed, starting empty:', err?.message);
    table = new Map();
  }
}

// Replace the whole table. Validates first and writes before swapping, so a
// refused body or a failed write leaves both the file and memory as they were.
export async function save(raw: unknown): Promise<FolderGenresEntry[]> {
  const next = validateFolderGenres(raw);
  const entries = [...next].map(([folder, genres]) => ({ folder, genres }));
  await writeFileAtomic(FILE_PATH, JSON.stringify({ entries }, null, 2));
  table = next;
  return list();
}

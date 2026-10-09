// Fork: a SHOW's genre against the genres the operator assigned to FOLDERS
// (music/folder-genres.ts), which show-filter.trackGenres reads for a track
// with no genre tag. Two halves, both needed:
//  - resolution: subsonic.resolveGenreName knows only the tags getGenres
//    reports, so a genre only a folder carries resolved to null and the show's
//    genre lock came off whole ("the genre filter is OFF");
//  - a source: Navidrome's genre endpoints (getRandomSongs, getSongsByGenre)
//    know only tags too, so even a held lock had nothing in-genre to draw from,
//    and the strict auto.m3u coast, which hard-drops off-genre tracks per
//    source, could be left empty.
// Listener requests and the agent's songsByGenre stay on resolveGenreName: they
// fetch from Navidrome, which can return nothing by a folder genre.
// Pinned by scripts/folder-genre-show.test.ts.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as blocklist from './blocklist.js';
import * as folderGenres from './folder-genres.js';
import { genreMatches, normGenre } from './show-filter.js';

type FolderTrack = ReturnType<typeof library.untaggedPathTracks>[number];

// The scan below is a full read of the untagged rows plus the blocklist over
// each, and it runs several times per pick and on every auto.m3u rebuild —
// synchronously, on the event loop. So it is cached until something it reads
// changes: a library write (any connection), the folder table (only ever
// REPLACED, never edited in place, so its identity is its version) or anything
// that can change what the blocklist answers. Never on a timer alone: the
// blocklist is absolute, and a cache outliving a block would air the track.
let cache: {
  libraryToken: string;
  table: ReadonlyMap<string, string[]>;
  blockToken: string;
  rows: Array<{ track: FolderTrack; genres: string[] }>;
  byTarget: Map<string, FolderTrack[]>;
} | null = null;

function cachedRows(): NonNullable<typeof cache> {
  const libraryToken = library.changeToken();
  const table = folderGenres.assigned();
  const blockToken = blocklist.revisionToken();
  if (cache && cache.libraryToken === libraryToken && cache.table === table && cache.blockToken === blockToken) {
    return cache;
  }
  // The genres trackGenres reads for an untagged row with a path, resolved once
  // per row — only rows some folder genre reaches are worth keeping.
  const rows = library.untaggedPathTracks()
    .map((track) => ({ track, genres: folderGenres.genresForPath(track.path) }))
    .filter((r) => r.genres.length);
  cache = { libraryToken, table, blockToken, rows, byTarget: new Map() };
  return cache;
}

// The untagged library tracks one folder genre reaches, matched by the
// predicate the lock itself runs. Blocked tracks never get here. Fresh copies:
// callers stamp fields on the objects they air (queue.applyLoudnessGain).
export function folderGenreTracks(genreName: string): FolderTrack[] {
  const target = normGenre(genreName);
  if (!target || !folderGenres.assigned().size) return [];
  const c = cachedRows();
  let hits = c.byTarget.get(target);
  if (!hits) {
    hits = c.rows.filter((r) => genreMatches({ genres: r.genres }, [target])).map((r) => r.track);
    c.byTarget.set(target, hits);
  }
  return hits.map((t) => ({ ...t }));
}

// A show genre resolved to a library genre: an exact tag first, then an exact
// folder genre, and only then resolveGenreName's substring pass, which would
// otherwise broaden the show onto a different tag. A folder genre counts only
// while it reaches a playable track — as a tag counts only while a song carries
// it — so a stale assignment cannot hold a lock over nothing.
//
// The folder genre needs no Navidrome, so it still resolves while Navidrome is
// down; a genre that is not one rethrows the tag lookup's error exactly as
// resolveGenreName would, and every caller already drops a genre that throws.
export async function resolveShowGenreName(name: string): Promise<string | null> {
  const target = normGenre(name);
  let tag: string | null = null;
  let tagError: unknown = null;
  try {
    tag = await subsonic.resolveGenreName(name);
  } catch (err) {
    tagError = err;
  }
  if (!tagError && (!target || (tag && normGenre(tag) === target))) return tag;
  const hit = target
    ? [...folderGenres.assigned().values()].flat().find((g) => normGenre(g) === target)
    : undefined;
  if (hit && folderGenreTracks(hit).length) return hit;
  if (tagError) throw tagError;
  return tag;
}

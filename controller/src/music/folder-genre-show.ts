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
import * as folderGenres from './folder-genres.js';
import { genreMatches, normGenre } from './show-filter.js';

// The untagged library tracks one folder genre reaches. The genres trackGenres
// reads for such a row, matched by the predicate the lock itself runs — passed
// inline, so no per-row library.get. Blocked tracks never get here.
export function folderGenreTracks(genreName: string): ReturnType<typeof library.untaggedPathTracks> {
  const target = normGenre(genreName);
  if (!target || !folderGenres.assigned().size) return [];
  return library.untaggedPathTracks().filter((t) =>
    genreMatches({ genres: folderGenres.genresForPath(t.path) }, [target]));
}

// A show genre resolved to a library genre: an exact tag first, then an exact
// folder genre, and only then resolveGenreName's substring pass, which would
// otherwise broaden the show onto a different tag. A folder genre counts only
// while it reaches a playable track — as a tag counts only while a song carries
// it — so a stale assignment cannot hold a lock over nothing.
export async function resolveShowGenreName(name: string): Promise<string | null> {
  const target = normGenre(name);
  const tag = await subsonic.resolveGenreName(name);
  if (!target || (tag && normGenre(tag) === target)) return tag;
  const hit = [...folderGenres.assigned().values()].flat().find((g) => normGenre(g) === target);
  return hit && folderGenreTracks(hit).length ? hit : tag;
}

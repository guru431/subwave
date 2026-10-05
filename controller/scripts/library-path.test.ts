// The track path column (the fork's idempotent column check after upstream's
// migrations — it was migration 21 on v1.8.0): upsertTrackMeta stores only
// an ABSOLUTE path, and a walk without one — Navidrome's fake "Artist/Album/…"
// path when Report Real Path is off, or no path at all — never erases a stored
// one. The path rides getTrack and the rule-match / folder-tree projections.
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR (set before the
// dynamic import), like scripts/airing.test.ts.
// Run: `tsx scripts/library-path.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-path-'));
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

const REAL = '/mnt/music/Unsorted/!Помойка русская/Song.mp3';

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A', path: REAL });
assert.equal(db.getTrack('t1')?.path, REAL, 'an absolute path is stored');

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A', path: 'A/Album/Song.mp3' });
assert.equal(db.getTrack('t1')?.path, REAL, 'a fake relative path never overwrites a real one');

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A' });
assert.equal(db.getTrack('t1')?.path, REAL, 'a walk without a path keeps the stored one');

db.upsertTrackMeta('t2', { title: 'Other', artist: 'B', path: 'B/Album/Other.mp3', genres: ['Рок'] });
assert.equal(db.getTrack('t2')?.path ?? null, null, 'a fake path is not stored at all');

assert.equal(db.ruleMatchRows().find((r) => r.id === 't1')?.path, REAL, 'rule-match rows carry the path');

const rows = db.folderRows().map((r) => `${r.path}|${r.tagged}`).sort();
assert.deepEqual(rows, [`${REAL}|false`, 'null|true'], 'folder rows: path + whether a genre tag exists');

// ── the library-row fallback ────────────────────────────────────────────────
// AI picks reach queue.push / purgeBlocked through trackFields(), which strips
// path and genres: an item carrying only { id } sees Folder rules and folder
// genres solely through library.get() in show-filter's trackPath / trackGenres.
const library = await import('../src/music/library.js');
const folderGenres = await import('../src/music/folder-genres.js');
const { trackPath, trackGenres } = await import('../src/music/show-filter.js');
await library.load(); // library.get() answers only once the facade is loaded, as in production

const BARE = '/mnt/music/Unsorted/!Помойка русская/Bare.mp3';
db.upsertTrackMeta('t3', { title: 'Bare', artist: 'C', path: BARE });
folderGenres.setAll(new Map([['/mnt/music/Unsorted/!Помойка русская', ['Поп']]]));
assert.equal(trackPath({ id: 't3' }), BARE, 'an id-only item reads its path from the library row');
assert.deepEqual(trackGenres({ id: 't3' }), ['Поп'], 'an id-only untagged item reads its folder genre');

// ── the column survives a second migrate ───────────────────────────────────
// The station DB reaches the new image with `path` already present (it was
// migration 21 on v1.8.0). The fork's column step must then be a no-op, not
// `duplicate column name`, and must leave user_version to upstream.
{
  const Database = (await import('better-sqlite3')).default;
  const file = join(process.env.STATE_DIR!, 'library.db');
  const raw = new Database(file, { readonly: true });
  const cols = (raw.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map((c) => c.name);
  const version = raw.pragma('user_version', { simple: true }) as number;
  raw.close();
  assert.ok(cols.includes('path'), 'a fresh DB gets the path column');
  assert.ok(version >= 27, `user_version stays upstream's (got ${version})`);
  // open() on an open handle is a no-op: close first, so migrate() really runs again.
  db.close();
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
  assert.equal(db.getTrack('t1')?.path, REAL, 'a second migrate keeps the column and its data');
}

console.log('library-path.test.ts: all assertions passed');
process.exit(0);

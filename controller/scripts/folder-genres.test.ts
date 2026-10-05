// Folder genres (music/folder-genres.ts): path helpers, the nearest-assigned-
// ancestor lookup, table validation, the folder-tree aggregation and the
// load/save contract (never throws on load; a refused save changes nothing).
// Run: `tsx scripts/folder-genres.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-folder-genres-'));
process.env.STATE_DIR = stateDir;
const fg = await import('../src/music/folder-genres.js');

// ── path helpers ────────────────────────────────────────────────────────────
assert.equal(fg.absolutePath('/a/b.mp3'), '/a/b.mp3');
assert.equal(fg.absolutePath('A/B/b.mp3'), null, 'a fake relative path is no path');
assert.equal(fg.absolutePath('/'), null);
assert.equal(fg.absolutePath(null), null);
assert.equal(fg.normFolder('/a/b/'), '/a/b', 'trailing slash dropped');
assert.equal(fg.normFolder('/a/b //'), '/a/b ', 'not trimmed: a folder name may end in a space');
assert.equal(fg.normFolder('a/b'), null);
assert.equal(fg.normFolder('/'), null);
assert.equal(fg.normFolder(42), null);
assert.equal(fg.parentDir('/a/b/c.mp3'), '/a/b');
assert.equal(fg.parentDir('/a'), null, 'no folder row above the top');
assert.equal(fg.pathInFolder('/m/Сборки', '/m/Сборки/x.mp3'), true);
assert.equal(fg.pathInFolder('/m/Сборки', '/m/Сборки 2/x.mp3'), false, '"/" boundary');
assert.equal(fg.pathInFolder('/m/Сборки', null), false);

// ── lookup ──────────────────────────────────────────────────────────────────
const table = new Map([['/m/U', ['Разное']], ['/m/U/Поп', ['Поп']]]);
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/Поп/a.mp3'), ['Поп'], 'own folder first');
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/Поп/deep/a.mp3'), ['Поп'], 'nearest assigned ancestor');
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/b.mp3'), ['Разное']);
assert.deepEqual(fg.lookupFolderGenres(table, '/m/S/c.mp3'), []);
assert.deepEqual(fg.lookupFolderGenres(table, 'U/Поп/a.mp3'), [], 'relative path → nothing');
assert.deepEqual(fg.lookupFolderGenres(new Map(), '/m/U/a.mp3'), []);

// ── validation ──────────────────────────────────────────────────────────────
const v = fg.validateFolderGenres({ entries: [
  { folder: '/m/U/', genres: [' Pop ', 'pop', '', 'Rock'] },
  { folder: '/m/Empty', genres: [] },
] });
assert.deepEqual([...v], [['/m/U', ['Pop', 'Rock']]], 'trimmed, deduped case-insensitively, empties dropped');
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: 'm/U', genres: ['x'] }] }), /absolute/);
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: ['x'.repeat(65)] }] }), /64/);
assert.throws(
  () => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: Array.from({ length: 13 }, (_, i) => `g${i}`) }] }),
  /12/,
);
assert.throws(() => fg.validateFolderGenres({ entries: 'nope' }), /entries/);
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: [42] }] }), /strings/);

// ── folder tree aggregation ─────────────────────────────────────────────────
const agg = fg.aggregateFolders([
  { path: '/m/U/Поп/a.mp3', tagged: false },
  { path: '/m/U/Поп/b.mp3', tagged: true },
  { path: '/m/S/c.mp3', tagged: true },
  { path: 'Fake/Album/d.mp3', tagged: false },
  { path: null, tagged: true },
], new Map([['/m/U/Поп', ['Поп']], ['/m/Gone', ['Рок']]]));
const by = new Map(agg.folders.map((f) => [f.path, f]));
assert.equal(agg.withoutPath, 2, 'rows without an absolute path are counted, not placed');
assert.deepEqual(by.get('/m'), { path: '/m', total: 3, untagged: 1, genres: [] }, 'ancestors carry cumulative counts');
assert.deepEqual(by.get('/m/U/Поп'), { path: '/m/U/Поп', total: 2, untagged: 1, genres: ['Поп'] });
assert.deepEqual(by.get('/m/Gone'), { path: '/m/Gone', total: 0, untagged: 0, genres: ['Рок'] }, 'a stale assignment still shows');
assert.equal(by.has('/'), false, 'the filesystem root is not a folder row');

// ── state + persistence ─────────────────────────────────────────────────────
await fg.load();
assert.deepEqual(fg.list(), [], 'no file → empty, no throw');
const saved = await fg.save({ entries: [{ folder: '/m/U/Поп', genres: ['Поп'] }] });
assert.deepEqual(saved, [{ folder: '/m/U/Поп', genres: ['Поп'] }]);
assert.deepEqual(fg.genresForPath('/m/U/Поп/a.mp3'), ['Поп']);
assert.deepEqual(
  JSON.parse(readFileSync(join(stateDir, 'folder-genres.json'), 'utf8')),
  { entries: [{ folder: '/m/U/Поп', genres: ['Поп'] }] },
);
await assert.rejects(() => fg.save({ entries: [{ folder: 'rel', genres: ['x'] }] }), /absolute/);
assert.deepEqual(fg.list(), saved, 'a refused save changes nothing');
writeFileSync(join(stateDir, 'folder-genres.json'), '{ not json');
await fg.load();
assert.deepEqual(fg.list(), [], 'a corrupt file starts empty instead of throwing');

console.log('folder-genres.test.ts: all assertions passed');

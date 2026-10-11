// Fork: the library's free-text filter and Cyrillic. filter() lowercases the
// query in JS, but compared it against SQLite's LOWER(), which folds ASCII only
// (no ICU) — as LIKE does. "кино" therefore never matched a stored "Кино": the
// admin Library search, GET /similar-tracks?q= and the title fallback of
// library.tracksLikeThis all read it. Latin behaviour must not move.
// Run: npm test -- library-browse-cyrillic

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-browse-cyrillic-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 4 });

const TRACKS = [
  { id: 'kino', title: 'Группа крови', artist: 'Кино', album: 'Группа крови' },
  { id: 'agata', title: 'Как на войне', artist: 'Агата Кристи', album: 'Позорная звезда' },
  { id: 'beatles', title: 'Yesterday', artist: 'The Beatles', album: 'Help!' },
];
for (const t of TRACKS) {
  db.upsertTrackMeta(t.id, { title: t.title, artist: t.artist, album: t.album, genres: ['Rock'] });
  db.upsertTrackTags(t.id, { moods: ['calm'], energy: 'medium', source: 'llm', model: 'test-model' });
}

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const ids = (q: string) => db.filter({ q }).rows.map(r => r.id).sort();

test('a Cyrillic query matches a capitalised stored value', () => {
  assert.deepEqual(ids('кино'), ['kino'], 'lowercase query against "Кино"');
  assert.deepEqual(ids('Кино'), ['kino'], 'query typed as stored');
  assert.deepEqual(ids('АГАТА КРИСТИ'), ['agata'], 'uppercase query');
  assert.deepEqual(ids('позорная'), ['agata'], 'album column');
  assert.deepEqual(ids('как на войне'), ['agata'], 'title column');
});

test('Latin queries behave as before', () => {
  assert.deepEqual(ids('beatles'), ['beatles']);
  assert.deepEqual(ids('YESTERDAY'), ['beatles']);
  assert.deepEqual(ids('help'), ['beatles']);
  assert.deepEqual(ids('нет такого'), []);
});

// Folder genres and Folder rules (music/show-filter.ts + music/blocklist-rules.ts
// + schemas/blocklist.ts): a track WITHOUT a genre tag reads the genre of its
// folder (nearest assigned ancestor), a tag always wins, fake relative paths
// are ignored, a Folder rule blocks everything under the folder on a "/"
// boundary, and real paths may run past the 64-char cap names keep.
// Pure: tracks carry genres/path inline, library-db is never opened.
// Run: `tsx scripts/folder-rules.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-folder-rules-'));
const folderGenres = await import('../src/music/folder-genres.js');
const { trackGenres, trackPath, genreMatches, normGenre } = await import('../src/music/show-filter.js');
const { compileRules, ruleMatches, validateRulePatch } = await import('../src/music/blocklist-rules.js');
const { blockRuleSchema, RULE_TEXT_MAX } = await import('../src/schemas/blocklist.js');

const ROOT = '/mnt/music';
folderGenres.setAll(new Map([
  [`${ROOT}/Unsorted/!Помойка русская`, ['Поп']],
  [`${ROOT}/Unsorted`, ['Разное']],
]));

// ── genre fallback ──────────────────────────────────────────────────────────
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Unsorted/!Помойка русская/a.mp3` }), ['Поп'], 'own folder');
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Unsorted/Юля Кошкина/b.mp3` }), ['Разное'], 'nearest assigned ancestor');
assert.deepEqual(
  trackGenres({ genres: ['Äðóãîå'], path: `${ROOT}/Unsorted/!Помойка русская/c.mp3` }),
  ['Äðóãîå'],
  'a tag always wins, even a junk one',
);
assert.deepEqual(trackGenres({ genres: [], path: 'Artist/Album/d.mp3' }), [], 'a fake relative path gives no folder genre');
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Sorted/e.mp3` }), [], 'unassigned folder → no genre');
assert.equal(
  genreMatches({ genres: [], path: `${ROOT}/Unsorted/!Помойка русская/a.mp3` }, [normGenre('Поп')]),
  true,
  'Genre rules and genre shows see the folder genre',
);

// ── raw OpenSubsonic genres ─────────────────────────────────────────────────
// A raw Subsonic song (exact requests, the auto.m3u fallback, rejectArchive)
// carries `genres: [{ name }]` objects beside the scalar `genre`.
const rawSong = { genres: [{ name: 'Шансон' }] } as any;
assert.deepEqual(trackGenres(rawSong), ['Шансон'], 'raw [{name}] genres are tags');
assert.equal(genreMatches(rawSong, [normGenre('Шансон')]), true, 'genre shows see a raw genre');
const chansonRule = (field: 'genre' | 'tag') => compileRules([{
  id: 'r', label: 'x', field, values: ['Шансон'], season: null, showIds: [], addedAt: '2026-01-01T00:00:00.000Z',
}])[0]!;
assert.equal(ruleMatches(chansonRule('genre'), rawSong, null), true, 'a Genre rule blocks a raw tagged song');
assert.equal(ruleMatches(chansonRule('tag'), rawSong, null), true, 'an Any-tag rule blocks a raw tagged song');
assert.deepEqual(
  trackGenres({ genres: [{ name: '' }], path: `${ROOT}/Unsorted/!Помойка русская/x.mp3` } as any),
  ['Поп'],
  'empty raw names are no tag — the folder genre applies',
);

// ── trackPath ───────────────────────────────────────────────────────────────
assert.equal(trackPath({ path: `${ROOT}/x.mp3` }), `${ROOT}/x.mp3`);
assert.equal(trackPath({ path: 'A/B/x.mp3' }), null, 'a fake path is no path');
assert.equal(trackPath({}), null);

// ── Folder rule matching ────────────────────────────────────────────────────
const folderRule = (values: string[]) => compileRules([{
  id: 'r', label: 'x', field: 'folder', values, season: null, showIds: [], addedAt: '2026-01-01T00:00:00.000Z',
}])[0]!;
const sborki = folderRule([`${ROOT}/Сборки`]);
assert.equal(ruleMatches(sborki, { path: `${ROOT}/Сборки/Europa Plus/a.mp3` }, null), true, 'subfolders included');
assert.equal(ruleMatches(sborki, { path: `${ROOT}/Сборки 2/a.mp3` }, null), false, 'boundary is "/"');
assert.equal(ruleMatches(sborki, { path: 'Сборки/a.mp3' }, null), false, 'a fake path never matches');
assert.equal(ruleMatches(sborki, {}, null), false, 'no path, no match');
assert.equal(ruleMatches(folderRule([`${ROOT}/Сборки/`]), { path: `${ROOT}/Сборки/a.mp3` }, null), true, 'trailing slash normalised');

// ── validation ──────────────────────────────────────────────────────────────
const long = `${ROOT}/Sorted (mp3_320)/Рок зарубежный/Metallica/1991 - Metallica (Remastered)`;
assert.ok(long.length > RULE_TEXT_MAX);
assert.deepEqual(
  validateRulePatch({ label: 'x', field: 'folder', values: [`${long}/`] }).values,
  [long],
  'a long real path is accepted, trailing slash stripped',
);
assert.throws(() => validateRulePatch({ label: 'x', field: 'folder', values: ['Сборки'] }), /absolute/, 'relative folder refused');
assert.deepEqual(
  validateRulePatch({ label: 'x', field: 'folder', values: [' /m/Still '] }).values,
  ['/m/Still '],
  'a folder path keeps its trailing space (a real folder name may end in one)',
);
assert.deepEqual(
  validateRulePatch({ label: 'x', field: 'tag', values: [' Рок '] }).values,
  ['Рок'],
  'names are still trimmed',
);
assert.equal(
  blockRuleSchema.safeParse({ label: 'x', field: 'genre', values: ['x'.repeat(RULE_TEXT_MAX + 1)] }).success,
  false,
  'names keep the 64-char cap',
);

console.log('folder-rules.test.ts: all assertions passed');

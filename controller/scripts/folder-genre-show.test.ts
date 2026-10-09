// Fork: a show genre that only a FOLDER carries (music/folder-genres.ts). The
// show's genre lock resolved through subsonic.resolveGenreName, which knows
// only the tags getGenres reports, so a folder-only genre resolved to null and
// the lock came off whole ("the genre filter is OFF") — the strict show aired
// the whole library. And Navidrome's genre fetches know only tags too, so the
// show-genre source had nothing in-genre to offer even once the lock held.
// Real library.db; only Navidrome and the model are faked.
// Run: npm test -- folder-genre-show

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-folder-genre-show-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

// The library's TAG genres. "Русский шансон" is there so a substring pass
// would broaden "Шансон" onto it.
const TAGS = [
  { value: 'Рок', songCount: 2, albumCount: 1 },
  { value: 'Русский шансон', songCount: 1, albumCount: 1 },
];

const ok = (body: object) => new Response(JSON.stringify({
  'subsonic-response': { status: 'ok', version: '1.16.1', ...body },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const endpoint = new URL(url).pathname.replace('/rest/', '');
    if (endpoint === 'getGenres') return ok({ genres: { genre: TAGS } });
    return ok({});                // genre fetches, random, albums: nothing
  }
  // The model: refused outright, so the pool picker takes its first candidate.
  if (url.startsWith('http://127.0.0.1:9/v1/')) {
    return new Response(JSON.stringify({ error: { message: 'fixture refuses' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const folderGenres = await import('../src/music/folder-genres.js');
const subsonic = await import('../src/music/subsonic.js');
const picker = await import('../src/music/picker.js');
// Dynamic per test where the module is new, so the rest still runs RED.
const showGenre = () => import('../src/music/folder-genre-show.js');

after(() => { globalThis.fetch = realFetch; });

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
} as never);

await library.load();
const KIDS = '/m/Unsorted/Детские';
folderGenres.setAll(new Map([
  [KIDS, ['Детские']],
  ['/m/Unsorted/Шансон', ['Шансон']],
  ['/m/Gone', ['Пусто']],                           // renamed away: no track left
]));
const track = (id: string, path: string, genres: string[] | null) => library.set(id, {
  title: `Song ${id}`, artist: `Artist ${id}`, album: `Album ${id}`, year: 2000,
  genres, duration: 200, path, moods: ['calm'], energy: 'low', source: 'manual',
});
track('kid-1', `${KIDS}/1.mp3`, null);
track('kid-2', `${KIDS}/2.mp3`, null);
track('kid-3', `${KIDS}/sub/3.mp3`, null);          // nearest assigned ancestor
track('kid-tagged', `${KIDS}/4.mp3`, ['Рок']);      // a tag always wins
track('rock-1', '/m/Rock/1.mp3', ['Рок']);
track('loose-1', '/m/Other/1.mp3', null);           // no folder genre
track('chanson-1', '/m/Unsorted/Шансон/1.mp3', null);
const KID_IDS = ['kid-1', 'kid-2', 'kid-3'];

test('a show genre resolves to a genre only a folder carries', async () => {
  const { resolveShowGenreName } = await showGenre();
  assert.equal(await resolveShowGenreName('Детские'), 'Детские');
  assert.equal(await resolveShowGenreName('детские'), 'Детские', 'normalised like a tag');
});

test('an exact folder genre beats the substring pass over tags', async () => {
  const { resolveShowGenreName } = await showGenre();
  assert.equal(await resolveShowGenreName('Шансон'), 'Шансон');
});

test('a folder genre no track reads is no library genre', async () => {
  // As a tag counts only while a song carries it: a stale assignment must not
  // hold a lock over nothing.
  const { resolveShowGenreName } = await showGenre();
  assert.equal(await resolveShowGenreName('Пусто'), null);
});

test('an exact tag still wins, and the tag-only resolver is unchanged', async () => {
  const { resolveShowGenreName } = await showGenre();
  assert.equal(await resolveShowGenreName('рок'), 'Рок');
  // Listener requests and the agent's songsByGenre fetch from Navidrome, which
  // knows no folder genre — they keep resolving against tags alone.
  assert.equal(await subsonic.resolveGenreName('Детские'), null);
  assert.equal(await subsonic.resolveGenreName('Шансон'), 'Русский шансон');
});

test('the folder-genre source returns the untagged tracks the folder covers', async () => {
  const { folderGenreTracks } = await showGenre();
  assert.deepEqual(folderGenreTracks('Детские').map((t: any) => t.id).sort(), KID_IDS);
  assert.deepEqual(folderGenreTracks('Рок'), [], 'no folder carries it: tagged tracks are Navidrome\'s to fetch');
  assert.deepEqual(folderGenreTracks(''), []);
});

test('the pool picker locks a strict show to the folder genre and pools the folder', async () => {
  const logs: string[] = [];
  const stubQueue = {
    upcoming: [], current: null, history: [],
    recentlyPlayed: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
    recentArtistsSince: () => new Set<string>(),
    recentAlbumKeys: () => new Set<string>(),
    recentlyPlayedByCount: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
    log: (_kind: string, msg: string) => { logs.push(msg); },
  };
  const show = {
    id: 'kids', name: 'Детский час', genres: ['Детские'], filtersStrict: true,
    moods: [], eras: [], energies: [], vocals: '', playlistIds: [],
  };
  const pick = await picker.pickViaPool(stubQueue, { dominantMood: 'calm', activeShow: show });
  assert.ok(
    logs.some(l => l === 'strict genre Детские: 3/3 in-genre'),
    `the lock must hold and the pool be the folder — log:\n${logs.join('\n')}`,
  );
  assert.ok(logs.some(l => /show-genre=3\b/.test(l)), `the show-genre source must bring the folder — log:\n${logs.join('\n')}`);
  assert.ok(pick && KID_IDS.includes(pick.song.id), `picked ${pick?.song?.id}`);
});

test('the auto.m3u coast and the pool picker take the folder source in step', () => {
  // No harness drives refreshAutoPlaylist end to end; pin the shared call in
  // both show-genre sources (picker §1e, scheduler §0 — "keep in step").
  const has = (p: string, needle: string) =>
    assert.ok(readFileSync(new URL(p, import.meta.url), 'utf8').includes(needle), `${p}: ${needle}`);
  for (const file of ['../src/music/picker.ts', '../src/broadcast/scheduler.ts']) {
    has(file, 'folderGenreTracks(genreName)');
    has(file, 'resolveShowGenreName(');
  }
  has('../src/broadcast/dj-agent.ts', 'resolveShowGenreName(');
  has('../src/music/show-candidates.ts', 'resolveShowGenreName(');
});

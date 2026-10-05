// Dislike suggestions: parsing the room's answer, the blocklist check rows and
// the reason line. Same harness as roomRules.test.ts (assert + ✓/✗ + exit 1).
// Run:  npx --yes tsx web/lib/dislikeSuggestions.test.ts

import assert from 'node:assert/strict';
import {
  checkRows, listenerLabel, parseSuggestions, reasonLine, withoutBlocked,
  type Suggestion,
} from './dislikeSuggestions';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

const artist: Suggestion = {
  kind: 'artist', key: 'кино', songId: 's2', title: 'Пачка сигарет', artist: 'Кино',
  album: 'Звезда по имени Солнце',
  listeners: [{ name: 'Маша', tag: 'a1b2' }, { name: '', tag: 'c3d4' }],
  explicit: 1, songs: 3, lastAt: '2026-09-24T12:00:00.000+00:00',
};
const track: Suggestion = {
  kind: 'track', key: 's1', songId: 's1', title: 'Звезда', artist: 'Кино',
  album: 'Звезда по имени Солнце', listeners: [{ name: 'Дима', tag: 'e5f6' }],
  lastAt: '2026-09-24T11:00:00.000+00:00',
};

console.log('parseSuggestions');

test('the room answer reads as is', () => {
  assert.deepEqual(parseSuggestions({ artists: [artist], tracks: [track] }),
    { artists: [artist], tracks: [track] });
});

test('garbage and the wrong kind are dropped', () => {
  assert.deepEqual(parseSuggestions(null), { artists: [], tracks: [] });
  assert.deepEqual(parseSuggestions({ artists: [track], tracks: [{ kind: 'track' }] }),
    { artists: [], tracks: [] });
});

test('a broken listener list becomes empty, not a crash', () => {
  const { tracks } = parseSuggestions({ tracks: [{ ...track, listeners: 'x' }] });
  assert.deepEqual(tracks[0]?.listeners, []);
});

console.log('checkRows / withoutBlocked');

test('an artist is checked by name only, a track by all its fields', () => {
  assert.deepEqual(checkRows({ artists: [artist], tracks: [track] }), [
    { id: 'artist:кино', artist: 'Кино' },
    { id: 's1', title: 'Звезда', artist: 'Кино', album: 'Звезда по имени Солнце' },
  ]);
});

test('anything the blocklist already catches is not suggested', () => {
  const all = { artists: [artist], tracks: [track] };
  assert.deepEqual(withoutBlocked(all, { 'artist:кино': { kind: 'entry' }, s1: null }),
    { artists: [], tracks: [track] });
});

test('a blocked representative song does not hide its artist', () => {
  const all = { artists: [artist], tracks: [] };
  assert.deepEqual(withoutBlocked(all, { s2: { kind: 'entry' } }), all);
});

console.log('labels');

test('a nameless listener is anon plus the id head', () => {
  assert.equal(listenerLabel({ name: '', tag: 'c3d4' }), 'anon·c3d4');
  assert.equal(listenerLabel({ name: ' Маша ', tag: 'a1b2' }), 'Маша');
});

test('the artist reason names listeners, artist dislikes and songs', () => {
  assert.equal(reasonLine(artist),
    'disliked by Маша, anon·c3d4 · 1 artist dislike · 3 songs disliked');
});

test('the track reason names listeners only', () => {
  assert.equal(reasonLine(track), 'disliked by Дима');
});

test('zero artist dislikes are not mentioned', () => {
  assert.equal(reasonLine({ ...artist, explicit: 0, songs: 2 }),
    'disliked by Маша, anon·c3d4 · 2 songs disliked');
});

if (failures) {
  console.error(`\n${failures} checks failed`);
  process.exit(1);
}
console.log('\nall passed');

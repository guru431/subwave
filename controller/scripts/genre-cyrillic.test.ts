// Cyrillic genres (music/show-filter.ts): normGenre and the word-boundary walk
// kept only a-z0-9, so "Рок" normalised to "" — a Genre rule or a genre show
// with a Cyrillic name matched nothing, silently. Latin behaviour must not move.
// Pure: tracks carry their genres inline. Run: `tsx scripts/genre-cyrillic.test.ts`.

import assert from 'node:assert/strict';
import { genreMatches, normGenre } from '../src/music/show-filter.js';

assert.equal(normGenre('Рок'), 'рок', 'Cyrillic letters survive');
assert.equal(normGenre('Шансон'), 'шансон');
assert.equal(normGenre('Rock (Hard)'), 'rockhard', 'Latin unchanged');
assert.equal(normGenre('Hip-Hop'), 'hiphop', 'Latin unchanged');
assert.equal(normGenre('Música'), 'música', 'accented Latin keeps its letter');

const t = (genres: string[]) => ({ genres });
assert.equal(genreMatches(t(['Рок']), [normGenre('Рок')]), true, 'exact Cyrillic genre');
assert.equal(genreMatches(t(['Поп-рок']), [normGenre('Поп')]), true, 'refines on a word boundary');
assert.equal(genreMatches(t(['Попса']), [normGenre('Поп')]), false, 'no match inside a word');
assert.equal(genreMatches(t(['Рок']), [normGenre('Rock')]), false, 'Рок and Rock stay different genres');
assert.equal(genreMatches(t(['Rock (Hard)']), [normGenre('Rock')]), true, 'Latin refine unchanged');

console.log('genre-cyrillic.test.ts: all assertions passed');

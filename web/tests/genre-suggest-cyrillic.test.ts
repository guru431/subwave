// Fork: the chip lookup key kept only [a-z0-9], so every Cyrillic genre folded
// to '' — typing «Рок» in the show editor found neither the genre nor its
// neighbours and fell through to "popular genres".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { genreMatchKey } from '../components/admin/GenreSuggest';

test('Cyrillic genres keep distinct, non-empty match keys', () => {
  assert.equal(genreMatchKey(' Рок '), 'рок');
  assert.notEqual(genreMatchKey('Рок'), genreMatchKey('Поп'));
  assert.ok(genreMatchKey('Ро') && genreMatchKey('Рок').includes(genreMatchKey('Ро')));
});

test('Latin keys fold exactly as before', () => {
  assert.equal(genreMatchKey('Hip-Hop'), 'hiphop');
  assert.equal(genreMatchKey('Rock (Hard)'), 'rockhard');
  assert.equal(genreMatchKey('R&B'), 'rb');
});

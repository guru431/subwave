// Fork: Cyrillic artist names and titles. subsonic.normArtist and
// musicbrainz.norm kept only a-z0-9, so "Агата Кристи" normalised to "" —
// resolveArtist() answered null without asking Navidrome (the request
// cascade's artist branch, "latest by X", searchLibrary/identifyRequestedTrack's
// artist retry, recentByArtist and the artist queue-block all read it), and a
// Cyrillic title never matched a MusicBrainz recording, so the track was
// stamped a miss. Latin behaviour must not move.
// Only Navidrome is faked. Run: npm test -- artist-cyrillic

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-artist-cyrillic-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const AGATA = { id: 'ar-agata', name: 'Агата Кристи' };
const BI2 = { id: 'ar-bi2', name: 'Би-2' };
const BEYONCE = { id: 'ar-beyonce', name: 'Beyonce' };
const ARTISTS = [AGATA, BI2, BEYONCE];

// search3 the way Navidrome answers it: every query word must start a word of
// the name, case-insensitively — so a declined "Агату" finds nothing on its own.
const searched: string[] = [];
function search3(query: string) {
  searched.push(query);
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ARTISTS.filter(a => {
    const nameWords = a.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.length > 0 && words.every(w => nameWords.some(n => n.startsWith(w)));
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const u = new URL(url);
    const body = u.pathname === '/rest/search3'
      ? { searchResult3: { artist: search3(u.searchParams.get('query') || '') } }
      : {};
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const subsonic = await import('../src/music/subsonic.js');
const { earliestOriginalYear } = await import('../src/music/musicbrainz.js');

after(() => { globalThis.fetch = realFetch; });

test('resolveArtist: a Cyrillic name asks Navidrome and resolves', async () => {
  searched.length = 0;
  const hit = await subsonic.resolveArtist('Агата Кристи');
  assert.ok(searched.length > 0, 'search3 was never called — the name normalised to nothing');
  assert.equal(hit?.id, AGATA.id);
});

test('resolveArtist: a declined Cyrillic name resolves through the per-token fuzzy pass', async () => {
  // "Агату Кристи" (accusative): the exact search finds nothing, "кристи" does,
  // and the full names are one letter apart.
  assert.equal((await subsonic.resolveArtist('Агату Кристи'))?.id, AGATA.id);
});

test('resolveArtist: Cyrillic with a digit and punctuation', async () => {
  assert.equal((await subsonic.resolveArtist('Би-2'))?.id, BI2.id);
});

test('resolveArtist: an unknown Cyrillic name stays unresolved', async () => {
  assert.equal(await subsonic.resolveArtist('Неизвестная Группа'), null);
});

test('resolveArtist: Latin unchanged — diacritics still fold', async () => {
  assert.equal((await subsonic.resolveArtist('Beyoncé'))?.id, BEYONCE.id);
});

const rec = (title: string, artist: string, date: string) => ({
  score: 100, title, 'artist-credit': [{ name: artist }], 'first-release-date': date,
});

test('earliestOriginalYear: a Cyrillic title and artist match their recording', () => {
  const recs = [rec('Как на войне', 'Агата Кристи', '2000'), rec('Как на войне', 'Агата Кристи', '1993')];
  assert.equal(earliestOriginalYear(recs, { title: 'Как на войне', artist: 'Агата Кристи' }), 1993);
});

test('earliestOriginalYear: Cyrillic still gates on title and artist', () => {
  assert.equal(
    earliestOriginalYear([rec('Чёрная луна', 'Агата Кристи', '1990')], { title: 'Как на войне', artist: 'Агата Кристи' }),
    null,
    'another title must not lend its year',
  );
  assert.equal(
    earliestOriginalYear([rec('Как на войне', 'Другая группа', '1990')], { title: 'Как на войне', artist: 'Агата Кристи' }),
    null,
    'another artist must not lend its year',
  );
});

test('earliestOriginalYear: Latin unchanged', () => {
  assert.equal(
    earliestOriginalYear([rec('Dancing Queen (Remastered)', 'ABBA', '1976')], { title: 'Dancing Queen', artist: 'ABBA' }),
    1976,
  );
});

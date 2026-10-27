// Fork (C07): on the request path searchLibrary's artist retry reads as wide as
// its first search. A declined name ("Агату Кристи") misses lexically — search3
// matches word prefixes — and resolveArtist() turns it into the tagged
// "Агата Кристи"; the retry then asked for 25 rows of a 103-track shelf, the
// very cut C07 lifted on the first search. The pick path keeps its 25.
// Only Navidrome is faked. Run: npm test -- search-library-request

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-search-library-request-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const AGATA = { id: 'ar-agata', name: 'Агата Кристи' };
const SHELF = Array.from({ length: 103 }, (_, i) => ({
  id: `ag-${i + 1}`, title: `Песня ${i + 1}`, artist: AGATA.name, artistId: AGATA.id,
  album: 'Альбом', duration: 240,
}));

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// search3 the way Navidrome answers it: every query word must start a word of
// the name — so the declined "Агату" finds nothing on its own.
const matches = (query: string, text: string) => {
  const q = words(query);
  const t = words(text);
  return q.length > 0 && q.every(w => t.some(n => n.startsWith(w)));
};

// songCount of every search3 that asked for songs, by query
const songCounts: Array<{ query: string; songCount: number }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const u = new URL(url);
    let body = {};
    if (u.pathname === '/rest/search3') {
      const query = u.searchParams.get('query') || '';
      const songCount = Number(u.searchParams.get('songCount') || 0);
      const songOffset = Number(u.searchParams.get('songOffset') || 0);
      if (songCount > 0) songCounts.push({ query, songCount });
      const song = SHELF.filter(s => matches(query, `${s.title} ${s.artist}`))
        .slice(songOffset, songOffset + songCount);
      body = { searchResult3: { artist: matches(query, AGATA.name) ? [AGATA] : [], song } };
    }
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');

after(() => { globalThis.fetch = realFetch; });

async function searchLibrary(requestPath: boolean, query: string) {
  songCounts.length = 0;
  const { tools } = buildPickerTools({ requestPath });
  const out = await (tools.searchLibrary as any).execute({ query }, { toolCallId: 't', messages: [] });
  const retry = songCounts.filter(c => c.query === AGATA.name);
  return { out, retry };
}

test('request path: the artist retry after a lexical miss reads the whole shelf', async () => {
  const { out, retry } = await searchLibrary(true, 'Агату Кристи');
  assert.equal(retry.length, 1, 'expected one retry under the resolved name');
  assert.equal(retry[0].songCount, 200);
  assert.ok(Array.isArray(out), `expected tracks, got ${JSON.stringify(out).slice(0, 200)}`);
  assert.equal(out.length, SHELF.length);
  assert.ok(out.some((s: any) => s.id === 'ag-60'), 'track 60 of the shelf is beyond the old 25-row cut');
});

test('pick path: the artist retry keeps its 25-row page', async () => {
  const { out, retry } = await searchLibrary(false, 'Агату Кристи');
  assert.equal(retry.length, 1, 'expected one retry under the resolved name');
  assert.equal(retry[0].songCount, 25);
  assert.ok(Array.isArray(out) && out.length > 0 && out.length <= 8);
});

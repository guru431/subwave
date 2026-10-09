// Fork (C08): the pool picker's artist window covers what is QUEUED, not only
// what played.
//
// The agent path's hard window takes the whole queue (queue.queuedArtistRoots),
// but pickViaPool read only queue.recentArtistsSince — played tracks and the
// one on air. With a deep queue.lookahead the pool could choose an artist
// already waiting to air, both as the agent's fallback and as runArtistGuard's
// pool rescue, which artist-guard.ts promises "applies the same window itself".
// The queued artists now join the same relaxable window, so the never-starve
// cascade still hands back a candidate when every artist is queued.
// Real library.db; only Navidrome and the model are faked (the model refuses,
// so the pool takes its first candidate).
// Run: npm test -- pool-artist-window-queue

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-pool-artist-window-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const ok = (body: object) => new Response(JSON.stringify({
  'subsonic-response': { status: 'ok', version: '1.16.1', ...body },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) return ok({});
  if (url.startsWith('http://127.0.0.1:9/v1/')) {
    return new Response(JSON.stringify({ error: { message: 'fixture refuses' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const picker = await import('../src/music/picker.js');
const { queue } = await import('../src/broadcast/queue.js');

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
const song = (id: string, artist: string) => library.set(id, {
  title: `Song ${id}`, artist, album: `Album ${id}`, year: 2000,
  genres: ['Rock'], duration: 200, moods: ['calm'], energy: 'low', source: 'manual',
});
song('kb-1', 'Kate Bush');
song('kb-2', 'Kate Bush');
song('kb-3', 'Kate Bush');
song('oa-1', 'Other Act');

const q = queue as any;
const logs: string[] = [];
q.log = (_kind: string, msg: string) => { logs.push(msg); };

async function poolPickBehind(queuedArtists: string[]) {
  logs.length = 0;
  q.current = null;
  q.history = [];
  q._recentPlays = [];
  q.upcoming = queuedArtists.map((artist, i) => ({
    track: { id: `queued-${i}`, title: `Queued ${i}`, artist, duration: 200 },
    aiPicked: true, sent: false,
  }));
  return picker.pickViaPool(queue, { dominantMood: 'calm', activeShow: null });
}

const poolSize = () => Number(logs.find(l => /^pool \d+/.test(l))?.match(/^pool (\d+)/)?.[1] ?? NaN);

test('an artist already queued is left out of the pool', async () => {
  const pick = await poolPickBehind(['Kate Bush']);
  assert.equal(poolSize(), 1, `only the act nobody queued — log:\n${logs.join('\n')}`);
  assert.equal(pick?.song?.id, 'oa-1');
});

test('a queued collaboration keeps its lead act out too', async () => {
  const pick = await poolPickBehind(['Kate Bush & Peter Gabriel']);
  assert.equal(poolSize(), 1, `log:\n${logs.join('\n')}`);
  assert.equal(pick?.song?.id, 'oa-1');
});

test('never-starve: with every artist queued the window relaxes and the pool still picks', async () => {
  const pick = await poolPickBehind(['Kate Bush', 'Other Act']);
  assert.equal(poolSize(), 4, `log:\n${logs.join('\n')}`);
  assert.ok(pick?.song?.id, 'a track is still chosen');
});

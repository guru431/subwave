// "more like this" on the public player's request chip picks another song by
// the on-air artist: pickByArtistAndSort shuffles the artist's albums and takes
// the first one. Its comment promises to walk down the list when an album's
// tracks were all just played — the code returned a track from the first
// non-empty album regardless. An artist whose first-shuffled album is the
// one-track single on air right now answered with that very track, push()
// refused it as a duplicate, and the listener heard "already queued" while the
// artist's LP sat untouched. Real router over HTTP; only Navidrome, Icecast and
// the model are faked.
// Run: npm test -- request-more-like-this-walk

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-request-more-like-this-walk-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const song = (id: string, artist: string, album: string) =>
  ({ id, title: `Song ${id}`, artist, album, duration: 200 });

// Album order as getArtist returns it; the test pins shuffle() to keep it.
const ARTISTS: Record<string, { id: string; name: string; albums: Record<string, ReturnType<typeof song>[]> }> = {
  'ar-walk': {
    id: 'ar-walk', name: 'Walk Artist', albums: {
      'al-single': [song('single-on-air', 'Walk Artist', 'Single')],
      'al-lp': [song('lp-1', 'Walk Artist', 'LP'), song('lp-2', 'Walk Artist', 'LP')],
    },
  },
  'ar-stale': {
    id: 'ar-stale', name: 'Stale Artist', albums: {
      'al-first': [song('first-1', 'Stale Artist', 'First')],
      'al-second': [song('second-1', 'Stale Artist', 'Second')],
    },
  },
};

const ok = (body: Record<string, unknown>) => new Response(
  JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const u = new URL(url);
    const method = u.pathname.split('/').pop()!.replace(/\.view$/, '');
    const id = u.searchParams.get('id') || '';
    if (method === 'search3') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      return ok({ searchResult3: { artist: Object.values(ARTISTS).filter(a => a.name.toLowerCase() === q).map(a => ({ id: a.id, name: a.name })) } });
    }
    if (method === 'getArtist') {
      const a = ARTISTS[id];
      return ok({ artist: a ? { id: a.id, name: a.name, album: Object.keys(a.albums).map(al => ({ id: al, name: al })) } : null });
    }
    if (method === 'getAlbum') {
      const songs = Object.values(ARTISTS).map(a => a.albums[id]).find(Boolean) || [];
      return ok({ album: { id, song: songs } });
    }
    if (method === 'getSimilarSongs2') return ok({ similarSongs2: { song: [] } });
    if (method === 'getOpenSubsonicExtensions') return ok({ openSubsonicExtensions: [] });
    return ok({});
  }
  if (url.startsWith('http://127.0.0.1:9/v1/')) {
    return new Response(JSON.stringify({
      id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'A fixture request intro.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input as any, init);
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/request.js');

(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
  requests: { cooldownSec: 0, onePendingPerIp: false, repeatCooldownMin: 120 },
} as never);

const app = express();
app.use(express.json());
app.use('/', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

let listener = 0;
// Math.random pinned just under 1: Fisher–Yates swaps every element with
// itself, so the albums keep getArtist's order, and a pool pick takes its last.
async function moreLikeThis() {
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    const post = await realFetch(`${base}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++listener}` },
      body: JSON.stringify({ text: 'more like this', name: 'tester' }),
    });
    assert.equal(post.status, 202, `receipt expected, got ${post.status}: ${await post.clone().text()}`);
    const { requestId: id } = await post.json() as { requestId: string };
    for (let i = 0; i < 100; i++) {
      const status = await (await realFetch(`${base}/request/${id}`)).json() as any;
      if (status.status !== 'pending') return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('request never resolved');
  } finally {
    Math.random = realRandom;
  }
}

test('the single on air is skipped for a fresh track from the next album', async () => {
  queue.upcoming = [];
  queue.current = { track: ARTISTS['ar-walk'].albums['al-single'][0] } as any;
  (queue as any)._recentPlays = [];
  const status = await moreLikeThis();
  assert.equal(status.status, 'resolved');
  assert.notEqual(status.queuePosition, null, `queued, not refused as a duplicate: ${status.ack}`);
  const queued = queue.upcoming.map((i: any) => i.track.id);
  assert.ok(queued.some((id: string) => id.startsWith('lp-')), `an LP track queued, got ${queued}`);
});

test('control: when every album was just played, the first one still answers', async () => {
  queue.upcoming = [];
  queue.current = { track: song('elsewhere', 'Stale Artist', 'Elsewhere') } as any;
  (queue as any)._recentPlays = ['first-1', 'second-1'].map(id => ({
    id, title: `Song ${id}`, artist: 'Stale Artist', endedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  }));
  const status = await moreLikeThis();
  assert.equal(status.status, 'resolved');
  assert.deepEqual(queue.upcoming.map((i: any) => i.track.id), ['first-1']);
});

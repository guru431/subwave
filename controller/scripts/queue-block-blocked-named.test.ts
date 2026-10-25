// Fork: an operator block never named what it skipped. resolveBlockSource read
// the record through subsonic.getAlbum / getTopSongs, which already drop
// never-play songs (rejectArchive → blocklist.rejectBlocked), so the plan's
// hitOf and push()'s -2 never saw one: a part-blocked album queued with no
// "N skipped (never-play)", and a wholly blocked one answered 404 "that album
// has no tracks in the library". The block now reads with includeBlocked;
// push() is still the gate. Only Navidrome is faked. Run: npm test -- queue-block-blocked

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-queue-block-blocked-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'secret';

const song = (id: string, track: number, albumId: string) => ({
  id, title: `Song ${id}`, artist: 'Some Act', artistId: 'ar-1',
  album: `Record ${albumId}`, albumId, track, duration: 200,
});
const ALBUMS: Record<string, unknown[]> = {
  'alb-part': [song('s1', 1, 'alb-part'), song('s2', 2, 'alb-part'), song('s3', 3, 'alb-part')],
  'alb-all': [song('b1', 1, 'alb-all'), song('b2', 2, 'alb-all')],
};

let local = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const u = new URL(url);
    const id = u.searchParams.get('id') || '';
    const body = u.pathname === '/rest/getAlbum' ? { album: { id, song: ALBUMS[id] || [] } } : {};
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (local && url.startsWith(local)) return realFetch(input, init);
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const subsonic = await import('../src/music/subsonic.js');
const blocklist = await import('../src/music/blocklist.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/dj.js');

// Same neutralisation the queue-block wiring test uses.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

await library.load();
await blocklist.load();
await blocklist.add({ type: 'track', id: 's2', name: 'Song s2', artist: 'Some Act', album: 'Record alb-part' });
await blocklist.add({ type: 'album', id: 'alb-all', name: 'Record alb-all', artist: 'Some Act' });

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
  globalThis.fetch = realFetch;
  library.shutdown();
});

const press = async (body: unknown) => {
  const r = await fetch(`${local}/dj/queue-block`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};

test('airing paths still never see a blocked song', async () => {
  assert.deepEqual((await subsonic.getAlbum('alb-part')).map((s: any) => s.id), ['s1', 's3']);
  assert.deepEqual(
    (await subsonic.getAlbum('alb-part', { includeBlocked: true })).map((s: any) => s.id),
    ['s1', 's2', 's3'],
  );
});

test('a part-blocked album queues the rest and names the skipped track', async () => {
  queue.upcoming = [];
  const { status, body } = await press({ kind: 'album', id: 'alb-part' });
  assert.equal(status, 200);
  assert.equal(body.queued, 2);
  assert.deepEqual(body.skipped.map((s: any) => [s.title, s.reason]), [['Song s2', 'blocked']]);
  assert.deepEqual(queue.upcoming.map((i: any) => i.track.id), ['s1', 's3']);
});

test('a wholly blocked album says so instead of "no tracks in the library"', async () => {
  queue.upcoming = [];
  const { status, body } = await press({ kind: 'album', id: 'alb-all' });
  assert.equal(status, 409);
  assert.match(body.error, /never-play blocklist/);
  assert.equal(body.skipped.length, 2);
  assert.equal(queue.upcoming.length, 0);
});

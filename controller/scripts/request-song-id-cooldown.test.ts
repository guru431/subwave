// Fork (C02): the exact request (`songId` from the request box) skips the
// matching cascade — but not the repeat cooldown. The cascade and the agent
// path refuse a song played within `requests.repeatCooldownMin`; branch 0a has
// to as well, or a listener can re-request one song the moment it ends.
// Real router over HTTP; only Navidrome, Icecast and the model are faked.
// Run: npm test -- request-song-id-cooldown

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-request-song-id-cooldown-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const SONGS: Record<string, { id: string; title: string; artist: string; album: string; duration: number }> = {
  'song-played': { id: 'song-played', title: 'Played Song', artist: 'Cooldown Artist', album: 'A', duration: 200 },
  'song-fresh': { id: 'song-fresh', title: 'Fresh Song', artist: 'Fresh Artist', album: 'B', duration: 210 },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/getSong')) {
    const song = SONGS[new URL(url).searchParams.get('id') || ''];
    return new Response(JSON.stringify({
      'subsonic-response': song ? { status: 'ok', version: '1.16.1', song } : {
        status: 'failed', version: '1.16.1', error: { code: 70, message: 'not found' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
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
async function exactRequest(songId: string) {
  const song = SONGS[songId];
  const post = await realFetch(`${base}/request`, {
    method: 'POST',
    // A distinct listener per request: the per-IP cooldown is not under test.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++listener}` },
    body: JSON.stringify({ text: `${song.title} — ${song.artist}`, name: 'tester', songId }),
  });
  assert.equal(post.status, 202, `receipt expected, got ${post.status}: ${await post.clone().text()}`);
  const { requestId: id } = await post.json() as { requestId: string };
  for (let i = 0; i < 100; i++) {
    const status = await (await realFetch(`${base}/request/${id}`)).json() as any;
    if (status.status !== 'pending') return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('request never resolved');
}

test('an exact request for a song that ended 30 minutes ago is refused with the cooldown ack', async () => {
  queue.upcoming = [];
  queue.current = null;
  (queue as any)._recentPlays = [{
    id: 'song-played', title: 'Played Song', artist: 'Cooldown Artist',
    endedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  }];
  const status = await exactRequest('song-played');
  assert.equal(status.status, 'resolved');
  assert.equal(status.queuePosition, null, 'refused, not queued');
  assert.equal(status.ack, queue.cooldownAck('song-played', 'Played Song'));
  assert.equal(queue.upcoming.some((i: any) => i.track.id === 'song-played'), false);
});

test('control: an exact request for a song outside the cooldown is queued', async () => {
  queue.upcoming = [];
  queue.current = null;
  (queue as any)._recentPlays = [];
  const status = await exactRequest('song-fresh');
  assert.equal(status.status, 'resolved');
  assert.equal(queue.upcoming.some((i: any) => i.track.id === 'song-fresh'), true);
});

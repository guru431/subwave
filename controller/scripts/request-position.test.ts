// Fork (C01): a listener request goes in FRONT of the undrained auto-picks, so
// the position it is told is push()'s own return — never `upcoming.length`,
// which after the insert is somebody else's tail. With five picks queued the
// request plays NEXT, so the listener must read 1, not 6. Pinned on the
// more-like-this branch over HTTP; the agent path and the stateless cascade
// report the same push() value.
// Real router over HTTP; only Navidrome and the model are faked.
// Run: npm test -- request-position

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-request-position-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const SIMILAR = { id: 'similar-1', title: 'Similar Song', artist: 'Other Artist', album: 'S', duration: 200 };

const ok = (body: object) => new Response(JSON.stringify({
  'subsonic-response': { status: 'ok', version: '1.16.1', ...body },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    const endpoint = new URL(url).pathname.replace('/rest/', '');
    if (endpoint === 'getSimilarSongs2') return ok({ similarSongs2: { song: [SIMILAR] } });
    if (endpoint === 'getOpenSubsonicExtensions') return ok({ openSubsonicExtensions: [] });
    return ok({});                                  // search3 etc.: nothing found
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
  // The pair-aware drain would keep the request off a pick already paired
  // with the on-air track; that rule is not under test here.
  transitions: { pairDrain: false },
  requests: { cooldownSec: 0, onePendingPerIp: false, repeatCooldownMin: 0 },
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

async function request(text: string) {
  const post = await realFetch(`${base}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    body: JSON.stringify({ text, name: 'tester' }),
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

test('a request behind five undrained auto-picks is told it is first, not sixth', async () => {
  queue.current = {
    track: { id: 'on-air', title: 'On Air', artist: 'Ref Artist', duration: 200 },
    startedAt: new Date().toISOString(), source: 'ai',
  } as any;
  queue.upcoming = [1, 2, 3, 4, 5].map(n => ({
    track: { id: `pick-${n}`, title: `Pick ${n}`, artist: `Artist ${n}`, duration: 200 },
    aiPicked: true, sent: false, requestedBy: null,
  })) as any;

  const status = await request('more like this');
  assert.equal(status.status, 'resolved', JSON.stringify(status));
  assert.equal(queue.upcoming[0].track.id, SIMILAR.id, 'the request jumped the auto-picks');
  assert.equal(status.queuePosition, 1, 'the listener is told the slot push() gave the request');
});

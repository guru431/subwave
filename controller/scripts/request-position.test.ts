// Fork (C01): a listener request goes in FRONT of the undrained auto-picks, so
// the position it is told is push()'s own return — never `upcoming.length`,
// which after the insert is somebody else's tail. With five picks queued the
// request plays NEXT, so the listener must read 1, not 6. Pinned over HTTP on
// the three branches that resolve a free-text request: more-like-this, the
// stateless cascade and the request agent (whose runRequest hands the route
// push()'s value).
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
// What a library search for the requested title finds (cascade and agent).
const FOUND = { id: 'found-1', title: 'Found Song', artist: 'Found Artist', album: 'F', duration: 210 };

// The model, answering by the shape of what it is asked:
//  * a forced object (the cascade matcher) -> the match, as the tool's args;
//  * the request agent's free discovery step -> one searchLibrary call;
//  * its final step (after a tool result) -> `done` with FOUND's id;
//  * no tools at all -> a plain intro line.
const MATCH = {
  kind: 'track', search_terms: ['Found Song'], artist: null, genre: null, language: null,
  sort: null, scope: 'song', mood: null, intent: 'a song by title', ack: 'Уже ставлю.',
};
function modelReply(body: any) {
  const tools: any[] = body?.tools ?? [];
  const reply = (message: object, finish: string) => new Response(JSON.stringify({
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (!tools.length) return reply({ content: 'A fixture request intro.' }, 'stop');
  const props = (t: any) => Object.keys(t?.function?.parameters?.properties ?? {});
  const forced = body.tool_choice?.function?.name;
  const searched = (body.messages ?? []).some((m: any) => m.role === 'tool');
  const search = tools.find(t => t.function?.name === 'searchLibrary');
  let tool = forced ? tools.find(t => t.function?.name === forced) : null;
  if (!tool && search && !searched) tool = search;
  // The answer tools (matcher, `done`) are the ones carrying an on-air `ack`.
  tool ??= tools.find(t => props(t).includes('ack')) ?? tools[0];
  const keys = props(tool);
  const args = tool === search ? { query: 'Found Song' }
    : keys.includes('search_terms') ? MATCH
    : { kind: 'track', id: FOUND.id, ack: 'Уже ставлю.', ...(keys.includes('intro') ? { intro: 'Вот ваш заказ.' } : {}) };
  return reply({
    content: null,
    tool_calls: [{ id: `call-${tool.function.name}`, type: 'function',
      function: { name: tool.function.name, arguments: JSON.stringify(args) } }],
  }, 'tool_calls');
}

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
    if (endpoint === 'search3' && /found/i.test(new URL(url).searchParams.get('query') || '')) {
      return ok({ searchResult3: { song: [FOUND] } });
    }
    return ok({});                                  // anything else: nothing found
  }
  if (url.startsWith('http://127.0.0.1:9/v1/')) {
    const raw = typeof init?.body === 'string' ? init.body : '';
    return modelReply(raw ? JSON.parse(raw) : null);
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

let listener = 0;
async function request(text: string) {
  const post = await realFetch(`${base}/request`, {
    method: 'POST',
    // A distinct listener per request: the per-IP rate limit is not under test.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++listener}` },
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

function fiveAutoPicks() {
  queue.current = {
    track: { id: 'on-air', title: 'On Air', artist: 'Ref Artist', duration: 200 },
    startedAt: new Date().toISOString(), source: 'ai',
  } as any;
  queue.upcoming = [1, 2, 3, 4, 5].map(n => ({
    track: { id: `pick-${n}`, title: `Pick ${n}`, artist: `Artist ${n}`, duration: 200 },
    aiPicked: true, sent: false, requestedBy: null,
  })) as any;
  queue.djLog = [];
}

const logged = (re: RegExp) => queue.djLog.some((e: any) => re.test(String(e.message)));

test('more like this: a request behind five undrained auto-picks is told it is first, not sixth', async () => {
  fiveAutoPicks();
  const status = await request('more like this');
  assert.equal(status.status, 'resolved', JSON.stringify(status));
  assert.equal(queue.upcoming[0].track.id, SIMILAR.id, 'the request jumped the auto-picks');
  assert.equal(status.queuePosition, 1, 'the listener is told the slot push() gave the request');
});

test('stateless cascade: the same request is told it is first', async () => {
  fiveAutoPicks();
  const status = await request('Found Song please');
  assert.equal(status.status, 'resolved', JSON.stringify(status));
  assert.ok(logged(/resolved via search/), 'the cascade resolved it');
  assert.equal(queue.upcoming[0].track.id, FOUND.id);
  assert.equal(status.queuePosition, 1);
});

test("request agent: runRequest hands the route push()'s position", async (t) => {
  await settings.update({ llm: { pickerAgent: true } } as never);
  t.after(() => settings.update({ llm: { pickerAgent: false } } as never));
  fiveAutoPicks();
  const status = await request('Found Song please');
  assert.equal(status.status, 'resolved', JSON.stringify(status));
  assert.ok(logged(/agent resolved/), 'the agent resolved it, not the cascade fallback');
  assert.equal(queue.upcoming[0].track.id, FOUND.id);
  assert.equal(status.queuePosition, 1);
});

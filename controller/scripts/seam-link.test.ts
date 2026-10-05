// Fork (C04): the seam link on a deep queue.
//
//  * writeSeamLink writes into an item it captured BEFORE a model call that can
//    take tens of seconds. By the time the line comes back the item may have
//    aired, been cancelled, or got a line of its own (a request intro, a pick's
//    link). The line is then dropped — no fields, no persist, no render.
//  * maybeWriteSeamLink spends the shared `tracksUntilLink` cadence only when
//    it actually writes. A seam with nothing to write for (everything handed
//    over, a request or a scripted item at the head) leaves the counter due,
//    so the next eligible seam speaks instead of waiting a whole interval.
// Only the model and the weather are faked.
// Run: npm test -- seam-link

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-seam-link-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const LINE = 'That was a fine one, and this next record keeps the night rolling along.';
// Runs inside the model call: the moment the world may change under the line.
let duringModelCall: () => void = () => {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/v1/')) {
    duringModelCall();
    return new Response(JSON.stringify({
      id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: LINE }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input as any, init);
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const djAgent = await import('../src/broadcast/dj-agent.js');

let persists = 0;
(queue as any).persist = () => { persists++; };
(queue as any).drainToLiquidsoap = async () => {};
after(() => { globalThis.fetch = realFetch; });

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    fallback: { enabled: false },
  },
  queue: { lookahead: 5 },
} as never);

const PREVIOUS = { id: 'prev', title: 'Previous', artist: 'Prev Artist', duration: 200 };
const item = (id: string, extra: object = {}) => ({
  track: { id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200 },
  aiPicked: true, requestedBy: null, sent: false, introScript: null, ...extra,
}) as any;

function reset(upcoming: any[]) {
  duringModelCall = () => {};
  persists = 0;
  queue.current = {
    track: PREVIOUS, startedAt: new Date().toISOString(), source: 'ai',
  } as any;
  queue.history = [{ track: { id: 'older', title: 'Older', artist: 'Older Artist' } }] as any;
  queue.upcoming = upcoming;
}

// ── writeSeamLink ───────────────────────────────────────────────────────────

test('control: an item still waiting gets the line', async () => {
  const next = item('next');
  reset([next]);
  assert.equal(await djAgent.writeSeamLink(queue, next, PREVIOUS), true);
  assert.ok(next.introScript, 'the line was written');
  assert.equal(next.introKind, 'link');
  assert.equal(next.linkPrev?.id, 'prev');
});

test('an item that left the queue during the model call gets nothing', async () => {
  const next = item('next');
  reset([next]);
  duringModelCall = () => { queue.upcoming = []; };       // aired or cancelled
  assert.equal(await djAgent.writeSeamLink(queue, next, PREVIOUS), false);
  assert.equal(next.introScript, null);
  assert.equal(next.linkPrev, undefined, 'no link fields are stamped');
  assert.equal(persists, 0, 'nothing to persist');
});

test('an item that got its own line during the model call keeps it', async () => {
  const next = item('next');
  reset([next]);
  duringModelCall = () => { next.introScript = 'Its own line.'; next.introKind = 'dj-speak'; };
  assert.equal(await djAgent.writeSeamLink(queue, next, PREVIOUS), false);
  assert.equal(next.introScript, 'Its own line.');
  assert.equal(next.introKind, 'dj-speak');
  assert.equal(persists, 0);
});

// ── maybeWriteSeamLink: the cadence ─────────────────────────────────────────

test('a seam with everything handed over does not spend the due counter', () => {
  reset([item('a', { sent: true })]);
  queue.tracksUntilLink = 1;
  queue.maybeWriteSeamLink(true);
  assert.equal(queue.tracksUntilLink, 0, 'still due — the next seam writes');
});

test('a request at the head does not spend the due counter', () => {
  reset([item('r', { aiPicked: false, requestedBy: 'alice' })]);
  queue.tracksUntilLink = 0;
  queue.maybeWriteSeamLink(true);
  assert.ok(queue.tracksUntilLink <= 0, `still due (got ${queue.tracksUntilLink})`);
});

test('a head that already has a line does not spend the due counter', () => {
  reset([item('s', { introScript: 'Already scripted.' })]);
  queue.tracksUntilLink = 1;
  queue.maybeWriteSeamLink(true);
  assert.equal(queue.tracksUntilLink, 0);
});

test('control: a seam that writes resets the counter', async () => {
  const next = item('w');
  reset([next]);
  queue.tracksUntilLink = 1;
  queue.maybeWriteSeamLink(true);
  assert.ok(queue.tracksUntilLink > 0, `a fresh interval (got ${queue.tracksUntilLink})`);
  for (let i = 0; i < 200 && !next.introScript; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(next.introScript, 'and the line was written');
});

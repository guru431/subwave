// Fork (C01, C04) on top of upstream's pair-aware drain (#1652).
//
// 1. A listener request jumps ahead of the first unsent auto-pick — but not
//    ahead of one already PAIRED with what plays before it: a stem seam (its
//    head is mixed into the clip ahead), or under the pair-aware drain the
//    successor the sent (or on-air) item was stamped against. Breaking that
//    pair airs the sent track's transition into the wrong song.
// 2. The seam link exists for a DEEP queue. At depth 1 (upstream behaviour) a
//    pair-held or queued item at track start must not count down the link
//    cadence — the pick path already does, and the DJ would speak half as often.
// Run: npm test -- queue-request-pair

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-queue-request-pair-'));

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');

(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};
const realPairDrainActive = (queue as any).pairDrainActive.bind(queue);

const track = (id: string) => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200 });
const pick = (id: string, sent = false) => ({ track: track(id), aiPicked: true, sent, requestedBy: null });

function setQueue(items: any[], { pairDrain, onAir = true }: { pairDrain: boolean; onAir?: boolean }) {
  queue.upcoming = items as any;
  queue.current = onAir ? { track: track('on-air'), source: 'ai' } as any : null;
  (queue as any).pairDrainActive = () => pairDrain;
}

const order = () => queue.upcoming.map((i: any) => i.track.id);

test('pair drain: a request waits behind the successor a sent item was paired with', async () => {
  setQueue([pick('X', true), pick('S'), pick('T')], { pairDrain: true });
  const pos = await queue.push({ track: track('R'), requestedBy: 'alice' });
  assert.deepEqual(order(), ['X', 'S', 'R', 'T']);
  assert.equal(pos, 3);
});

test('pair drain: the on-air track is paired with the head of the queue too', async () => {
  setQueue([pick('S'), pick('T')], { pairDrain: true });
  await queue.push({ track: track('R'), requestedBy: 'alice' });
  assert.deepEqual(order(), ['S', 'R', 'T']);
});

test('a stem seam is never split, pair drain or not', async () => {
  const s = { ...pick('S'), stemSeam: true };
  setQueue([pick('X', true), s, pick('T')], { pairDrain: false });
  await queue.push({ track: track('R'), requestedBy: 'alice' });
  assert.deepEqual(order(), ['X', 'S', 'R', 'T']);
});

test('control: eager drain still puts the request before the first unsent auto-pick', async () => {
  setQueue([pick('X', true), pick('S'), pick('T')], { pairDrain: false });
  const pos = await queue.push({ track: track('R'), requestedBy: 'alice' });
  assert.deepEqual(order(), ['X', 'R', 'S', 'T']);
  assert.equal(pos, 2);
});

test('pair drain with only the paired successor left: the request goes to the tail', async () => {
  setQueue([pick('X', true), pick('S')], { pairDrain: true });
  await queue.push({ track: track('R'), requestedBy: 'alice' });
  assert.deepEqual(order(), ['X', 'S', 'R']);
});

async function seamCountdown(lookahead: number) {
  await settings.update({ queue: { lookahead } } as never);
  setQueue([pick('S')], { pairDrain: true });
  queue.history = [{ track: track('before') }] as any;
  queue.tracksUntilLink = 5;
  queue.maybeWriteSeamLink(true);
  return queue.tracksUntilLink;
}

test('depth 1: a queued item at track start does not count down the link cadence', async () => {
  assert.equal(await seamCountdown(1), 5);
});

test('control: a deep queue counts the seam down', async () => {
  assert.equal(await seamCountdown(5), 4);
  (queue as any).pairDrainActive = realPairDrainActive;
});

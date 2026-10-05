// Fork (C03): a FORCED drain skips the pair-aware hold, never the held drain of
// a deep queue. Queue.DRAIN_AHEAD keeps at most one handed-over item in
// `upcoming`, so a listener request can still jump the rest (push() inserts
// before the first UNSENT auto-pick). Before this, `force` skipped that check
// too, and an operator skip (commitBeforeSkip) emptied a five-deep queue into
// dj_queue. A force reaches exactly what its caller needs: the head for a
// skip, or the one item a clip-as-track fire is waiting for.
// Real drain; Liquidsoap's 1s poll of next.txt is played by a fake consumer.
// Run: npm test -- drain-force

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, type TestContext } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-drain-force-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const { config } = await import('../src/config.js');
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');

(queue as any).persist = () => {};
(queue as any).verifyPushResolved = async () => {};
// The auto-DJ is not under test: onTrackStarted must not start a pick.
queue.autoPick = false;
queue.autoLink = false;

await settings.update({ transitions: { pairDrain: false } } as never);

// Liquidsoap's side of next.txt: consume each handoff so the next write
// does not wait out writeHandoff's 5s budget.
const consumer = setInterval(() => {
  const file = config.liquidsoap.queueFile;
  if (existsSync(file)) rmSync(file, { force: true });
}, 20);
after(() => clearInterval(consumer));

const item = (id: string, sent = false) => ({
  // replayGain: null — the loudness lookup would otherwise ask Navidrome.
  track: { id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200, replayGain: null },
  aiPicked: true, requestedBy: null, sent, introScript: null,
}) as any;

function reset(items: any[]) {
  queue.current = {
    // Ten minutes left: a pair-held head is nowhere near its hard deadline.
    track: { id: 'on-air', title: 'On Air', artist: 'Someone', duration: 600 },
    startedAt: new Date().toISOString(), source: 'ai',
  } as any;
  queue.lastSeenKey = null;
  queue.upcoming = items;
}

const sentIds = () => queue.upcoming.filter((i: any) => i.sent).map((i: any) => i.track.id);

async function settled() {
  for (let i = 0; i < 200 && queue.senderBusy; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(queue.senderBusy, false, 'the drain finished');
}

test('a forced drain with the head already handed over sends nothing more', async () => {
  reset([item('a', true), item('b'), item('c')]);
  await queue.drainToLiquidsoap(true);
  assert.deepEqual(sentIds(), ['a'], 'b and c stay on our side, where a request can still jump them');
});

// The pair-aware hold needs a DJ-mode persona and transitions.pairDrain on;
// a head with no successor is then held until its successor arrives.
async function withPairHold(t: TestContext) {
  const personas = settings.get().personas;
  await settings.update({
    personas: personas.map((p: any, i: number) => (i === 0 ? { ...p, djMode: true } : p)),
    transitions: { pairDrain: true },
  } as never);
  t.after(async () => {
    await settings.update({ personas, transitions: { pairDrain: false } } as never);
  });
  assert.equal(queue.pairDrainActive(), true, 'the pair hold is in effect');
}

test('a forced drain sends a pair-held head', async (t) => {
  await withPairHold(t);
  reset([item('a')]);
  await queue.drainToLiquidsoap();
  assert.deepEqual(sentIds(), [], 'control: the ordinary drain holds a head with no successor');
  await queue.drainToLiquidsoap(true);
  assert.deepEqual(sentIds(), ['a'], 'force reaches past the pair hold');
});

test('a forced drain that meets a busy sender runs when the sender frees', async (t) => {
  await withPairHold(t);
  reset([item('a')]);
  queue.senderBusy = true;
  await queue.drainToLiquidsoap(true);
  assert.equal(queue.pendingForceDrain, true, 'the force is remembered, not dropped');
  assert.deepEqual(sentIds(), []);
  // The in-flight drain finishing is what re-runs the pending force.
  queue.senderBusy = false;
  await queue.drainToLiquidsoap();
  for (let i = 0; i < 200 && !queue.upcoming[0].sent; i++) await new Promise(r => setTimeout(r, 10));
  await settled();
  assert.deepEqual(sentIds(), ['a']);
});

test('a clip-as-track target that meets a busy sender is reached after release', async () => {
  reset([item('a', true), item('b'), item('c')]);
  queue.senderBusy = true;
  await queue.drainToLiquidsoap(queue.upcoming[1]);
  assert.equal(queue.pendingForceItem, queue.upcoming[1]);
  queue.senderBusy = false;
  await queue.drainToLiquidsoap();
  for (let i = 0; i < 200 && !queue.upcoming[1].sent; i++) await new Promise(r => setTimeout(r, 10));
  await settled();
  assert.deepEqual(sentIds(), ['a', 'b'], 'b past DRAIN_AHEAD; c is not forced');
  assert.equal(queue.pendingForceItem, null);
});

test('the clip-as-track guard drains the item that fired, and nothing behind it', async () => {
  reset([item('a', true), item('b'), item('c')]);
  queue.onTrackStarted({ subsonic_id: 'b', title: 'Title b', artist: 'Artist b' } as any);
  for (let i = 0; i < 200 && !queue.upcoming[1].sent; i++) await new Promise(r => setTimeout(r, 10));
  await settled();
  assert.deepEqual(sentIds(), ['a', 'b'], 'b is handed over past DRAIN_AHEAD; c is not');
});

test('an ordinary drain still holds at DRAIN_AHEAD', async () => {
  reset([item('a'), item('b'), item('c')]);
  await queue.drainToLiquidsoap();
  assert.deepEqual(sentIds(), ['a']);
});

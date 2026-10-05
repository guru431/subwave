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
import test, { after } from 'node:test';

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
    track: { id: 'on-air', title: 'On Air', artist: 'Someone', duration: 200 },
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

test('a forced drain sends the held head and only the head', async () => {
  reset([item('a'), item('b'), item('c')]);
  await queue.drainToLiquidsoap(true);
  assert.deepEqual(sentIds(), ['a']);
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

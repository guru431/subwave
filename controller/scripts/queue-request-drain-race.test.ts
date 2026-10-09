// Fork (C01 + C03): a request that arrives while the drain is handing the head
// of the queue to Liquidsoap. The drain captures the head with
// `find(i => !i.sent)` and only marks it `sent` after loudness, bed and
// writeHandoff — up to a second per seam. A request pushed into that window
// used to go in FRONT of the head (it is still an unsent auto-pick), the head
// went out anyway, and the request sat unsent ahead of it: DRAIN_AHEAD would
// not pass it, and onTrackStarted's `splice(0, idx + 1)` threw it away as
// "played during the downtime" — while the listener had been told "#1".
// Real drain; Liquidsoap's 1s poll of next.txt is played by a fake consumer.
// Run: npm test -- queue-request-drain-race

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-request-drain-race-'));
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

// Without a DJ-mode persona there is no pair to protect, so a request goes in
// front of the first unsent auto-pick — the case the race lives in.
await settings.update({ transitions: { pairDrain: false } } as never);

const consumer = setInterval(() => {
  const file = config.liquidsoap.queueFile;
  if (existsSync(file)) rmSync(file, { force: true });
}, 20);
after(() => clearInterval(consumer));

const track = (id: string) => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200, replayGain: null });
const pick = (id: string, sent = false) => ({
  track: track(id), aiPicked: true, requestedBy: null, sent, introScript: null,
}) as any;

function reset(items: any[]) {
  queue.current = {
    track: { id: 'on-air', title: 'On Air', artist: 'Someone', duration: 600 },
    startedAt: new Date().toISOString(), source: 'ai',
  } as any;
  queue.lastSeenKey = null;
  queue.upcoming = items;
}

const order = () => queue.upcoming.map((i: any) => i.track.id);

async function settled() {
  for (let i = 0; i < 200 && queue.senderBusy; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(queue.senderBusy, false, 'the drain finished');
}

test('a request pushed while the head is being handed over is not dropped when the head airs', async (t) => {
  // Hold the drain between capturing the head and marking it sent — the
  // loudness lookup is one of the awaits in that window.
  const realGain = (queue as any).applyLoudnessGain;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const inWindow = new Promise<void>(r => { entered = r; });
  (queue as any).applyLoudnessGain = async () => { entered(); await gate; };
  t.after(() => { (queue as any).applyLoudnessGain = realGain; });

  const head = pick('a');
  reset([head]);
  const drained = queue.drainToLiquidsoap();
  await inWindow;

  const position = await queue.push({ track: track('r'), requestedBy: 'alice' });
  release();
  await drained;
  await settled();

  assert.equal(head.sent, true, 'the head went to Liquidsoap');
  assert.deepEqual(order(), ['a', 'r'], 'the request waits behind the head it could no longer overtake');
  assert.equal(position, 2, 'and the listener is told where it really is');

  queue.onTrackStarted({ subsonic_id: 'a', title: 'Title a', artist: 'Artist a' } as any);
  assert.deepEqual(order(), ['r'], 'the head airing does not take the request with it');
});

test('a track starting drops only the HANDED-OVER items ahead of it', async () => {
  // However an unsent item ended up ahead of a sent one, Liquidsoap never
  // received it, so it cannot have been played during any downtime.
  reset([{ ...pick('r'), aiPicked: false, requestedBy: 'alice' }, pick('x', true), pick('a', true), pick('b')]);
  queue.onTrackStarted({ subsonic_id: 'a', title: 'Title a', artist: 'Artist a' } as any);
  assert.deepEqual(order(), ['r', 'b'], 'x was consumed during the downtime; r never left our side');
  assert.equal(queue.current?.track.id, 'a');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAnchorFrame, topUpDepth } from '../src/broadcast/queue/pure.js';

test('a station at the default depth never tops up', () => {
  // lookahead 1 is upstream's behaviour: the pick happens when the queue drains
  assert.equal(topUpDepth({ lookahead: 1, queued: 1, sameShow: true }), 0);
  assert.equal(topUpDepth({ lookahead: 1, queued: 0, sameShow: true }), 1);
});

test('tops up to the configured depth', () => {
  assert.equal(topUpDepth({ lookahead: 5, queued: 0, sameShow: true }), 5);
  assert.equal(topUpDepth({ lookahead: 5, queued: 3, sameShow: true }), 2);
  assert.equal(topUpDepth({ lookahead: 5, queued: 5, sameShow: true }), 0);
});

test('an over-full queue is not a negative top-up', () => {
  // a listener request can push the queue past the depth; that is not a cue to
  // remove anything, just to stop picking
  assert.equal(topUpDepth({ lookahead: 5, queued: 7, sameShow: true }), 0);
});

test('a show boundary stops the top-up where it stands', () => {
  // the pick would air under the NEXT show's rules while being chosen under
  // this one's — the queue simply stays shorter until the show changes
  assert.equal(topUpDepth({ lookahead: 5, queued: 2, sameShow: false }), 0);
});

test('the boundary never blocks the first track', () => {
  // an empty queue at a boundary still needs the one track that plays next,
  // otherwise the station falls through to the auto playlist
  assert.equal(topUpDepth({ lookahead: 5, queued: 0, sameShow: false }), 1);
});

test('a nonsense depth degrades to upstream behaviour', () => {
  assert.equal(topUpDepth({ lookahead: 0, queued: 0, sameShow: true }), 1);
  assert.equal(topUpDepth({ lookahead: Number.NaN, queued: 0, sameShow: true }), 1);
  assert.equal(topUpDepth({ lookahead: 2.7, queued: 0, sameShow: true }), 2);
});

// ── the anchored pick's lead and predecessor ───────────────────────────────
// A top-up anchors on the TAIL of the queue: the pick airs after every queued
// track, so all of them count toward the lead, and what the anchor itself
// follows is the item ahead of it — not the on-air track.

type It = { id: string; dur: number };
const on: It = { id: 'on-air', dur: 240 };
const q: It[] = [{ id: 'a', dur: 200 }, { id: 'b', dur: 180 }, { id: 'c', dur: 300 }];
const frame = (anchor: It, remainingSec: number | null = 60, upcoming: It[] = q) =>
  pickAnchorFrame({ upcoming, anchor, current: on, remainingSec, durationSec: i => i.dur });

test('a top-up anchored on the tail counts every queued track in its lead', () => {
  const f = frame(q[2]);
  assert.equal(f.leadSec, 60 + 200 + 180 + 300);
  assert.equal(f.prior, q[1], 'the tail follows the item ahead of it');
});

test('an anchor at the head is the deadline path, unchanged', () => {
  const f = frame(q[0]);
  assert.equal(f.leadSec, 60 + 200, 'remaining on air plus the held track');
  assert.equal(f.prior, on, 'the head follows the on-air track');
});

test('a queued track of unknown length means no look-ahead', () => {
  const holey = [q[0], { id: 'x', dur: 0 }, q[2]];
  assert.equal(frame(holey[2], 60, holey).leadSec, null);
  assert.equal(frame(q[2], null).leadSec, null, 'an unknown on-air clock too');
});

test('an anchor no longer in the queue falls back to itself after the on-air track', () => {
  const gone = { id: 'gone', dur: 120 };
  const f = frame(gone);
  assert.equal(f.leadSec, 60 + 120);
  assert.equal(f.prior, on);
});

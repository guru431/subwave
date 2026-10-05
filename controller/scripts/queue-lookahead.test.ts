import test from 'node:test';
import assert from 'node:assert/strict';
import { topUpDepth } from '../src/broadcast/queue/pure.js';

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

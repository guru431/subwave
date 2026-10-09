// Fork (C08 + C03): the hard artist window covers the WHOLE queue.
//
// pickViaAgent took the queue's artists for the hours window only from
// neighbourArtistRoots(artistVarietyWindow), which reads the queue's TAIL
// (`upcoming.slice(-n)`) and nothing at all at n = 0. With queue.lookahead
// deeper than the window, the head of the queue fell out of it, and a top-up
// could choose an artist already waiting to air — the repeat C08 exists to stop.
//
// Drives the production runTrackEvent -> pickViaAgent -> runArtistGuard path,
// as pair-drain-interleaving.test.ts does; only pickerAgent.run is faked. The
// run surfaces no other artist and the test library is empty, so a guard that
// fires ends in the logged relaxation — the line is the assertion.
//
// Run: npm test -- artist-window-deep-queue

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-artist-window-deep-queue-'));
// The pool rescue asks Navidrome for candidates: refuse at once, not on a timeout.
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const session = await import('../src/broadcast/session.js');

const q = queue as any;
q.persist = () => {};
const realRun = (pickerAgent as any).run;

after(() => {
  (pickerAgent as any).run = realRun;
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  library.shutdown();
});

const ctx = { activeShow: null, clock: {}, time: { period: 'day' }, dominantMood: null };

before(async () => {
  await settings.load();
  await settings.update({ llm: { pickerAgent: true, dailyTokenCap: 0 } } as never);
  session.start(ctx as any);
});

const track = (id: string, artist: string) => ({ id, title: `Title ${id}`, artist, duration: 240 });

// A ten-deep queue (queue.lookahead 10) whose FIRST item is by the artist the
// agent is about to pick again.
async function pickBehindDeepQueue(window: number) {
  await settings.update({ llm: { artistVarietyWindow: window } } as never);
  q.current = { track: track('on-air', 'Someone Else'), source: 'ai', startedAt: new Date().toISOString() };
  q.upcoming = [
    { track: track('q1', 'Kate Bush'), aiPicked: true, sent: true, queuedAt: new Date().toISOString() },
    ...Array.from({ length: 9 }, (_, i) => ({
      track: track(`q${i + 2}`, `Filler Artist ${i + 2}`), aiPicked: true, sent: false, queuedAt: new Date().toISOString(),
    })),
  ];
  q.history = [];
  q.djLog = [];
  q._recentPlays = [];
  q.senderBusy = true;            // never reach Liquidsoap's handoff files
  const again = track('kb2', 'Kate Bush');
  (pickerAgent as any).run = async () => ({
    object: { id: again.id, reason: 'More Kate Bush.', say: null, transition: 'normal' },
    steps: 1,
    toolCalls: [],
    extras: { seen: new Map([[again.id, again]]) },
  });
  try {
    await runTrackEvent(queue, ctx, { wantLink: false, pickAnchor: q.upcoming.at(-1).track });
  } finally {
    q.senderBusy = false;
  }
  return queue.djLog.find(e => e.kind === 'picker' && e.message.includes('artist "Kate Bush"'))?.message ?? null;
}

test('the head of a queue deeper than the spacing window is inside the artist window', async () => {
  const line = await pickBehindDeepQueue(5);
  assert.match(line ?? '', /^recently-played artist "Kate Bush" \(heard within [\d.]+ h\)/,
    'Kate Bush is queued nine slots ahead of this pick — the hours window must see her');
});

test('a spacing window of 0 still leaves the queued artists inside the artist window', async () => {
  const line = await pickBehindDeepQueue(0);
  assert.match(line ?? '', /^recently-played artist "Kate Bush" \(heard within [\d.]+ h\)/);
});

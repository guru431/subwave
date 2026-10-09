// Fork (C03): a top-up cycle does not air the show handoff while a request or
// studio track is still queued.
//
// Upstream airs a pending mic-pass from the pick cycle, which it runs on an
// EMPTY queue — anything queued airs first, and a handoff never lands between
// two tracks of one record. The fork's top-up runs runPickCycle on a NON-empty
// queue: a studio block crossing a show change, the session rolled, the queue
// below `queue.lookahead` — and the top-up aired the sign-off and greeting
// with block tracks still to play. It now releases the handoff only when every
// queued item is an auto-pick; otherwise a later cycle does.
//
// Real runPickCycle -> session.maybeRoll -> runPersonaHandoff -> runTrackEvent;
// only the model and the weather fetch are faked. The station voice is off, so
// a released handoff is marked aired at once instead of rendering — which is
// exactly the observable: pending before, gone after.
// Run: npm test -- queue-handoff-topup

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-handoff-topup-'));
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent } = await import('../src/broadcast/dj-agent.js');

const q = queue as any;
q.persist = () => {};
q.drainToLiquidsoap = async () => {};
queue.autoPick = false;               // no top-up chain: each test runs one cycle

const realFetch = globalThis.fetch;
const realRun = (pickerAgent as any).run;
after(() => { globalThis.fetch = realFetch; (pickerAgent as any).run = realRun; });

const track = (id: string, duration = 240) => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration });

before(async () => {
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  await settings.load();
  const personas = settings.get().personas;
  assert.ok(personas.length >= 2);
  // "Long Player" (its own host) holds every grid hour; a Default-programming
  // takeover began five minutes ago — the show change the block ran across.
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill('long');
  const changeAt = Date.now() - 5 * 60_000;
  await settings.update({
    timezone: 'UTC',
    activePersonaId: personas[0].id,
    shows: [{ id: 'long', name: 'Long Player', topic: 'ambient', personaId: personas[1].id }],
    schedule: week,
    scheduleOverride: { showId: null, startedAt: changeAt, expiresAt: changeAt + 3_600_000 },
    queue: { lookahead: 5 },
    tts: { enabled: false },
    llm: { pickerAgent: true, dailyTokenCap: 0 },
  } as never);
  // The outgoing show's session, opened before the change.
  const before = new Date(changeAt - 5 * 60_000);
  session.start({ activeShow: settings.resolveActiveShow(before), at: before.toISOString(), time: { period: 'day' } } as never);
  assert.equal(session.getSession()?.key, 'show:long');
});

let n = 0;
async function topUpCycle(upcoming: unknown[]) {
  queue.current = { track: track('on-air', 300), startedAt: new Date(Date.now() - 60_000).toISOString(), source: 'ai' } as never;
  queue.upcoming = upcoming as never;
  queue.djLog = [];
  const pick = track(`np${++n}`);
  (pickerAgent as any).run = async () => ({
    object: { id: pick.id, reason: 'Next.', say: null, transition: 'normal' },
    steps: 1, toolCalls: [], extras: { seen: new Map([[pick.id, pick]]) },
  });
  queue.runPickCycle({ isAutonomous: true, topUp: true });
  for (let i = 0; i < 500 && queue.pickerBusy; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(queue.pickerBusy, false, 'the cycle finished');
}

const studio = (id: string, index: number) => ({
  track: track(id), requestedBy: 'studio', operator: true, sent: index === 1,
  block: { id: 'blk', label: 'An Album', index, size: 5 }, queuedAt: new Date().toISOString(),
});
const autoPick = (id: string) => ({ track: track(id), aiPicked: true, sent: false, queuedAt: new Date().toISOString() });

test('three block tracks still queued: the top-up rolls the session but holds the mic-pass', async () => {
  await topUpCycle([studio('b3', 1), studio('b4', 2), studio('b5', 3)]);
  assert.notEqual(session.getSession()?.key, 'show:long', 'the session changed over');
  assert.ok(session.pendingHandoff(), 'the handoff still waits for the block to finish');
  assert.ok(queue.djLog.some(e => /Show handoff held/.test(e.message)), 'and the booth log says why');
  assert.ok(queue.upcoming.some(i => i.track.id === 'np1'), 'the top-up itself still picked');
});

test('a listener request still queued holds it too', async () => {
  await topUpCycle([
    { track: track('r'), requestedBy: 'alice', sent: false, queuedAt: new Date().toISOString() },
    autoPick('p1'),
  ]);
  assert.ok(session.pendingHandoff());
});

test('with only auto-picks queued the next top-up releases it', async () => {
  await topUpCycle([autoPick('p1'), autoPick('p2')]);
  assert.equal(session.pendingHandoff(), null, 'released (the voice is off, so marked aired)');
});

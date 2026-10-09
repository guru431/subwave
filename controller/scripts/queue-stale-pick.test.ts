// Fork (C01 + C03): an auto-pick pushed into the NEXT show by a request or a
// studio block is dropped, so the incoming show does not air the outgoing
// show's picks after its mic-pass.
//
// The top-up stops at a show boundary only for NEW picks. A block (or a
// request) jumps ahead of the unsent auto-picks — on purpose, C01 — and shifts
// them later; nothing rechecked them, so a long block shortly before a
// changeover carried up to lookahead-1 picks of the outgoing show into the
// incoming one. Now an auto-pick remembers the show it was chosen for, and an
// unsent one whose air forecast (queue.airForecastSec, the forecast the block's
// runsPastShowChange warning reads) lands in another show is taken off the
// queue. Requests, block members, handed-over items, the armed handoff's final
// track and items from an older queue.json (no stamp) are never touched.
//
// The show change is a timed takeover, not a grid hour, so nothing here
// depends on when the suite runs (as in show-boundary-drain.test.ts).
// Run: npm test -- queue-stale-pick

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-stale-pick-'));
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
queue.autoPick = false;

const REMAINING_SEC = 60;
// "Long Player" holds every grid hour; a Default-programming takeover starts
// ten minutes from now and is the show change.
const boundaryMs = Date.now() + 600_000;
const LONG = 'show:long';

await settings.load();
const personas = settings.get().personas;
assert.ok(personas.length >= 2, 'two personas: the handoff case needs a host change');
const week: Record<number, (string | null)[]> = {};
for (let d = 0; d < 7; d++) week[d] = Array(24).fill('long');
await settings.update({
  timezone: 'UTC',
  transitions: { pairDrain: false },
  activePersonaId: personas[0].id,
  shows: [{ id: 'long', name: 'Long Player', topic: 'ambient', personaId: personas[1].id }],
  schedule: week,
  scheduleOverride: { showId: null, startedAt: boundaryMs, expiresAt: boundaryMs + 3_600_000 },
} as never);

const track = (id: string, duration: number) => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration });
const pick = (id: string, extra: Record<string, unknown> = {}) => ({
  track: track(id, 200), aiPicked: true, requestedBy: null, sent: false,
  queuedAt: new Date().toISOString(), pickedForShow: LONG, ...extra,
});

beforeEach(() => {
  queue.current = {
    track: track('on-air', 600),
    startedAt: new Date(Date.now() - (600 - REMAINING_SEC) * 1000).toISOString(),
    source: 'ai',
  } as never;
  queue.djLog = [];
});

const order = () => queue.upcoming.map(i => i.track.id);

// The studio's block press, as POST /dj/queue-block pushes it.
async function pushBlock(n: number, secs = 240) {
  for (let i = 0; i < n; i++) {
    await queue.push({
      track: track(`b${i + 1}`, secs), requestedBy: 'studio', operator: true, allowDuplicate: true,
      block: { id: 'blk', label: 'An Album', index: i + 1, size: n },
    });
  }
}

test('a block before a show change drops the auto-picks it pushes into the next show', async () => {
  // Before the block: x1 airs in 60 s, the request at 260 s, p2 at 460 s and
  // p3 at 660 s (+120 s attribution) — p2 inside Long Player, as chosen.
  queue.upcoming = [
    pick('x1', { sent: true }),
    { track: track('r', 200), requestedBy: 'alice', sent: false, queuedAt: new Date().toISOString() },
    pick('p2'),
    pick('legacy', { pickedForShow: undefined }),   // a snapshot from before the stamp
  ] as never;
  await pushBlock(3);
  assert.deepEqual(order(), ['x1', 'r', 'b1', 'b2', 'b3', 'legacy'],
    'p2 now airs after the changeover and goes; the request, the block, the sent item and the unstamped item stay');
  const line = queue.djLog.find(e => /auto-pick/.test(e.message))?.message ?? '';
  assert.match(line, /Title p2/, 'the booth log names what was dropped');
  assert.match(line, /Long Player/, 'and the show it was chosen for');
});

test('a pick moved later but still inside its own show stays', async () => {
  queue.upcoming = [pick('x1', { sent: true }), pick('p2')] as never;
  await pushBlock(1, 30);                    // p2: 260 s → 290 s, still before the change
  assert.deepEqual(order(), ['x1', 'b1', 'p2']);
});

test('a pick chosen for the INCOMING show is never dropped for airing early', async () => {
  // Look-ahead picks for the next show are the handoff's business, not this
  // rule's: n1 was picked for the takeover yet is forecast before it (a skip or
  // a cancel moves picks EARLIER), and the block below does not change that.
  queue.upcoming = [
    pick('x1', { sent: true, track: track('x1', 100) }),
    pick('p2', { track: track('p2', 100) }),
    pick('n1', { pickedForShow: 'default' }),
  ] as never;
  await pushBlock(1, 30);
  assert.deepEqual(order(), ['x1', 'b1', 'p2', 'n1']);
});

test("the armed handoff's final outgoing track is kept even when pushed past the change", async (t) => {
  session.start({ activeShow: settings.resolveActiveShow(new Date()), at: new Date().toISOString(), time: { period: 'day' } } as never);
  const incoming = { activeShow: null, at: new Date(boundaryMs + 60_000).toISOString(), time: { period: 'day' } };
  queue.upcoming = [pick('x1', { sent: true }), pick('p2'), pick('n1', { pickedForShow: 'default' })] as never;
  assert.equal(session.armBoundaryHandoff(incoming as never, queue.upcoming[1].track), true, 'handoff armed on p2');
  t.after(() => session.start({ activeShow: null, time: { period: 'day' } } as never));
  await pushBlock(3);
  assert.deepEqual(order(), ['x1', 'b1', 'b2', 'b3', 'p2', 'n1'],
    'p2 carries the sign-off and greeting; dropping it would strand the armed pair');
});

test('a pick still being made when a block jumps in is rechecked once it lands', async (t) => {
  // The push-time recheck runs before this pick exists; the pick cycle that
  // saw the block runs it again. Real runPickCycle -> runTrackEvent ->
  // pickViaAgent -> enqueuePick -> push; only the model (and the weather
  // fetch) are faked.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const realRun = (pickerAgent as any).run;
  t.after(() => { globalThis.fetch = realFetch; (pickerAgent as any).run = realRun; });
  await settings.update({ llm: { pickerAgent: true, dailyTokenCap: 0 } } as never);
  session.start({ activeShow: settings.resolveActiveShow(new Date()), at: new Date().toISOString(), time: { period: 'day' } } as never);

  // The top-up anchors on p2: it reads its rules for 60+100+100 s from now
  // (+120 s) — inside Long Player.
  queue.upcoming = [
    pick('x1', { sent: true, track: track('x1', 100) }),
    pick('p2', { track: track('p2', 100) }),
  ] as never;
  const np = track('np', 200);
  (pickerAgent as any).run = async () => {
    await pushBlock(2);                      // 480 s lands while the model is "thinking"
    return {
      object: { id: np.id, reason: 'Next.', say: null, transition: 'normal' },
      steps: 1, toolCalls: [], extras: { seen: new Map([[np.id, np]]) },
    };
  };
  queue.runPickCycle({ isAutonomous: true, topUp: true });
  for (let i = 0; i < 500 && queue.pickerBusy; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(queue.pickerBusy, false, 'the pick cycle finished');
  assert.ok(queue.djLog.some(e => e.kind === 'ai-pick' && /Title np/.test(e.message)), 'the pick was queued');
  assert.deepEqual(order(), ['x1', 'b1', 'b2'], 'p2 went at the push, np after its own cycle');
});

test('an auto-pick remembers the show its rules came from', async () => {
  queue.upcoming = [] as never;
  await queue.push({ track: track('a', 200), aiPicked: true, pickShowAt: new Date() } as never);
  await queue.push({ track: track('b', 200), aiPicked: true, pickShowAt: new Date(boundaryMs + 60_000) } as never);
  await queue.push({ track: track('c', 200), requestedBy: 'alice' });
  const stamps = Object.fromEntries(queue.upcoming.map(i => [i.track.id, (i as any).pickedForShow]));
  assert.deepEqual(stamps, { c: undefined, a: LONG, b: 'default' });
});

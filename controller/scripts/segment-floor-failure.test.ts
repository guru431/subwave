// Fork: the segment director's frequency floor is spent by a FAILED attempt,
// not only by a segment that aired — the rule Queue.maybeWriteSeamLink already
// follows for its link counter (C04). Before, a line that could not render (TTS
// endpoint down, F5 out of memory) left lastAnySegment untouched, so the next
// 5-minute tick asked the model again: three to six times the station's own
// cadence, every call written and thrown away. Silence is NOT a failure — the
// model choosing not to speak keeps the director's every-tick re-ask, as
// upstream designed.
//
// The clock is faked (node:test mock timers, Date only) so the floor can be
// crossed without waiting it out.

import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-segment-floor-'));
process.env.STATE_DIR = root;

const skillDir = join(root, 'skills', 'floor-skill');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: floor-skill\ncooldown: 0\n---\nSay one sentence about the moment.\n');

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { agenticTick, directorAgent } = await import('../src/skills/_agent.js');

// A moderate station: 15 minutes between any two segments.
const FLOOR_MS = 15 * 60 * 1000;
mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 15, 10, 5, 0).getTime() });

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_floor', name: 'Host', skills: ['floor-skill'], frequency: 'moderate', djMode: false };

function ctx() {
  return { at: new Date().toISOString(), time: { period: 'day' }, clock: {}, weather: null } as any;
}

let calls = 0;
const realRun = directorAgent.run;
const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

function segmentReply() {
  return {
    object: { air: true, reason: 'worth saying', segment: { kind: 'floor-skill', text: 'A line for the listener.', sfx: null } },
    steps: 1, toolCalls: [], extras: undefined,
  };
}

await settings.load();
await settings.update({
  personas: [HOST], activePersonaId: HOST.id,
  skills: { enabled: { 'floor-skill': true } },
  llm: { pickerAgent: true },
  sfx: { enabled: false },
} as never);
session.start(ctx());
await loadSkills();
queue.senderBusy = true;
(queue as any)._airVoice = async () => ({ voiceId: 'unexpected', clipMs: 1_000, aired: Promise.resolve(null) });

after(async () => {
  directorAgent.run = realRun;
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = false;
  mock.timers.reset();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

test('a model that chooses silence is asked again on the next tick', async () => {
  calls = 0;
  directorAgent.run = (async () => {
    calls += 1;
    return { object: { air: false, reason: 'nothing fresh', segment: { kind: '', text: '', sfx: null } }, steps: 1, toolCalls: [], extras: undefined };
  }) as any;
  await agenticTick(ctx());
  mock.timers.tick(5 * 60 * 1000);
  await agenticTick(ctx());
  assert.equal(calls, 2, 'silence is a decision, not a spent attempt');
});

test('a segment that fails to render spends the floor', async () => {
  calls = 0;
  directorAgent.run = (async () => { calls += 1; return segmentReply(); }) as any;
  (queue as any)._speak = async () => { throw new Error('remote TTS 502: upstream down'); };

  await agenticTick(ctx());
  assert.equal(calls, 1);
  mock.timers.tick(5 * 60 * 1000);
  await agenticTick(ctx());
  assert.equal(calls, 1, 'the next tick inside the floor must not call the model again');

  mock.timers.tick(FLOOR_MS);
  await agenticTick(ctx());
  assert.equal(calls, 2, 'past the floor the director is offered the minute again');
});

test('a model call that fails outright spends the floor too', async () => {
  mock.timers.tick(FLOOR_MS);
  calls = 0;
  directorAgent.run = (async () => { calls += 1; throw new Error('fetch failed'); }) as any;

  await agenticTick(ctx());
  mock.timers.tick(5 * 60 * 1000);
  await agenticTick(ctx());
  assert.equal(calls, 1, 'a failing provider is not retried on every tick');
});

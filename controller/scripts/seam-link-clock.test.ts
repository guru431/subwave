// Fork (C04): the seam link (writeSeamLink) builds its prompt through the
// verified context packet, which offers "Approximate air time" only on
// `clockIsAirTime`. Upstream moved the station clock switch into the callers,
// so the seam path must pass it too — otherwise a station with clock speech
// off gets a timed seam link and no drift stamp to catch it.
// Real writeSeamLink and provider adapter; only the model HTTP is faked.
// Run: npm test -- seam-link-clock

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-seam-link-clock-'));

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { writeSeamLink } = await import('../src/broadcast/dj-agent.js');

const realFetch = globalThis.fetch;
const modelRequests: Array<{ messages?: unknown[] }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1:9/')) {
    return new Response(JSON.stringify({ error: 'offline fixture' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
  modelRequests.push(JSON.parse(String(init?.body || '{}')));
  return new Response(JSON.stringify({
    id: `chatcmpl-${modelRequests.length}`,
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'A deterministic fixture seam link.' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => { globalThis.fetch = realFetch; });

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
} as never);

session.start({
  at: new Date().toISOString(),
  activeShow: null,
  dominantMood: 'calm',
  time: { period: 'daytime', vibe: 'steady' },
} as Parameters<typeof session.start>[0]);

function fixtureQueue() {
  return {
    upcoming: [] as any[],
    // Five minutes until the seam item airs: a valid runway for a clock line.
    remainingUntilItemAirs: () => 300,
    getDjRecap: () => null,
    getRecentTracks: () => [],
    getRecentOpeners: () => [],
    getLastLinkText: () => null,
    persist: () => {},
    log: () => {},
    startIntroRender: async () => {},
  };
}

async function seamLinkWire(speakClock: boolean) {
  await settings.update({ djSpeakClock: speakClock } as never);
  const queue = fixtureQueue();
  const item: any = {
    track: { id: `seam-${speakClock}`, title: 'Seam Song', artist: 'Seam Artist', duration: 200 },
    sent: false,
  };
  queue.upcoming.push(item);
  const before = modelRequests.length;
  const wrote = await writeSeamLink(queue, item, { id: 'prev', title: 'Before', artist: 'Prev Artist' });
  assert.equal(modelRequests.length, before + 1, 'one model call for the seam link');
  return { wrote, item, wire: JSON.stringify(modelRequests[before].messages ?? []) };
}

const clockOff = await seamLinkWire(false);
const clockOn = await seamLinkWire(true);

test('with clock speech disabled the seam link is not offered an approximate air time', () => {
  assert.equal(clockOff.wrote, true);
  assert.doesNotMatch(clockOff.wire, /Approximate air time:/);
  assert.equal(clockOff.item.linkClockAt, null);
});

test('control: with clock speech enabled the same seam link is offered its air time', () => {
  assert.equal(clockOn.wrote, true);
  assert.match(clockOn.wire, /Approximate air time:/);
  assert.notEqual(clockOn.item.linkClockAt, null);
});

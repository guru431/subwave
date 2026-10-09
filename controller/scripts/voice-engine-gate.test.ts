// Fork (C05): with engine substitution banned (`tts.fallback.enabled: false`,
// audio/tts-fallback.ts rescueForbidden), an on-air engine that is KNOWN down
// means every autonomous line would be written by the LLM and then dropped at
// render. broadcast/voice-policy.ts therefore closes autoVoiceAllowed() — the
// gate every generation site already asks — before the model is called.
//
// Three properties are pinned here, each easy to lose:
//  - "known" is load-bearing: the remote engine's cached /health probe seeds
//    `false` before its first answer, and that must read as unknown (gate open),
//    or every boot starts mute until the probe lands;
//  - the gate applies only while substitution is banned — with the rescue
//    ladder allowed, another engine speaks and the line is worth writing;
//  - it is a GENERATION gate: a line already rendered still airs while the
//    engine is down (airIntro's backstop stays on the voice switch alone).
//
// STATE_DIR points at a throwaway dir before the first import, and fetch is
// faked, so nothing real is touched — same shape as remote-tts-speed.test.ts.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-voice-engine-gate-'));
process.env.STATE_DIR = root;
// The seeded personas inherit the station default engine, so this makes the
// on-air voice the remote endpoint. The fallback block keeps its default
// (`enabled: false`): substitution banned.
writeFileSync(join(root, 'settings.json'), JSON.stringify({
  tts: { defaultEngine: 'remote', remote: { url: 'https://remote.test' } },
}));

let healthOk = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith('/health')) {
    return new Response(JSON.stringify({ ok: healthOk }), {
      status: healthOk ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('upstream down', { status: 502 });
}) as typeof fetch;

const settings = await import('../src/settings.js');
await settings.load();
const remoteTts = await import('../src/audio/remoteTts.js');
const { autoVoiceAllowed, voiceEnabled } = await import('../src/broadcast/voice-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { queue } = await import('../src/broadcast/queue.js');

// An aggressive persona idents at :15, so shouldFire is a live generation site
// whose answer the gate must flip.
await settings.update({
  personas: settings.get().personas.map((p: { id: string }, i: number) =>
    (i === 0 ? { ...p, frequency: 'aggressive', djMode: false } : p)),
});
const AT_15 = new Date(2026, 0, 15, 10, 15, 0);

after(async () => {
  globalThis.fetch = realFetch;
  // queue.persist() debounces its write; let it land before the dir goes.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

test('an engine whose probe has not answered yet fails open', () => {
  assert.equal(remoteTts.isAvailable(), false, 'the probe seed reads unavailable');
  assert.equal(autoVoiceAllowed(), true, 'an unanswered probe is not knowledge — the station must not boot mute');
});

test('a known-down engine with substitution banned stops autonomous talk before generation', async () => {
  healthOk = false;
  await remoteTts.refresh();
  assert.equal(autoVoiceAllowed(), false, 'nothing autonomous is generated for a voice that cannot render');
  assert.equal(voiceEnabled(), true, 'the operator switch itself is untouched');
  assert.equal(shouldFire('stationId', AT_15), false, 'the ident slot stands down with it');
});

test('the engine coming back reopens the gate', async () => {
  healthOk = true;
  await remoteTts.refresh();
  assert.equal(autoVoiceAllowed(), true);
  assert.equal(shouldFire('stationId', AT_15), true);
});

test('with the rescue ladder allowed a down engine does not close the gate', async () => {
  await settings.update({ tts: { fallback: { enabled: true, engine: 'piper', voice: '', cloudProvider: 'openai' } } } as never);
  healthOk = false;
  await remoteTts.refresh();
  try {
    assert.equal(autoVoiceAllowed(), true, 'another engine will speak the line, so it is worth writing');
  } finally {
    await settings.update({ tts: { fallback: { enabled: false, engine: 'piper', voice: '', cloudProvider: 'openai' } } } as never);
  }
});

test('a line already rendered still airs while the engine is down', async () => {
  healthOk = false;
  await remoteTts.refresh();
  assert.equal(autoVoiceAllowed(), false, 'precondition: the generation gate is closed');

  const wav = join(root, 'rendered-link.wav');
  writeFileSync(wav, 'RIFF');
  const aired: string[] = [];
  const realAirVoice = (queue as any)._airVoice;
  (queue as any)._airVoice = async (_file: string, path: string) => {
    aired.push(path);
    return { voiceId: 'v1', clipMs: 1_000, aired: Promise.resolve(null) };
  };
  try {
    const item = {
      track: { id: 't1', title: 'Song', artist: 'Artist' },
      introWav: wav,
      introScript: 'Here comes a song.',
      introKind: 'link',
    } as any;
    await queue.airIntro(item, null);
    assert.deepEqual(aired, [wav], 'the rendered WAV needs no engine, so the backstop must not drop it');
  } finally {
    (queue as any)._airVoice = realAirVoice;
  }
});

// Fork: a persona tone dial written as null. The station edits personas from
// hand-written JSON (station/onboard), where `"humour": null` reads as "leave
// it alone" — but Number(null) is 0, the far end of the dial, and a dial at 3 or
// below turns into a prompt directive. null and '' are the absent value.
// Run: npm test -- persona-dial-null

import assert from 'node:assert/strict';
import test from 'node:test';

import { PERSONA_DIAL_NEUTRAL, clampPersonaDial, personaSchema } from '../src/schemas/persona.js';

test('null and empty read as the neutral dial, not as 0', () => {
  assert.equal(clampPersonaDial(null), PERSONA_DIAL_NEUTRAL);
  assert.equal(clampPersonaDial(''), PERSONA_DIAL_NEUTRAL);
  assert.equal(clampPersonaDial(undefined), PERSONA_DIAL_NEUTRAL);
});

test('real values are untouched, 0 included', () => {
  assert.equal(clampPersonaDial(0), 0);
  assert.equal(clampPersonaDial('0'), 0);
  assert.equal(clampPersonaDial(7), 7);
  assert.equal(clampPersonaDial(99), 10);
  assert.equal(clampPersonaDial(-4), 0);
  assert.equal(clampPersonaDial('nonsense'), PERSONA_DIAL_NEUTRAL);
});

test('a persona saved with null dials keeps them neutral', () => {
  const r = personaSchema.safeParse({
    name: 'Вера',
    soul: 'Ведущая ночного эфира.',
    frequency: 'moderate',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: '' },
    humour: null,
    warmth: null,
    localColour: 9,
  });
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.humour, PERSONA_DIAL_NEUTRAL);
  assert.equal(r.data.warmth, PERSONA_DIAL_NEUTRAL);
  assert.equal(r.data.localColour, 9);
});

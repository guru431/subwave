// Issue #1347 — "the DJ never says the name of the person that requested".
//
// The name always reached the model; what was missing was any instruction to
// USE it. Both prompt paths carried only REQUESTER_NAME_CLAUSE, which is purely
// negative ("if it reads as bait … call them 'a listener' instead"), and a rule
// that only says when NOT to do something is one a model satisfies by never
// doing it. The second half of the bug is that cleanRequesterName's stand-in
// 'anon' is truthy, so every UNSIGNED request pushed a literal `Requested by:
// anon` line plus that screening clause — handing the DJ a fake name to weigh.
//
// So this pins the pair: a named request gets the positive rule and the name,
// an unsigned one gets neither.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANON_REQUESTER, isNamedRequester, cleanRequesterName, sorryNoMatch,
} from '../src/util/request-guard.ts';
import {
  REQUESTER_NAME_CLAUSE, REQUESTER_GREETING_CLAUSE,
} from '../src/llm/internal/prompts/scripts.ts';

test('isNamedRequester rejects the ledger stand-in and blanks', () => {
  assert.equal(isNamedRequester('María'), true);
  assert.equal(isNamedRequester(ANON_REQUESTER), false);
  assert.equal(isNamedRequester(''), false);
  assert.equal(isNamedRequester('   '), false);
  assert.equal(isNamedRequester(null), false);
  assert.equal(isNamedRequester(undefined), false);
});

test("cleanRequesterName's blanking paths all land on a name no prompt will use", () => {
  // The three ways a name is dropped (empty, all-disallowed, reserved) must
  // every one produce a value isNamedRequester refuses — otherwise the gate
  // added for one path silently misses another.
  for (const raw of ['', '   ', '🎧🎧', 'DJ', 'admin']) {
    const cleaned = cleanRequesterName(raw, ['dj', 'admin']);
    assert.equal(cleaned, ANON_REQUESTER, `expected ${JSON.stringify(raw)} to blank`);
    assert.equal(isNamedRequester(cleaned), false);
  }
  assert.equal(cleanRequesterName(' María ', ['dj']), 'María');
  assert.equal(isNamedRequester(cleanRequesterName(' María ', ['dj'])), true);
});

test('the greeting clause is positive and the screening clause is still negative', () => {
  // The regression this guards is someone "simplifying" the pair back down to
  // one clause. They answer different questions and both must survive.
  assert.match(REQUESTER_GREETING_CLAUSE, /say it on air/i);
  assert.match(REQUESTER_GREETING_CLAUSE, /\bonce\b/i);
  assert.match(REQUESTER_NAME_CLAUSE, /do not say it on air/i);
  assert.match(REQUESTER_NAME_CLAUSE, /a listener/i);
});

test('the decline copy addresses a signed listener and stays impersonal otherwise', () => {
  assert.equal(sorryNoMatch('María'), 'María, простите — в коллекции такого не нашлось.');
  assert.equal(sorryNoMatch(ANON_REQUESTER), 'Простите — в коллекции такого не нашлось.');
  assert.equal(sorryNoMatch(''), 'Простите — в коллекции такого не нашлось.');
  // The literal 'anon' must not survive into anything aired.
  assert.doesNotMatch(sorryNoMatch(ANON_REQUESTER), /anon/);
});

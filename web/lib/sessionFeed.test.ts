// Ключи строк ленты «Студия» (lib/sessionFeed.ts, stableTurnKeys): прежний
// turnKey(turn, i) брал номер в списке «новые сверху», и каждая новая реплика
// меняла ключи всех строк — AnimatePresence переигрывал выход и вход всей ленты.
// Запуск из корня клона:  npx tsx --test web/lib/sessionFeed.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableTurnKeys } from './sessionFeed';
import type { SessionTurn } from './types';

const turn = (t: string, kind: string, text = kind): SessionTurn => ({ t, kind, text, role: 'assistant' });

const feed = [
  turn('2026-10-25T10:00:00.000Z', 'segment'),
  turn('2026-10-25T10:03:00.000Z', 'pick'),
  turn('2026-10-25T10:03:00.000Z', 'track'),
];

const keysNewestFirst = (turns: SessionTurn[]) => stableTurnKeys(turns).reverse().map((r) => r.key);

test('a new turn leaves the keys of the older rows as they were', () => {
  const before = keysNewestFirst(feed);
  const after = keysNewestFirst([...feed, turn('2026-10-25T10:07:00.000Z', 'segment')]);
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(1), before);
});

test('keys are unique, even for one stamp and kind twice', () => {
  const twins = [...feed, turn('2026-10-25T10:03:00.000Z', 'track', 'another')];
  const keys = stableTurnKeys(twins).map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
  // the first of the pair keeps its key when the second arrives
  assert.equal(keys[2], stableTurnKeys(feed).map((r) => r.key)[2]);
});

test('each key rides its own turn through a filter', () => {
  const rows = stableTurnKeys(feed);
  const tracks = rows.filter((r) => r.turn.kind === 'track');
  const third = rows[2];
  assert.ok(third);
  assert.deepEqual(tracks.map((r) => r.key), [third.key]);
});

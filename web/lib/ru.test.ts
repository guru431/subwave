// Числительные и «назад» плеера (lib/ru.ts). Приём тот же, что у
// web/lib/roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/ru.test.ts

import assert from 'node:assert/strict';
import { ruAgo, ruListeners } from './ru';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

console.log('ruListeners');

test('1, 21, 101 — слушатель', () => {
  assert.equal(ruListeners(1), '1 слушатель');
  assert.equal(ruListeners(21), '21 слушатель');
  assert.equal(ruListeners(101), '101 слушатель');
});

test('2–4, 22 — слушателя', () => {
  assert.equal(ruListeners(2), '2 слушателя');
  assert.equal(ruListeners(4), '4 слушателя');
  assert.equal(ruListeners(22), '22 слушателя');
});

test('0, 5, 11–14, 111 — слушателей', () => {
  for (const n of [0, 5, 11, 12, 14, 111, 112]) {
    assert.equal(ruListeners(n), `${n} слушателей`);
  }
});

console.log('ruAgo');

test('единицы relTime переводятся', () => {
  assert.equal(ruAgo('5s'), '5 с назад');
  assert.equal(ruAgo('5m'), '5 мин назад');
  assert.equal(ruAgo('3h'), '3 ч назад');
  assert.equal(ruAgo('2d'), '2 дн назад');
});

test('незнакомый вид не теряет число', () => {
  assert.equal(ruAgo('2w'), '2w назад');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

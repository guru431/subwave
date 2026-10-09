// Слепок слушателя: без хранилища (приватное окно, запрет сайта) id один на
// вкладку, а не новый на каждый вызов — по нему комната держит 👎 и лимит.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/listener.test.ts

import assert from 'node:assert/strict';
import { listener } from './listener';

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

const g = globalThis as Record<string, unknown>;

function storage(getItem: (k: string) => string | null, setItem: (k: string, v: string) => void) {
  g.window = { localStorage: { getItem, setItem } };
}

console.log('listener');

test('хранилище запрещено — id один на вкладку', () => {
  storage(() => { throw new Error('SecurityError'); }, () => { throw new Error('SecurityError'); });
  const first = listener().id;
  assert.ok(first);
  assert.equal(listener().id, first);
  assert.equal(listener().id, first);
});

test('читать можно, писать нельзя (старый Safari) — тоже один id', () => {
  storage(() => null, () => { throw new Error('QuotaExceededError'); });
  assert.equal(listener().id, listener().id);
});

test('рабочее хранилище — id из него, не запасной', () => {
  const store = new Map<string, string>();
  storage(k => store.get(k) ?? null, (k, v) => { store.set(k, v); });
  const id = listener().id;
  assert.equal(JSON.parse(store.get('subwave.listener') ?? '{}').id, id);
  assert.equal(listener().id, id);
});

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nвсё прошло');

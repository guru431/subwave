// Опрос по видимости (lib/poll.ts): фон, resync и прежний контракт возврата.
// Приём тот же, что у web/lib/ru.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/poll.test.ts

import assert from 'node:assert/strict';
import { pollWhileVisible } from './poll';

// poll.ts трогает только document.hidden, подписку на visibilitychange и
// setInterval/clearInterval — их и подделываем.
type Listener = () => void;
const listeners = new Set<Listener>();
const doc = {
  hidden: false,
  addEventListener: (_type: string, fn: Listener) => { listeners.add(fn); },
  removeEventListener: (_type: string, fn: Listener) => { listeners.delete(fn); },
};
let nextId = 1;
const timers = new Map<number, number>();   // id → период
Object.assign(globalThis, {
  document: doc,
  setInterval: (_fn: () => void, ms: number) => { const id = nextId++; timers.set(id, ms); return id; },
  clearInterval: (id: number) => { timers.delete(id); },
});

function setHidden(hidden: boolean) {
  doc.hidden = hidden;
  for (const fn of [...listeners]) fn();
}
const armed = () => [...timers.values()];
function reset() {
  listeners.clear();
  timers.clear();
  doc.hidden = false;
}

let failures = 0;
function test(name: string, fn: () => void) {
  reset();
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

console.log('pollWhileVisible');

test('возврат по-прежнему вызывается как очистка: снимает таймер и слушателя', () => {
  const stop = pollWhileVisible(() => {}, 5000);
  assert.deepEqual(armed(), [5000]);
  stop();
  assert.deepEqual(armed(), []);
  assert.equal(listeners.size, 0);
});

test('эфир, включённый в скрытой вкладке, запускает фоновый опрос сразу', () => {
  let keep = false;
  let fires = 0;
  const poll = pollWhileVisible(() => { fires++; }, 5000, () => (keep ? 15000 : null));
  assert.equal(fires, 1);
  setHidden(true);                 // эфир выключен — опрос встал
  assert.deepEqual(armed(), []);
  keep = true;                     // включили с экрана блокировки
  poll.resync();
  assert.deepEqual(armed(), [15000]);
  // Данные старые ровно настолько, насколько долго стоял опрос, — спросить сразу.
  assert.equal(fires, 2);
  poll();
});

test('эфир, выключенный в скрытой вкладке, останавливает фоновый опрос', () => {
  let keep = true;
  const poll = pollWhileVisible(() => {}, 5000, () => (keep ? 15000 : null));
  setHidden(true);
  assert.deepEqual(armed(), [15000]);
  keep = false;
  poll.resync();
  assert.deepEqual(armed(), []);
  poll();
});

test('resync на переднем плане ничего не меняет', () => {
  let fires = 0;
  const poll = pollWhileVisible(() => { fires++; }, 5000, () => 15000);
  const before = [...timers.keys()];
  poll.resync();
  assert.deepEqual([...timers.keys()], before);   // таймер тот же, фаза не сбита
  assert.equal(fires, 1);
  poll();
});

test('смена видимости — как раньше: в фон без выстрела, на передний план сразу', () => {
  let fires = 0;
  const poll = pollWhileVisible(() => { fires++; }, 5000, () => 15000);
  setHidden(true);
  assert.deepEqual(armed(), [15000]);
  assert.equal(fires, 1);          // только что опрошено на переднем плане
  setHidden(false);
  assert.deepEqual(armed(), [5000]);
  assert.equal(fires, 2);
  poll();
});

test('resync после очистки опрос не воскрешает', () => {
  const poll = pollWhileVisible(() => {}, 5000, () => 15000);
  poll();
  poll.resync();
  assert.deepEqual(armed(), []);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

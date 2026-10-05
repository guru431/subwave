// Подписка Web Push: разбор ключа сервера и опознание подписки на прежний ключ.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/roomPush.test.ts

import assert from 'node:assert/strict';
import { keyBytes, sameKey } from './roomPush';

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

// открытый ключ из примера RFC 8291 (приложение A): 65 байт, начинается с 0x04
const RFC_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

console.log('keyBytes');

test('base64url без добивки разбирается в байты', () => {
  assert.deepEqual(Array.from(keyBytes('AQID')), [1, 2, 3]);
  assert.deepEqual(Array.from(keyBytes('-_8')), [0xfb, 0xff]);
});

test('ключ VAPID — несжатая точка P-256', () => {
  const bytes = keyBytes(RFC_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
});

console.log('sameKey');

test('подписка на тот же ключ остаётся', () => {
  assert.equal(sameKey(keyBytes(RFC_KEY).buffer as ArrayBuffer, RFC_KEY), true);
});

test('подписка на прежний ключ опознаётся как мёртвая', () => {
  const other = keyBytes(RFC_KEY);
  other[64] ^= 1;
  assert.equal(sameKey(other.buffer as ArrayBuffer, RFC_KEY), false);
});

test('браузер, не сообщивший ключ, подписку не теряет', () => {
  assert.equal(sameKey(null, RFC_KEY), true);
  assert.equal(sameKey(undefined, RFC_KEY), true);
});

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nвсё прошло');

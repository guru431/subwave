// Привязка songId к тексту заказа (lib/requestPick.ts). Приём тот же, что у
// web/lib/roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/requestPick.test.ts

import assert from 'node:assert/strict';
import { bindPick, pickedSongId } from './requestPick';

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

console.log('pickedSongId');

test('выбор альтернативы: подставленный текст уходит с её songId сразу', () => {
  const pick = bindPick('alt-1', 'Кино — Кукушка');
  assert.equal(pickedSongId(pick, 'Кино — Кукушка'), 'alt-1');
});

test('правка текста человеком рвёт привязку', () => {
  const pick = bindPick('alt-1', 'Кино — Кукушка');
  assert.equal(pickedSongId(pick, 'Кино — Кукушк'), undefined);
  assert.equal(pickedSongId(pick, 'что-нибудь бодрое'), undefined);
});

test('пробелы по краям привязку не рвут', () => {
  const pick = bindPick('ex-1', '  кино кукушка ');
  assert.equal(pickedSongId(pick, 'кино кукушка  '), 'ex-1');
});

test('без привязки songId нет', () => {
  assert.equal(pickedSongId(null, 'Кино — Кукушка'), undefined);
});

test('очищенное после отправки поле songId не несёт', () => {
  assert.equal(pickedSongId(bindPick('ex-1', 'кино кукушка'), ''), undefined);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

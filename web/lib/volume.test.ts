// Сохранённая громкость (lib/volume.ts): что восстанавливается при загрузке.
// Приём тот же, что у web/lib/ru.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/volume.test.ts

import assert from 'node:assert/strict';
import { loadVolumePref } from './volume';

// volume.ts трогает только window.localStorage — его и подделываем.
const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
  },
});
const saved = (v: string) => { store.clear(); store.set('subwave-volume', v); };

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

console.log('loadVolumePref');

test('iOS: сохранённый 0 не восстанавливается', () => {
  // Он стал бы el.muted, а аппаратные кнопки iPhone muted не снимают.
  saved('0');
  assert.equal(loadVolumePref({ ios: true }), null);
});

test('iOS: ненулевой уровень восстанавливается, как раньше', () => {
  saved('0.4');
  assert.equal(loadVolumePref({ ios: true }), 0.4);
});

test('не iOS: 0 восстанавливается, как раньше', () => {
  saved('0');
  assert.equal(loadVolumePref({ ios: false }), 0);
  assert.equal(loadVolumePref(), 0);
});

test('ничего не сохранено или мусор — null', () => {
  store.clear();
  assert.equal(loadVolumePref({ ios: true }), null);
  saved('abc');
  assert.equal(loadVolumePref(), null);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

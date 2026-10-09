// Текст экрана блокировки, шторки и CarPlay (lib/mediaMetadata.ts).
// Приём тот же, что у web/lib/ru.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/mediaMetadata.test.ts

import assert from 'node:assert/strict';
import { mediaText } from './mediaMetadata';

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

console.log('mediaText');

test('заглушка Navidrome «[Unknown Album]» не показывается — вместо неё имя станции', () => {
  const t = mediaText({ title: 'Song', artist: 'Band', album: '[Unknown Album]', talking: false, stationName: 'Радио Х' });
  assert.equal(t.album, 'Радио Х');
});

test('настоящий альбом остаётся', () => {
  const t = mediaText({ title: 'Song', artist: 'Band', album: 'Violator', talking: false, stationName: 'Радио Х' });
  assert.deepEqual(t, { title: 'Song', artist: 'Band', album: 'Violator' });
});

test('пустые поля — имя станции и «Прямой эфир», а не SUB/WAVE и Live broadcast', () => {
  const t = mediaText({ talking: false, stationName: 'Радио Х' });
  assert.deepEqual(t, { title: 'Радио Х', artist: 'Прямой эфир', album: 'Радио Х' });
});

test('имя станции ещё не пришло — запасное «AI радио», как в шапке', () => {
  const t = mediaText({ talking: false, stationName: '  ' });
  assert.equal(t.title, 'AI радио');
  assert.equal(t.album, 'AI радио');
});

test('ведущий говорит — исполнитель это ведущий', () => {
  assert.equal(mediaText({ artist: 'Band', talking: true, personaName: 'Ведущая Х' }).artist, 'Ведущая Х');
  assert.equal(mediaText({ talking: true }).artist, 'Прямой эфир');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

// «Не нравится»: разбор ответа комнаты и тексты тостов.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск:  npx --yes tsx web/lib/roomDislikes.test.ts

import assert from 'node:assert/strict';
import { doneText, errorText, isMarked, markOf, parseMarks } from './roomDislikes';

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

console.log('parseMarks');

test('отметки читаются по песням', () => {
  assert.deepEqual(parseMarks({ marks: { a: { track: true, artist: false } } }),
    { a: { track: true, artist: false } });
});

test('мусор вместо ответа — отметок нет', () => {
  assert.deepEqual(parseMarks(null), {});
  assert.deepEqual(parseMarks('<html>'), {});
  assert.deepEqual(parseMarks({ marks: 'x' }), {});
});

test('не булево — не отметка', () => {
  assert.deepEqual(parseMarks({ marks: { a: { track: 'true', artist: 1 } } }),
    { a: { track: false, artist: false } });
});

console.log('markOf / isMarked');

test('песня без отметок и пустой id — пустая отметка', () => {
  assert.deepEqual(markOf({}, 'a'), { track: false, artist: false });
  assert.deepEqual(markOf({ a: { track: true, artist: false } }, null),
    { track: false, artist: false });
});

test('отметка исполнителя подсвечивает кнопку', () => {
  assert.equal(isMarked({ track: false, artist: true }), true);
  assert.equal(isMarked({ track: false, artist: false }), false);
});

console.log('тексты');

test('отказ комнаты — по коду', () => {
  assert.equal(errorText(403), 'Песня уже уехала из ленты');
  assert.equal(errorText(429), 'Отметок слишком много');
  assert.equal(errorText(502), 'Станция не ответила, попробуйте позже');
  assert.equal(errorText(500), 'Не получилось отметить');
  assert.equal(errorText(0), 'Не получилось отметить');
});

test('тост называет песню или исполнителя', () => {
  assert.equal(doneText('track', true, 'Звезда', 'Кино'),
    'Отмечено: не нравится «Звезда». Решение за владельцем станции');
  assert.equal(doneText('artist', true, 'Звезда', 'Кино'),
    'Отмечено: не нравится «Кино». Решение за владельцем станции');
});

test('без названия — без пустых кавычек', () => {
  assert.equal(doneText('artist', true, 'Звезда', '  '),
    'Отмечено. Решение за владельцем станции');
});

test('снятие отметки', () => {
  assert.equal(doneText('track', false, 'Звезда', 'Кино'), 'Отметка снята');
});

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nвсё прошло');

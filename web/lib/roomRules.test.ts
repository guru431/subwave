// Правила уведомлений чата. Приём тот же, что у web/lib/audienceStats.test.ts
// апстрима (assert + ✓/✗ + ненулевой выход) — другого раннера у веб-части нет.
// Запуск из корня клона:  npx tsx web/lib/roomRules.test.ts

import assert from 'node:assert/strict';
import {
  unreadCount,
  fromOthers,
  turnKey,
  djChatReplies,
  mergeFeed,
  type RoomMessage,
  type FeedItem,
} from './roomRules';
import type { SessionTurn } from './types';

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

function msg(id: number, text: string, name = 'Аня', at = '2026-09-22T12:00:00+00:00'): RoomMessage {
  return { id, at, name, text };
}

console.log('unreadCount');

test('считает только то, что новее курсора', () => {
  assert.equal(unreadCount([msg(1, 'раз'), msg(2, 'два'), msg(3, 'три')], 1), 2);
});

test('нулевой курсор означает, что не прочитано ничего', () => {
  assert.equal(unreadCount([msg(1, 'раз'), msg(2, 'два')], 0), 2);
});

test('курсор впереди ленты не даёт отрицательных', () => {
  assert.equal(unreadCount([msg(1, 'раз')], 99), 0);
});

console.log('fromOthers');

test('громко — каждое чужое сообщение, а не только упоминание имени', () => {
  // владелец 23.09: «нет всплывающих уведомлений из чата» на «Всем привет!»
  const fresh = [msg(13, 'Всем привет!', 'Alex'), msg(14, 'срочно сервер мне поставьте', 'Петр')];
  assert.deepEqual(fromOthers(fresh, new Set(), 'Петр').map(m => m.id), [13]);
});

test('своё из этой вкладки не звенит, даже если имя сменили', () => {
  assert.deepEqual(fromOthers([msg(20, 'это я', 'Старое имя')], new Set([20]), 'Новое имя'), []);
});

test('своё с другого устройства узнаётся по имени — регистр и ё не в счёт', () => {
  assert.deepEqual(fromOthers([msg(21, 'я с телефона', 'алёна')], new Set(), 'Алена'), []);
});

test('без имени своё узнаётся только по номеру', () => {
  // пустое имя не должно совпадать с чужими «гостями»
  assert.deepEqual(fromOthers([msg(22, 'привет', 'гость')], new Set(), '').map(m => m.id), [22]);
});

console.log('djChatReplies');

function turn(kind: string, text: string, airedAt: string): SessionTurn {
  return { role: 'segment', kind, text, meta: { airedAt } };
}

test('отбирает реплики навыка chat', () => {
  const turns = [
    turn('link', 'а это была Кино', '2026-09-22T12:00:00.000Z'),
    turn('chat', 'Аня спрашивает про Кино — ставлю', '2026-09-22T12:01:00.000Z'),
  ];
  assert.deepEqual(djChatReplies(turns, new Set()).map(t => t.text), ['Аня спрашивает про Кино — ставлю']);
});

test('уже виденное не возвращается', () => {
  const t = turn('chat', 'привет, Аня', '2026-09-22T12:01:00.000Z');
  assert.deepEqual(djChatReplies([t], new Set([turnKey(t)])), []);
});

test('реплика без текста пропускается', () => {
  assert.deepEqual(djChatReplies([turn('chat', '', '2026-09-22T12:01:00.000Z')], new Set()), []);
});

test('ключ различает одинаковый текст в разное время', () => {
  // ведущий повторяется; по одному тексту вторая реплика сочлась бы виденной
  const a = turn('chat', 'привет', '2026-09-22T12:01:00.000Z');
  const b = turn('chat', 'привет', '2026-09-22T12:40:00.000Z');
  assert.notEqual(turnKey(a), turnKey(b));
});

console.log('mergeFeed');

const EV: FeedItem = { kind: 'track', key: 't1', at: Date.parse('2026-09-22T12:00:30Z'), text: 'сейчас играет Кино — Звезда' };

test('строки идут по времени, а не по источнику', () => {
  const out = mergeFeed(
    [msg(1, 'раз', 'Аня', '2026-09-22T12:00:00+00:00'), msg(2, 'два', 'Аня', '2026-09-22T12:01:00+00:00')],
    [EV],
    10,
  );
  assert.deepEqual(out.map(i => i.kind), ['msg', 'track', 'msg']);
});

test('лимит режет старое, а не свежее', () => {
  const many = [1, 2, 3, 4, 5].map(i => msg(i, `сообщение ${i}`, 'Аня', `2026-09-22T12:0${i}:00+00:00`));
  assert.deepEqual(mergeFeed(many, [], 2).map(i => (i.kind === 'msg' ? i.text : '')), ['сообщение 4', 'сообщение 5']);
});

test('пустая лента даёт пустой список, а не падение', () => {
  assert.deepEqual(mergeFeed([], [], 10), []);
});

test('сообщения одной секунды сохраняют порядок id, а не строки', () => {
  // комната отдаёт метку времени с секундной точностью
  // (station/room/store.py, isoformat(timespec="seconds")), поэтому равный `at`
  // у двух сообщений подряд — норма, а не край. Старый тай-брейк сравнивал
  // ключи строкой и ставил m100 перед m99.
  const same = '2026-09-22T12:05:00+00:00';
  const out = mergeFeed([msg(99, 'девяносто девять', 'Аня', same), msg(100, 'сто', 'Аня', same)], [], 10);
  assert.deepEqual(out.map(i => i.key), ['m99', 'm100']);
});

test('лимит 0 отдаёт пустой список, а не всё', () => {
  assert.deepEqual(mergeFeed([msg(1, 'раз')], [], 0), []);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

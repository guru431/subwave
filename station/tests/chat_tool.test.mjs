// Навык chat (skills/chat/tool.mjs) на node:test. Запускает его
// test_chat_tool.py — так он идёт в быстром наборе станции. Лежит здесь, а не
// рядом с навыком: каталог навыка целиком копируется в state/skills/chat/.
//
// Комната и журнал recall подделаны, часы — mock.timers (только Date).

import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import readChat from '../skills/chat/tool.mjs';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
mock.timers.enable({ apis: ['Date'], now: NOW });

// Отметка времени так, как её пишет комната (store._iso): UTC, миллисекунды, +00:00.
const at = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString().replace('Z', '+00:00');

let services;
beforeEach(() => {
  const seen = new Set();
  services = {
    seen,
    recall: { seen: key => seen.has(key), remember: key => { seen.add(key); } },
    log: () => {},
  };
});

function room(messages) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    messages,
    last: messages.length ? messages[messages.length - 1].id : 0,
  }));
}

test('после рестарта сообщение недельной давности в эфир не идёт, но считается прочитанным', async () => {
  // Курсор пуст (рестарт), а журнал recall забыл прочитанное старше 7 дней —
  // комната же хранит сообщения 14 дней.
  room([
    { id: 1, at: at(8 * 24 * 60), name: 'Аня', text: 'Поставьте что-нибудь весёлое' },
    { id: 2, at: at(5), name: 'Петя', text: 'Привет из пробки' },
  ]);
  const state = {};
  const out = await readChat({}, state, services, {});
  assert.deepEqual(out.messages, [{ name: 'Петя', text: 'Привет из пробки', minutesAgo: 5 }]);
  assert.ok(services.seen.has('chat:1'), 'старое помечено: решено раз и навсегда');
  assert.ok(services.seen.has('chat:2'));
  assert.equal(state.chatSince, 2);
});

test('порог — два часа: на границе ещё читается, за ней уже нет', async () => {
  room([
    { id: 3, at: at(121), name: 'Оля', text: 'Чуть опоздала' },
    { id: 4, at: at(120), name: 'Ира', text: 'Успела' },
  ]);
  const out = await readChat({}, {}, services, {});
  assert.deepEqual(out.messages.map(m => m.name), ['Ира']);
  assert.equal(out.messages[0].minutesAgo, 120);
});

test('сообщение без отметки времени не выдаётся за свежее', async () => {
  room([{ id: 5, name: 'Гость', text: 'Без даты' }]);
  const out = await readChat({}, {}, services, {});
  assert.deepEqual(out.messages, []);
});

test('уже прочитанное не возвращается', async () => {
  services.recall.remember('chat:6');
  room([{ id: 6, at: at(1), name: 'Вера', text: 'Уже звучало' }]);
  const out = await readChat({}, {}, services, {});
  assert.deepEqual(out.messages, []);
});

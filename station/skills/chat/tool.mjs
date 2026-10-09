// Чат — забрать у комнаты то, что появилось с прошлого раза, и отдать ведущему
// репликами с именами. Комната наша (station/room), контроллер в этом пути не
// участвует: у него нет ни понятия чата, ни открытого слушателю маршрута.
export const description = 'Fetch listener chat messages that have not been read on air yet. Each message carries `minutesAgo` — how long ago it was written; messages older than two hours are never returned. Returns `messages: []` when the room is quiet or unreachable — treat an empty list as a cue to stay silent, not to improvise a line about the chat.';

export const configFields = {
  room: { type: 'url', label: 'Комната · базовый адрес', placeholder: 'http://room:8080' },
};

// Адрес по умолчанию — имя контейнера в сети стека: комната и контроллер стоят
// в одном compose, наружу за этим ходить незачем.
const DEFAULT_ROOM = 'http://room:8080';
const LIMIT = 10;
// Старше этого сообщение в эфир не идёт: ответ прозвучал бы как на свежее.
// После рестарта курсор пуст, журнал recall помнит прочитанное 7 дней, а
// комната хранит сообщения 14 — без порога тихая неделя возвращала бы в эфир
// чат недельной давности.
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export default async function readChat(ctx, state, services, config) {
  const base = (config?.room || DEFAULT_ROOM).replace(/\/+$/, '');
  // Курсор живёт в state (быстрый путь внутри процесса). После рестарта он
  // пуст, поэтому второй рубеж — durable recall: без него ведущий зачитал бы
  // заново всё, что уже прочитал до перезапуска. Recall забывает через 7 дней,
  // и третий рубеж — порог возраста MAX_AGE_MS.
  const since = Number.isFinite(state.chatSince) ? state.chatSince : 0;
  let payload;
  try {
    const r = await fetch(`${base}/unread?since=${since}&limit=${LIMIT}`);
    if (!r.ok) throw new Error(`room answered ${r.status}`);
    payload = await r.json();
  } catch (err) {
    // Недоступная комната не должна быть слышна в эфире: молчим, как при
    // пустом чате, и оставляем след в логе будки.
    services.log(`chat: комната недоступна — ${err.message}`);
    return { messages: [] };
  }

  const now = Date.now();
  const fresh = [];
  for (const m of payload.messages || []) {
    if (services.recall.seen(`chat:${m.id}`)) continue;
    // Помечается и устаревшее: решение о нём принято, в эфир оно не пойдёт.
    services.recall.remember(`chat:${m.id}`);
    // Без отметки времени age — NaN и тоже не проходит: свежесть не доказана.
    const age = now - Date.parse(m.at);
    if (!(age <= MAX_AGE_MS)) continue;
    // Возраст — модели: «минуту назад» и «час назад» звучат по-разному.
    fresh.push({ name: m.name, text: m.text, minutesAgo: Math.max(0, Math.round(age / 60_000)) });
  }
  state.chatSince = payload.last || since;
  return { messages: fresh };
}

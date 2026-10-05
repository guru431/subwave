// Чат — забрать у комнаты то, что появилось с прошлого раза, и отдать ведущему
// репликами с именами. Комната наша (station/room), контроллер в этом пути не
// участвует: у него нет ни понятия чата, ни открытого слушателю маршрута.
export const description = 'Fetch listener chat messages that have not been read on air yet. Returns `messages: []` when the room is quiet or unreachable — treat an empty list as a cue to stay silent, not to improvise a line about the chat.';

export const configFields = {
  room: { type: 'url', label: 'Комната · базовый адрес', placeholder: 'http://room:8080' },
};

// Адрес по умолчанию — имя контейнера в сети стека: комната и контроллер стоят
// в одном compose, наружу за этим ходить незачем.
const DEFAULT_ROOM = 'http://room:8080';
const LIMIT = 10;

export default async function readChat(ctx, state, services, config) {
  const base = (config?.room || DEFAULT_ROOM).replace(/\/+$/, '');
  // Курсор живёт в state (быстрый путь внутри процесса). После рестарта он
  // пуст, поэтому второй рубеж — durable recall: без него ведущий зачитал бы
  // заново всё, что уже прочитал до перезапуска.
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

  const fresh = (payload.messages || []).filter(m => !services.recall.seen(`chat:${m.id}`));
  for (const m of fresh) services.recall.remember(`chat:${m.id}`);
  state.chatSince = payload.last || since;
  if (!fresh.length) return { messages: [] };
  return {
    messages: fresh.map(m => ({ name: m.name, text: m.text })),
  };
}

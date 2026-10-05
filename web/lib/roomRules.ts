// Чистые правила чата: что считать непрочитанным, что — важным и в каком
// порядке показывать разнородные строки ленты.
//
// Без React и без сети, и это не вкусовщина. У веб-части апстрима нет
// тест-раннера, поэтому проверить можно только то, что не тянет за собой ни
// DOM, ни хуки; всё решающее вынесено сюда, а в хуке и разметке остаётся
// проводка (см. roomRules.test.ts).

import type { SessionTurn } from './types';

/** Сообщение комнаты — ровно то, что отдаёт `GET /room/messages`. */
export interface RoomMessage {
  id: number;
  at: string;
  name: string;
  text: string;
}

/** Строка ленты чата. `at` — миллисекунды, чтобы три разных источника
 *  сравнивались одним числом. */
export type FeedItem =
  | { kind: 'msg'; key: string; at: number; name: string; text: string }
  | { kind: 'dj'; key: string; at: number; text: string }
  | { kind: 'track'; key: string; at: number; text: string };

// Слаг навыка, чьи реплики считаются ответом на чат. Контроллер кладёт его в
// turn.kind, когда реплика произнесена (broadcast/queue.ts::onSpoken), а слаг
// равен имени каталога навыка в state/skills/.
export const CHAT_SKILL = 'chat';

export function unreadCount(messages: RoomMessage[], lastSeenId: number): number {
  return messages.reduce((n, m) => (m.id > lastSeenId ? n + 1 : n), 0);
}

// Имена сравниваются в свёрнутой форме: регистр не важен, ё и е — одна буква,
// латинская диакритика снимается. Кириллица под NFD тоже распадается (й → и +
// бревис), но обе стороны сворачиваются одинаково, поэтому на совпадение это
// не влияет.
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Чужие сообщения из пачки — каждое из них звучит громко (решение владельца
 *  2026-09-23; до того громким было только упоминание имени, и сообщения других
 *  слушателей молча капали в счётчик). Своё — отправленное из этой вкладки
 *  (`ownIds`, номер из ответа комнаты) либо подписанное тем же именем: так не
 *  звенит и собственное сообщение, отправленное с другого устройства. */
export function fromOthers(
  messages: RoomMessage[],
  ownIds: ReadonlySet<number>,
  myName: string,
): RoomMessage[] {
  const me = fold(myName);
  return messages.filter(m => !ownIds.has(m.id) && !(me && fold(m.name) === me));
}

/** Опознание реплики: время выхода в эфир плюс начало текста. Одного текста
 *  мало — ведущий повторяется, и вторая такая же реплика сошла бы за виденную. */
export function turnKey(turn: SessionTurn): string {
  const aired = turn.meta?.airedAt;
  const stamp = typeof aired === 'string' ? aired : String(turn.t ?? '');
  return `${stamp}|${(turn.text || '').slice(0, 64)}`;
}

/** Реплики ведущего, сказанные по навыку chat и ещё не показанные. */
export function djChatReplies(turns: SessionTurn[], seen: ReadonlySet<string>): SessionTurn[] {
  return turns.filter(t => t.kind === CHAT_SKILL && !!t.text && !seen.has(turnKey(t)));
}

export function mergeFeed(messages: RoomMessage[], events: FeedItem[], limit: number): FeedItem[] {
  const fromRoom: FeedItem[] = messages.map(m => ({
    kind: 'msg',
    key: `m${m.id}`,
    // Неразобранная метка времени уводит строку в начало ленты, а не роняет
    // склейку: комната отдаёт ISO-8601, но лента важнее одной кривой записи.
    at: Date.parse(m.at) || 0,
    name: m.name,
    text: m.text,
  }));
  // Без тай-брейка по ключу: комната отдаёт `at` с секундной точностью
  // (station/room/store.py, isoformat(timespec="seconds")), и у двух сообщений
  // подряд равный `at` — норма, а не теория. Строковое сравнение ключей вида
  // `m<id>` совпадает с числовым только пока у id одинаковая длина (`m100`
  // встаёт перед `m99`), и это переставляло ответ раньше вопроса. sort
  // стабилен, а входной порядок уже верный: сообщения приходят от комнаты по
  // возрастанию id, события — в порядке появления.
  const merged = [...fromRoom, ...events].sort((a, b) => a.at - b.at);
  return limit <= 0 ? [] : merged.slice(-limit);
}

// Кто это пишет в чат и что он уже видел. Ни паролей, ни учётных записей: имя
// и id — подпись, а не учётка. Станция открыта всем, кто знает адрес, и чат
// публичен осознанно: подмена имени в localStorage даёт ровно то, что и так
// доступно — написать под чужим именем, а держат комнату её лимиты (station/room).
//
// `id` нужен не для доверия, а для частотного лимита комнаты: снаружи все
// слушатели приходят в стек ОДНИМ адресом (Caddy переписывает X-Forwarded-*
// для пиров вне trusted_proxies), поэтому лимит по IP считал бы семью за
// одного человека.
//
// Здесь же — «докуда дочитан чат» и согласие на системные уведомления. Это тот
// же локальный слепок слушателя, и второй ключ хранилища ради двух полей завёл
// бы два места, где живёт одно.
const KEY = 'subwave.listener';

export interface Listener {
  id: string;
  name: string;
  /** id последнего сообщения комнаты, которое человек видел своими глазами. */
  lastSeenId: number;
  /** Согласен ли слушатель на системные уведомления браузера. */
  notify: boolean;
}

// Та же цифра, что у имени в заказе (REQUEST_NAME_MAX) и в комнате: одно поле
// на двух формах одного плеера не должно жить по двум правилам.
export const LISTENER_NAME_MAX = 40;

function randomId(): string {
  // crypto.randomUUID есть не везде (http-контекст, старые webview) —
  // запасной путь важнее красоты: без id комната откажет в записи.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `l-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

const EMPTY: Listener = { id: '', name: '', lastSeenId: 0, notify: false };

// Запасной id вкладки, когда хранилище запрещено: один на всю её жизнь. Новый на
// каждый вызов делал каждый запрос новым слушателем — комната не узнавала 👎
// после следующего опроса, а частотный лимит считал каждый запрос первым.
let spareId: string | null = null;

export function listener(): Listener {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Listener>;
      if (parsed && typeof parsed.id === 'string' && parsed.id) {
        return {
          id: parsed.id,
          name: typeof parsed.name === 'string' ? parsed.name : '',
          // Слепок, записанный до появления уведомлений, полей не имеет:
          // читать его надо как «ничего не прочитано, согласия нет», а не
          // ронять чат на NaN.
          lastSeenId: typeof parsed.lastSeenId === 'number' ? parsed.lastSeenId : 0,
          notify: parsed.notify === true,
        };
      }
    }
    const fresh = { ...EMPTY, id: randomId() };
    window.localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  } catch {
    // Приватное окно и запрет на хранилище — не повод ломать плеер: чат в этой
    // вкладке будет работать до перезагрузки, под случайным id.
    spareId ??= randomId();
    return { ...EMPTY, id: spareId };
  }
}

function patch(fields: Partial<Listener>): void {
  if (typeof window === 'undefined') return;
  const current = listener();
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...current, ...fields }));
  } catch {
    /* см. listener(): хранилище может быть запрещено */
  }
}

export function setListenerName(name: string): void {
  patch({ name: name.trim().slice(0, LISTENER_NAME_MAX) });
}

/** Курсор двигается только вперёд: «прочитано до N» нельзя отменить назад
 *  опоздавшим ответом комнаты. */
export function setLastSeenId(id: number): void {
  if (!Number.isFinite(id)) return;
  const current = listener();
  if (id <= current.lastSeenId) return;
  patch({ lastSeenId: id });
}

export function setNotifyEnabled(on: boolean): void {
  patch({ notify: on });
}

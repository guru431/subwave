// «Не нравится» слушателя: запросы в комнату (deploy/room, /room/dislikes) и
// всё, что о них решается без React. Эфир от отметки не меняется — это сигнал
// владельцу станции, и тост после нажатия говорит слушателю именно это.
//
// Тест:  npx --yes tsx web/lib/roomDislikes.test.ts

import { listener } from './listener';

export type DislikeKind = 'track' | 'artist';

export interface Mark {
  /** Слушатель отметил саму песню. */
  track: boolean;
  /** Слушатель отметил её исполнителя — любой его песней из окна. */
  artist: boolean;
}

/** Отметки по песням окна станции; песни без отметок в наборе нет. */
export type Marks = Record<string, Mark>;

const NO_MARK: Mark = { track: false, artist: false };

export function parseMarks(raw: unknown): Marks {
  const marks = raw && typeof raw === 'object' ? (raw as { marks?: unknown }).marks : null;
  if (!marks || typeof marks !== 'object') return {};
  const out: Marks = {};
  for (const [id, m] of Object.entries(marks as Record<string, unknown>)) {
    const v = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    out[id] = { track: v.track === true, artist: v.artist === true };
  }
  return out;
}

export function markOf(marks: Marks, songId: string | null | undefined): Mark {
  return (songId ? marks[songId] : undefined) ?? NO_MARK;
}

export function isMarked(m: Mark): boolean {
  return m.track || m.artist;
}

/** Текст отказа по коду ответа комнаты; 0 — сеть не ответила вовсе. */
export function errorText(status: number): string {
  if (status === 403) return 'Песня уже уехала из ленты';
  if (status === 429) return 'Отметок слишком много';
  if (status === 502) return 'Станция не ответила, попробуйте позже';
  return 'Не получилось отметить';
}

/** Тост после удачного нажатия: что отмечено и что будет дальше. */
export function doneText(kind: DislikeKind, on: boolean,
                         title?: string | null, artist?: string | null): string {
  if (!on) return 'Отметка снята';
  const what = (kind === 'artist' ? artist : title)?.trim();
  return what
    ? `Отмечено: не нравится «${what}». Решение за владельцем станции`
    : 'Отмечено. Решение за владельцем станции';
}

function identity(): Record<string, string> {
  const me = listener();
  const headers: Record<string, string> = { 'X-Listener-Id': me.id };
  // Заголовки по RFC 7230 — latin-1, кириллица в них иначе не проходит.
  if (me.name) headers['X-Listener-Name'] = encodeURIComponent(me.name);
  return headers;
}

/** Отметки этого слушателя; null — комната не ответила, прежние не трогать. */
export async function fetchMarks(): Promise<Marks | null> {
  try {
    const r = await fetch('/room/dislikes', { headers: identity() });
    return r.ok ? parseMarks(await r.json()) : null;
  } catch {
    return null;
  }
}

/** Поставить или снять отметку; `status` 0 — сеть не ответила. */
export async function setDislike(songId: string, kind: DislikeKind, on: boolean):
    Promise<{ ok: true } | { ok: false; status: number }> {
  try {
    const r = await fetch('/room/dislikes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity() },
      body: JSON.stringify({ songId, kind, on }),
    });
    return r.ok ? { ok: true } : { ok: false, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

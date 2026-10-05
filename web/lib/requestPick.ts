// Точный заказ ящика заказа (W09): какой songId уходит вместе с текстом.
//
// songId привязан к тексту, при котором его выбрали — точное совпадение сверки
// или нажатая альтернатива. Правка текста человеком привязку рвёт: в поле уже
// другой заказ. Программная подстановка (выбор альтернативы пишет в поле
// «артист — название») её не рвёт: текст совпадает с привязанным. Поэтому
// songId не сбрасывается эффектом на смену текста, а сверяется при чтении.
// Сравнение — без пробелов по краям: так же обрезается запрос сверки.

export interface RequestPick {
  songId: string;
  text: string;
}

export const bindPick = (songId: string, text: string): RequestPick =>
  ({ songId, text: text.trim() });

export const pickedSongId = (pick: RequestPick | null, text: string): string | undefined =>
  (pick && pick.text === text.trim() ? pick.songId : undefined);

// Точное совпадение сверки привязывает свой songId, только если к этому тексту
// ещё ничего не привязано. Выбор альтернативы подставляет в поле «артист —
// название», и через паузу сверка видит этот текст как точное совпадение; при
// двух одинаковых треках (альбом и сборник) она вернула бы первый по выдаче, а
// не выбранный слушателем.
export const bindExact = (prev: RequestPick | null, songId: string, text: string): RequestPick =>
  (prev && prev.text === text.trim() ? prev : bindPick(songId, text));

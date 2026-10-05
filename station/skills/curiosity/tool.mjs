// Curiosity — одно событие «в этот день» из Википедии, и только оно.
//
// Встроенный навык апстрима при пустой выдаче прямо велел модели сочинить факт
// самой ("fall back to your own oddly-specific factoid") — так 22.09.2026 в
// эфир ушёл несуществующий «первый Международный кинофестиваль в Лондоне
// 22 сентября 1945 года». Здесь пустая выдача означает молчание.
//
// Второй фильтр — события с жертвами. Список запретных слов апстрима ловит
// «died» и «dies », но не «people die,», и в эфир ушла гибель людей на озере
// Мичиган. Лишний отсев стоит одной несказанной реплики, пропуск — трагедии
// между песнями.
//
// Копия в state/skills/curiosity/ переживает рестарт: контроллер засевает
// встроенные навыки, только если файлов нет. Откатывает её лишь кнопка сброса
// навыка в админке.
const GRIM = /\b(die[sd]?|dead|deaths?|kill\w*|injur\w*|wound\w*|victims?|casualt\w*|riot\w*|capsiz\w*|drown\w*|crash\w*|collaps\w*|disasters?|tragedy|tragic|massacre\w*|murder\w*|assassinat\w*|execut\w*|genocide|terror\w*|attack\w*|bomb\w*|shoot\w*|shot|war|wars|battle\w*|invasion|siege|earthquake|flood\w*|hurricane|tornado|explosion|fire[sd]?)\b/i;

export const description = 'Fetch one historical "on this day" event for today\'s date from Wikipedia — cultural, scientific or sporting entries since 1850, de-duped against curiosities already aired. Returns `available: false` when there is no fresh item: then say nothing at all — never substitute a fact of your own.';

export default async function getCuriosityItem(ctx, state, services) {
  const items = await services.onThisDay();
  const fresh = items.filter(it => !GRIM.test(it.text) && !services.recall.seen(it.text));
  if (!fresh.length) return { available: false, note: 'nothing to air — stay silent' };
  // Burn-on-read into the durable ledger so a later tick — or one after a
  // restart — doesn't re-offer the same event (issue #577).
  for (const it of fresh.slice(0, 3)) services.recall.remember(it.text);
  return {
    available: true,
    items: fresh.slice(0, 3).map(it => ({ year: it.year, text: it.text })),
  };
}

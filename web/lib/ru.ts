// Русские подписи для значений, которые контроллер отдаёт словами.
//
// Переводить их в контроллере нельзя: 'afternoon', 'cloudy', 'energetic' —
// это КЛЮЧИ (settings.moodSchedule, settings.weatherMoods, теги настроений), по
// ним же идут выборка треков и промпты ведущего. Поэтому перевод живёт на
// стороне интерфейса и применяется в точке показа, а данные остаются прежними.
//
// Незнакомое значение возвращается как есть: новый вариант в upstream должен
// проявиться английским словом в интерфейсе, а не пропасть с экрана.

const TIME_SHOW: Record<string, string> = {
  breakfast: 'утро',
  morning: 'день начинается',
  midday: 'полдень',
  afternoon: 'вторая половина дня',
  'drive-time': 'вечерний час',
  evening: 'вечер',
  late: 'поздний вечер',
  graveyard: 'ночь',
};

const TIME_VIBE: Record<string, string> = {
  'gentle waking': 'спокойное пробуждение',
  productive: 'рабочий настрой',
  'lunch hour': 'обеденный час',
  'sustained energy': 'ровная энергия',
  'end of the workday': 'конец рабочего дня',
  'wind down': 'сбавляем ход',
  'late hours': 'поздние часы',
  'after hours': 'глубокая ночь',
};

const WEATHER: Record<string, string> = {
  clear: 'ясно',
  cloudy: 'облачно',
  foggy: 'туман',
  rainy: 'дождь',
  snowy: 'снег',
  stormy: 'гроза',
};

const MOOD: Record<string, string> = {
  energetic: 'энергичное',
  calm: 'спокойное',
  reflective: 'задумчивое',
  celebratory: 'праздничное',
  romantic: 'романтичное',
  spiritual: 'возвышенное',
  focus: 'для сосредоточения',
  workout: 'для тренировки',
  driving: 'дорожное',
  cooking: 'домашнее',
  rainy: 'дождливое',
  sunny: 'солнечное',
  night: 'ночное',
  morning: 'утреннее',
  evening: 'вечернее',
  festival: 'фестивальное',
  cultural: 'фольклорное',
};

const ENERGY: Record<string, string> = {
  low: 'низкая энергия',
  medium: 'средняя энергия',
  high: 'высокая энергия',
};

const pick = (table: Record<string, string>, v: string | null | undefined): string =>
  (v ? table[v.toLowerCase()] ?? v : '');

export const ruShow = (v?: string | null) => pick(TIME_SHOW, v);
export const ruVibe = (v?: string | null) => pick(TIME_VIBE, v);
export const ruWeather = (v?: string | null) => pick(WEATHER, v);
export const ruMood = (v?: string | null) => pick(MOOD, v);
export const ruEnergy = (v?: string | null) => pick(ENERGY, v);

// Форма слова при числе: 1 слушатель, 2 слушателя, 5 слушателей, 11 слушателей,
// 21 слушатель. Число берётся целым по модулю: дробных слушателей не бывает.
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n));
  const d = a % 10;
  const dd = a % 100;
  if (dd >= 11 && dd <= 14) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

export const ruListeners = (n: number): string =>
  `${n} ${ruPlural(n, 'слушатель', 'слушателя', 'слушателей')}`;

// «5m» из relTime (lib/format.ts — общий для всех скинов, его не трогаем) →
// «5 мин назад». Незнакомый вид отдаётся с «назад», без потери числа.
const REL_UNIT: Record<string, string> = { s: 'с', m: 'мин', h: 'ч', d: 'дн' };
export function ruAgo(rel: string): string {
  const m = /^(\d+)([smhd])$/.exec(rel);
  const unit = m?.[2] ? REL_UNIT[m[2]] : undefined;
  return m && unit ? `${m[1]} ${unit} назад` : `${rel} назад`;
}

// Имя станции из настройки `station` (W04) или запасное, пока оно не пришло.
// Одно на шапку плеера и экран блокировки (lib/mediaMetadata.ts).
export const ruStationName = (v?: string | null): string => v?.trim() || 'AI радио';

// Navidrome подставляет «[Unknown Album]» вместо пустого тега; это не название
// альбома, а заглушка, поэтому в эфирной карточке она не показывается вовсе.
const ALBUM_PLACEHOLDERS = new Set(['[unknown album]', 'unknown album', '[unknown]']);
export const ruAlbum = (v?: string | null): string =>
  (v && !ALBUM_PLACEHOLDERS.has(v.trim().toLowerCase()) ? v : '');

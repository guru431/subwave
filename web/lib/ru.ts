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

// Navidrome подставляет «[Unknown Album]» вместо пустого тега; это не название
// альбома, а заглушка, поэтому в эфирной карточке она не показывается вовсе.
const ALBUM_PLACEHOLDERS = new Set(['[unknown album]', 'unknown album', '[unknown]']);
export const ruAlbum = (v?: string | null): string =>
  (v && !ALBUM_PLACEHOLDERS.has(v.trim().toLowerCase()) ? v : '');

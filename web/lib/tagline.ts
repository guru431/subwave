import type { StationContext } from './types';
import { ruShow, ruVibe, ruWeather, ruMood } from './ru';

// Compact context tagline, festival > show + vibe + weather. e.g.
// "late · late hours · 6° clear".
export function buildTagline(context: StationContext | null | undefined): string | null {
  if (!context) return null;
  const parts: string[] = [];

  if (context.festival?.name) {
    parts.push(context.festival.name.toLowerCase());
    if (context.festival.mood) parts.push(ruMood(context.festival.mood));
  } else {
    if (context.time?.show) parts.push(ruShow(context.time.show));
    if (context.time?.vibe && context.time.vibe !== context.time?.show) {
      parts.push(ruVibe(context.time.vibe));
    }
  }

  if (context.weather && context.weather.condition && context.weather.condition !== 'unknown') {
    const t = context.weather.temp;
    const cond = ruWeather(context.weather.condition);
    parts.push(Number.isFinite(t) ? `${t}° ${cond}` : cond);
  }

  return parts.length ? parts.join(' · ') : null;
}

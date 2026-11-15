// Weather — surfaces current conditions and whether they changed since the
// DJ last spoke about them. No external call; reads ctx.weather.
export const description = 'Get the current weather and whether its condition has changed since the DJ last spoke about weather on air. Dull or unchanged conditions are usually not worth airing. The temperature is returned in the unit indicated by `tempUnit` ("C" or "F") — read it on air in that unit, do not convert.';

export default async function checkWeather(ctx, state) {
  const w = ctx.weather;
  if (!w || !w.condition || w.condition === 'unknown') return { available: false };
  return {
    available: true,
    location: w.location,
    condition: w.condition,
    temp: w.temp ?? null,
    tempUnit: w.tempUnit || 'C',
    changedSinceLastMention: w.condition !== state.lastWeatherCondition,
  };
}

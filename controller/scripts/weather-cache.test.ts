// Погода на горячем пути: getWeather() зовут /now-playing, заказ, пик и
// подводки. Недоступный Open-Meteo не должен стоить каждому из них таймаута
// (23.09 — «тормозит вся админка»), а параллельные вызовы — плодить запросы.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWeather, invalidateWeatherCache, WEATHER_FAIL_TTL_MS } from '../src/context.js';

const realFetch = globalThis.fetch;
const realNow = Date.now;

function stubFetch(answer: () => Response | Promise<Response>): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return answer();
  }) as typeof fetch;
  return () => calls;
}

function restore() {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  invalidateWeatherCache();
}

test('неудача помнится: второй вызов не ждёт Open-Meteo', async (t) => {
  t.after(restore);
  invalidateWeatherCache();
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  assert.equal((await getWeather()).condition, 'unknown');
  assert.equal((await getWeather()).condition, 'unknown');
  assert.equal(calls(), 1);
});

test('после окна неудачи погода спрашивается снова', async (t) => {
  t.after(restore);
  invalidateWeatherCache();
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  const start = realNow();
  Date.now = () => start;
  await getWeather();
  Date.now = () => start + WEATHER_FAIL_TTL_MS + 1;
  await getWeather();
  assert.equal(calls(), 2);
});

test('параллельные вызовы ждут один запрос', async (t) => {
  t.after(restore);
  invalidateWeatherCache();
  const calls = stubFetch(() => new Response(JSON.stringify({
    current: { weather_code: 0, temperature_2m: 12.4, is_day: 1 },
  })));
  const all = await Promise.all([getWeather(), getWeather(), getWeather()]);
  assert.equal(calls(), 1);
  assert.deepEqual(all.map((w) => w.temp), [12, 12, 12]);
});

test('смена места сбрасывает память о неудаче', async (t) => {
  t.after(restore);
  invalidateWeatherCache();
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  await getWeather();
  invalidateWeatherCache();
  await getWeather();
  assert.equal(calls(), 2);
});

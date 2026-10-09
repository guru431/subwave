// Подписка Web Push: разбор ключа сервера, опознание подписки на прежний ключ и
// «подписки не стало» для ящика чата.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/roomPush.test.ts

import assert from 'node:assert/strict';
import { disablePush, enablePush, keyBytes, pushLost, sameKey, watchPushLost } from './roomPush';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

// открытый ключ из примера RFC 8291 (приложение A): 65 байт, начинается с 0x04
const RFC_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

console.log('keyBytes');

test('base64url без добивки разбирается в байты', () => {
  assert.deepEqual(Array.from(keyBytes('AQID')), [1, 2, 3]);
  assert.deepEqual(Array.from(keyBytes('-_8')), [0xfb, 0xff]);
});

test('ключ VAPID — несжатая точка P-256', () => {
  const bytes = keyBytes(RFC_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
});

console.log('sameKey');

test('подписка на тот же ключ остаётся', () => {
  assert.equal(sameKey(keyBytes(RFC_KEY).buffer as ArrayBuffer, RFC_KEY), true);
});

test('подписка на прежний ключ опознаётся как мёртвая', () => {
  const other = keyBytes(RFC_KEY);
  other[64] = (other[64] ?? 0) ^ 1;
  assert.equal(sameKey(other.buffer as ArrayBuffer, RFC_KEY), false);
});

test('браузер, не сообщивший ключ, подписку не теряет', () => {
  assert.equal(sameKey(null, RFC_KEY), true);
  assert.equal(sameKey(undefined, RFC_KEY), true);
});

// Поддельный браузер: push есть, разрешение дано; `subscribe` либо оформляет
// подписку, либо отказывает — как WebKit без жеста человека.
const env = { canSubscribe: true, sub: null as null | { endpoint: string } };

function fakeBrowser(): void {
  const g = globalThis as Record<string, unknown>;
  const pushManager = {
    getSubscription: async () => env.sub,
    subscribe: async () => {
      if (!env.canSubscribe) throw new Error('NotAllowedError: requires a user gesture');
      const sub = {
        endpoint: 'https://push.test/1',
        options: { applicationServerKey: keyBytes(RFC_KEY).buffer },
        toJSON: () => ({ endpoint: 'https://push.test/1' }),
        unsubscribe: async () => { env.sub = null; return true; },
      };
      env.sub = sub;
      return sub;
    },
  };
  const reg = { pushManager };
  const store = new Map<string, string>();
  g.window = {
    PushManager: class {},
    Notification: {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
    configurable: true,
    writable: true,
  });
  g.Notification = { permission: 'granted' };
  g.fetch = async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith('/push/key') ? { key: RFC_KEY } : {}),
  });
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

async function lostCases() {
  console.log('pushLost');
  fakeBrowser();
  let calls = 0;
  const stop = watchPushLost(() => { calls++; });

  await testAsync('подписка не оформилась — ящик узнаёт, что push потерян', async () => {
    env.canSubscribe = false;
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), true);
    assert.equal(calls, 1);
  });

  await testAsync('оформилась заново — потеря снята', async () => {
    env.canSubscribe = true;
    assert.equal(await enablePush(), true);
    assert.equal(pushLost(), false);
    assert.equal(calls, 2);
  });

  await testAsync('выключенные уведомления — не потеря', async () => {
    env.canSubscribe = false;
    env.sub = null;
    await enablePush();
    assert.equal(pushLost(), true);
    await disablePush();
    assert.equal(pushLost(), false);
  });

  await testAsync('браузер без push — не потеря: остаются уведомления страницы', async () => {
    const win = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
    const PushManager = win.PushManager;
    delete win.PushManager;
    env.canSubscribe = false;
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), false);
    win.PushManager = PushManager;
  });

  stop();
}

void lostCases().then(() => {
  if (failures) {
    console.error(`\n${failures} проверок не прошло`);
    process.exit(1);
  }
  console.log('\nвсё прошло');
});

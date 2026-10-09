// Подписка Web Push: разбор ключа сервера, опознание подписки на прежний ключ и
// «подписки не стало» для ящика чата.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/roomPush.test.ts

import assert from 'node:assert/strict';
import {
  disablePush, enablePush, keyBytes, pushLost, renewPush, sameKey, watchPushLost,
} from './roomPush';

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

/// Поддельный браузер: push есть, разрешение дано. Каждый способ не подписаться —
// свой: отказ самого браузера (WebKit без жеста — NotAllowedError), отказ
// push-сервиса (Brave без него — AbortError), сеть и ответы комнаты.
const env = {
  subscribeError: null as null | 'NotAllowedError' | 'AbortError',
  sub: null as null | { endpoint: string },
  offline: false,
  keyStatus: 200,
  saveStatus: 200,
  fetches: [] as string[],
  subscribes: 0,
};

function fakeBrowser(): void {
  const g = globalThis as Record<string, unknown>;
  const pushManager = {
    getSubscription: async () => env.sub,
    // не async: отказ и вызов фиксируются синхронно, как у браузера
    subscribe: () => {
      env.subscribes++;
      if (env.subscribeError) {
        return Promise.reject(new DOMException('subscribe refused', env.subscribeError));
      }
      const sub = {
        endpoint: 'https://push.test/1',
        options: { applicationServerKey: keyBytes(RFC_KEY).buffer },
        toJSON: () => ({ endpoint: 'https://push.test/1' }),
        unsubscribe: async () => { env.sub = null; return true; },
      };
      env.sub = sub;
      return Promise.resolve(sub);
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
  g.fetch = async (url: string) => {
    env.fetches.push(url);
    if (env.offline) throw new TypeError('Failed to fetch');
    const status = url.endsWith('/push/key') ? env.keyStatus : env.saveStatus;
    return {
      ok: status < 400,
      status,
      json: async () => (url.endsWith('/push/key') ? { key: RFC_KEY } : {}),
    };
  };
}

/** Исходное: подписки нет, браузер и сеть в порядке, потери нет. */
async function reset(): Promise<void> {
  Object.assign(env, { subscribeError: null, offline: false, keyStatus: 200, saveStatus: 200 });
  await disablePush();
  env.sub = null;
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await reset();
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

  await testAsync('подписки нет, браузер отказал (WebKit без жеста) — потеря', async () => {
    let calls = 0;
    const stop = watchPushLost(() => { calls++; });
    env.subscribeError = 'NotAllowedError';
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), true);
    assert.equal(calls, 1);
    stop();
  });

  await testAsync('оформилась заново — потеря снята', async () => {
    env.subscribeError = 'NotAllowedError';
    await enablePush();
    env.subscribeError = null;
    assert.equal(await enablePush(), true);
    assert.equal(pushLost(), false);
  });

  await testAsync('сеть не ответила — не потеря', async () => {
    env.offline = true;
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), false);
  });

  await testAsync('комната ответила 5xx или 429 на ключ — не потеря', async () => {
    for (const status of [502, 429]) {
      env.keyStatus = status;
      assert.equal(await enablePush(), false, String(status));
      assert.equal(pushLost(), false, String(status));
    }
  });

  await testAsync('подписка есть, комната не сохранила её — не потеря', async () => {
    assert.equal(await enablePush(), true);
    env.saveStatus = 503;
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), false);
  });

  await testAsync('push-сервиса нет (Brave, AbortError) — не потеря', async () => {
    env.subscribeError = 'AbortError';
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), false);
  });

  await testAsync('выключенные уведомления — не потеря', async () => {
    env.subscribeError = 'NotAllowedError';
    await enablePush();
    assert.equal(pushLost(), true);
    await disablePush();
    assert.equal(pushLost(), false);
  });

  await testAsync('нажатие «включите заново» — subscribe() сразу, без сети до него', async () => {
    // переподписка при открытии плеера: WebKit без жеста отказал
    env.subscribeError = 'NotAllowedError';
    await enablePush();
    assert.equal(pushLost(), true);
    env.subscribeError = null;
    env.fetches = [];
    env.subscribes = 0;
    const pending = renewPush();      // обработчик нажатия, без await
    assert.equal(env.subscribes, 1, 'subscribe() вызван синхронно, в самом нажатии');
    assert.deepEqual(env.fetches, [], 'до subscribe() не было ни одного запроса');
    assert.equal(await pending, true);
    assert.equal(pushLost(), false);
    assert.deepEqual(env.fetches, ['/room/push/subscribe']);
  });

  await testAsync('нажатие, а браузер снова отказал — потеря остаётся', async () => {
    env.subscribeError = 'NotAllowedError';
    await enablePush();
    assert.equal(await renewPush(), false);
    assert.equal(pushLost(), true);
  });

  await testAsync('браузер без push — не потеря: остаются уведомления страницы', async () => {
    const win = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
    const PushManager = win.PushManager;
    delete win.PushManager;
    env.subscribeError = 'NotAllowedError';
    assert.equal(await enablePush(), false);
    assert.equal(pushLost(), false);
    win.PushManager = PushManager;
  });
}

void lostCases().then(() => {
  if (failures) {
    console.error(`\n${failures} проверок не прошло`);
    process.exit(1);
  }
  console.log('\nвсё прошло');
});

// Service worker станции (web/public/sw.js): что делает push и нажатие на
// уведомление. sw.js — классический скрипт без модулей, поэтому он грузится
// как есть в контекст node:vm с поддельными self/clients/registration.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/serviceWorker.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const SOURCE = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
const ORIGIN = 'https://radio.test';

const UA = {
  // установленное на iPhone приложение: в строке нет даже `Safari/`
  iosApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
};

interface FakeWindow {
  url: string;
  visibilityState: 'visible' | 'hidden';
  focused: boolean;
  messages: unknown[];
  focus: () => Promise<FakeWindow>;
  postMessage: (msg: unknown) => void;
}

interface Shown {
  title: string;
  options: { tag?: string; badge?: string; data?: { url?: string } };
  open: boolean;
  close: () => void;
}

type Handler = (event: unknown) => void;

function win(path: string, visibilityState: 'visible' | 'hidden' = 'visible'): FakeWindow {
  const w: FakeWindow = {
    url: ORIGIN + path,
    visibilityState,
    focused: false,
    messages: [],
    focus: async () => { w.focused = true; return w; },
    postMessage: (msg) => { w.messages.push(msg); },
  };
  return w;
}

/** sw.js в поддельном окружении: окна, показанные уведомления, открытые адреса. */
function worker(userAgent: string, windows: FakeWindow[]) {
  const handlers: Record<string, Handler> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const navigator = { userAgent };
  const self = {
    location: { origin: ORIGIN },
    navigator,
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); return null; },
      claim: async () => {},
    },
    registration: {
      // как у браузера: тот же tag заменяет прежнюю карточку, а не встаёт рядом
      showNotification: async (title: string, options: Shown['options']) => {
        for (const n of shown) if (n.open && n.options.tag === options.tag) n.open = false;
        const n: Shown = { title, options, open: true, close: () => { n.open = false; } };
        shown.push(n);
      },
      getNotifications: async (filter?: { tag?: string }) =>
        shown.filter(n => n.open && (!filter?.tag || n.options.tag === filter.tag)),
    },
  };
  const ctx: Record<string, unknown> = { self, navigator, URL, console };
  runInNewContext(SOURCE, ctx);

  async function fire(type: string, event: Record<string, unknown>): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const handler = handlers[type];
    assert.ok(handler, `нет обработчика ${type}`);
    handler({ ...event, waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    assert.ok(pending.length > 0, `${type}: без event.waitUntil браузер не ждёт обработчика`);
    await Promise.all(pending);
  }

  return {
    shown,
    opened,
    ctx,
    push: (payload: Record<string, unknown>) =>
      fire('push', { data: { json: () => payload } }),
    click: (data: Record<string, unknown>) =>
      fire('notificationclick', { notification: { data, close: () => {} } }),
  };
}

const MSG = { title: 'Петя — в чате', body: 'Привет', tag: 'subwave-chat', url: '/?chat=1' };

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

async function main() {
  console.log('push');

  await test('скрытая вкладка: уведомление показано и остаётся в шторке', async () => {
    for (const ua of [UA.android, UA.iosApp]) {
      const sw = worker(ua, [win('/', 'hidden')]);
      await sw.push(MSG);
      assert.equal(sw.shown.length, 1, ua);
      assert.equal(sw.shown[0]?.open, true, ua);
      assert.equal(sw.shown[0]?.options.tag, 'subwave-chat', ua);
    }
  });

  await test('видимая вкладка не на WebKit: уведомления нет, скажет тост', async () => {
    for (const ua of [UA.android, UA.edge, UA.firefox]) {
      const sw = worker(ua, [win('/')]);
      await sw.push(MSG);
      assert.equal(sw.shown.length, 0, ua);
    }
  });

  await test('видимая вкладка на WebKit: уведомление показано и сразу закрыто', async () => {
    // WebKit считает push без showNotification тихим и снимает подписку
    for (const ua of [UA.iosApp, UA.iosChrome, UA.macSafari]) {
      const sw = worker(ua, [win('/')]);
      await sw.push(MSG);
      assert.equal(sw.shown.length, 1, ua);
      assert.equal(sw.shown[0]?.options.tag, 'subwave-chat', ua);
      assert.equal(sw.shown[0]?.open, false, ua);
    }
  });

  await test('значок строки состояния — прозрачный, не иконка установки', async () => {
    // Android красит badge по альфа-каналу; /icons/192 непрозрачна — квадрат
    const sw = worker(UA.android, [win('/', 'hidden')]);
    await sw.push(MSG);
    assert.equal(sw.shown[0]?.options.badge, '/icons/badge');
  });

  console.log('notificationclick');

  await test('поднимается вкладка плеера, а не первая вкладка сайта', async () => {
    const admin = win('/admin');
    const player = win('/');
    const sw = worker(UA.android, [admin, win('/manual'), player]);
    await sw.click({ url: '/?chat=1' });
    assert.equal(admin.focused, false);
    assert.deepEqual(admin.messages, []);
    assert.equal(player.focused, true);
    // объект создан в контексте vm — у него чужой Object.prototype
    assert.equal(JSON.stringify(player.messages), '[{"type":"room:open-chat"}]');
    assert.deepEqual(sw.opened, []);
  });

  await test('плеера среди вкладок нет — новая с ?chat=1, чужие не трогаются', async () => {
    const admin = win('/admin');
    const news = win('/news');
    const sw = worker(UA.android, [admin, news]);
    await sw.click({ url: '/?chat=1' });
    assert.equal(admin.focused || news.focused, false);
    assert.deepEqual(sw.opened, [`${ORIGIN}/?chat=1`]);
  });

  await test('плеер на /listen — тоже плеер, второй вкладки не будет', async () => {
    const admin = win('/admin');
    const player = win('/listen');
    const sw = worker(UA.android, [admin, player]);
    await sw.click({ url: '/?chat=1' });
    assert.equal(admin.focused, false);
    assert.equal(player.focused, true);
    assert.equal(JSON.stringify(player.messages), '[{"type":"room:open-chat"}]');
    assert.deepEqual(sw.opened, []);
  });

  await test('/listening и /listen/x — не плеер', async () => {
    const sw = worker(UA.android, [win('/listening'), win('/listen/x')]);
    await sw.click({ url: '/?chat=1' });
    assert.deepEqual(sw.opened, [`${ORIGIN}/?chat=1`]);
  });

  await test('плеер с чатом в адресе — тоже плеер', async () => {
    const player = win('/?chat=1#x');
    const sw = worker(UA.android, [player]);
    await sw.click({});
    assert.equal(player.focused, true);
    assert.deepEqual(sw.opened, []);
  });

  if (failures) {
    console.error(`\n${failures} проверок не прошло`);
    process.exit(1);
  }
  console.log('\nвсё прошло');
}

void main();

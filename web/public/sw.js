// SUB/WAVE service worker — minimal, hand-rolled. Goals:
//   1. Make the app installable (PWA install criteria require an active SW).
//   2. Keep the app shell responsive when the network blips, so the lock-screen
//      controls and "scanning the dial" state survive a flaky connection.
// Non-goals:
//   • Offline playback. The live Icecast stream and the controller API are
//     pass-through (network-only). Caching either would either serve stale
//     audio chunks or stale "now playing" state — both worse than failing.
//
// Cache strategy:
//   • /stream.mp3, /stream.opus, /api/*  → bypass entirely (do not even respondWith).
//   • POST / non-GET       → bypass.
//   • Cross-origin         → bypass (Next image/font CDNs can self-cache).
//   • /_next/static/*      → cache-first. These URLs are content-hashed and
//                            immutable, so a cache hit is always correct.
//   • Everything else (HTML documents, RSC payloads, icons, manifest)
//                          → network-first, cache only as an offline fallback.
//
// Why network-first for HTML and not stale-while-revalidate: an HTML document
// (or RSC payload) embeds references to content-hashed `_next/static/*` chunk
// filenames. After a deploy those hashes change. Serving a *stale* cached
// document means the browser then requests chunk hashes the server no longer
// has → 404 → ChunkLoadError → "Application error: a client-side exception".
// That is exactly the failure a stale-while-revalidate HTML cache produced on
// the first route a returning visitor landed on after a deploy. Network-first
// guarantees the document always matches the build whose chunks are live.
//
// Bump CACHE on any deploy that changes this file's semantics — the `activate`
// handler deletes every cache whose key isn't the current CACHE, which is what
// evicts a previous version's (now-poisoned) HTML.

const CACHE = 'subwave-shell-v2';

self.addEventListener('install', (event) => {
  // Take over straight away so a freshly-deployed shell isn't stuck behind
  // the previous worker for a whole tab lifetime.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/stream.mp3' || url.pathname === '/stream.opus') return;
  if (url.pathname.startsWith('/api/')) return;
  // The room — live data and files of 8–14 MB. networkFirst would put every
  // downloaded track into Cache Storage a second time, and serving would go
  // through respondWith — a layer where standalone iOS behaves unpredictably.
  if (url.pathname.startsWith('/room/')) return;

  // Content-hashed, immutable build assets — a cache hit is always correct.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML documents, RSC navigations, icons, manifest — must track the live
  // build. Network-first; the cache is only a flaky-network fallback.
  event.respondWith(networkFirst(request));
});

// Immutable assets: serve from cache if present, otherwise fetch and store.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    return Response.error();
  }
}

// Everything else: always prefer the network so the shell matches the deployed
// build; fall back to the last good cached copy only when the network fails.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

// WebKit — Safari и любой браузер на iOS. Узнаётся по строке агента: движка
// service worker не сообщает. `AppleWebKit` пишут и Chromium-браузеры, но у
// всех них есть токен `Chrome/` (Edge, Opera, Samsung — тоже), а у iOS-сборок
// Chrome и Edge его нет (`CriOS/`, `EdgiOS/`) — они и есть WebKit. `Safari/`
// не годится как признак: у установленного на iPhone приложения его в строке нет.
function isWebKit(ua) {
  return /AppleWebKit\//.test(ua) && !/\b(Chrome|Chromium|Edg)\//.test(ua);
}

// Web Push комнаты (station/room/push.py): важное в чате при закрытой вкладке.
// Открытая и видимая вкладка скажет сама — тостом, и вторая карточка об одном
// была бы шумом. Тег `subwave-chat` — тот же, что у уведомления страницы
// (lib/roomNotify.ts): живая скрытая вкладка и push-сервис не выстроят в
// шторке двух карточек об одном сообщении, вторая заменит первую.
//
// Кроме WebKit: push, на который не вызван showNotification, он считает тихим и
// после нескольких таких снимает подписку — а переподписка без жеста молча не
// удаётся. Поэтому там уведомление показывается всегда, а при видимом окне
// сразу закрывается: о сообщении и так скажет тост.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* не JSON — покажем заголовок по умолчанию */
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = wins.some((w) => w.visibilityState === 'visible');
      const webkit = isWebKit((self.navigator && self.navigator.userAgent) || '');
      if (visible && !webkit) return;
      const tag = data.tag || 'subwave-chat';
      await self.registration.showNotification(data.title || 'AI радио', {
        body: data.body || '',
        tag,
        icon: '/icons/192',
        badge: '/icons/192',
        data: { url: data.url || '/?chat=1' },
      });
      if (!visible) return;
      const shown = await self.registration.getNotifications({ tag });
      for (const n of shown) n.close();
    })()
  );
});

// Нажатие на уведомление: открытая вкладка плеера поднимается и открывает чат,
// иначе открывается новая — с `?chat=1`, по которому плеер откроет его сам.
// Вкладка плеера — та, чей путь совпадает с адресом уведомления (`/`): любая
// вкладка сайта не годится — `room:open-chat` слушает только плеер, и у
// владельца первой оказывалась админка, где чат не открывался.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/?chat=1',
    self.location.origin);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        const at = new URL(w.url);
        if (at.origin === target.origin && at.pathname === target.pathname && 'focus' in w) {
          await w.focus();
          w.postMessage({ type: 'room:open-chat' });
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })()
  );
});

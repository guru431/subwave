'use client';

// Настоящий Web Push: уведомление о важном в чате при ЗАКРЫТОЙ вкладке.
//
// Уведомление страницы (roomNotify.ts) живёт, пока жива вкладка; закрытую
// будит только push-сервис браузера — по подписке, которую хранит комната
// (station/room/push.py). Подписка идёт от того же переключателя «Уведомлять о
// важном»: согласие одно, способов доставки два. Что считается важным, решает
// комната по тем же правилам, что и roomRules.ts.
//
// Недоступный push — не поломка: уведомления страницы работают как прежде,
// поэтому все функции здесь молча возвращают «не вышло», а не бросают.

import { listener } from './listener';

const ROOM = '/room';

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** base64url → байты: в таком виде PushManager.subscribe() ждёт ключ сервера. */
export function keyBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Совпадает ли ключ сервера, на который оформлена подписка, с нынешним. */
export function sameKey(current: ArrayBuffer | null | undefined, key: string): boolean {
  // Браузер, не сообщающий ключ подписки, — повод её не трогать, а не снимать
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = keyBytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function headers(): Record<string, string> {
  const me = listener();
  return {
    'Content-Type': 'application/json',
    'X-Listener-Id': me.id,
    // заголовки по RFC 7230 — latin-1, кириллица в имени едет percent-encoded
    'X-Listener-Name': encodeURIComponent(me.name),
  };
}

/** Подписаться — или обновить подписку: комната ловит упоминание по имени,
 *  и имя, сменённое после подписки, должно до неё доехать. */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch(`${ROOM}/push/key`);
    if (!res.ok) return false;
    const { key } = (await res.json()) as { key: string };
    let sub = await reg.pushManager.getSubscription();
    // Подписка на прежний ключ комнаты мертва: push-сервис отвергнет подпись
    // сервера. Её снимают и заводят заново, а не оставляют молча не работать.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      });
    }
    const saved = await fetch(`${ROOM}/push/subscribe`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return saved.ok;
  } catch {
    return false;
  }
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const { endpoint } = sub;
    await sub.unsubscribe();
    await fetch(`${ROOM}/push/unsubscribe`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* комната забудет подписку сама — по первому 410 от push-сервиса */
  }
}

'use client';

// Системное уведомление браузера о важном в чате.
//
// Показывается ТОЛЬКО при скрытой вкладке: на открытой своё дело делает тост, а
// два уведомления об одном — это шум, а не забота.
//
// Разрешение браузер даёт лишь по жесту человека, поэтому спрашивает его
// askPermission() из переключателя в ящике, а не страница при загрузке.

import { isIOSDevice, isStandalone } from './platform';
import { listener } from './listener';

export type NotifyState = 'ready' | 'ask' | 'denied' | 'ios-install' | 'unsupported';

export interface NotifyEnv {
  supported: boolean;
  permission: 'default' | 'granted' | 'denied';
  ios: boolean;
  standalone: boolean;
}

/** Чистое решение: что показывать вместо переключателя. Вынесено из readEnv,
 *  потому что проверить можно только то, у чего нет окружения. */
export function notifyState(env: NotifyEnv): NotifyState {
  // Порядок проверок важен: на iOS вне установленного приложения объекта
  // Notification либо нет, либо запрос молча не срабатывает, и сказать про
  // «Поделиться → На экран „Домой"» полезнее, чем про «браузер не умеет».
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.supported) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  if (env.permission === 'granted') return 'ready';
  return 'ask';
}

export function readEnv(): NotifyEnv {
  if (typeof window === 'undefined') {
    return { supported: false, permission: 'default', ios: false, standalone: false };
  }
  const supported = 'Notification' in window;
  return {
    supported,
    permission: supported ? Notification.permission : 'default',
    ios: isIOSDevice(),
    standalone: isStandalone(),
  };
}

/** Спросить разрешение. Зовётся только из обработчика нажатия: без жеста
 *  браузеры запрос игнорируют. */
export async function askPermission(): Promise<NotifyState> {
  const env = readEnv();
  const state = notifyState(env);
  if (state !== 'ask') return state;
  try {
    const answer = await Notification.requestPermission();
    return notifyState({ ...env, permission: answer });
  } catch {
    return 'unsupported';
  }
}

export function showHidden(title: string, body: string, onClick: () => void): void {
  if (typeof document === 'undefined' || !document.hidden) return;
  if (notifyState(readEnv()) !== 'ready') return;
  // Разрешение браузера и согласие слушателя — разные вещи: снятая в ящике
  // галочка обязана выключать показ, а не только рисоваться снятой.
  if (!listener().notify) return;
  try {
    // Один tag на весь чат: пока слушатель не вернулся, три сообщения подряд
    // должны сменять друг друга в шторке, а не выстроиться в стопку.
    const n = new Notification(title, { body, tag: 'subwave-chat', icon: '/icons/192' });
    n.onclick = () => {
      window.focus();
      n.close();
      onClick();
    };
  } catch {
    /* браузер вправе отказать и с granted (например, в фоновом окне) */
  }
}

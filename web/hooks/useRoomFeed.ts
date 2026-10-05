'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { listener, setLastSeenId, setListenerName } from '@/lib/listener';
import { unreadCount, type RoomMessage } from '@/lib/roomRules';

// Открытый ящик — как было до уведомлений. Закрытый опрашивается вшестеро реже:
// счётчику на точке секунды не важны, а это телефон в кармане.
const OPEN_POLL_MS = 5_000;
const CLOSED_POLL_MS = 30_000;
// Сколько сообщений держим в памяти вкладки; лента комнаты длиннее.
const KEEP_MESSAGES = 100;

export interface UseRoomFeedOptions {
  /** Открыт ли ящик чата: от этого зависит и частота опроса, и то, считается
   *  ли пришедшее прочитанным. */
  open: boolean;
  /** Скрытая вкладка опрашивает комнату, только пока играет эфир: страница при
   *  этом и так жива и ходит за /now-playing. Ref, а не значение, — чтобы
   *  включение эфира не пересобирало подписку (тот же приём, что у
   *  useStationFeed). */
  keepAliveWhenHidden?: RefObject<boolean>;
  /** Зовётся на каждой непустой пачке. `firstLoad` — пачка первого удачного
   *  опроса: по ней ничего не должно звучать, это история, а не новое.
   *  `ownIds` — номера сообщений, отправленных из этой вкладки: своё звенеть
   *  не должно, а курсор «прочитано» для этого не годится — при открытом
   *  ящике он проходит всю пачку ещё до вызова. */
  onArrive?: (fresh: RoomMessage[], firstLoad: boolean, ownIds: ReadonlySet<number>) => void;
}

export interface RoomFeed {
  messages: RoomMessage[];
  unread: number;
  sending: boolean;
  /** `null` — отправлено; строка — причина отказа для показа человеку. */
  send: (text: string, name: string) => Promise<string | null>;
}

export function useRoomFeed({ open, keepAliveWhenHidden, onArrive }: UseRoomFeedOptions): RoomFeed {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [sending, setSending] = useState(false);
  // Докуда СКАЧАНО из комнаты. Не путать с lastSeenRef: докуда ПРОЧИТАНО
  // человеком. Скачать можно при закрытом ящике, прочитать — нет.
  const sinceRef = useRef(0);
  const lastSeenRef = useRef(0);
  const firstLoadRef = useRef(true);
  const openRef = useRef(open);
  const arriveRef = useRef(onArrive);
  const busyRef = useRef(false);
  const ownIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => { arriveRef.current = onArrive; }, [onArrive]);
  useEffect(() => { openRef.current = open; }, [open]);
  // Первым эффектом, до опроса: listener() трогает localStorage, и делать это
  // в теле рендера нельзя. Порядок эффектов в React — порядок объявления.
  useEffect(() => { lastSeenRef.current = listener().lastSeenId; }, []);

  const markRead = useCallback((upTo: number) => {
    if (upTo > lastSeenRef.current) {
      lastSeenRef.current = upTo;
      setLastSeenId(upTo);
    }
    setUnread(0);
  }, []);

  const poll = useCallback(async () => {
    // Опрос зовут двое: интервал и отправка. Без этого замка оба прочитали бы
    // один и тот же `sinceRef`, получили одну пачку и дописали её дважды —
    // дубли в ленте и двойной счёт непрочитанного.
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      try {
        const r = await fetch(`/room/messages?since=${sinceRef.current}`);
        if (!r.ok) return;
        const body = (await r.json()) as { messages: RoomMessage[]; last: number };
        const fresh = body.messages || [];
        const wasFirst = firstLoadRef.current;
        firstLoadRef.current = false;
        if (!fresh.length) return;
        sinceRef.current = body.last;
        setMessages(prev => [...prev, ...fresh].slice(-KEEP_MESSAGES));
        if (openRef.current) markRead(body.last);
        else setUnread(n => n + unreadCount(fresh, lastSeenRef.current));
        arriveRef.current?.(fresh, wasFirst, ownIdsRef.current);
      } catch {
        /* комната недоступна — лента просто не пополняется */
      }
    } finally {
      busyRef.current = false;
    }
  }, [markRead]);

  // Ящик открыли — всё, что в нём видно, прочитано. pollWhileVisible на
  // переднем плане стреляет сразу, поэтому свежее подтянется тем же движением.
  useEffect(() => { if (open) markRead(sinceRef.current); }, [open, markRead]);

  useEffect(() => pollWhileVisible(
    () => { void poll(); },
    open ? OPEN_POLL_MS : CLOSED_POLL_MS,
    () => (keepAliveWhenHidden?.current ? CLOSED_POLL_MS : null),
  ), [open, poll, keepAliveWhenHidden]);

  const send = useCallback(async (text: string, name: string): Promise<string | null> => {
    const body = text.trim();
    if (!body) return 'Пустое сообщение';
    const who = name.trim();
    if (!who) return 'Как вас зовут? Ведущий обращается по имени.';
    setSending(true);
    try {
      setListenerName(who);
      const me = listener();
      const r = await fetch('/room/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Listener-Id': me.id,
          // Заголовки по RFC 7230 — latin-1, кириллица в них иначе не проходит.
          'X-Listener-Name': encodeURIComponent(who),
        },
        body: JSON.stringify({ text: body }),
      });
      const payload = (await r.json().catch(() => null)) as { id?: number; error?: string } | null;
      if (!r.ok) return payload?.error || 'Сообщение не отправлено';
      // Курсор двигается по ответу комнаты, а не по приходу своего сообщения
      // следующим опросом: иначе закрытый сразу после отправки ящик посчитал бы
      // собственную реплику непрочитанной.
      if (typeof payload?.id === 'number') {
        markRead(payload.id);
        ownIdsRef.current.add(payload.id);
      }
      void poll();
      return null;
    } catch {
      return 'Комната недоступна';
    } finally {
      setSending(false);
    }
  }, [markRead, poll]);

  return { messages, unread, sending, send };
}

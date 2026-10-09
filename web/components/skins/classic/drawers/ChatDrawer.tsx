'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listener, setNotifyEnabled, LISTENER_NAME_MAX } from '@/lib/listener';
import { askPermission, notifyState, readEnv, type NotifyState } from '@/lib/roomNotify';
import { disablePush, enablePush, pushLost, renewPush, watchPushLost } from '@/lib/roomPush';
import type { FeedItem } from '@/lib/roomRules';

const TEXT_MAX = 280;        // та же цифра, что у заказа (REQUEST_TEXT_MAX)
const AT_BOTTOM_PX = 40;     // ближе к дну — читатель «внизу», лента его догоняет

// Что написано вместо переключателя, когда включать нечего. Молчать нельзя:
// невидимая причина читается как поломка.
const NOTIFY_EXPLAIN: Partial<Record<NotifyState, string>> = {
  denied: 'Уведомления запрещены в настройках браузера',
  'ios-install': 'Уведомления на iPhone — только из установленного приложения',
  unsupported: 'Этот браузер не умеет системные уведомления',
};

export interface ChatDrawerProps {
  /** Лента целиком: сообщения комнаты вперемешку со строками станции. Склейку
   *  делает скин — у него одного есть и комната, и эфир. */
  items: FeedItem[];
  send: (text: string, name: string) => Promise<string | null>;
  sending: boolean;
}

export default function ChatDrawer({ items, send, sending }: ChatDrawerProps) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  const [state, setState] = useState<NotifyState>('ask');
  // Подписку снял браузер (WebKit — за «тихие» push), а переподписка без жеста
  // не удалась: галочка стоит, push мёртв. Молчать нельзя — нужно нажатие.
  const lost = useSyncExternalStore(watchPushLost, pushLost, () => false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  // Был ли читатель у дна ДО новой строки: меряется на прокрутке, а новая
  // строка удлиняет ленту без неё. Открытый ящик встаёт на последнее.
  const atBottomRef = useRef(true);
  // Своё только что отправленное видно, даже если человек листал историю.
  const sentRef = useRef(false);

  useEffect(() => {
    const me = listener();
    setName(me.name);
    setNotifyOn(me.notify);
    setState(notifyState(readEnv()));
  }, []);

  // Лента меняется и сама — строкой «сейчас играет» раз в трек, чужим
  // сообщением, ответом ведущего. Тянуть вниз того, кто листает историю, —
  // сбивать его с места; догоняем только стоящего у дна и только что писавшего.
  useEffect(() => {
    if (!atBottomRef.current && !sentRef.current) return;
    sentRef.current = false;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
  }, []);

  const toggleNotify = useCallback(async () => {
    if (notifyOn) {
      setNotifyOn(false);
      setNotifyEnabled(false);
      void disablePush();
      return;
    }
    const next = await askPermission();
    setState(next);
    const on = next === 'ready';
    setNotifyOn(on);
    setNotifyEnabled(on);
    // Второй способ доставки — для закрытой вкладки. Не вышло (браузер без
    // push, комната без ключа) — остаются уведомления страницы, как раньше.
    if (on) void enablePush();
  }, [notifyOn]);

  const submit = useCallback(async () => {
    if (sending) return;
    const before = listener().name;
    const problemText = await send(text, name);
    setProblem(problemText);
    if (!problemText) {
      setText('');
      sentRef.current = true;
    }
    // По имени из подписки комната узнаёт автора на его другом устройстве:
    // сменившееся имя должно доехать и туда, иначе своё сообщение зазвенит
    const me = listener();
    if (!problemText && me.notify && me.name !== before) void enablePush();
  }, [send, text, name, sending]);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* role=log: новые строки скринридер объявляет сам, не перебивая */}
      <div
        ref={feedRef}
        onScroll={onFeedScroll}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 ? (
          <div className="text-[13px] leading-relaxed text-muted">
            Пока тихо. Напишите — ведущий читает чат и отвечает в эфире.
          </div>
        ) : (
          items.map(item =>
            item.kind === 'msg' ? (
              <div key={item.key} className="border-b border-separator-soft py-[10px]">
                <div className="text-[9px] tracking-[0.3em] text-muted uppercase">{item.name}</div>
                <div className="mt-0.5 text-sm text-ink">{item.text}</div>
              </div>
            ) : item.kind === 'dj' ? (
              <div key={item.key} className="border-b border-separator-soft py-[10px]">
                <div className="text-[9px] tracking-[0.3em] text-vermilion uppercase">Ведущий</div>
                <div className="mt-0.5 text-sm text-ink">{item.text}</div>
              </div>
            ) : (
              <div key={item.key} className="py-[10px] text-[11px] text-muted">
                ♪ {item.text}
              </div>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={LISTENER_NAME_MAX}
          placeholder="Ваше имя"
          aria-label="Ваше имя"
          className="w-full rounded border border-separator-strong bg-transparent px-2 py-1 text-sm"
        />
        <textarea
          value={text}
          onChange={e => setText(e.target.value.slice(0, TEXT_MAX))}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Сообщение ведущему"
          aria-label="Сообщение ведущему"
          className="w-full resize-none rounded border border-separator-strong bg-transparent px-2 py-1 text-sm"
        />
        {problem && <div className="text-xs text-vermilion">{problem}</div>}
        <div className="flex items-center justify-between gap-2">
          {state === 'ask' || state === 'ready' ? (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={notifyOn} onChange={() => void toggleNotify()} />
              Уведомлять о важном
            </label>
          ) : (
            <span className="text-[11px] text-muted">{NOTIFY_EXPLAIN[state]}</span>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            className="self-end rounded bg-vermilion px-3 py-1 text-xs tracking-eyebrow uppercase disabled:opacity-40"
          >
            {sending ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
        {notifyOn && lost && (state === 'ask' || state === 'ready') && (
          // Потеря бывает только при разрешении granted, так что спрашивать его
          // не нужно: subscribe() зовётся прямо в нажатии — WebKit требует жеста.
          <button
            type="button"
            onClick={() => void renewPush()}
            className="self-start text-left text-[11px] text-vermilion underline"
          >
            Уведомления отключены — включите заново
          </button>
        )}
      </div>
    </div>
  );
}

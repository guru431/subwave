'use client';

// The reference consumer of the skin contract (see ../types.ts): everything
// here reads the core contexts; the shell owns the <audio> element, the root
// frame, and the toaster.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { CalendarClock, History, MessageSquare, Mic } from 'lucide-react';
import TopBar from './TopBar';
import CenterStage from './CenterStage';
import Waveform from './Waveform';
import TransportBar from './TransportBar';
import TuneInOverlay from './TuneInOverlay';
import DotRail from './DotRail';
import CommandPalette, { type PlayerDrawer } from './CommandPalette';
import ShortcutsDialog from './ShortcutsDialog';
import TimelineDrawer from './drawers/TimelineDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import ChatDrawer from './drawers/ChatDrawer';
import { Sheet } from '@/components/ui/sheet';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import type { SkinProps } from '@/components/skins/types';
import type { QueueEntry, RequestResult } from '@/lib/types';
import { useRoomFeed } from '@/hooks/useRoomFeed';
import { notify } from '@/lib/notify';
import { listener } from '@/lib/listener';
import { showHidden } from '@/lib/roomNotify';
import { enablePush } from '@/lib/roomPush';
import { djChatReplies, fromOthers, mergeFeed, turnKey, type FeedItem, type RoomMessage } from '@/lib/roomRules';

const DRAWER_TITLES: Record<PlayerDrawer, string> = {
  timeline: 'Лента',
  booth: 'Эфир студии',
  request: 'Заказать трек',
  schedule: 'Расписание',
  chat: 'Чат',
};

// Hoisted so the DotRail counts memo below keeps stable element references —
// recreating these per render would defeat DotRail's React.memo.
const TIMELINE_ICON = <History size={18} strokeWidth={1.5} />;
const BOOTH_ICON = <Mic size={18} strokeWidth={1.5} />;
const SCHEDULE_ICON = <CalendarClock size={18} strokeWidth={1.5} />;
const CHAT_ICON = <MessageSquare size={18} strokeWidth={1.5} />;
// Сколько строк держим в ящике: сообщения комнаты плюс строки станции.
const CHAT_FEED_MAX = 100;

export default function ClassicSkin({ portalNode }: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, llmTokens,
    state, session, trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const boothFeed = session.messages;
  const { audioRef, tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { tune, toggleMute, setVolume, submitRequest: coreSubmitRequest, pollRequest } =
    usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  // Normalise the feed's number | { current } | null shape to a plain count.
  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : (listeners.current ?? null);

  // Same coverSrc shape as CenterStage so the extraction hits the controller's
  // cached proxy.
  const coverSubsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = coverSubsonicId ? client.coverUrl(coverSubsonicId) : null;
  const coverColors = useCoverColors(coverSrc);
  const ambientRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(ambientRef, {
    '--cover-tint': coverColors.vibrant,
    '--cover-tint-2': coverColors.average ?? coverColors.vibrant,
  });

  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawer, setDrawer] = useState<PlayerDrawer | null>(null);

  const chatOpen = drawer === 'chat';
  // Своя копия «эфир играет» ссылкой: такая же есть в PlayerCore для ленты
  // станции, но она не выставлена наружу, а расширять контекст ради одного
  // потребителя — дороже, чем две строки здесь.
  const tunedInRef = useRef(false);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);

  const [chatEvents, setChatEvents] = useState<FeedItem[]>([]);
  const openChat = useCallback(() => setDrawer('chat'), []);

  // Web Push (lib/roomPush.ts). Переподписка на каждом открытии плеера: имя для
  // упоминаний не должно отставать от подписки, а подписку, потерянную комнатой,
  // это возвращает. Нажатие на уведомление открывает плеер с `?chat=1` — либо,
  // если вкладка уже открыта, service worker присылает `room:open-chat`.
  useEffect(() => {
    if (listener().notify) void enablePush();
    const params = new URLSearchParams(window.location.search);
    if (params.get('chat') === '1') {
      openChat();
      params.delete('chat');
      const rest = params.toString();
      window.history.replaceState(null, '',
        window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
    }
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'room:open-chat') openChat();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [openChat]);

  // Громкое на сообщения комнаты: каждое чужое (lib/roomRules.ts::fromOthers).
  // Первая пачка — это история, и звучать она не должна. Звенит последнее
  // чужое сообщение пачки, а не каждое: после переподключения пачка бывает
  // длинной, и стопка тостов — это шум, а не новость.
  const onArrive = useCallback((fresh: RoomMessage[], firstLoad: boolean, ownIds: ReadonlySet<number>) => {
    if (firstLoad) return;
    const last = fromOthers(fresh, ownIds, listener().name).at(-1);
    if (!last) return;
    if (!chatOpen) notify.chat(last.name, last.text, openChat);
    showHidden(last.name, last.text, openChat);
  }, [chatOpen, openChat]);

  const room = useRoomFeed({ open: chatOpen, keepAliveWhenHidden: tunedInRef, onArrive });

  // Лента студии уже отфильтрована по слышимости (useStationFeed →
  // splitAudibleTurns), поэтому реплика попадает в чат ровно тогда, когда
  // слушатель её слышит, а не когда контроллер её сочинил.
  const seenTurnsRef = useRef<Set<string>>(new Set());
  const boothSeededRef = useRef(false);
  useEffect(() => {
    if (!boothFeed.length) return;
    // Первая пришедшая лента — окно истории. Она должна быть ВИДНА: лента
    // комнаты после перезагрузки возвращается целиком, и ответы ведущего не
    // могут при этом пропадать — иначе в чате остаются люди, говорящие в
    // пустоту. Молчать она обязана: иначе перезагрузка выстреливала бы тостами
    // по всему, что ведущий успел сказать за последние полчаса. Взводится на
    // первой непустой ленте, а не на первой ленте с репликами chat: иначе
    // первый настоящий ответ за сессию (ведущий отвечает редко, и до него в
    // окне ленты реплик chat нет) сходил бы за историю и звучал бы молча.
    const seeded = boothSeededRef.current;
    boothSeededRef.current = true;
    const replies = djChatReplies(boothFeed, seenTurnsRef.current);
    for (const t of replies) seenTurnsRef.current.add(turnKey(t));
    if (!replies.length) return;
    setChatEvents(prev => [
      ...prev,
      ...replies.map(t => ({
        kind: 'dj' as const,
        key: turnKey(t),
        at: Date.parse(String(t.meta?.airedAt ?? '')) || Date.now(),
        text: t.text || '',
      })),
    ].slice(-CHAT_FEED_MAX));
    if (!seeded) return;   // история видна, но молчит
    const last = replies.at(-1);
    if (!last) return;
    if (!chatOpen) notify.chat('Ведущий ответил', last.text || '', openChat);
    showHidden('Ведущий ответил', last.text || '', openChat);
  }, [boothFeed, chatOpen, openChat]);

  // Смена трека в ленте чата — контекст разговора, а не повод дёргать человека:
  // ни тоста, ни системного уведомления она не даёт.
  const trackLineRef = useRef<string | null>(null);
  useEffect(() => {
    const title = nowPlaying?.title?.trim();
    if (!title) return;
    const line = `${nowPlaying?.artist?.trim() || 'неизвестный исполнитель'} — ${title}`;
    if (trackLineRef.current === line) return;
    const first = trackLineRef.current === null;
    trackLineRef.current = line;
    if (first) return;   // то, что играло при открытии страницы, новостью не является
    setChatEvents(prev => [
      ...prev,
      { kind: 'track' as const, key: `t${Date.now()}`, at: Date.now(), text: `сейчас играет ${line}` },
    ].slice(-CHAT_FEED_MAX));
  }, [nowPlaying?.title, nowPlaying?.artist]);

  const chatItems = useMemo(
    () => mergeFeed(room.messages, chatEvents, CHAT_FEED_MAX),
    [room.messages, chatEvents],
  );

  // Stable handlers + counts for the memoized layout components, so a feed
  // update that doesn't touch them costs no re-render.
  const openSchedule = useCallback(() => setDrawer('schedule'), []);
  const openBooth = useCallback(() => setDrawer('booth'), []);
  const openTimeline = useCallback(() => setDrawer('timeline'), []);
  const upcomingCount = state.upcoming?.length ?? 0;
  const dotRailCounts = useMemo(
    () => ({
      timeline: upcomingCount || TIMELINE_ICON,
      booth: BOOTH_ICON,
      schedule: SCHEDULE_ICON,
    }),
    [upcomingCount],
  );
  // Queue head for CenterStage's "up next" tease, reduced to the two fields it
  // renders so the fresh array each /state poll doesn't re-render the stage.
  const nextTitle = state.upcoming?.[0]?.title;
  const nextArtist = state.upcoming?.[0]?.artist;
  const upNext = useMemo<QueueEntry | null>(
    () => (nextTitle ? { title: nextTitle, artist: nextArtist } : null),
    [nextTitle, nextArtist],
  );
  const [tickerOn, setTickerOn] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Haptics live here rather than at each call site so every entry point
  // (DotRail, shortcut, palette, swipe-dismiss) feels the same.
  const prevDrawerRef = useRef<PlayerDrawer | null>(drawer);
  useEffect(() => {
    const prev = prevDrawerRef.current;
    prevDrawerRef.current = drawer;
    if (prev === drawer) return;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    if (prev == null && drawer != null) navigator.vibrate(8);
    else if (prev != null && drawer == null) navigator.vibrate(5);
    else navigator.vibrate(6);
  }, [drawer]);

  // Hydrate ticker preference from localStorage (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:ticker');
      if (v != null) setTickerOn(v === '1');
    } catch {}
  }, []);

  // Increments only on keyboard-driven adjusts (TransportBar pulses off it).
  // Knob drags must NOT tick it: the cells track the finger during a drag.
  const [volumePulse, setVolumePulse] = useState(0);
  const adjustVolume = (delta: number) => {
    setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100)));
    setVolumePulse(n => n + 1);
  };

  // Global keyboard shortcuts. Bare keys are suppressed while a text field
  // is focused or while the palette/help dialog owns input; ⌘K always works.
  useKeyboardShortcuts(
    {
      space: handleTune,
      k: handleTune,
      arrowup: () => adjustVolume(0.05),
      arrowdown: () => adjustVolume(-0.05),
      m: toggleMute,
      '1': () => setDrawer('timeline'),
      '2': () => setDrawer('booth'),
      '3': () => setDrawer('request'),
      '4': () => setDrawer('schedule'),
      '5': () => setDrawer('chat'),
      r: () => setDrawer('request'),
      '?': () => setShortcutsOpen(true),
      'mod+k': () => setPaletteOpen(o => !o),
    },
    { disabled: paletteOpen || shortcutsOpen },
  );

  // The controller returns a request id immediately; matching runs in the booth
  // and the drawer polls pollRequest() for the outcome.
  const submitRequest = async (): Promise<RequestResult | null> => {
    if (!requestText.trim() || isSubmitting) return null;
    setIsSubmitting(true);
    try {
      const data = await coreSubmitRequest(requestText.trim(), requesterName.trim());
      if (data.success) setRequestText('');
      return data;
    } catch {
      toast.error('Заказ не прошёл. Контроллер запущен?');
      return { success: false, message: 'Ошибка сети.' };
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div
        ref={ambientRef}
        aria-hidden="true"
        className={cn('v3-cover-ambient', coverColors.vibrant && 'v3-cover-ambient-on')}
      />

      <TopBar
        tunedIn={tunedIn}
        context={context}
        stationName={typeof dj?.station === 'string' ? dj.station : undefined}
        djName={typeof dj?.name === 'string' ? dj.name : undefined}
        activeShow={activeShow}
        onOpenSchedule={openSchedule}
      />

      <CenterStage
        nowPlaying={nowPlaying}
        trackStartedAt={trackStartedAt}
        llmTokens={llmTokens}
        feed={boothFeed}
        djLineOn={tickerOn}
        boothBuddyOn={state.ui?.boothBuddy === true}
        offline={offline}
        upNext={upNext}
        onOpenBooth={openBooth}
        onOpenTimeline={openTimeline}
      />

      <Waveform
        audioRef={audioRef}
        tunedIn={tunedIn}
        trackStartedAt={trackStartedAt}
        duration={nowPlaying?.duration ?? 0}
      />

      <DotRail counts={dotRailCounts} active={drawer} onSelect={setDrawer} />

      <TransportBar
        tunedIn={tunedIn}
        status={status}
        onTune={tune}
        offline={offline}
        volume={volume}
        setVolume={setVolume}
        volumePulse={volumePulse}
        muted={muted}
        onToggleMute={toggleMute}
        latencyMs={signal.latencyMs}
        signalQuality={signal.quality}
        listeners={listenerCount}
      />

      <Sheet
        open={drawer != null}
        onOpenChange={(v: boolean) => { if (!v) setDrawer(null); }}
        title={drawer ? DRAWER_TITLES[drawer] : ''}
        container={portalNode}
      >
        {drawer === 'timeline' && (
          <TimelineDrawer upcoming={state.upcoming} history={state.history} />
        )}
        {drawer === 'booth'   && <BoothDrawer items={boothFeed} timezone={timezone} locale={locale} />}
        {drawer === 'request' && (
          <RequestDrawer
            requestText={requestText} setRequestText={setRequestText}
            requesterName={requesterName} setRequesterName={setRequesterName}
            isSubmitting={isSubmitting}
            onSubmit={submitRequest}
            onPoll={pollRequest}
            onClose={() => setDrawer(null)}
            nowPlaying={nowPlaying}
            context={context}
          />
        )}
        {drawer === 'schedule' && <ScheduleDrawer activeShow={activeShow} context={context} />}
        {drawer === 'chat'     && <ChatDrawer items={chatItems} send={room.send} sending={room.sending} />}
      </Sheet>

      <AnimatePresence>
        {showOverlay && !offline && (
          <TuneInOverlay key="tune-in" onTune={tuneInFromOverlay} nowPlaying={nowPlaying} />
        )}
      </AnimatePresence>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        container={portalNode}
        tunedIn={tunedIn}
        muted={muted}
        onTune={handleTune}
        onOpenDrawer={setDrawer}
        onToggleMute={toggleMute}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        container={portalNode}
      />
    </>
  );
}

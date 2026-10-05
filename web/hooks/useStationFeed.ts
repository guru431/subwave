'use client';

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { splitAudibleTurns } from '@/lib/sessionFeed';
import { useStationClient } from '@/lib/stationClient';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingTrack,
  SessionPayload,
  StationContext,
  StationState,
  StationLocale,
} from '@/lib/types';

export interface StationFeed {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj: DjState | null;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  /** null until the first poll resolves — distinguishes "not yet known" from "offline". */
  streamOnline: boolean | null;
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  state: StationState;
  session: SessionPayload;
  /** Epoch ms when the current track became AUDIBLE to this listener, null
   *  before the first poll. Consumers derive elapsed/progress locally
   *  (useElapsed) so the per-second tick doesn't re-render the player tree.
   *  Listener-time, not broadcast-time: the server stamps startedAt at the live
   *  edge but Icecast bursts `stream.bufferSeconds` on connect, so this carries
   *  the offset already added and can briefly sit in the future — useElapsed
   *  clamps at 0 rather than banking the buffer as elapsed (issue #1114). */
  trackStartedAt: number | null;
  /** Whether the station is configured to serve `/stream.opus`, or null before
   *  the first poll. This is the SETTING, not a live mount probe — it needs a
   *  mixer restart to take effect, so it can read true while the mount is still
   *  404ing. The player must not upgrade to the Opus mount on codec support
   *  alone — Opus is off by default, so the mount 404s and playback sits on
   *  "acquiring" until the error handler pins MP3 back (issue #1300, bug 5). */
  opusEnabled: boolean | null;
  /** Station IANA timezone (e.g. "Europe/London"), or null before first poll.
   *  Render on-air timestamps in this zone so they match what the DJ speaks
   *  (issue #418). */
  timezone: string | null;
  locale: StationLocale;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
const OFFLINE_CONFIRM_POLLS = 4;
// Cadence while the page is hidden but the stream is still playing (see
// UseStationFeedOptions). Three times slower than the foreground poll: the only
// consumer that far back is the OS lock screen, and a track change it learns
// about ~15s late is invisible next to a track that never changes at all.
const BACKGROUND_POLL_MS = 15_000;

export interface UseStationFeedOptions {
  /** Hidden page → the poll normally stops, and everything derived from the
   *  feed freezes with it. On a phone that includes the lock screen's track
   *  title and progress, which is exactly when the listener is looking at it,
   *  so a tuned-in player keeps polling in the background instead.
   *  A ref rather than a boolean because this hook runs BEFORE usePlayer (the
   *  Opus gate needs the feed first) and because tuning in must not tear down
   *  and re-subscribe the poll. */
  keepAliveWhenHidden?: RefObject<boolean>;
}

// Returning `prev` from the updater skips the re-render, so a quiet poll tick
// costs nothing. Server JSON keeps stable key order, so the stringify compare is
// reliable (and cheap at a few KB every 5s).
function setIfChanged<T>(setter: Dispatch<SetStateAction<T>>, next: T): void {
  setter(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
}

// 5s polling of /now-playing + /state + /session, paused while the tab is
// hidden (with an immediate refetch on return). Single source of truth for
// "what's on air right now".
//
// The listener offset is the advertised stream.bufferSeconds, full stop. Do not
// go back to a per-tab `buffered.end − currentTime` measurement: `buffered`
// reports only the DEMUXED window (Chrome keeps the connect burst in an internal
// cache it never exposes), so it read 2.25s while the listener was genuinely
// 22.5s behind, flipping every title ~20s early. The burst is also sized in
// SECONDS per mount server-side now, so every mount lands on bufferSeconds.
export function useStationFeed({ keepAliveWhenHidden }: UseStationFeedOptions = {}): StationFeed {
  const client = useStationClient();
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [llmTokens, setLlmTokens] = useState<number | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const [opusEnabled, setOpusEnabled] = useState<boolean | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>('en-GB');
  const lastTrackKeyRef = useRef<string | null>(null);
  const offlinePollsRef = useRef(0);
  // Listener buffer depth in ms. A ref, not state, so the polling effect never
  // re-subscribes when it arrives. 0 until the first payload lands, degrading to
  // live-edge behaviour rather than guessing an offset.
  const leadMsRef = useRef(0);
  // Holds a track whose metadata has arrived but whose audio hasn't reached this
  // listener yet, until it's audible.
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Same idea for the DJ's spoken lines (#1382): the feed carries them stamped
  // with the live-edge air time, so a line is withheld until its audio has
  // reached THIS listener. Raw payload in a ref, filtered copy in state.
  const rawSessionRef = useRef<SessionPayload>(EMPTY_SESSION);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Re-derive the visible feed from the last payload and re-arm for the next
    // line to become audible. Runs on every poll and on its own timer, so a held
    // line lands on time rather than on the 5s poll grid.
    const applySession = () => {
      const raw = rawSessionRef.current;
      const { visible, nextChangeMs } = splitAudibleTurns(raw.messages, leadMsRef.current, Date.now());
      setIfChanged(setSession, { session: raw.session, messages: visible });
      if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = nextChangeMs == null
        ? null
        : setTimeout(applySession, Math.max(0, nextChangeMs - Date.now()));
    };
    const tick = async () => {
      try {
        const [npRes, stRes, seRes] = await Promise.all([
          client.nowPlaying(),
          client.state(),
          client.session(),
        ]);
        const np = npRes.nowPlaying;
        // Clamped: a bad value here would either park the clock in the far
        // future or wind it back past the track start.
        const bufSec = npRes.stream?.bufferSeconds;
        if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
          leadMsRef.current = Math.min(Math.max(bufSec, 0), 60) * 1000;
        }
        const trackKey = np ? `${np.title}\u0000${np.artist}` : null;
        // Prefer the queue's start time over "first seen by this client": a tab
        // hidden at the transition (or a poll that flipped through null on a torn
        // now-playing.json read) would stamp Date.now() mid-track and drag the
        // clock minutes behind. Guarded to the matching track and to plausible
        // values — a server clock skewed into the future falls back to first-seen.
        const cur = (stRes as StationState & { current?: { title?: string; startedAt?: string } }).current;
        let serverStart = NaN;
        if (np?.title && cur && cur.title === np.title && cur.startedAt) {
          const t = Date.parse(cur.startedAt);
          if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
        }
        // Shift into listener-time: serverStart is the live edge, and the audio
        // reaches this listener leadMs later (issue #1114).
        const leadMs = leadMsRef.current;
        const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : Date.now();

        if (trackKey !== lastTrackKeyRef.current) {
          const commit = () => {
            promoteTimerRef.current = null;
            lastTrackKeyRef.current = trackKey;
            setTrackStartedAt(trackKey != null ? audibleAt : null);
            setIfChanged(setNowPlaying, np);
          };
          const wait = audibleAt - Date.now();
          // Promote immediately when the audio is already out (wait <= 0), when
          // the stream drops, or on the first payload — a cold load has no
          // earlier track to keep showing. The clock stays right there because
          // trackStartedAt carries the offset and useElapsed clamps at 0.
          if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) {
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            commit();
          } else {
            // Re-armed on every poll while the switch is pending, so the wait is
            // recomputed against the freshest server stamp rather than drifting.
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            promoteTimerRef.current = setTimeout(commit, wait);
          }
        } else {
          if (Number.isFinite(serverStart)) {
            // Same track, better information — converge on the server stamp (and
            // repair any mid-track reset) without re-render noise inside ±2.5s.
            setTrackStartedAt(prev =>
              prev != null && Math.abs(audibleAt - prev) <= 2500 ? prev : audibleAt,
            );
          }
          // Metadata enrichment (genres, bpm, cover) lands on later polls for a
          // track already on air — keep taking it.
          setIfChanged(setNowPlaying, np);
        }
        setIfChanged(setContext, npRes.context);
        if (npRes.dj) setIfChanged<DjState | null>(setDj, npRes.dj);
        setIfChanged(setActiveShow, npRes.activeShow ?? npRes.context?.activeShow ?? null);
        if (npRes.listeners != null) setIfChanged<ListenerCount | number | null>(setListeners, npRes.listeners);
        if (typeof npRes.streamOnline === 'boolean') {
          if (npRes.streamOnline) {
            offlinePollsRef.current = 0;
            setStreamOnline(true);
          } else {
            offlinePollsRef.current += 1;
            if (offlinePollsRef.current >= OFFLINE_CONFIRM_POLLS) setStreamOnline(false);
          }
        }
        // Which mounts are actually live. Only an explicit boolean counts — an
        // older controller omits the key, and "unknown" must not read as "on".
        if (typeof npRes.stream?.opusEnabled === 'boolean') {
          setIfChanged<boolean | null>(setOpusEnabled, npRes.stream.opusEnabled);
        }
        if (typeof npRes.llmTokens === 'number') setIfChanged<number | null>(setLlmTokens, npRes.llmTokens);
        if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
        if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
        setIfChanged(setState, stRes);
        if (seRes && Array.isArray(seRes.messages)) {
          rawSessionRef.current = seRes;
          applySession();
        }
      } catch {}
    };
    const stopPolling = pollWhileVisible(
      () => { void tick(); },
      5000,
      () => (keepAliveWhenHidden?.current ? BACKGROUND_POLL_MS : null),
    );
    return () => {
      stopPolling();
      // A held track switch (or a held spoken line) must not land after teardown.
      if (promoteTimerRef.current) {
        clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
      if (voiceTimerRef.current) {
        clearTimeout(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
    };
  }, [client, keepAliveWhenHidden]);

  return { nowPlaying, context, dj, activeShow, listeners, streamOnline, llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale };
}

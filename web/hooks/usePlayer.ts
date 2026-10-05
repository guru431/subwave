'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isIOSDevice } from '@/lib/platform';
import { useStationOrigin } from '@/lib/stationOrigin';
import { withStreamAuth } from '@/lib/stationAuth';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';

// Reconnect backoff for the watchdog's error path: quick first retry, doubling
// to a minute so an abandoned tab on a downed station can't hammer reconnects.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Idle cutoff (issue #343). A forgotten tab counts as a listener and holds the
// DJ's pause-when-empty gate open, so tune out after this long with no pointer,
// key or focus activity; the consumer offers resume via `idleStopped`. 8h clears
// an untouched workday of listening while still catching an abandoned tab.
const IDLE_TUNE_OUT_MS = 8 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// HTMLMediaElement.HAVE_FUTURE_DATA. Read as a constant rather than off the
// instance so the checks below work on a detached/erroring element too.
const HAVE_FUTURE_DATA = 3;

// Ground truth for "the listener is hearing sound": network-level events
// (`stalled`) say nothing about it, and a wedged element fails this check even
// though `paused` is false.
function advancingSince(el: HTMLAudioElement, since: number): boolean {
  return !el.paused && el.readyState >= HAVE_FUTURE_DATA && el.currentTime > since;
}

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Ref callback the consumer MUST put on its <audio> element instead of
   *  audioRef: it keeps audioRef on the live node AND tells the hook when that
   *  node is replaced so the media listeners re-attach. The private-station gate
   *  remounts the element mid-session, and with a plain object ref the fresh
   *  node got no listeners at all (issue #1232). Stable identity. */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
  // True when the idle cutoff (not the listener) tore playback down. Cleared on
  // the next tune().
  idleStopped: boolean;
}

export interface UsePlayerOptions {
  initialVolume?: number;
  /** Whether the station is configured to serve `/stream.opus` (from
   *  /now-playing's `stream.opusEnabled` — the setting, not a live mount
   *  probe). null/undefined = not known yet — the Opus upgrade waits rather
   *  than guessing. */
  opusEnabled?: boolean | null;
}

// Owns the <audio> element + tune-in state. The consumer renders the <audio>
// tag, so skins can also reach it for their Web Audio taps.
export function usePlayer({ initialVolume = 1, opusEnabled = null }: UsePlayerOptions = {}): Player {
  const { streams } = useStationOrigin();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // audioRef.current mirrored into state so the listener effect can depend on
  // it. Refs don't notify on attach, so an element that mounts later (or is
  // swapped out and back) has to announce itself.
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    setAudioEl(el);
  }, []);
  // SSR + first render use the MP3 URL so server and client markup agree; the
  // canPlayType effect below upgrades to Opus.
  const [streamUrl, setStreamUrl] = useState<string>(streams.mp3);
  const [tunedIn, setTunedIn] = useState(false);
  // 'connecting' covers the gap between the tune-in gesture and the first
  // audible frames, so the UI doesn't claim to be playing while silent.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolume] = useState(initialVolume);
  const [idleStopped, setIdleStopped] = useState(false);
  const preMuteVolume = useRef(initialVolume || 1);

  // play() resolves asynchronously and pausing before it settles rejects with
  // AbortError. The latest promise plus a generation counter let rapid tune/stop
  // toggles settle on the last action without a stale teardown clobbering a
  // fresh play.
  const playPromise = useRef<Promise<void> | null>(null);
  const gen = useRef(0);

  // Refs mirror the latest values of state the stall watchdog needs to read,
  // so its event listeners can stay registered once and still see fresh data.
  const tunedInRef = useRef(tunedIn);
  const streamUrlRef = useRef(streamUrl);
  const streamsRef = useRef(streams);
  const volumeRef = useRef(volume);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Media clock at arm time — the baseline the fire compares against to decide
  // whether audio kept flowing.
  const watchdogArmedAt = useRef(0);
  // Consecutive failed reconnects since the last 'playing'; drives the backoff.
  const retryCount = useRef(0);
  // Last listener activity, read by the idle sweep. Seeded by the sweep effect
  // at mount (not here — render must stay pure) so a fresh tab gets the full
  // idle window.
  const lastActivityAt = useRef(0);
  // The idle sweep mounts once but must call the latest stop(), recreated per
  // render — bridge with a ref.
  const stopRef = useRef<() => void>(() => {});
  // Set if the optional Opus mount fails to load — pins us to MP3 so the
  // watchdog stops retrying a dead URL (e.g. Opus disabled server-side, 404).
  const opusFailedRef = useRef(false);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  // Volume 0 also rides the element's native `muted` flag. On iOS `volume` is
  // read-only at the system level, so muting by level alone did nothing there
  // and the mute button read as broken; `muted` is honoured on every platform,
  // and setting both keeps the behaviour identical everywhere else (#298).
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume;
    el.muted = volume === 0;
  }, [volume]);

  // Restore the listener's last-used volume (issue #783). Effect-only, so SSR
  // and first paint stay on the default with no hydration mismatch; `hydrated`
  // keeps this restoring setVolume from racing the persist effect below.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadVolumePref();
    if (stored !== null) {
      setVolume(stored);
      preMuteVolume.current = stored > 0 ? stored : preMuteVolume.current;
    }
    hydratedRef.current = true;
  }, []);

  // Debounced so a knob drag collapses to one write. The cleanup also keeps the
  // mount pass's default value from reaching localStorage before the restore
  // effect's setVolume lands.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => saveVolumePref(volume), 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Four gates guard the Opus upgrade; MP3 is the universal floor.
  //
  // Three are about codecs. Two browser families claim Opus but choke on the
  // chained Ogg stream Icecast emits at a crossfade, going silent at the first
  // track change with no event for the watchdog to catch: Safari iOS/iPadOS
  // (optimistic 'maybe') and Firefox/Gecko (says 'probably', still can't follow
  // the page chain — issue #212). So: require 'probably', skip the iOS family,
  // skip Firefox by UA.
  //
  // The fourth is that the station has to serve the mount at all. Opus is off
  // by default, so without this the upgrade pointed Chrome at a 404 (#1300 bug
  // 5). Only an explicit true upgrades — null is "not polled yet". It reports
  // the SETTING, and the mixer only reads that at startup, so a saved-but-not-
  // restarted station can still 404; hence the `onError` self-heal below.
  //
  // No live retarget, deliberately: setStreamUrl reaches the element only on
  // the next tune()/reconnect(), so tapping play before the first poll rides
  // MP3 for that session. Swapping src under a playing element would cut audio,
  // and every regression in this hook has come from an extra src assignment
  // (#1232, #1234).
  useEffect(() => {
    if (opusEnabled !== true) return;
    if (!streams.opus || opusFailedRef.current) return;
    const ua = navigator.userAgent;
    // Desktop/Android Firefox + Gecko forks (LibreWolf, Waterfox) carry
    // "Firefox" in the UA; Firefox-for-iOS reports "FxiOS" and is already
    // caught by isIOSDevice() below, so /firefox/i doesn't double-handle it.
    const isFirefox = /firefox/i.test(ua);
    if (isIOSDevice() || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(streams.opus);
    }
  }, [streams.opus, opusEnabled]);

  // Drive `status` from the <audio> element's own events, and reconnect when the
  // element wedges mid-broadcast (symptom: seconds of silence around a track
  // transition that only a page refresh recovers from). 'playing' clears the
  // watchdog; 'waiting'/'stalled' arm a 5s timer that re-sets src if the media
  // clock hasn't moved; 'error' reconnects with exponential backoff, reset on
  // the next successful 'playing'. Re-runs when the element is replaced — see
  // attachAudio.
  useEffect(() => {
    const el = audioEl;
    if (!el) return;

    const clearWatchdog = () => {
      if (watchdogTimer.current !== null) {
        clearTimeout(watchdogTimer.current);
        watchdogTimer.current = null;
      }
    };

    const reconnect = () => {
      clearWatchdog();
      if (!tunedInRef.current || !audioRef.current) return;
      const audio = audioRef.current;
      // The media clock moved while the watchdog was pending, so the listener is
      // hearing audio: a network hiccup the buffer absorbed, not a wedged
      // element. Re-setting src here would cut audible sound for nothing, so
      // reconcile the UI instead (issue #1232).
      if (advancingSince(audio, watchdogArmedAt.current)) {
        retryCount.current = 0;
        setStatus('playing');
        return;
      }
      const myGen = ++gen.current;
      audio.src = withStreamAuth(`${streamUrlRef.current}?t=${Date.now()}`);
      audio.volume = volumeRef.current;
      audio.muted = volumeRef.current === 0;
      setStatus('connecting');
      const p = audio.play();
      playPromise.current = p;
      Promise.resolve(p).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
        if (gen.current === myGen && name !== 'AbortError') {
          console.error('Reconnect failed:', err);
        }
      });
    };

    const armWatchdog = (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      // Sample the media clock so the fire can tell "stream died" from "bytes
      // were late but playback never missed a beat".
      watchdogArmedAt.current = audioRef.current?.currentTime ?? 0;
      watchdogTimer.current = setTimeout(reconnect, delay);
    };

    const onPlaying = () => {
      clearWatchdog();
      retryCount.current = 0;
      setStatus('playing');
    };
    // 'waiting' is a PLAYBACK event: the element ran out of decoded audio and
    // has actually gone silent, so the UI should say so.
    const onWaiting = () => {
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    // 'stalled' is a NETWORK event (no bytes for ~3s) and fires routinely on a
    // live mount while playback continues from buffer, so no second 'playing'
    // event is coming: pinning status here left the signal badge on "Acquiring"
    // all session while audio played fine (issue #1232). Arm the watchdog — a
    // real dead mount also stalls — but leave `status` to the fire-time check.
    const onStalled = () => {
      armWatchdog(5000);
    };
    // timeupdate fires ~4x/s but only while the clock actually moves, so it
    // reconciles a status left on 'connecting' by event sequences the handlers
    // above don't model (browsers differ on when they re-emit 'playing').
    const onTimeUpdate = () => {
      if (el.paused || el.readyState < HAVE_FUTURE_DATA) return;
      setStatus(s => (s === 'connecting' ? 'playing' : s));
    };
    const onError = () => {
      setStatus('idle');
      // A failing Opus mount (commonly 404 when the operator disabled Opus
      // server-side) falls back permanently to MP3 rather than reconnecting to
      // the dead URL on every retry.
      const { mp3, opus } = streamsRef.current;
      if (opus && streamUrlRef.current === opus) {
        opusFailedRef.current = true;
        streamUrlRef.current = mp3;
        setStreamUrl(mp3);
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
      retryCount.current += 1;
      armWatchdog(delay);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('error', onError);
    return () => {
      clearWatchdog();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onStalled);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('error', onError);
    };
  }, [audioEl]);

  // Idle cutoff (issue #343): a tab tuned in with no activity for
  // IDLE_TUNE_OUT_MS is tuned out, so an abandoned browser doesn't sit on the
  // mount as a phantom listener holding pause-when-empty's DJ gate open.
  // Activity = pointer, key, or the tab becoming visible. Sweeps once a minute;
  // an hour-scale cutoff needs no finer precision.
  useEffect(() => {
    const markActivity = () => { lastActivityAt.current = Date.now(); };
    markActivity(); // seed: mount counts as the start of the idle window
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActivity();
    };
    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    document.addEventListener('visibilitychange', onVisibility);
    const sweep = setInterval(() => {
      if (!tunedInRef.current) return;
      if (Date.now() - lastActivityAt.current < IDLE_TUNE_OUT_MS) return;
      setIdleStopped(true);
      stopRef.current();
    }, IDLE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(sweep);
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Tear down playback. Also called by PlayerApp when the station goes off air,
  // so the <audio> element isn't left retrying a dead mount.
  const stop = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    const myGen = ++gen.current;
    if (watchdogTimer.current !== null) {
      clearTimeout(watchdogTimer.current);
      watchdogTimer.current = null;
    }
    setTunedIn(false);
    setStatus('idle');
    // Let any in-flight play() settle before pausing, then bail if a later
    // tune() has already superseded this teardown.
    Promise.resolve(playPromise.current)
      .catch(() => {})
      .then(() => {
        if (gen.current !== myGen) return;
        el.pause();
        el.src = '';
      });
  };
  stopRef.current = stop;

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    // A fresh tune-in is listener activity: restart the idle window, clear any
    // pending idle prompt, reset the reconnect backoff.
    lastActivityAt.current = Date.now();
    setIdleStopped(false);
    retryCount.current = 0;
    el.src = withStreamAuth(`${streamUrl}?t=${Date.now()}`);
    el.volume = volume;
    el.muted = volume === 0;
    setTunedIn(true);
    setStatus('connecting');
    const p = el.play();
    playPromise.current = p;
    Promise.resolve(p).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (gen.current === myGen && name !== 'AbortError') {
        console.error('Play failed:', err);
      }
    });
  };

  // Mute is volume 0 (mirrored onto the element's `muted` flag — see the volume
  // effect); toggling restores the last non-zero level so the 'M' shortcut and
  // the command palette round-trip.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  return { audioRef, attachAudio, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted: volume === 0, idleStopped };
}

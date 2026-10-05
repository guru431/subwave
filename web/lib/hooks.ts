'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useInterval } from 'usehooks-ts';
import { isAndroidDevice, isIOSDevice } from './platform';

// SSR-safe iOS flag: false on the server and the first client render (so the
// markup agrees and hydration stays clean), then the real value after mount.
// Lets components branch UI that can't work on iOS (issue #298) safely.
export function useIsIOS(): boolean {
  const [ios, setIos] = useState(false);
  useEffect(() => { setIos(isIOSDevice()); }, []);
  return ios;
}

// Null until mount, for the same SSR reason as useIsIOS: the server has no
// clock the client would agree with. The first tick lands on mount, then
// useInterval owns the cadence (and its own cleanup).
export function useClock(): Date | null {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => { setT(new Date()); }, []);
  useInterval(() => setT(new Date()), 1000);
  return t;
}

export interface Analyser {
  ready: boolean;
  read: () => Uint8Array<ArrayBuffer> | null;
  /** Null until the graph exists. Callers mapping bins to frequencies need it:
   *  44.1k vs 48k shifts every bin. */
  sampleRate: number | null;
}

// Older Safari exposes AudioContext as webkitAudioContext.
type AudioContextCtor = typeof AudioContext;
interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
}

interface ElementAudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
}

// One Web Audio graph per media element, for the lifetime of the page.
// createMediaElementSource permanently captures the element's output (a second
// call throws, and tearing the graph down would mute playback), and skins mount
// and unmount visualisers against the same shared <audio>, so a later hook
// instance must REUSE the first one's graph. Otherwise every visualiser after a
// skin switch falls back to the pseudo-random walk, and each remount leaks a
// fresh AudioContext on the failed re-capture.
const ELEMENT_GRAPHS = new WeakMap<HTMLMediaElement, ElementAudioGraph>();

/** Existing graph for the element, or a freshly built one. Returns null when
 *  Web Audio is unavailable; throws (after closing the orphan context) when
 *  capture fails, so callers keep their not-ready fallback path. */
function getOrCreateElementGraph(audioEl: HTMLMediaElement): ElementAudioGraph | null {
  const existing = ELEMENT_GRAPHS.get(audioEl);
  if (existing) return existing;
  const AC: AudioContextCtor | undefined =
    window.AudioContext || (window as Window & WebkitWindow).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    // 4096-point FFT (2048 bins). The Waveform's log-frequency sweep needs
    // low-end resolution: at 1024 the bins were ~47 Hz wide, so the bottom
    // octave read one bin and moved as a single block.
    analyser.fftSize = 4096;
    // Light smoothing only: 0.78 stacked on the spans' 60ms CSS transitions
    // left bars trailing the beat by ~100ms. This is the only smoothing layer.
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const graph: ElementAudioGraph = { ctx, analyser };
    ELEMENT_GRAPHS.set(audioEl, graph);
    return graph;
  } catch (err) {
    // Capture failed (element claimed outside this hook). Don't leave an idle
    // AudioContext behind on every attempt.
    void ctx.close().catch(() => {});
    throw err;
  }
}

// Wires an AnalyserNode to the <audio> ref the first time `active` flips true.
// If CORS or anything else blocks attachment, `ready` stays false and `read()`
// returns null, and the Waveform falls back to its pseudo-random walk.
//
// Phones are opted out entirely: createMediaElementSource on a live MP3 stream
// only ever yields zeros on iOS, and on BOTH mobile platforms routing the
// element through Web Audio jeopardises lock-screen / background playback
// (issue #298). Upstream opted out iOS only; Android shows the same damage —
// measured 2026-09-21 on Firefox for Android, sound died a few minutes after
// backgrounding and the lock screen never showed a player at all. The cost is
// the visualiser falling back to its pseudo-random walk on phones, where it is
// a thumbnail anyway; the gain is a radio that keeps playing in a pocket.
export function useAnalyser(
  audioRef: RefObject<HTMLAudioElement | null> | null | undefined,
  active: boolean,
): Analyser {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const probedRef = useRef(false);
  const [ready, setReadyState] = useState(false);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  // In a ref so `read`'s identity never changes, and the caller's rAF effect
  // doesn't tear down and restart on every render.
  const readyRef = useRef(false);
  const setReady = useCallback((v: boolean) => {
    readyRef.current = v;
    setReadyState(v);
  }, []);

  useEffect(() => {
    if (!active || !audioRef?.current) return;
    // Phones: never touch Web Audio (see hook header). Stay not-ready → fallback.
    if (isIOSDevice() || isAndroidDevice()) { setReady(false); return; }
    let cancelled = false;
    const audioEl = audioRef.current;
    let probeInterval: ReturnType<typeof setInterval> | null = null;
    let onPlaying: (() => void) | null = null;
    (async () => {
      try {
        const graph = getOrCreateElementGraph(audioEl);
        if (!graph) return; // no Web Audio in this browser
        analyserRef.current = graph.analyser;
        binsRef.current = new Uint8Array(graph.analyser.frequencyBinCount);
        setSampleRate(graph.ctx.sampleRate);
        if (graph.ctx.state === 'suspended') await graph.ctx.resume();
        if (cancelled) return;
        setReady(true);

        // Some non-iOS WebKit builds (desktop Safari on a live MP3 mount) wire
        // the graph up but only ever return zeros. Probe once after playback
        // starts; no samples in ~600ms means fall back.
        if (probedRef.current) return;
        onPlaying = () => {
          if (probedRef.current || cancelled) return;
          probedRef.current = true;
          let max = 0;
          let ticks = 0;
          probeInterval = setInterval(() => {
            if (cancelled) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              return;
            }
            const bins = binsRef.current;
            const an = analyserRef.current;
            if (!bins || !an) return;
            an.getByteFrequencyData(bins);
            for (let i = 0; i < bins.length; i++) {
              const v = bins[i] ?? 0;
              if (v > max) max = v;
            }
            if (++ticks >= 12) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              if (max === 0) {
                // No usable data. Fall back, but DON'T disconnect: the source
                // feeds the speakers through this graph, so tearing it down
                // mutes playback. An idle analyser in the chain is transparent.
                setReady(false);
              }
            }
          }, 50);
        };
        audioEl.addEventListener('playing', onPlaying, { once: true });
        if (!audioEl.paused && audioEl.readyState >= 2) onPlaying();
      } catch {
        // CORS or other failure — stay not-ready
      }
    })();
    return () => {
      cancelled = true;
      if (probeInterval) clearInterval(probeInterval);
      if (onPlaying && audioEl) audioEl.removeEventListener('playing', onPlaying);
    };
  }, [active, audioRef, setReady]);

  const read = useCallback((): Uint8Array<ArrayBuffer> | null => {
    if (!readyRef.current || !analyserRef.current || !binsRef.current) return null;
    analyserRef.current.getByteFrequencyData(binsRef.current);
    return binsRef.current;
  }, []);

  return { ready, read, sampleRate };
}

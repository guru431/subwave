// Air-time marker reader for spoken segments (#1382).
//
// Everything the controller knows about a segment is handoff-time: airVoice
// resolves when the path has been written into say.txt/intro.txt, which is one
// 0.5s Liquidsoap poll plus the request queue, the lead-in and the duck ramp
// before a listener hears the first word. radio.liq writes voice-playing.json
// the moment the clip actually starts feeding, carrying the `voiceId` the
// controller stamped into the clip's annotate: URI — so a segment can be told
// exactly when it went to air rather than when it was handed over.
//
// The STAMP is what matters, not the detection: `startedAt` comes from the
// mixer's own clock, so a consumer gets the exact air time even though this
// poller notices it up to POLL_MS later. That is why the cadence here is a
// cheap 500ms rather than something tighter.
//
// Degrading is deliberate and silent. A mixer that predates this marker never
// writes the file, so awaitVoiceAir() resolves null IMMEDIATELY (see
// markerFilePresent) rather than making every station without it wait out the
// timeout before its booth log and webhooks fire. Callers treat null as "air
// time unknown" and fall back to today's handoff-time behaviour.
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.

import { existsSync, readFileSync } from 'node:fs';
import { config } from '../../config.js';

export interface VoiceMarker {
  voiceId: string;
  /** Epoch ms the clip started feeding, from the mixer's clock. */
  airedAt: number;
  channel: 'say' | 'intro' | null;
  filename: string | null;
}

const POLL_MS = 500;
// How long a segment waits for its own marker before giving up and reporting an
// unknown air time. Generous: the normal lag is well under 2s, but a clip
// handed over while the queue still holds the previous one airs later, and a
// late-but-correct stamp beats a wrong one. Only ever paid on a station whose
// mixer DOES write markers (see markerFilePresent).
export const VOICE_AIR_TIMEOUT_MS = 20_000;
// Markers seen before their segment registered a waiter. airVoice registers
// only after its handoff write resolves, so a mixer that polls in that window
// would otherwise be missed. Small and time-bounded — this is a race window,
// not a history.
const RECENT_MAX = 32;
const RECENT_TTL_MS = 60_000;

// Parse a marker file's contents. Returns null for anything unusable, so a
// half-written or hand-mangled file costs one tick rather than throwing inside
// the poller. Liquidsoap's time() is unix SECONDS (float), like every other
// marker in the state dir.
export function parseVoiceMarker(raw: string): VoiceMarker | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const voiceId = typeof m.voiceId === 'string' ? m.voiceId : '';
  const startedAt = Number(m.startedAt);
  if (!voiceId || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  const channel = m.channel === 'say' || m.channel === 'intro' ? m.channel : null;
  return {
    voiceId,
    airedAt: Math.round(startedAt * 1000),
    channel,
    filename: typeof m.filename === 'string' && m.filename ? m.filename : null,
  };
}

type Waiter = { resolve: (airedAt: number | null) => void; timer: ReturnType<typeof setTimeout>; promise: Promise<number | null> };

const _waiters = new Map<string, Waiter>();
// voiceId → {airedAt, seenAt}. Aged on seenAt, NOT on the marker's own stamp:
// that stamp comes from the mixer's clock, and a mixer running behind this
// process would have every marker it writes look instantly expired.
const _recent = new Map<string, { airedAt: number; seenAt: number }>();
let _timer: ReturnType<typeof setInterval> | null = null;
let _lastVoiceId = '';

function rememberRecent(voiceId: string, airedAt: number) {
  _recent.set(voiceId, { airedAt, seenAt: Date.now() });
  const cutoff = Date.now() - RECENT_TTL_MS;
  // Insertion-ordered, so the oldest are at the front: stop at the first entry
  // that is both within the cap and still fresh.
  for (const [id, rec] of _recent) {
    if (_recent.size <= RECENT_MAX && rec.seenAt >= cutoff) break;
    _recent.delete(id);
  }
}

// One read of the marker file, dispatched to whoever is waiting. Exported for
// the tests, which drive it directly instead of waiting out real intervals.
export function pollVoiceMarker(): VoiceMarker | null {
  let raw: string;
  try {
    raw = readFileSync(config.liquidsoap.voicePlayingFile, 'utf8');
  } catch {
    return null; // never written, or gone — nothing has aired
  }
  const marker = parseVoiceMarker(raw);
  // Deduped on voiceId, not on the file's mtime: the file is never deleted, so
  // every tick re-reads the last clip's marker and only a NEW id is an edge.
  if (!marker || marker.voiceId === _lastVoiceId) return null;
  _lastVoiceId = marker.voiceId;
  rememberRecent(marker.voiceId, marker.airedAt);

  const waiter = _waiters.get(marker.voiceId);
  if (waiter) {
    _waiters.delete(marker.voiceId);
    clearTimeout(waiter.timer);
    waiter.resolve(marker.airedAt);
  }
  return marker;
}

function startPoller() {
  if (_timer) return;
  _timer = setInterval(pollVoiceMarker, POLL_MS);
  // Never hold the process open for a marker poll.
  _timer.unref?.();
}

// Test seam: stop the poller and forget every waiter/marker seen so far.
export function resetVoiceMarkers() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _lastVoiceId = '';
  for (const w of _waiters.values()) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
  _waiters.clear();
  _recent.clear();
}

// Whether this station's mixer writes voice markers at all. The file is never
// deleted once written, so its absence means either a Liquidsoap older than
// #1382 or one that has not spoken since it started — both of which must
// degrade to instant, handoff-time bookkeeping rather than a 20s stall on every
// segment.
function markerFilePresent(): boolean {
  return existsSync(config.liquidsoap.voicePlayingFile);
}

// Resolve when the clip stamped with `voiceId` starts on air, or with null when
// that can't be known. Never rejects — an unknown air time is a degraded signal,
// not an error, and the caller's bookkeeping must run either way.
export function awaitVoiceAir(
  voiceId: string,
  timeoutMs: number = VOICE_AIR_TIMEOUT_MS,
): Promise<number | null> {
  const seen = _recent.get(voiceId);
  if (seen && Date.now() - seen.seenAt <= RECENT_TTL_MS) {
    return Promise.resolve(seen.airedAt);
  }
  _recent.delete(voiceId);
  if (!markerFilePresent()) return Promise.resolve(null);
  const pending = _waiters.get(voiceId);
  if (pending) return pending.promise;
  startPoller();
  let waiter: Waiter;
  const promise = new Promise<number | null>(resolve => {
    const timer = setTimeout(() => {
      _waiters.delete(voiceId);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    waiter = { resolve, timer, promise: null! };
  });
  waiter!.promise = promise;
  _waiters.set(voiceId, waiter!);
  return promise;
}

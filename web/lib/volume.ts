// Persisted listener volume (issue #783). Mirrored into localStorage as a
// clamped 0..1 float string; volume 0 is persisted verbatim.
//
// Reads/writes are effect-only, never during render, so there's no hydration
// mismatch: the knob renders at the default on first paint and snaps to the
// stored value a tick later.

const STORAGE_KEY = 'subwave-volume';

/** Null when nothing valid is stored, so the caller keeps its own default.
 *  Null on the server.
 *
 *  Fork (W05): with `ios`, a stored 0 reads as null too. Volume 0 rides the
 *  element's `muted` flag (usePlayer), and on iOS that is the ONLY thing it
 *  does: the hardware buttons never clear `muted` and the level slider is
 *  inert there, so a mute restored at load had no way out but finding the
 *  mute button. A mute on iPhone now lasts the session, not the install. */
export function loadVolumePref({ ios = false }: { ios?: boolean } = {}): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    const clamped = Math.min(1, Math.max(0, v));
    return ios && clamped === 0 ? null : clamped;
  } catch {
    return null;
  }
}

/** Clamped to 0..1. Storage failures are swallowed; playback is unaffected. */
export function saveVolumePref(volume: number): void {
  if (typeof window === 'undefined') return;
  try {
    const v = Math.min(1, Math.max(0, volume));
    window.localStorage.setItem(STORAGE_KEY, String(v));
  } catch { /* private mode / quota — non-fatal */ }
}

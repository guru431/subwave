// Runs `fn` immediately and then every `intervalMs`, pausing entirely while
// the tab is hidden and firing again the moment it returns to the foreground.
// Keeps background tabs from burning network/CPU on polls nobody can see.
// Returns a cleanup function.
//
// `hiddenIntervalMs` opts a caller out of that pause. It is consulted on every
// visibility flip; a number keeps the poll running in the background at that
// (slower) cadence, null stops as usual. Needed only where the page still has a
// job to do while nobody is looking at it — the station feed behind a phone's
// lock screen is the one such caller (see useStationFeed).
export function pollWhileVisible(
  fn: () => void,
  intervalMs: number,
  hiddenIntervalMs?: () => number | null,
): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  // Which cadence is armed, so a re-sync at the same one leaves the timer (and
  // its phase) alone instead of restarting it.
  let armedMs = 0;
  const stop = () => {
    if (id != null) clearInterval(id);
    id = null;
    armedMs = 0;
  };
  const arm = (ms: number, fireNow: boolean) => {
    if (id != null && armedMs === ms) return;
    stop();
    armedMs = ms;
    if (fireNow) fn();
    id = setInterval(fn, ms);
  };
  // Foreground always fires at once — arriving (or coming back) wants fresh
  // data now; a background re-arm just waits for its first tick.
  const sync = () => {
    if (!document.hidden) {
      arm(intervalMs, true);
      return;
    }
    const ms = hiddenIntervalMs?.() ?? null;
    if (ms == null) stop();
    else arm(ms, false);
  };
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', sync);
  };
}

// Back-to-back artist guard policy — pure, unit-pinned (#1124 / #1187 / #1251).
//
// The guard itself lives in dj-agent.pickViaAgent: when the agent's pick repeats
// the artist already on air, it re-picks from the run's OWN candidates. This
// module owns the one question that re-pick has to answer — WHICH candidates it
// may choose from — so the answer is testable without a model call, and so the
// policy isn't spread across the call site.
//
// #1251: excluding only the on-air artist gave the re-pick no memory of the
// slots before it. On any catalogue with a deep bench for the show's filters,
// whichever artist ranks next-highest wins the re-pick, and wins it AGAIN the
// next time the guard fires — no adjacent repeats, but the same artist every
// other slot (observed live: Marvin Gaye in 3 of 5 slots, all three placed by
// the guard). So the re-pick also steps around the artists of the last few
// plays, and only falls back to the bare on-air exclusion when that leaves it
// nothing — the same never-starve philosophy as #1187's pool rescue.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// How many recent plays the re-pick remembers. 5 covers the reported
// oscillation (an artist re-entering every other slot is inside any window ≥ 2;
// 5 also catches the slower every-third-slot shape) while staying far below the
// point where a show-filtered run's candidate set is likely to be wholly recent
// — and if it ever is, the fallback below hands the bare exclusion back rather
// than starving.
//
// NOTE the effective exclusion is wider than "5 plays": neighbourArtistRoots(n)
// gathers up to n queued-and-unaired tracks AND the on-air track AND the last n
// distinct plays — so this window can exclude up to 2n+1 artists, by design
// (the queued side is what covers pair-aware drains, where the pick is not
// adjacent to the track on air).
export const ARTIST_VARIETY_WINDOW = 5;

export interface AlternativePool<T> {
  // The candidates the re-pick may choose from, keyed by id as `seen` is.
  alt: Map<string, T>;
  // How many other-artist candidates the recency window removed. 0 means it
  // removed none — because no recent artist was in the pool, or because the
  // window emptied it and was overridden (see `starved`).
  dropped: number;
  // True when EVERY alternative was a recently-heard artist and the window was
  // overridden — the bare on-air exclusion was handed back. Distinguishes
  // "the window was a no-op" from "the window was overruled" in telemetry;
  // `dropped` is 0 in both cases.
  starved: boolean;
}

// The candidate set for a guard re-pick.
//
// `avoidRoot` is the predecessor's lead key (artistRootKey), `recentRoots` the
// lead keys of the surrounding slots (queue.neighbourArtistRoots — queued and
// unaired, on air, and the last few plays). Candidates with no artist at all are
// never dropped — an untagged track is not evidence of a repeat, and dropping it
// would narrow thin runs for nothing.
export function alternativeCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  avoidRoot: string,
  recentRoots: Set<string> = new Set(),
): AlternativePool<T> {
  const base = [...seen].filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || root !== avoidRoot;
  });
  if (!base.length || !recentRoots.size) return { alt: new Map(base), dropped: 0, starved: false };

  const fresh = base.filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || !recentRoots.has(root);
  });
  // Every alternative is a recently-heard artist. Hand back the unnarrowed set:
  // a same-artist repeat one slot later is a worse outcome than a same-artist
  // repeat five slots later, and the caller's pool rescue is the wrong escalation
  // here — the run DID surface another artist.
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false };
}

// ── The artist window on the pick path ─────────────────────────────────────
//
// The guard above fires only when the pick repeats the artist ON AIR, and the
// agent path carries no recentArtists filter (#618) — so the library-scaled
// artist-recency window (recencyWindowsForLibrary: 3 h at 3k+ tracks) that the
// pool picker honours never applied to the agent, which makes most picks. On a
// catalogue with a few deep shelves that let one band air every 40–60 minutes;
// the agent even wrote "new artist" for bands heard 8 minutes earlier.
//
// The window is enforced where #1124 enforces variety — at the point of choice,
// never as a strip inside the tools — so #618's starved similarity pool can't
// come back. Only pickViaAgent calls this; the request path stays exempt.

export type GuardTrigger = 'on-air' | 'recent' | null;

// Which rule the agent's pick breaks, if any. `onAirRoot` wins over the window
// so the #1124 path keeps its own logging and fallback. An untagged pick is
// never a repeat — the same stance alternativeCandidates takes on candidates.
export function artistGuardTrigger(pickRoot: string, onAirRoot: string, windowRoots: Set<string>): GuardTrigger {
  if (!pickRoot) return null;
  if (onAirRoot && pickRoot === onAirRoot) return 'on-air';
  if (windowRoots.has(pickRoot)) return 'recent';
  return null;
}

// The window's lead keys. `recentArtists` is queue.recentArtistsSince — RAW
// lowercase names, matched raw-to-raw by the pool picker — so they are keyed
// onto the lead act here (#1251: a collaboration must not walk past the window).
// `neighbourRoots` (queue.neighbourArtistRoots) adds the queued-and-unaired
// tracks, which have no play row yet but will air before this pick does.
export function artistWindowRoots(recentArtists: Iterable<string>, neighbourRoots: Set<string>): Set<string> {
  const out = new Set(neighbourRoots);
  for (const artist of recentArtists) {
    const key = artistRootKey(artist);
    if (key) out.add(key);
  }
  return out;
}

// The candidate set for a fired guard. 'on-air' is alternativeCandidates as it
// always was, only stepping around the whole window instead of the last few
// plays. 'recent' differs in the starved fallback: there every other-artist
// candidate is inside the window, and the bare set alternativeCandidates hands
// back can hold the artist ON AIR — a back-to-back repeat bought to avoid one a
// few hours on. So it offers nothing, and the caller escalates to the pool
// rescue, which applies the artist window itself. The on-air artist joins the
// window here so that invariant doesn't rest on how the caller built it.
export function guardRepickSet<T extends CandidateLike>(
  trigger: 'on-air' | 'recent',
  seen: Iterable<[string, T]>,
  pickRoot: string,
  onAirRoot: string,
  windowRoots: Set<string>,
): AlternativePool<T> {
  if (trigger === 'on-air') return alternativeCandidates(seen, pickRoot, windowRoots);
  const window = onAirRoot ? new Set([...windowRoots, onAirRoot]) : windowRoots;
  const pool = alternativeCandidates(seen, pickRoot, window);
  if (pool.starved) return { alt: new Map(), dropped: 0, starved: true };
  return pool;
}

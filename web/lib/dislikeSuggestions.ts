// Block suggestions from listener dislikes (the room, /room/admin/dislikes) and
// everything done with them outside React: the rows that ask the controller
// "is this blocked already" and the filter over its answer.
//
// Test:  npx --yes tsx web/lib/dislikeSuggestions.test.ts

export type SuggestionKind = 'track' | 'artist';

export interface SuggestionListener {
  name: string;
  /** Head of the listener id — tells nameless listeners apart. */
  tag: string;
}

export interface Suggestion {
  kind: SuggestionKind;
  /** The room's target: song id for a track, normalised name for an artist. */
  key: string;
  /** Newest disliked song — the controller resolves what to block from it. */
  songId: string;
  title: string;
  artist: string;
  album: string;
  listeners: SuggestionListener[];
  /** Artist only: listeners who disliked the artist itself. */
  explicit?: number;
  /** Artist only: distinct songs of the artist disliked. */
  songs?: number;
  lastAt: string;
}

export interface Suggestions { artists: Suggestion[]; tracks: Suggestion[] }

export interface CheckRow { id: string; title?: string; artist?: string; album?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function one(raw: unknown, kind: SuggestionKind): Suggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.kind !== kind || !str(s.key) || !str(s.songId)) return null;
  const listeners = Array.isArray(s.listeners)
    ? s.listeners
        .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
        .map(l => ({ name: str(l.name), tag: str(l.tag) }))
    : [];
  const base: Suggestion = {
    kind, key: str(s.key), songId: str(s.songId), title: str(s.title),
    artist: str(s.artist), album: str(s.album), listeners, lastAt: str(s.lastAt),
  };
  return kind === 'artist' ? { ...base, explicit: num(s.explicit), songs: num(s.songs) } : base;
}

export function parseSuggestions(raw: unknown): Suggestions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { artists?: unknown; tracks?: unknown };
  const pick = (list: unknown, kind: SuggestionKind) =>
    (Array.isArray(list) ? list : [])
      .map(x => one(x, kind))
      .filter((x): x is Suggestion => x !== null);
  return { artists: pick(r.artists, 'artist'), tracks: pick(r.tracks, 'track') };
}

/** What the blocklist check is asked with. An artist goes by NAME ONLY, under
 *  a made-up id: with the real songId the answer "blocked" about one song — a
 *  track entry, a genre or folder rule — would pass for the whole artist. */
export function checkId(s: Suggestion): string {
  return s.kind === 'artist' ? `artist:${s.key}` : s.songId;
}

export function checkRows(all: Suggestions): CheckRow[] {
  return [
    ...all.artists.map(s => ({ id: checkId(s), artist: s.artist })),
    ...all.tracks.map(s => ({ id: checkId(s), title: s.title, artist: s.artist, album: s.album })),
  ];
}

/** Whatever the blocklist already catches, by any entry or rule, is not suggested. */
export function withoutBlocked(all: Suggestions, blocked: Record<string, unknown>): Suggestions {
  const open = (s: Suggestion) => !blocked[checkId(s)];
  return { artists: all.artists.filter(open), tracks: all.tracks.filter(open) };
}

export function listenerLabel(l: SuggestionListener): string {
  return l.name.trim() || `anon·${l.tag}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why the row is here: "disliked by Маша, Дима · 3 songs disliked". */
export function reasonLine(s: Suggestion): string {
  const parts = [`disliked by ${s.listeners.map(listenerLabel).join(', ')}`];
  if (s.kind === 'artist') {
    if (s.explicit) parts.push(plural(s.explicit, 'artist dislike', 'artist dislikes'));
    if (s.songs) parts.push(`${plural(s.songs, 'song', 'songs')} disliked`);
  }
  return parts.join(' · ');
}

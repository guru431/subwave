'use client';

// The headless player core — the per-station singletons every skin shares,
// split into three contexts by update cadence so a component subscribes only
// to the churn it actually renders:
//
//   • feed    — the /now-playing + /state + /session snapshot, 5s cadence.
//   • audio   — tune state, volume, signal meter; changes on user gestures
//               and (while tuned in) each 5s signal probe. A volume drag
//               re-renders audio consumers only, never the feed tree.
//   • actions — permanently-stable callbacks (bridged through refs, since
//               usePlayer recreates its closures per render); subscribing
//               to this context never causes a re-render.
//
// The provider also runs the shared side-effect service every skin gets for
// free: the OS media session (lock screen / headphones / car controls),
// including the persona-avatar swap while the DJ is talking. The <audio>
// element itself is rendered by the shell — skins need the ref in the tree
// for the Waveform's Web Audio tap.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useStationFeed, type StationFeed } from '@/hooks/useStationFeed';
import { usePlayer, type PlayerStatus } from '@/hooks/usePlayer';
import { useSignal, type Signal } from '@/hooks/useSignal';
import { useMediaSession } from '@/hooks/useMediaSession';
import { useStationClient, type LikeResult, type LikeStatus } from '@/lib/stationClient';
import { listenerRequestSchema } from '@/lib/schemas.generated';
import type { RequestResult } from '@/lib/types';

export interface PlayerAudio {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Ref callback for the shell's <audio> element. Skins read audioRef; only
   *  the shell that renders the element attaches it, and it must use this
   *  rather than audioRef so the hook sees a remount (see usePlayer). */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  muted: boolean;
  idleStopped: boolean;
  /** Stream confirmed offline. useStationFeed's streamOnline is null until
   *  the first poll and only flips false after the confirm window, so this
   *  never flashes true on load. */
  offline: boolean;
  signal: Signal;
}

export interface PlayerActions {
  /** Toggle tune-in/out. */
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  setVolume: Dispatch<SetStateAction<number>>;
  /** Submit a listener request. Rejects on network error — form state and
   *  error toasts are the skin's business. */
  submitRequest: (text: string, name: string, songId?: string) => Promise<RequestResult>;
  /** Poll a submitted request's outcome (null on network error, so drawers
   *  keep trying). */
  pollRequest: (requestId: string) => Promise<RequestResult | null>;
  /** Like the currently playing track (#991). null on network error; error
   *  statuses come back as a LikeResult with `error`. */
  likeCurrent: (songId: string) => Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null on network error. */
  likeStatus: () => Promise<LikeStatus | null>;
}

const FeedContext = createContext<StationFeed | null>(null);
const AudioContext = createContext<PlayerAudio | null>(null);
const ActionsContext = createContext<PlayerActions | null>(null);

function useRequired<T>(ctx: React.Context<T | null>, name: string): T {
  const value = useContext(ctx);
  if (value == null) throw new Error(`${name} must be used inside <PlayerCoreProvider>`);
  return value;
}

export function usePlayerFeed(): StationFeed {
  return useRequired(FeedContext, 'usePlayerFeed');
}

export function usePlayerAudio(): PlayerAudio {
  return useRequired(AudioContext, 'usePlayerAudio');
}

export function usePlayerActions(): PlayerActions {
  return useRequired(ActionsContext, 'usePlayerActions');
}

export function PlayerCoreProvider({ children }: { children: ReactNode }) {
  const client = useStationClient();
  // A tuned-in player keeps the feed polling while the page is hidden, so the
  // lock screen learns about a track change instead of freezing on whatever was
  // playing when the screen went dark. A ref because the feed is created first
  // (see below) and because tuning in must not re-subscribe its poll.
  const tunedInRef = useRef(false);
  // Feed first: usePlayer's Opus upgrade is gated on the mount the station says
  // it actually serves (issue #1300, bug 5).
  const feed = useStationFeed({ keepAliveWhenHidden: tunedInRef });
  const {
    audioRef,
    attachAudio,
    tunedIn,
    status,
    volume,
    setVolume,
    tune,
    stop,
    toggleMute,
    muted,
    idleStopped,
  } = usePlayer({ opusEnabled: feed.opusEnabled });

  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);

  // Only an explicit false is offline — see PlayerAudio.offline.
  const offline = feed.streamOnline === false;
  const signal = useSignal({ tunedIn, status, offline });

  // usePlayer's tune/stop/toggleMute close over per-render state, so their
  // identity changes every render. Bridge through refs so the actions context
  // value is created exactly once — consumers can safely list actions in
  // effect deps without re-running.
  const tuneRef = useRef(tune);
  const stopRef = useRef(stop);
  const muteRef = useRef(toggleMute);
  tuneRef.current = tune;
  stopRef.current = stop;
  muteRef.current = toggleMute;

  const actions = useMemo<PlayerActions>(
    () => ({
      tune: () => tuneRef.current(),
      stop: () => stopRef.current(),
      toggleMute: () => muteRef.current(),
      setVolume,
      // Pre-flight against the shared request schema — the same rule the
      // controller's validateBody enforces, run here once so every skin's box
      // gets it (they all submit through this action). A refusal comes back as
      // the ordinary failed RequestResult every box already renders, with the
      // schema's own listener-facing message, and never touches the network.
      submitRequest: (text, name, songId) => {
        const parsed = listenerRequestSchema.safeParse({ text, name, songId });
        if (!parsed.success) {
          return Promise.resolve({
            success: false,
            message: parsed.error.issues[0]?.message,
          });
        }
        return client.submitRequest(parsed.data.text, parsed.data.name, parsed.data.songId);
      },
      pollRequest: requestId => client.requestStatus(requestId),
      likeCurrent: songId => client.likeCurrent(songId),
      likeStatus: () => client.likeStatus(),
    }),
    [setVolume, client],
  );

  // Persona avatar to surface on the OS lock screen while the DJ is talking.
  // Prefer the on-air show's persona (a scheduled show can hand the hour to a
  // different DJ); fall back to the global "active" persona from /now-playing.
  // The controller emits a path without the `/api` prefix; client.resolve
  // prepends the station's API base so this resolves the same way in prod
  // (via Caddy), dev (direct origin), and the landing showcase (remote).
  const avatarPath =
    (typeof feed.activeShow?.persona?.avatar === 'string' && feed.activeShow.persona.avatar) ||
    (typeof feed.dj?.avatar === 'string' ? feed.dj.avatar : '') ||
    '';
  const personaAvatarUrl = avatarPath ? client.resolve(avatarPath) : null;
  const personaName =
    (typeof feed.activeShow?.persona?.name === 'string' && feed.activeShow.persona.name) ||
    (typeof feed.dj?.name === 'string' ? feed.dj.name : '') ||
    null;

  // Wire OS-level media controls (lock screen, headphones, car display).
  // No onSkip on the public listener — a stray AirPods double-tap shouldn't
  // skip the song for every other listener on the station.
  useMediaSession({
    tunedIn,
    nowPlaying: feed.nowPlaying,
    audioRef,
    trackStartedAt: feed.trackStartedAt,
    onTune: actions.tune,
    boothFeed: feed.session.messages,
    personaAvatarUrl,
    personaName,
  });

  // useStationFeed returns a fresh object every render; its fields are
  // reference-stable (setIfChanged). Memoize on the fields so audio-context
  // churn (a volume drag) doesn't cascade into every feed consumer.
  const {
    nowPlaying, context, dj, activeShow, listeners, streamOnline,
    llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale,
  } = feed;
  const feedValue = useMemo<StationFeed>(
    () => ({
      nowPlaying, context, dj, activeShow, listeners, streamOnline,
      llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale,
    }),
    [nowPlaying, context, dj, activeShow, listeners, streamOnline,
     llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale],
  );

  const { latencyMs, quality } = signal;
  const audioValue = useMemo<PlayerAudio>(
    () => ({
      audioRef, attachAudio, tunedIn, status, volume, muted, idleStopped, offline,
      signal: { latencyMs, quality },
    }),
    [audioRef, attachAudio, tunedIn, status, volume, muted, idleStopped, offline, latencyMs, quality],
  );

  return (
    <FeedContext.Provider value={feedValue}>
      <AudioContext.Provider value={audioValue}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </AudioContext.Provider>
    </FeedContext.Provider>
  );
}

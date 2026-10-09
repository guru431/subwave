'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useStationClient } from '@/lib/stationClient';
import { mediaText } from '@/lib/mediaMetadata';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

// How long after the last spoken turn the DJ avatar stays on the lock screen:
// typical voice-segment length plus a tail. Longer segments extend it anyway
// because each new turn resets the timer.
const TALKING_LINGER_MS = 15_000;

// How often the published position is re-stated. The OS extrapolates between
// updates from playbackRate, so this only has to correct drift — and it has to
// run behind a locked screen, where timers are throttled, so it stays coarse.
const POSITION_REFRESH_MS = 5_000;

export interface UseMediaSessionParams {
  tunedIn: boolean;
  nowPlaying: NowPlayingTrack | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Epoch ms when the current track became audible to this listener (from
   *  useStationFeed). Together with the track's duration it is the only source
   *  of lock-screen progress: a live stream's own clock says nothing about
   *  where inside the song the listener is. */
  trackStartedAt?: number | null;
  onTune?: () => void;
  onSkip?: () => void;
  /** Booth-feed messages, most recent last; the tail decides whether the DJ is
   *  talking now. Omitting it means the persona avatar is never swapped in. */
  boothFeed?: SessionTurn[];
  /** Public avatar URL for the on-air persona. Swapped into the MediaSession
   *  artwork while the DJ is talking; otherwise the track cover wins. */
  personaAvatarUrl?: string | null;
  /** On-air host name, shown as the metadata "artist" while the DJ is talking so
   *  the lock screen doesn't pretend Track Artist is speaking. */
  personaName?: string | null;
  /** Fork (W07): the station's own name, the fallback title/album in place of
   *  the product's (see lib/mediaMetadata.ts). */
  stationName?: string | null;
}

// Turn kinds that map to "the DJ is on the mic". Tracks and request acks share
// the booth-feed channel but aren't voiced over the music bus, so they must not
// trigger the avatar swap.
const VOICE_TURN_KINDS = new Set([
  'voice',
  'segment',
  'link',
  'intro',
  'station-id',
  'weather',
  'hourly',
  'say',
]);

function isVoiceTurn(turn: SessionTurn | undefined): boolean {
  if (!turn) return false;
  const kind = (turn.kind || '').toLowerCase();
  if (VOICE_TURN_KINDS.has(kind)) return true;
  const role = (turn.role || '').toLowerCase();
  return role === 'voice' || role === 'segment';
}

function lastVoiceTurnTime(feed: SessionTurn[] | undefined): number | null {
  if (!feed?.length) return null;
  // Only voice turns near the tail matter for "is the DJ talking now".
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    if (!isVoiceTurn(turn)) continue;
    const t = typeof turn?.t === 'number'
      ? turn.t
      : typeof turn?.t === 'string'
        ? Date.parse(turn.t)
        : NaN;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Wires the Media Session API to the now-playing feed: track/artist/album on the
// OS lock screen, Android shade, Control Centre, Bluetooth and car displays,
// with hardware play/pause/headphone buttons routed through these handlers.
// Tied to the <audio> element usePlayer owns, and play/pause/stop go through
// usePlayer.tune() so the rest of the UI state stays consistent.
//
// "seekto"/"seekbackward"/"seekforward" are deliberately NOT wired — a live
// stream can't be scrubbed, so the bar the OS draws from the published position
// (see the setPositionState effect) stays a read-only readout instead of a
// control that swallows the drag. `nexttrack` IS wired (headphone
// "next" means skip the song you're hearing) but gated on the skip callback so
// consumers like a public listener page can opt out.
export function useMediaSession({
  tunedIn,
  nowPlaying,
  audioRef,
  trackStartedAt = null,
  onTune,
  onSkip,
  boothFeed,
  personaAvatarUrl,
  personaName,
  stationName,
}: UseMediaSessionParams): void {
  const client = useStationClient();
  // True for TALKING_LINGER_MS after the most recent voice turn. Held in state
  // rather than derived so a setTimeout can flip it off with no feed update.
  const [talking, setTalking] = useState(false);
  const lastVoiceTs = useMemo(() => lastVoiceTurnTime(boothFeed), [boothFeed]);

  useEffect(() => {
    if (lastVoiceTs == null) {
      setTalking(false);
      return;
    }
    const remaining = TALKING_LINGER_MS - (Date.now() - lastVoiceTs);
    if (remaining <= 0) {
      setTalking(false);
      return;
    }
    setTalking(true);
    const id = window.setTimeout(() => setTalking(false), remaining);
    return () => window.clearTimeout(id);
  }, [lastVoiceTs]);
  // The browser renders the lock-screen play/pause glyph from this, so it stays
  // correct even while the <audio> readyState is still loading.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = tunedIn ? 'playing' : 'paused';
  }, [tunedIn]);

  // Artwork routes through /api/cover/:id so the controller proxies the Subsonic
  // bytes and credentials never leak into the page. Falls back to the app icon
  // when there's no id (jingles, station idents, scanning state).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!('MediaMetadata' in window)) return;

    const subsonicId = nowPlaying?.subsonic_id;
    const coverArt: MediaImage | null = subsonicId
      ? {
          src: client.coverUrl(subsonicId),
          sizes: '512x512',
          type: 'image/jpeg',
        }
      : null;
    const personaArt: MediaImage | null = personaAvatarUrl
      ? {
          src: personaAvatarUrl,
          sizes: '512x512',
          type: 'image/png',
        }
      : null;
    const appIcon: MediaImage = { src: '/icons/192', sizes: '192x192', type: 'image/png' };
    const appIconLg: MediaImage = { src: '/icons/512', sizes: '512x512', type: 'image/png' };

    // Lock screen / CarPlay picks the first usable artwork entry, so leading
    // with the persona wins while the DJ talks. The cover stays in the chain so
    // the next push after the linger expires reverts on its own.
    const useAvatar = talking && !!personaArt;
    // Fork (W07): Russian text, the station's name and no "[Unknown Album]".
    const { title, artist, album } = mediaText({
      title: nowPlaying?.title,
      artist: nowPlaying?.artist,
      album: nowPlaying?.album,
      talking: useAvatar,
      personaName,
      stationName,
    });

    let artwork: MediaImage[];
    if (useAvatar && personaArt) {
      artwork = [personaArt, ...(coverArt ? [coverArt] : []), appIcon];
    } else if (coverArt) {
      artwork = [coverArt, appIcon];
    } else {
      artwork = [appIcon, appIconLg];
    }

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title,
      artist,
      album,
      artwork,
    });
  }, [
    nowPlaying?.title,
    nowPlaying?.artist,
    nowPlaying?.album,
    nowPlaying?.subsonic_id,
    talking,
    personaAvatarUrl,
    personaName,
    stationName,
    client,
  ]);

  // Lock-screen progress. The <audio> element can't supply it: on a live
  // Icecast mount its duration is Infinity and currentTime counts the
  // CONNECTION, not the song, so iOS/Android draw either nothing or a bar that
  // restarts on every reconnect. Publishing the position explicitly is the only
  // way the OS learns where inside the current track the listener is — the
  // length comes from /now-playing, the offset from the same listener-time
  // stamp the on-screen clock uses.
  //
  // Seeking stays unwired on purpose (see the note above): the handlers are
  // null, so the bar the OS draws from this is a read-only readout.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof session.setPositionState !== 'function') return;

    const duration = nowPlaying?.duration;
    const known =
      tunedIn &&
      trackStartedAt != null &&
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0;
    if (!known) {
      // An untagged track (no duration) or nothing on air. Clearing matters:
      // left alone, the PREVIOUS track's bar stays on the lock screen and keeps
      // advancing past a song it no longer describes.
      try { session.setPositionState(); } catch {}
      return;
    }
    const publish = () => {
      // Clamped both ways: the stamp carries the listener's buffer offset and
      // can briefly sit in the future, and a track that overruns its tagged
      // length would otherwise hand the OS a position past the end.
      const position = Math.min(Math.max(0, (Date.now() - trackStartedAt) / 1000), duration);
      try {
        session.setPositionState({ duration, position, playbackRate: 1 });
      } catch {}
    };
    publish();
    const id = window.setInterval(publish, POSITION_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [tunedIn, trackStartedAt, nowPlaying?.duration]);

  // Rebound on every dependency change so the handlers always close over the
  // latest tune / skip callbacks.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const session = navigator.mediaSession;

    const handlePlay = () => {
      if (!tunedIn) onTune?.();
      else audioRef.current?.play().catch(() => {});
    };
    const handlePause = () => {
      if (tunedIn) onTune?.();
      else audioRef.current?.pause();
    };
    const handleStop = () => {
      if (tunedIn) onTune?.();
    };
    const handleNext = () => {
      onSkip?.();
    };

    try {
      session.setActionHandler('play', handlePlay);
      session.setActionHandler('pause', handlePause);
      session.setActionHandler('stop', handleStop);
      session.setActionHandler('nexttrack', onSkip ? handleNext : null);
      // Explicitly null so the UI hides these rather than greying them out.
      session.setActionHandler('previoustrack', null);
      session.setActionHandler('seekto', null);
      session.setActionHandler('seekbackward', null);
      session.setActionHandler('seekforward', null);
    } catch {
      // Older Safari throws on unsupported action types; the supported subset is
      // still registered.
    }

    return () => {
      try {
        session.setActionHandler('play', null);
        session.setActionHandler('pause', null);
        session.setActionHandler('stop', null);
        session.setActionHandler('nexttrack', null);
      } catch {}
    };
  }, [tunedIn, onTune, onSkip, audioRef]);
}

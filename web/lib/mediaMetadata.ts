// Fork (W07): text of the OS media session (lock screen, notification shade,
// CarPlay) — the pure half of hooks/useMediaSession.ts, kept free of React so
// it can be tested on its own. Russian like the rest of the player page (W01):
// the album goes through ruAlbum, which hides Navidrome's "[Unknown Album]"
// placeholder exactly as the track card does, and an empty field falls back to
// the station's own name (as in the header) rather than the product's.

import { ruAlbum, ruStationName } from './ru';

export interface MediaTextInput {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  /** The DJ is on the mic and the persona's avatar leads the artwork. */
  talking: boolean;
  personaName?: string | null;
  /** Settings `station` (dj.station on /now-playing); null before the first poll. */
  stationName?: string | null;
}

export interface MediaText {
  title: string;
  artist: string;
  album: string;
}

const LIVE = 'Прямой эфир';

export function mediaText({ title, artist, album, talking, personaName, stationName }: MediaTextInput): MediaText {
  const station = ruStationName(stationName);
  return {
    title: title || station,
    // While the DJ talks the lock screen shouldn't pretend the track artist is
    // speaking.
    artist: talking ? (personaName || artist || LIVE) : (artist || LIVE),
    album: ruAlbum(album) || station,
  };
}

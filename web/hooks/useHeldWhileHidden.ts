'use client';

// Fork (W14): while the page is hidden, return what was last seen.
//
// Classic's stage keys its title block and its cover on the track inside a
// popLayout AnimatePresence. A hidden page paints no frames, so an exit
// animation started there never completes — and since a tuned-in player keeps
// polling the feed in the background (W07), every track change used to leave
// one more title block (heart, 👎 menu, download link) and one more cover
// mounted, ~360 a day, each still subscribed to the feed and dislike
// contexts. Holding the stage's inputs while hidden means no key change, so no
// copies; on return the stage takes the fresh value in a single transition.
//
// For what is DRAWN only. Anything that must stay live behind a locked screen
// (the OS media session, the chat feed) keeps reading the feed directly.

import { useEffect, useRef, useState } from 'react';

export function useHeldWhileHidden<T>(value: T): T {
  const latestRef = useRef(value);
  useEffect(() => { latestRef.current = value; }, [value]);
  // Boxed, so a held null is told apart from "not holding". A mount in an
  // already-hidden tab starts holding: the visibilitychange that would arm it
  // has already fired. No document on the server, and the first render returns
  // `value` either way, so hydration agrees.
  const [held, setHeld] = useState<{ value: T } | null>(() =>
    typeof document !== 'undefined' && document.hidden ? { value } : null,
  );
  useEffect(() => {
    const onVisibility = () => setHeld(document.hidden ? { value: latestRef.current } : null);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return held ? held.value : value;
}

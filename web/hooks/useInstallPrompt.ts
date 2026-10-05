'use client';

import { useCallback, useEffect, useState } from 'react';
import { isIOSDevice, isStandalone } from '@/lib/platform';
import type { BeforeInstallPromptEvent } from '@/lib/install';

export type InstallState =
  /** Already running as an app, or a browser with no way to install. */
  | 'hidden'
  /** Chromium handed us an install event to replay. */
  | 'prompt'
  /** iOS — no API, only the Share-sheet route, so all we can offer is the how. */
  | 'manual';

// Reads "can this listener install the station" and replays the captured
// install event. See lib/install for why the event is captured in a pre-hydration
// script rather than here.
export function useInstallPrompt(): { state: InstallState; install: () => void } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  // Starts as "installed" so the server render and the first client render
  // agree on showing nothing; the effect below tells the truth after mount.
  const [installed, setInstalled] = useState(true);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIOSDevice());
    setDeferred(window.__subwaveInstallPrompt ?? null);

    // The event can also arrive later — on a first visit Chrome only decides
    // the page is installable once the service worker is live, which happens
    // well after hydration.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
      window.__subwaveInstallPrompt = null;
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    const evt = deferred;
    if (!evt) return;
    // One shot: the browser refuses to replay a prompt it has already shown, so
    // drop it either way. A declined install re-fires the event on a later
    // visit and re-arms the button then.
    setDeferred(null);
    window.__subwaveInstallPrompt = null;
    void evt.prompt().catch(() => undefined);
  }, [deferred]);

  const state: InstallState = installed
    ? 'hidden'
    : deferred
      ? 'prompt'
      : ios
        ? 'manual'
        : 'hidden';

  return { state, install };
}

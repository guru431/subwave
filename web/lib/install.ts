// Installing the station as an app.
//
// Chrome stopped offering it by itself when it retired the mini-infobar:
// `beforeinstallprompt` still fires, the browser does nothing visible with it,
// and on Android the only route left is a menu item most listeners never open.
// So the event is captured and replayed from a button in the player (see
// useInstallPrompt / InstallButton). Safari has no equivalent API at all — on
// iOS installation is Share → «На экран „Домой"», and the app can only say so.

// Chromium's install event. Not in lib.dom, so the two members used here are
// declared by hand.
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    /** Set by INSTALL_INIT_SCRIPT below; read once by useInstallPrompt. */
    __subwaveInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

// Runs before hydration. On a repeat visit the service worker is already
// registered, so Chrome can decide the page is installable and fire the event
// while React is still booting — a listener added in an effect would miss it
// and the button would never appear. preventDefault() only suppresses whatever
// built-in UI the browser might still show; the event itself stays replayable.
export const INSTALL_INIT_SCRIPT = `
(function () {
  window.__subwaveInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__subwaveInstallPrompt = e;
  });
})();
`;

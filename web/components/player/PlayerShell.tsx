'use client';

// Player chrome every skin gets for free: the headless core provider, the
// <audio> element skins tap for the visualiser, contained-embed portal
// plumbing, and skin resolution.
//
// Skin precedence mirrors themes: listener override (localStorage) > station
// default (ui.skin on GET /state) > built-in fallback. The last-seen station
// skin is cached; contained showcases follow the remote station strictly.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useThemeSwitcher } from '@/components/ThemeProvider';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/cn';
import {
  cacheStationSkin,
  canonicalSkinId,
  loadCachedStationSkin,
  loadSkinOverride,
  saveSkinOverride,
} from '@/lib/skin';
import {
  DEFAULT_SKIN_COMPONENT,
  DEFAULT_SKIN_ID,
  SKINS,
  SKIN_COMPONENTS,
  resolveSkinId,
} from '@/components/skins';
import { SkinSelectionProvider, type SkinSelection } from '@/components/skins/SkinContext';
import type { SkinComponent } from '@/components/skins/types';
import { PlayerCoreProvider, usePlayerAudio, usePlayerFeed } from './PlayerCore';
import { StationPasswordGate, useStationAuth } from './StationGate';

export interface PlayerShellProps {
  /** Explicit skin — bypasses registry resolution (previews, tests). */
  skin?: SkinComponent;
  /** Rendered inside a showcase frame (landing page) rather than full-page:
   *  absolute instead of fixed positioning, dialogs portal into the frame,
   *  no toaster. */
  contained?: boolean;
}

export default function PlayerShell({ skin, contained = false }: PlayerShellProps) {
  return (
    <PlayerCoreProvider>
      <ShellChrome skin={skin} contained={contained} />
    </PlayerCoreProvider>
  );
}

/** True when the keypress landed inside an open modal. */
function targetInsideDialog(e?: KeyboardEvent): boolean {
  return e?.target instanceof HTMLElement && e.target.closest('[role="dialog"]') != null;
}

// Fork (W01): only the classic face is translated (and carries the fork's chat,
// 👎, download and volume slider), so the full-page player offers no other. The
// palette's picker and the `s` shortcut both work off this list, and a pick of
// another skin saved before the change is dropped. The operator's station-wide
// `ui.skin` still applies; showcases (`contained`) keep the whole registry.
const PAGE_SKINS = SKINS.filter(s => s.id === DEFAULT_SKIN_ID);
const isPageSkin = (id: string | null) => PAGE_SKINS.some(s => s.id === canonicalSkinId(id));

function ShellChrome({ skin, contained }: { skin?: SkinComponent; contained: boolean }) {
  const { attachAudio } = usePlayerAudio();
  const { state } = usePlayerFeed();
  const stationSkinRaw = typeof state.ui?.skin === 'string' && state.ui.skin ? state.ui.skin : null;

  // localStorage is effect-only (SSR renders the default), so an override or
  // cached non-default station skin swaps one tick after hydration.
  // SKIN_INIT_SCRIPT hides the shell pre-paint (data-skin-pending on <html>)
  // so that swap is a blank, not a flash of the default face; `hydrated`
  // lifts the curtain once the resolved skin is in the tree.
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [cachedStation, setCachedStation] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (contained) return; // showcases follow the remote station strictly
    // Fork (W01): a saved pick outside PAGE_SKINS is cleared, not just ignored,
    // so the pre-paint script stops blanking the shell for it on every load.
    const saved = loadSkinOverride();
    if (saved && !isPageSkin(saved)) saveSkinOverride(null);
    setOverrideId(saved && isPageSkin(saved) ? saved : null);
    setCachedStation(loadCachedStationSkin());
    setHydrated(true);
  }, [contained]);
  useEffect(() => {
    if (!hydrated || typeof document === 'undefined') return;
    document.documentElement.removeAttribute('data-skin-pending');
  }, [hydrated]);
  useEffect(() => {
    if (contained || !stationSkinRaw) return;
    // Cache the RESOLVED id: a skin this build doesn't ship falls back to the
    // default, and caching the raw id would pre-paint-hide the shell forever.
    cacheStationSkin(resolveSkinId(stationSkinRaw, null));
  }, [contained, stationSkinRaw]);

  const stationSkinId = stationSkinRaw ?? cachedStation ?? DEFAULT_SKIN_ID;
  const effectiveId = resolveSkinId(stationSkinId, contained ? null : overrideId);

  const setOverride = useCallback((id: string | null) => {
    saveSkinOverride(id);
    setOverrideId(id);
  }, []);

  const selection = useMemo<SkinSelection>(
    () => ({
      // Fork (W01): one skin on the page, so ThemeSwitcher hides its picker.
      skins: contained ? SKINS : PAGE_SKINS,
      stationSkinId: resolveSkinId(stationSkinId, null),
      overrideId,
      effectiveId,
      setOverride,
    }),
    [contained, stationSkinId, overrideId, effectiveId, setOverride],
  );

  // Shell-level cycling shortcuts, live in every skin: `s` cycles the skin
  // override, `t` the theme override. Both stand down while a skin-owned
  // modal has focus (swapping would tear it down mid-use); Radix traps focus
  // inside role="dialog", so the event target is the tell. Skins' own
  // shortcut maps still work inside drawers, hence the check lives here and
  // not in useKeyboardShortcuts.
  const themeCtx = useThemeSwitcher();
  // Fork (W01): cycles PAGE_SKINS (the shortcut is dead while contained), so
  // with the one skin there is nowhere to go; toasts are Russian, like the page.
  const cycleSkin = useCallback((e?: KeyboardEvent) => {
    if (contained || targetInsideDialog(e) || PAGE_SKINS.length < 2) return;
    const i = PAGE_SKINS.findIndex(s => s.id === effectiveId);
    const next = PAGE_SKINS[(i + 1) % PAGE_SKINS.length];
    if (!next) return;
    setOverride(next.id);
    toast(`Вид плеера: ${next.name}`);
  }, [contained, effectiveId, setOverride]);
  const cycleTheme = useCallback((e?: KeyboardEvent) => {
    if (contained || targetInsideDialog(e) || !themeCtx || themeCtx.themes.length === 0) return;
    const { themes, effectiveId: themeId, setOverride: setThemeOverride } = themeCtx;
    const i = themes.findIndex(t => t.id === themeId);
    const next = themes[(i + 1) % themes.length];
    if (!next) return;
    setThemeOverride(next.id);
    toast(`Тема: ${next.name}`);
  }, [contained, themeCtx]);
  useKeyboardShortcuts({ s: cycleSkin, t: cycleTheme }, { disabled: contained });

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  // The <audio> element lives in the shell, so a skin swap never interrupts
  // playback.
  const Skin = skin ?? SKIN_COMPONENTS[effectiveId] ?? DEFAULT_SKIN_COMPONENT;

  // Private-station gate (#478): no skin and no <audio> element until the
  // password is accepted. 'checking' counts as hidden, so a stored token
  // still being validated can't flash the face at a locked-out visitor.
  const auth = useStationAuth();
  const hideFace = state.privacy?.privatePlayer === true && auth.phase !== 'ok';

  return (
    <SkinSelectionProvider value={selection}>
      <div
        ref={rootRef}
        className={cn(
          // sw-player-shell is the pre-paint hide hook (SKIN_INIT_SCRIPT) —
          // full-page shells only; showcase embeds never set/clear the attr.
          contained ? 'absolute' : 'sw-player-shell fixed',
          'inset-0 overflow-hidden bg-bg text-ink',
        )}
      >
        {hideFace ? (
          // Live-flipped by the /state poll, like themes and skins.
          <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid />
        ) : (
          <>
            <audio ref={attachAudio} crossOrigin="anonymous" preload="auto" />
            {/* Skins are next/dynamic chunks, so an unfetched face suspends on
                first render. This boundary is required: without it the
                suspension escapes to the landing page's own boundary, which
                re-reveals every motion element without re-running its mount
                animation and leaves the page stuck at opacity 0. */}
            <Suspense fallback={null}>
              <Skin contained={contained} portalNode={portalNode} />
            </Suspense>
            {/* Same prompt, overlaid, when only the stream is locked. */}
            <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid={false} />
          </>
        )}
        {/* Toaster is mounted once at the app shell (app/layout.tsx). */}
      </div>
    </SkinSelectionProvider>
  );
}

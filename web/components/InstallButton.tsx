'use client';

import { Download } from 'lucide-react';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { notify } from '@/lib/notify';

// "Install as an app" for the player header. Renders nothing unless this
// listener can actually act on it — already installed, or a browser with no
// route at all, and the header keeps its shape (see useInstallPrompt).
//
// On iOS there is no API to call, so the button explains the Share-sheet route
// instead of pretending to do it. A toast rather than a popover: it needs no
// anchor, and the station already mounts one Toaster at the root.
export default function InstallButton() {
  const { state, install } = useInstallPrompt();
  if (state === 'hidden') return null;

  const manual = state === 'manual';
  const label = manual ? 'Как установить приложение' : 'Установить приложение';
  return (
    <button
      type="button"
      onClick={() =>
        manual
          ? notify.info('Установка на iPhone: «Поделиться» → «На экран „Домой"»')
          : install()
      }
      aria-label={label}
      title={label}
      className="v3-focus inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 leading-none text-muted hover:text-ink"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

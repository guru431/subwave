'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';
import { Kbd } from '@/components/ui/kbd';

interface Shortcut {
  keys: string[];
  label: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Space', 'K'], label: 'Включить / выключить' },
  { keys: ['↑'], label: 'Громче' },
  { keys: ['↓'], label: 'Тише' },
  { keys: ['M'], label: 'Звук выкл. / вкл.' },
  { keys: ['1'], label: 'Открыть ленту' },
  { keys: ['2'], label: 'Открыть эфир студии' },
  { keys: ['3', 'R'], label: 'Заказать трек' },
  { keys: ['4'], label: 'Открыть расписание' },
  { keys: ['S'], label: 'Следующий вид плеера' },
  { keys: ['T'], label: 'Следующая тема' },
  { keys: ['?'], label: 'Этот список сочетаний' },
  { keys: ['⌘K'], label: 'Палитра команд' },
  { keys: ['Esc'], label: 'Закрыть панель / окно' },
];

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
}

/* Accepts `container` so it stays inside the frame in contained mode,
   matching FullDialog / Modal. */
export default function ShortcutsDialog({ open, onOpenChange, container }: ShortcutsDialogProps) {
  const contained = !!container;
  const pos = contained ? 'absolute' : 'fixed';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay
          className={cn('v3-drawer-overlay inset-0 z-40 bg-overlay', pos)}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'v3-modal-pop top-1/2 left-1/2 z-50 flex flex-col border border-ink bg-bg text-ink shadow-drawer outline-none',
            '-translate-x-1/2 -translate-y-1/2',
            'max-h-[calc(100vh-3rem)] w-[min(420px,calc(100vw-2rem))]',
            pos,
          )}
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-ink px-6 py-4">
            <Dialog.Title className="v3-eyebrow m-0 text-[13px] tracking-[0.3em]">
              Сочетания клавиш
            </Dialog.Title>
            <Dialog.Close
              className="v3-focus cursor-pointer border-0 bg-transparent text-xl leading-none text-muted"
              aria-label="Закрыть"
            >
              ×
            </Dialog.Close>
          </div>

          <div className="v3-scroll flex-1 overflow-auto px-6 py-3">
            <ul className="flex flex-col">
              {SHORTCUTS.map((s) => (
                <li
                  key={s.label}
                  className="flex items-center justify-between gap-4 border-b border-dashed border-separator-soft py-2.5"
                >
                  <span className="text-sm">{s.label}</span>
                  <span className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

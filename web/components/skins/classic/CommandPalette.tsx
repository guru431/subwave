'use client';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';

export type PlayerDrawer = 'timeline' | 'booth' | 'request' | 'schedule';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  tunedIn: boolean;
  muted: boolean;
  onTune: () => void;
  onOpenDrawer: (kind: PlayerDrawer) => void;
  onToggleMute: () => void;
  onShowShortcuts: () => void;
}

interface PaletteItem {
  label: string;
  hint: string;
  onSelect: () => void;
}

/* Scope is player actions only — never admin/site routes. */
export default function CommandPalette({
  open,
  onOpenChange,
  container,
  tunedIn,
  muted,
  onTune,
  onOpenDrawer,
  onToggleMute,
  onShowShortcuts,
}: CommandPaletteProps) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const items: PaletteItem[] = [
    { label: tunedIn ? 'Выключить' : 'Включить', hint: 'Space', onSelect: run(onTune) },
    { label: 'Открыть ленту', hint: '1', onSelect: run(() => onOpenDrawer('timeline')) },
    { label: 'Открыть эфир студии', hint: '2', onSelect: run(() => onOpenDrawer('booth')) },
    { label: 'Заказать трек', hint: '3', onSelect: run(() => onOpenDrawer('request')) },
    { label: 'Открыть расписание', hint: '4', onSelect: run(() => onOpenDrawer('schedule')) },
    { label: muted ? 'Включить звук' : 'Выключить звук', hint: 'M', onSelect: run(onToggleMute) },
    { label: 'Сочетания клавиш', hint: '?', onSelect: run(onShowShortcuts) },
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      container={container}
      label="Палитра команд"
    >
      <CommandInput placeholder="Введите команду…" />
      <CommandList>
        <CommandEmpty>Команд не найдено.</CommandEmpty>
        <CommandGroup heading="Плеер">
          {items.map((it) => (
            <CommandItem key={it.label} value={it.label} onSelect={it.onSelect}>
              <span>{it.label}</span>
              <Kbd>{it.hint}</Kbd>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

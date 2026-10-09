'use client';

// «Не нравится» — одна кнопка с меню из двух пунктов: песня или исполнитель
// целиком. Одна, а не две: в строке «Уже прозвучало» уже стоит скачивание, а
// смысл второго значка на телефоне без подсказки не читается. Галочка —
// отметка ЭТОГО слушателя; эфир от неё не меняется, решает владелец станции.

import { ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { isMarked, markOf } from '@/lib/roomDislikes';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDislikes } from './DislikesContext';

export default function DislikeMenu({ songId, title, artist, size = 15, className }: {
  songId: string | null | undefined;
  title?: string | null;
  artist?: string | null;
  size?: number;
  className?: string;
}) {
  const dislikes = useDislikes();
  if (!songId || !dislikes) return null;
  const id: string = songId;
  const mark = markOf(dislikes.marks, id);
  const on = isMarked(mark);
  const label = { title, artist };
  return (
    // Ключ — песня. Строки «Уже прозвучало» апстрим ключует по индексу, и на
    // смене трека они сдвигаются: без ключа открытое меню оставалось открытым,
    // а его пункты уже отмечали соседнюю песню. Другая песня — другое меню,
    // смена его закрывает.
    <DropdownMenu key={id}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Не нравится"
          title="Не нравится"
          className={cn(
            'v3-focus inline-flex cursor-pointer items-center border-0 bg-transparent p-0 transition-colors',
            on ? 'text-vermilion' : 'text-muted hover:text-ink',
            className,
          )}
        >
          <ThumbsDown size={size} strokeWidth={1.75} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={mark.track}
          disabled={dislikes.busy}
          onCheckedChange={v => { void dislikes.toggle(id, 'track', v === true, label); }}
        >
          Не нравится песня
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={mark.artist}
          disabled={dislikes.busy || !artist?.trim()}
          onCheckedChange={v => { void dislikes.toggle(id, 'artist', v === true, label); }}
        >
          Не нравится исполнитель
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

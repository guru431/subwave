'use client';

// Отметки «не нравится» этого слушателя — одно состояние на скин. Кнопок на
// экране до полусотни (карточка и каждая строка «Уже прозвучало»), и
// спрашивать комнату каждой значило бы полсотни запросов на смену трека.
// Кнопки читают контекст, поэтому сетевое состояние не перерисовывает
// CenterStage под memo — по той же причине сердце живёт в собственном хуке.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  doneText, errorText, fetchMarks, setDislike, type DislikeKind, type Marks,
} from '@/lib/roomDislikes';

export interface DislikeLabel { title?: string | null; artist?: string | null }

export interface Dislikes {
  marks: Marks;
  /** Идёт запрос — пункты меню неактивны: двойное нажатие поставило бы и сняло. */
  busy: boolean;
  toggle: (songId: string, kind: DislikeKind, on: boolean, label: DislikeLabel) => Promise<void>;
}

const Ctx = createContext<Dislikes | null>(null);

export function DislikesProvider({ windowKey, children }: {
  /** Меняется вместе с окном станции (новый трек) — тогда отметки перечитываются. */
  windowKey: string;
  children: ReactNode;
}) {
  const [marks, setMarks] = useState<Marks>({});
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    const next = await fetchMarks();
    // Опоздавший ответ не затирает более свежий; отказ комнаты не стирает отметки.
    if (next && seq === seqRef.current) setMarks(next);
  }, []);

  useEffect(() => { void reload(); }, [windowKey, reload]);

  const toggle = useCallback<Dislikes['toggle']>(async (songId, kind, on, label) => {
    setBusy(true);
    try {
      const res = await setDislike(songId, kind, on);
      if (res.ok) toast(doneText(kind, on, label.title, label.artist));
      else toast.error(errorText(res.status));
      // И после отказа: 403 значит, что окно уже другое.
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const value = useMemo(() => ({ marks, busy, toggle }), [marks, busy, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** null — кнопка вне провайдера: её просто не рисуют. */
export function useDislikes(): Dislikes | null {
  return useContext(Ctx);
}

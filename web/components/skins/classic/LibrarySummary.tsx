'use client';

import { useEffect, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { ruPlural } from '@/lib/ru';

interface Summary {
  total: number;
  scanning: boolean;
}

export default function LibrarySummary({ onOpen }: { onOpen: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let pending = false;
    const stop = pollWhileVisible(() => {
      if (pending) return;
      pending = true;
      void (async () => {
        try {
          const response = await fetch('/room/library', { signal: abort.signal });
          if (!response.ok) throw new Error('library unavailable');
          const body = await response.json();
          if (!Number.isSafeInteger(body.total) || body.total < 0) throw new Error('invalid total');
          if (!abort.signal.aborted) setSummary({ total: body.total, scanning: body.scanning === true });
        } catch {
          if (!abort.signal.aborted) setSummary(null);
        } finally {
          pending = false;
        }
      })();
    }, 60_000);
    return () => { stop(); abort.abort(); };
  }, []);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="v3-focus w-fit max-w-full cursor-pointer border-0 bg-transparent p-0 text-left text-[11px] leading-relaxed text-muted hover:text-ink"
    >
      {summary?.scanning ? 'Коллекция обновляется' : summary
        ? `В коллекции: ${summary.total.toLocaleString('ru-RU')} ${ruPlural(summary.total, 'песня', 'песни', 'песен')}`
        : 'Коллекция радио'}
      {' · '}<span className="text-vermilion underline underline-offset-2">Проверить наличие</span>
    </button>
  );
}

'use client';
import { useState } from 'react';
import { useLibrary } from './LibraryContext';
import { libraryKeys } from './queries';
import { adminJson, useAdminQuery } from '@/lib/admin-query';

interface Diagnostic {
  summary: string;
  shows: Array<{ id: string; name: string }>;
  checks: Array<{ code: string; state: string; text: string }>;
  warnings: string[];
  lastAired: { at: string | null; count: number };
}

export function RotationDiagnostic({ id }: { id: string }) {
  const { adminFetch } = useLibrary();
  const [open, setOpen] = useState(false);
  const [showId, setShowId] = useState('');
  const query = useAdminQuery<Diagnostic>({
    adminFetch, key: libraryKeys.rotation(id, showId), enabled: open, staleTime: 0,
    request: (fetcher, signal) => adminJson(fetcher, `/library/rotation/${encodeURIComponent(id)}?showId=${encodeURIComponent(showId)}`, undefined, signal),
  });
  return <div className="text-xs">
    <button type="button" className="underline" aria-expanded={open} onClick={() => setOpen(v => !v)}>Почему не звучит?</button>
    {open && <div className="mt-2 space-y-2 break-words" aria-live="polite">
      <label>Шоу <select className="max-w-full" aria-label="Шоу для диагностики" value={showId} onChange={e => setShowId(e.target.value)}>
        <option value="">Текущее шоу</option>{query.data?.shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
      {query.isFetching && <p>Проверяем правила…</p>}
      {query.error && <p role="alert">Не удалось проверить: {query.error.message}</p>}
      {query.data && <><p>{query.data.summary}</p><ul className="list-inside list-disc">{query.data.checks.map(c => <li key={c.code}>{c.text}</li>)}</ul>
        <p>В журнале эфира: {query.data.lastAired.count}; последний выход: {query.data.lastAired.at || 'нет записи'}.</p>
        {query.data.warnings.map(w => <p key={w} className="text-muted">{w}</p>)}
        <button type="button" className="underline" onClick={() => { void query.refetch(); }}>Проверить снова</button></>}
    </div>}
  </div>;
}

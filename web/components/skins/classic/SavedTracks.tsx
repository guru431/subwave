'use client';
import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { toast } from 'sonner';
import { LIBRARY_EVENT, savedTracks, writeTracks, type SavedTrack } from '@/lib/listenerLibrary';

function useSavedTracks() {
  const [rows, setRows] = useState<SavedTrack[]>([]);
  useEffect(() => {
    const update = () => setRows(savedTracks());
    update();
    window.addEventListener(LIBRARY_EVENT, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(LIBRARY_EVENT, update); window.removeEventListener('storage', update); };
  }, []);
  return rows;
}

export function SaveTrackButton({ track }: { track: SavedTrack }) {
  const rows = useSavedTracks();
  const saved = rows.some(t => t.id === track.id && t.title === track.title && t.artist === track.artist);
  if (!track.id || !track.title) return null;
  const label = saved ? 'Удалить из личных закладок' : 'Сохранить себе';
  return <button type="button" aria-label={label} title={label} aria-pressed={saved}
    className="v3-focus ml-2 inline-flex shrink-0 align-middle text-muted hover:text-ink"
    onClick={() => {
      try {
        const latest = savedTracks();
        const exists = latest.some(t => t.id === track.id && t.title === track.title && t.artist === track.artist);
        if (!exists && latest.length >= 500) { toast.error('В закладках уже 500 песен. Удалите ненужные.'); return; }
        writeTracks(exists ? latest.filter(t => !(t.id === track.id && t.title === track.title && t.artist === track.artist)) : [track, ...latest]);
      } catch { toast.error('Браузер не разрешил сохранить закладку.'); }
    }}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /></button>;
}

export function SavedTracks({ onRequest }: { onRequest: (track: SavedTrack) => void }) {
  const rows = useSavedTracks();
  const exportList = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'radio-bookmarks.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="mb-5 border-b border-separator-soft pb-3">
    <summary className="v3-focus cursor-pointer text-sm">Мои закладки ({rows.length})</summary>
    <p className="my-2 text-xs text-muted">Хранятся в этом браузере. Заказ заново сверяется с коллекцией; выберите нужную запись в подсказке.</p>
    {!!rows.length && <button type="button" className="v3-focus text-xs underline" onClick={exportList}>Экспорт JSON</button>}
    <ul>{rows.map(t => <li key={`${t.id}|${t.artist}|${t.title}`} className="my-3 text-sm break-words">
      <div>{t.artist} — {t.title}</div><div className="text-xs text-muted">{t.album} · {t.airedAt}</div>
      <button type="button" className="v3-focus mr-3 text-xs underline" onClick={() => onRequest(t)}>Найти и заказать</button>
      <button type="button" className="v3-focus text-xs underline" onClick={() => {
        try { writeTracks(savedTracks().filter(r => !(r.id === t.id && r.title === t.title && r.artist === t.artist))); }
        catch { toast.error('Не удалось удалить закладку.'); }
      }}>Удалить</button>
    </li>)}</ul>
  </details>;
}

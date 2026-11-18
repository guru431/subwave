'use client';
import { useEffect, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { toast } from 'sonner';
import {
  LIBRARY_EVENT, planBookmarkImport, readBookmarkExport, sameSavedTrack, savedTracks, writeTracks, type SavedTrack,
} from '@/lib/listenerLibrary';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

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
  const saved = rows.some(t => sameSavedTrack(t, track));
  if (!track.id || !track.title) return null;
  const label = saved ? 'Удалить из личных закладок' : 'Сохранить себе';
  return <button type="button" aria-label={label} title={label} aria-pressed={saved}
    className="v3-focus ml-2 inline-flex shrink-0 align-middle text-muted hover:text-ink"
    onClick={() => {
      try {
        const latest = savedTracks();
        const exists = latest.some(t => sameSavedTrack(t, track));
        if (!exists && latest.length >= 500) { toast.error('В закладках уже 500 песен. Удалите ненужные.'); return; }
        writeTracks(exists ? latest.filter(t => !sameSavedTrack(t, track)) : [track, ...latest]);
      } catch { toast.error('Браузер не разрешил сохранить закладку.'); }
    }}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /></button>;
}

export function SavedTracks({ onRequest }: { onRequest: (track: SavedTrack) => void }) {
  const rows = useSavedTracks();
  const input = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<unknown[] | null>(null);
  const [reading, setReading] = useState(false);
  const preview = imported && planBookmarkImport(rows, imported);
  const previewImport = async (file: File) => {
    setImported(null);
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('Размер файла с закладками превышает 10 МБ.');
      return;
    }
    setReading(true);
    try { setImported(readBookmarkExport(await file.text())); }
    catch { toast.error('Не удалось прочитать JSON со списком закладок.'); }
    finally { setReading(false); }
  };
  const confirmImport = () => {
    if (!imported) return;
    try {
      const plan = planBookmarkImport(savedTracks(), imported);
      if (plan.added) writeTracks(plan.rows);
      setImported(null);
      toast.success(`Добавлено закладок: ${plan.added}`);
    } catch { toast.error('Браузер не разрешил сохранить закладки.'); }
  };
  const exportList = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'radio-bookmarks.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="mb-5 border-b border-separator-soft pb-3">
    <summary className="v3-focus cursor-pointer text-sm">Мои закладки ({rows.length})</summary>
    <p className="my-2 text-xs text-muted">Хранятся в этом браузере. Заказ заново сверяется с коллекцией; выберите нужную запись в подсказке.</p>
    {!!rows.length && <button type="button" className="v3-focus mr-3 text-xs underline" onClick={exportList}>Экспорт JSON</button>}
    <button type="button" className="v3-focus text-xs underline" disabled={reading} onClick={() => input.current?.click()}>
      {reading ? 'Читаем файл…' : 'Импорт JSON'}
    </button>
    <input ref={input} type="file" accept=".json,application/json" hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void previewImport(file);
    }} />
    {preview && <div className="my-2 text-xs">
      <p aria-live="polite">Новые: {preview.added} · Повторы: {preview.duplicates} · Непригодные: {preview.invalid} · Сверх лимита: {preview.overflow}</p>
      <button type="button" className="v3-focus mr-3 underline disabled:opacity-50" disabled={!preview.added}
        onClick={confirmImport}>Добавить закладки</button>
      <button type="button" className="v3-focus underline" onClick={() => setImported(null)}>Закрыть</button>
    </div>}
    <ul>{rows.map(t => <li key={`${t.id}|${t.artist}|${t.title}`} className="my-3 text-sm break-words">
      <div>{t.artist} — {t.title}</div><div className="text-xs text-muted">{t.album} · {t.airedAt}</div>
      <button type="button" className="v3-focus mr-3 text-xs underline" onClick={() => onRequest(t)}>Найти и заказать</button>
      <button type="button" className="v3-focus text-xs underline" onClick={() => {
        try { writeTracks(savedTracks().filter(r => !sameSavedTrack(r, t))); }
        catch { toast.error('Не удалось удалить закладку.'); }
      }}>Удалить</button>
    </li>)}</ul>
  </details>;
}

'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStationClient } from '@/lib/stationClient';
import { LIBRARY_EVENT, receiptIds, forgetReceipt } from '@/lib/listenerLibrary';
import { watchRequestPush } from '@/lib/roomPush';
import type { RequestResult } from '@/lib/types';

const labels = { accepted: 'Принято', searching: 'Ищем песню', queued: 'В очереди', aired: 'Прозвучало',
  declined: 'Отказ', failed: 'Не выполнено', removed: 'Снято / начало не подтверждено', answered: 'Ведущий ответил' };

export function RequestReceipts() {
  const client = useStationClient();
  const [rows, setRows] = useState<Array<{ id: string; result: RequestResult | null }>>([]);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const update = async () => {
      const run = ++generation;
      const result = await Promise.all(receiptIds().map(async id => ({ id, result: await client.requestStatus(id) })));
      if (!cancelled && run === generation) setRows(result);
    };
    void update();
    const changed = () => { void update(); };
    const timer = setInterval(changed, 10_000);
    window.addEventListener(LIBRARY_EVENT, changed); window.addEventListener('storage', changed);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener(LIBRARY_EVENT, changed); window.removeEventListener('storage', changed); };
  }, [client]);
  if (!rows.length) return null;
  return <details open className="mb-5 border-b border-separator-soft pb-3 text-xs">
    <summary className="v3-focus cursor-pointer">Мои заказы</summary>
    <p className="my-2 text-muted">Квитанции хранятся 7 дней. Время ожидания — оценка. Доступ к каждой есть только по её случайному номеру.</p>
    <ul aria-live="polite">{rows.map(({ id, result }) => <li key={id} className="my-3 break-words">
      <strong>{result?.phase ? labels[result.phase] : result?.status === 'unknown' ? 'Квитанция истекла' : 'Статус пока недоступен'}</strong>
      {result?.track && <div>{result.track.artist} — {result.track.title}</div>}
      {result?.phase === 'queued' && <p>{result.queuePosition ? `Позиция ${result.queuePosition}. ` : ''}
        {typeof result.estimatedWaitSec === 'number' ? `Около ${Math.ceil(result.estimatedWaitSec / 60)} мин. ` : ''}{result.waitReason}</p>}
      {result?.message && <p>{result.message}</p>}
      {result?.phase && ['accepted', 'searching', 'queued'].includes(result.phase) &&
        <button type="button" className="v3-focus mr-3 underline" onClick={async () => {
          const ok = await watchRequestPush(id);
          (ok ? toast.success : toast.error)(ok ? 'Уведомим о результате этого заказа' : 'Не удалось включить уведомление');
        }}>Уведомить о результате</button>}
      <button type="button" className="v3-focus underline" onClick={() => {
        try { forgetReceipt(id); } catch { toast.error('Не удалось удалить квитанцию из браузера.'); }
      }}>Убрать из списка</button>
    </li>)}</ul>
  </details>;
}

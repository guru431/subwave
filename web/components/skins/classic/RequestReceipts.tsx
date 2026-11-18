'use client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { defaultStationClient, useStationClient } from '@/lib/stationClient';
import { LIBRARY_EVENT, receiptIds, forgetReceipt } from '@/lib/listenerLibrary';
import { watchRequestPush } from '@/lib/roomPush';
import type { RequestResult } from '@/lib/types';

const labels = { accepted: 'Принято', searching: 'Ищем песню', queued: 'В очереди', aired: 'Прозвучало',
  declined: 'Отказ', failed: 'Не выполнено', removed: 'Снято / начало не подтверждено', answered: 'Ведущий ответил' };

export function RequestReceipts() {
  const client = useStationClient();
  const { apiUrl, roomUrl } = client.origin;
  const localRoom = apiUrl === defaultStationClient.origin.apiUrl && roomUrl === defaultStationClient.origin.roomUrl;
  const [rows, setRows] = useState<Array<{ id: string; result: RequestResult | null }>>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      const run = ++generation.current;
      const result = await Promise.all(receiptIds(apiUrl).map(async id => ({ id, result: await client.requestStatus(id) })));
      if (!cancelled && run === generation.current) setRows(result);
    };
    void update();
    const changed = () => { void update(); };
    const timer = setInterval(changed, 10_000);
    window.addEventListener(LIBRARY_EVENT, changed); window.addEventListener('storage', changed);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener(LIBRARY_EVENT, changed); window.removeEventListener('storage', changed); };
  }, [client, apiUrl]);
  const cancel = async (id: string) => {
    setCancelling(id);
    const result = await client.cancelRequest(id);
    setCancelling(null);
    if (!result) {
      toast.error('Не удалось получить результат отзыва. Проверьте статус заказа.');
      return;
    }
    generation.current++;
    setRows(latest => latest.map(row => row.id === id ? { id, result } : row));
    if (!result.cancelledByListener) toast.error('Заказ уже нельзя отозвать. Смотрите его текущий статус.');
  };
  if (!rows.length) return null;
  return <details open className="mb-5 border-b border-separator-soft pb-3 text-xs">
    <summary className="v3-focus cursor-pointer">Мои заказы</summary>
    <p className="my-2 text-muted">Квитанции хранятся 7 дней. Время ожидания — оценка. Доступ к каждой есть только по её случайному номеру.</p>
    <ul aria-live="polite">{rows.map(({ id, result }) => <li key={id} className="my-3 break-words">
      <strong>{result?.cancelledByListener ? 'Отозвано' : result?.phase ? labels[result.phase] : result?.status === 'unknown' ? 'Квитанция истекла' : 'Статус пока недоступен'}</strong>
      {result?.track && <div>{result.track.artist} — {result.track.title}</div>}
      {result?.phase === 'queued' && <p>{result.queuePosition ? `Позиция ${result.queuePosition}. ` : ''}
        {typeof result.estimatedWaitSec === 'number' ? `Около ${Math.ceil(result.estimatedWaitSec / 60)} мин. ` : ''}{result.waitReason}</p>}
      {result?.message && <p>{result.message}</p>}
      {localRoom && result?.phase && ['accepted', 'searching', 'queued'].includes(result.phase) &&
        <button type="button" className="v3-focus mr-3 underline" onClick={async () => {
          const ok = await watchRequestPush(id);
          (ok ? toast.success : toast.error)(ok ? 'Уведомим о результате этого заказа' : 'Не удалось включить уведомление');
        }}>Уведомить о результате</button>}
      {result?.canCancel && <button type="button" disabled={cancelling !== null}
        className="v3-focus mr-3 underline disabled:opacity-50" onClick={() => void cancel(id)}>
        {cancelling === id ? 'Отзываем…' : 'Отозвать заказ'}
      </button>}
      <button type="button" className="v3-focus underline" onClick={() => {
        try { forgetReceipt(apiUrl, id); } catch { toast.error('Не удалось удалить квитанцию из браузера.'); }
      }}>Убрать из списка</button>
    </li>)}</ul>
  </details>;
}

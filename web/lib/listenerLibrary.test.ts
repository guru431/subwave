import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStationClient } from './stationClient';
import { originForStation } from './stationOrigin';
import {
  forgetReceipt, planBookmarkImport, readBookmarkExport, receiptIds, rememberReceipt, type SavedTrack,
} from './listenerLibrary';

test('private receipts stay with the issuing station, even when a legacy list is present', async t => {
  const store = new Map<string, string>();
  const a = '00000000-0000-0000-0000-000000000001';
  const b = '00000000-0000-0000-0000-000000000002';
  const old = '00000000-0000-0000-0000-000000000003';
  store.set('subwave-receipts-v1', JSON.stringify([old]));
  const restoreWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const restoreStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'https://station-a.test' }, dispatchEvent: () => true,
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value),
  } });
  t.after(() => {
    for (const [key, descriptor] of [['window', restoreWindow], ['localStorage', restoreStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const local = originForStation('https://station-a.test');
  const remote = originForStation('https://station-b.test/');
  const sent: Array<[string, string | undefined]> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push([url, init.method]);
    return Response.json({ success: true, phase: 'queued' });
  });
  rememberReceipt('/api', a);
  rememberReceipt(remote.apiUrl, b);
  for (const origin of [local, remote]) {
    const client = createStationClient(origin);
    for (const id of receiptIds(origin.apiUrl)) await client.requestStatus(id);
  }
  assert.deepEqual(sent, [[`${local.apiUrl}/request/${a}`, 'GET'], [`${remote.apiUrl}/request/${b}`, 'GET']]);
  assert.equal(remote.roomUrl, 'https://station-b.test/room');
  forgetReceipt(local.apiUrl, a);
  assert.deepEqual(receiptIds('/api'), []);
  assert.deepEqual(receiptIds(remote.apiUrl), [b]);
});

const track = (id: string): SavedTrack => ({ id, title: `Track ${id}`, artist: 'Band', album: 'Record', airedAt: '2026-11-18' });

test('bookmarks round-trip, preserve existing metadata and report preview counts', () => {
  const exported = [track('a'), track('b')];
  const imported = planBookmarkImport([], readBookmarkExport(JSON.stringify(exported)));
  assert.equal(imported.added, 2);
  assert.deepEqual(imported.rows, exported);

  const current = Array.from({ length: 499 }, (_, n) => track(String(n)));
  const plan = planBookmarkImport(current, [track('b'), { ...track('0'), album: 'Other' }, null, track('a'), track('b')]);
  assert.deepEqual([plan.added, plan.duplicates, plan.invalid, plan.overflow], [1, 2, 1, 1]);
  assert.deepEqual(plan.rows, [...current, track('b')]);
  assert.equal(planBookmarkImport(imported.rows, exported).added, 0);
  assert.throws(() => readBookmarkExport('{}'));
});

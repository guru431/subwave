// A track leaves the mixer queue before the now-playing watcher sees it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { queue } from '../src/broadcast/queue.js';

test('reconciliation preserves a newly aired request until the metadata watcher handles it', async (t) => {
  const onAir = {
    track: { id: 'on-air', title: 'A', artist: 'Artist' },
    sent: true, confirmedInLiquidsoap: true, requestedBy: 'listener', introText: 'Your request',
  } as any;
  const stale = { track: { id: 'stale', title: 'C' }, sent: true, confirmedInLiquidsoap: true } as any;
  const next = { track: { id: 'next', title: 'B' }, sent: true, confirmedInLiquidsoap: true } as any;
  queue.upcoming = [onAir, stale, next];
  t.after(() => { queue.upcoming = []; });
  t.mock.method(queue, 'persist', () => {});
  t.mock.method(queue, 'log', () => {});
  const read = t.mock.method(queue, 'readNowPlayingFromDisk', async () => ({
    subsonic_id: 'on-air', title: 'A', artist: 'Artist',
  }));
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter() as any;
    socket.setTimeout = () => socket;
    socket.end = () => socket;
    socket.destroy = () => socket;
    socket.write = (command: string) => queueMicrotask(() => socket.emit('data', Buffer.from(
      command.startsWith('dj_queue.queue') ? '12\r\nEND\r\n' : 'subsonic_id="next"\r\nEND\r\n',
    )));
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  await queue.reconcileWithDjQueue();
  assert.deepEqual(queue.upcoming, [onAir, next]);
  assert.equal(queue.upcoming[0], onAir, 'keep the original request and intro bookkeeping');

  // Once the current marker no longer names the request, normal stale-item
  // cleanup must still work with the very same mixer snapshot.
  read.mock.mockImplementation(async () => null);
  await queue.reconcileWithDjQueue();
  assert.deepEqual(queue.upcoming, [next]);
});

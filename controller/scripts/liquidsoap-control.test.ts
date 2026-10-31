// The telnet response must finish before queue reconciliation can trust it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { getDjQueueIds, sendCommand } from '../src/broadcast/liquidsoap-control.js';

test('a truncated telnet reply rejects instead of publishing a partial queue', async (t) => {
  const socket = new EventEmitter() as any;
  socket.setTimeout = () => socket;
  socket.write = () => {
    queueMicrotask(() => {
      socket.emit('data', Buffer.from('12 34\r\n'));
      socket.emit('close');
    });
  };
  socket.end = () => socket;
  socket.destroy = () => socket;
  t.mock.method(net, 'createConnection', () => {
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  await assert.rejects(sendCommand('dj_queue.queue'), /incomplete.*response/i);
});

test('a complete telnet reply strips END and ignores the following close', async (t) => {
  const socket = new EventEmitter() as any;
  socket.setTimeout = () => socket;
  socket.write = () => {
    queueMicrotask(() => {
      socket.emit('data', Buffer.from('12 34\r\nE'));
      socket.emit('data', Buffer.from('ND\r\n'));
      socket.emit('close');
    });
  };
  socket.end = () => socket;
  socket.destroy = () => socket;
  t.mock.method(net, 'createConnection', () => {
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  assert.equal(await sendCommand('dj_queue.queue'), '12 34');
});

test('an incomplete metadata read cannot become a cached partial queue snapshot', async (t) => {
  let truncated = true;
  let snapshots = 0;
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter() as any;
    socket.setTimeout = () => socket;
    socket.end = () => socket;
    socket.destroy = () => socket;
    socket.write = (command: string) => queueMicrotask(() => {
      let reply: string;
      if (command.startsWith('dj_queue.queue')) {
        snapshots++;
        reply = '12 34\r\nEND\r\n';
      } else {
        reply = command.includes('12') ? 'subsonic_id="first"\r\n' : 'subsonic_id="second"\r\n';
        if (!truncated || command.includes('34')) reply += 'END\r\n';
      }
      socket.emit('data', Buffer.from(reply));
      socket.emit('close');
    });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  await assert.rejects(getDjQueueIds(), /incomplete.*response/i);
  truncated = false;
  assert.deepEqual(await getDjQueueIds(), new Set(['first', 'second']));
  assert.equal(snapshots, 2, 'the failed snapshot must not be cached');
});

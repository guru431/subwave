import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { QueueItem } from '../src/broadcast/queue/types.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-track-markers-'));
process.env.STATE_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');
const { readReceipt, saveReceipt } = await import('../src/broadcast/request-receipts.js');
const NOW = Date.parse('2026-11-18T12:00:00Z');
const song = { id: 'studio', title: 'Song', artist: 'Artist', duration: 300 };
const marker = { title: song.title, artist: song.artist, subsonic_id: song.id };

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  t.mock.method(queue, 'persist', () => {});
  t.mock.method(queue, 'persistRecentPlays', () => {});
  t.mock.method(queue, 'drainToLiquidsoap', async () => {});
  t.mock.method(queue, 'reconcileWithDjQueue', async () => {});
  t.mock.method(queue, 'airPendingVoice', async () => {});
  t.mock.method(queue, 'airIntro', async () => {});
  t.mock.method(queue, '_considerIdRotationRecovery', async () => {});
  queue.autoPick = false;
  queue.autoLink = false;
  queue.current = null;
  queue.upcoming = [];
  queue.history = [];
  queue.lastSeenKey = null;
  queue._tracksSinceJingle = 0;
});

test('a new start of the same song advances the queue once', () => {
  queue.upcoming = [{ track: song, sent: true }, { track: song, sent: true }];
  const first = { ...marker, timestamp: NOW / 1000 - 150 };
  const second = { ...marker, timestamp: NOW / 1000 };
  queue.onTrackStarted(first);
  queue.onTrackStarted(first);
  assert.equal(queue.upcoming.length, 1);
  queue.onTrackStarted(second);
  queue.onTrackStarted(second);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(queue._tracksSinceJingle, 2);
  assert.equal(queue.history.length, 1);
});

test('a stem clip and its cue-in count as one occurrence across restart', () => {
  const item = { track: song, sent: false, playId: 'clip-and-track' };
  queue.upcoming = [item];
  const clip = { ...marker, subwave_play_id: item.playId, subwave_clip: '1', timestamp: NOW / 1000 - 10 };
  queue.onTrackStarted(clip);
  assert.deepEqual(queue.upcoming, [item], 'the clip cannot consume the unsent song');
  item.sent = true;
  queue.onTrackStarted(clip);
  const live = queue.current;
  assert.equal(queue._tracksSinceJingle, 1);
  assert.equal(live?.startedAt, new Date(NOW - 10_000).toISOString());
  writeFileSync(config.queue.file, JSON.stringify({ current: live, tracksSinceJingle: 1 }));
  queue.recover();
  queue.onTrackStarted({ ...clip, subwave_clip: '', timestamp: NOW / 1000 });
  assert.equal(queue._tracksSinceJingle, 1);
  assert.equal(queue.current?.startedAt, live?.startedAt);
});

test('the occurrence token identifies the real airing when a duplicate was missed', () => {
  queue.upcoming = [
    { track: song, sent: true, playId: 'missed' },
    { track: song, sent: true, playId: 'heard' },
  ];
  queue.onTrackStarted({ ...marker, subwave_play_id: 'heard', timestamp: NOW / 1000 });
  assert.equal(queue.current?.playId, 'heard');
  assert.deepEqual(queue.upcoming, []);
});

test('legacy mixer markers can identify the rendered clip by its filename', () => {
  const clipPath = '/state/transitions/previous-studio.wav';
  queue.current = {
    track: { ...song, id: 'previous' },
    stemBlend: { clipPath, blendStartSec: 180, inCueSec: 10 },
  };
  queue.upcoming = [{ track: song, sent: true, stemSeam: true }];
  queue.onTrackStarted({ ...marker, filename: clipPath, timestamp: NOW / 1000 - 10 });
  queue.onTrackStarted({ ...marker, filename: 'studio.mp3', timestamp: NOW / 1000 });
  assert.equal(queue.current?.startedAt, new Date(NOW - 10_000).toISOString());
  assert.equal(queue._tracksSinceJingle, 1);
});

test('different IDs do not consume the request even when labels match', () => {
  saveReceipt('studio-version', { phase: 'queued', track: song });
  const item = { track: song, sent: true, requestId: 'studio-version' };
  queue.upcoming = [item];
  queue.onTrackStarted({ ...marker, subsonic_id: 'live', timestamp: NOW / 1000 - 180 });
  assert.equal(queue.current?.track.id, 'live');
  assert.equal(queue.current?.startedAt, new Date(NOW - 180_000).toISOString());
  assert.deepEqual(queue.upcoming, [item]);
  assert.equal(readReceipt('studio-version')?.phase, 'queued');
});

test('legacy label-only markers can confirm a sent request, never an unsent request', () => {
  const unsent = { track: song, sent: false };
  const sent = { track: song, sent: true };
  queue.upcoming = [unsent, sent];
  queue.onTrackStarted({ title: song.title, artist: song.artist });
  assert.equal(queue.current?.source, 'request');
  assert.equal(queue.current?.startedAt, new Date(NOW).toISOString());
  assert.deepEqual(queue.upcoming, [unsent]);
});

test('restart restores old manual items and uses the pending start timestamp', () => {
  saveReceipt('restart-air', { phase: 'queued', track: song });
  const queuedAt = new Date(NOW - 3 * 3600_000).toISOString();
  const sent: QueueItem = { track: song, requestId: 'restart-air', sent: true, queuedAt };
  const tail: QueueItem = { track: { ...song, id: 'tail' }, sent: false, operator: true, queuedAt };
  const stalePick: QueueItem = { track: { ...song, id: 'old-auto' }, sent: false, aiPicked: true, queuedAt };
  writeFileSync(config.queue.file, JSON.stringify({ upcoming: [sent, tail, stalePick] }));
  queue.recover();
  assert.deepEqual(queue.upcoming, [sent, tail]);
  queue.onTrackStarted({ ...marker, timestamp: NOW / 1000 - 180 });
  assert.equal(queue.remainingSecOnAir(), 120);
  assert.equal(readReceipt('restart-air')?.airedAt, new Date(NOW - 180_000).toISOString());
  assert.deepEqual(queue.upcoming, [tail]);
});

test('confirmed mixer audio failure survives slow resolution and receipt reload', async () => {
  const id = 'unplayable';
  saveReceipt(id, { phase: 'queued', track: song });
  const item = { track: song, requestId: id, sent: true };
  queue.upcoming = [item];
  queue.onPushResolveFailed(item);
  assert.equal(readReceipt(id)?.phase, 'failed');
  const cause = readReceipt(id)?.message;
  assert.ok(cause);
  saveReceipt(id, { phase: 'queued', message: null, ack: 'Late acknowledgement' });
  const reloaded = await import(new URL('../src/broadcast/request-receipts.js?reload=1', import.meta.url).href);
  assert.equal(reloaded.readReceipt(id)?.message, cause);
  assert.deepEqual(queue.upcoming, []);
});

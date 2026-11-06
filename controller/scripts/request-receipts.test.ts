import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('receipt survives reload, follows its queue occurrence, and marks only real playback once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-test-'));
  process.env.STATE_DIR = dir;
  process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T12:00:00Z') });
  const receipts = await import('../src/broadcast/request-receipts.js');
  const settings = await import('../src/settings.js');
  const library = await import('../src/music/library.js');
  const db = await import('../src/music/library-db.js');
  const { queue: q } = await import('../src/broadcast/queue.js');
  try {
    await settings.update({ tts: { enabled: false }, llm: { pickerAgent: false } } as never);
    await library.load();
    receipts.saveReceipt('receipt-1', { phase: 'accepted' });
    q.autoPick = false; q.autoLink = false;
    q.persist = () => {};
    q.drainToLiquidsoap = async () => {};
    q.airPendingVoice = async () => {};
    q.airIntro = async () => {};
    const song = { id: 'song', artist: 'Кино', title: 'Звезда', album: 'Альбом', duration: 240 };
    await q.push({ track: song, requestedBy: 'listener', requestId: 'receipt-1' });
    assert.equal(receipts.readReceipt('receipt-1')?.phase, 'queued');
    assert.equal(q.upcoming[0].requestId, 'receipt-1');
    assert.equal(JSON.stringify(q.snapshot()).includes('receipt-1'), false, 'capability must stay private');
    q.upcoming[0].sent = true;
    const fresh = await import(new URL('../src/broadcast/request-receipts.js?restart=1', import.meta.url).href);
    assert.equal(fresh.readReceipt('receipt-1')?.phase, 'queued');
    q.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist, timestamp: Date.now() / 1000 });
    const aired = receipts.readReceipt('receipt-1');
    assert.equal(aired?.phase, 'aired');
    q.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist, timestamp: Date.now() / 1000 });
    receipts.saveReceipt('receipt-1', { phase: 'queued', ack: 'slow acknowledgement' });
    assert.equal(receipts.readReceipt('receipt-1')?.airedAt, aired?.airedAt);
    assert.equal(receipts.readReceipt('receipt-1')?.phase, 'aired');
    assert.equal(receipts.readReceipt('receipt-1', Date.now() + 8 * 24 * 3600_000), null);
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

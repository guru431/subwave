// Fork (C06): noRepeatWindow goes up to 2000 distinct tracks (≈5.5 days of air
// at ~360 tracks a day), but recover() used to drop every sidecar row older
// than 96h on boot — ~1440 rows. After each restart the hard count guard could
// not see the oldest part of its window, and tracks from 4–5 days back were
// free to repeat for about a day. The sidecar is bounded by recentPlaysMax
// (count), so the boot load keeps what the count allows.
// Run: npm test -- recent-plays-boot

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-recent-plays-boot-'));

const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');

(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

const STEP_MS = 4 * 60_000;
const now = Date.now();
const plays = Array.from({ length: 2000 }, (_, i) => ({
  id: `t-${i}`, title: `Track ${i}`, artist: `Artist ${i % 300}`,
  endedAt: new Date(now - i * STEP_MS).toISOString(),
}));
writeFileSync(config.queue.recentPlaysFile, JSON.stringify(plays));

queue.recover();

test('a full 2000-track window survives a restart', () => {
  assert.equal((queue as any)._recentPlays.length, 2000);
  assert.equal(queue.recentlyPlayedByCount(2000).ids.size, 2000);
});

test('the oldest row (≈5.5 days back) is still in the window', () => {
  assert.ok(queue.recentlyPlayedByCount(2000).ids.has('t-1999'));
});

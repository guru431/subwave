// Fork: listeners.jsonl gets one row a minute and nothing ever trims it
// (~22 MB a year at the station), yet history() parsed the whole file on every
// GET /listeners — the stats page polls it every 30 s. It now reads only the
// tail the window can occupy; the rows are appended in time order.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-listeners-tail-'));
process.env.STATE_DIR = stateDir;
const { history } = await import('../src/broadcast/listeners.js');

const MIN = 60_000;
const now = Date.now();
const row = (ms: number, count: number) => JSON.stringify({ t: new Date(ms).toISOString(), count });

// 20 000 minutes of history (~2 weeks), newest last, as the poller writes it.
const rows = Array.from({ length: 20_000 }, (_, i) => ({ ms: now - (20_000 - i) * MIN, count: i % 7 }));

function writeHistory(head: string[] = []) {
  writeFileSync(join(stateDir, 'listeners.jsonl'),
    [...head, ...rows.map((r) => row(r.ms, r.count))].join('\n') + '\n');
}

test('a window returns exactly the rows a whole-file read would', async () => {
  writeHistory();
  for (const minutes of [5, 100, 1440, 7 * 1440]) {
    const since = new Date(now - minutes * MIN);
    const expected = rows
      .filter((r) => r.ms >= since.getTime())
      .map((r) => ({ t: new Date(r.ms).toISOString(), count: r.count }));
    assert.deepEqual(await history({ since }), expected, `${minutes}-minute window`);
  }
});

test('the head of a long file is never parsed', async () => {
  // A row at the very start stamped inside the window: a whole-file read
  // returns it, a tail read never reaches it (rows are in time order).
  writeHistory([row(now - MIN / 2, 999)]);
  const got = await history({ since: new Date(now - 100 * MIN) });
  assert.equal(got.some((s) => s.count === 999), false);
  assert.equal(got.length, 100);
});

test('a file shorter than the window is read whole', async () => {
  writeFileSync(join(stateDir, 'listeners.jsonl'), `${row(now - 3 * MIN, 1)}\n${row(now - MIN, 2)}\n`);
  assert.deepEqual((await history({ since: new Date(now - 7 * 1440 * MIN) })).map((s) => s.count), [1, 2]);
});

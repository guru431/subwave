// Fork (C03): settings.queue.lookahead survives a controller restart.
//
// settings.load() composes each section explicitly and does not spread
// DEFAULTS, so a block missing from that composition still validates, saves
// and works for the rest of the process — then silently reverts on the next
// cold load (controller/CLAUDE.md: #1317, #1327). For queue depth that revert
// is quiet in the worst way: the station drops back to depth 1 and nothing in
// the logs says so. Hence a COLD-LOAD round trip, plus the normalisation of a
// hand-edited value (pinned as it is, not as it might be) and the GET /settings
// read-back that `onboard.py --patch` verifies against.
//
// Run: npm test -- queue-settings-cold-load

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-queue-cold-load-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// A hand-written settings.json, read the way a controller restart reads it.
async function coldLoad(stored: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  return (settings.get() as any).queue?.lookahead;
}

test('a saved queue depth survives a controller restart', async () => {
  await coldLoad({});
  await settings.update({ queue: { lookahead: 5 } } as never);
  assert.equal((settings.get() as any).queue.lookahead, 5, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal((settings.get() as any).queue.lookahead, 5, 'and survives the restart');
});

test('a stored depth is rounded, and anything out of range or not a number is the default', async () => {
  assert.equal(await coldLoad({ queue: { lookahead: 2.7 } }), 3);
  assert.equal(await coldLoad({ queue: { lookahead: 0 } }), 1);
  assert.equal(await coldLoad({ queue: { lookahead: 11 } }), 1);
  // A string is not a number — the load path does not coerce it.
  assert.equal(await coldLoad({ queue: { lookahead: '5' } }), 1);
  // Absent (a settings.json written before the fork) → upstream's depth.
  assert.equal(await coldLoad({}), 1);
});

test('GET /settings reads the depth back after a restart', async () => {
  const express = (await import('express')).default;
  const { router } = await import('../src/routes/settings/core.js');
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  after(() => new Promise<void>(resolve => server.close(() => resolve())));

  await coldLoad({ queue: { lookahead: 5 } });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/settings`, {
    headers: { authorization: `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}` },
  });
  const body = await res.json() as { values?: { queue?: { lookahead?: number } } };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.values?.queue?.lookahead, 5);
});

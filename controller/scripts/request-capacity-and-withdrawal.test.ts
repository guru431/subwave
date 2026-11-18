import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'subwave-request-capacity-'));
process.env.STATE_DIR = dir;
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';
after(() => rmSync(dir, { recursive: true, force: true }));

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/request.js');
const fetchHttp = globalThis.fetch;

test('acceptance reserves capacity, and a private withdrawal frees only its own queued slot', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T12:00:00Z') });
  t.mock.method(queue, 'persist', () => {});
  t.mock.method(queue, 'drainToLiquidsoap', async () => {});
  await settings.update({
    requests: { enabled: true, onePendingPerIp: true, maxPending: 1, cooldownSec: 5 },
    tts: { enabled: false },
  } as never);

  const searchStarted = Promise.withResolvers<void>();
  const releaseSearch = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname !== '/rest/getSong.view' && url.pathname !== '/rest/getSong') {
      return new Response('offline fixture', { status: 503 });
    }
    const id = url.searchParams.get('id')!;
    if (id === 'missing') {
      searchStarted.resolve();
      await releaseSearch.promise;
      return Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70 } } });
    }
    return Response.json({ 'subsonic-response': {
      status: 'ok', version: '1.16.1', song: { id, title: `Title ${id}`, artist: 'Artist', duration: 300 },
    } });
  });

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    releaseSearch.resolve();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/request`;
  function submit(songId: string, client: number) {
    return fetchHttp(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${client}` },
      body: JSON.stringify({ text: `Title ${songId}`, songId }),
    });
  }
  const receipt = (id: string, method = 'GET') => fetchHttp(`${base}/${id}`, { method });
  async function waitForResolution(id: string) {
    for (let i = 0; i < 40; i++) {
      const response = await receipt(id);
      const body = await response.json() as { phase: string; canCancel?: boolean };
      if (body.phase !== 'accepted' && body.phase !== 'searching') return body;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('request did not resolve');
  }

  const first = await submit('missing', 1);
  assert.equal(first.status, 202);
  await searchStarted.promise;
  assert.equal(queue.upcoming.length, 0);
  assert.equal((await submit('concurrent', 2)).status, 429);
  releaseSearch.resolve();
  assert.equal((await waitForResolution((await first.json() as { requestId: string }).requestId)).phase, 'failed');
  assert.equal(queue.pendingListenerRequests(), 0);

  const accepted = await submit('recording', 3);
  assert.equal(accepted.status, 202);
  const { requestId } = await accepted.json() as { requestId: string };
  const status = await waitForResolution(requestId);
  assert.equal(status.phase, 'queued');
  assert.equal(status.canCancel, true);
  assert.equal(queue.pendingListenerRequests(), 1, 'queued item replaces its reservation');
  const own = queue.upcoming[0];
  const operator = { track: own.track, sent: false, operator: true, requestedBy: 'studio' };
  queue.upcoming.unshift(operator);
  assert.equal((await receipt('unknown-capability', 'DELETE')).status, 404);
  queue._drainingItem = own;
  const tooLate = await receipt(requestId, 'DELETE');
  assert.equal(tooLate.status, 409);
  assert.equal((await tooLate.json() as { canCancel: boolean }).canCancel, false);
  queue._drainingItem = null;

  // Model a crash before the debounced queue snapshot has dropped the item.
  writeFileSync(config.queue.file, JSON.stringify({ upcoming: queue.upcoming }));
  const applied = await receipt(requestId, 'DELETE');
  assert.equal(applied.status, 200);
  const withdrawn = await applied.json() as { phase: string; cancelledByListener: boolean };
  assert.equal(withdrawn.phase, 'removed');
  assert.equal(withdrawn.cancelledByListener, true);
  assert.deepEqual(queue.upcoming, [operator]);
  assert.equal(queue.pendingListenerRequests(), 0);
  queue.recover();
  assert.deepEqual(queue.upcoming, [operator]);
  const repeated = await receipt(requestId, 'DELETE');
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), withdrawn);
  t.mock.timers.tick(5_000);
  const replacement = await submit('replacement', 3);
  assert.equal(replacement.status, 202, 'normal cooldown is the only remaining wait');
  const replacementId = (await replacement.json() as { requestId: string }).requestId;
  assert.equal((await waitForResolution(replacementId)).phase, 'queued');
});

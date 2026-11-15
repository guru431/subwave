import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('controller review input and persistence regressions', { timeout: 30_000 }, async t => {
  const state = mkdtempSync(join(tmpdir(), 'controller-review-'));
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let library: typeof import('../src/music/library.js') | undefined;
  process.env.STATE_DIR = state;
  process.env.TTS_HEAVY_URL = '';
  try {
    writeFileSync(join(state, 'likes.json'), JSON.stringify({
      secret: 'fixture',
      likes: ['liked', 'unindexed'].map(songId => ({ songId,
        track: { id: songId, title: 'Old title', duration: 220 },
        airingKey: `${songId}|operator`, listenerKey: 'operator', via: 'operator',
        likedAt: '2026-01-01T12:00:00Z' })),
    }));
    const settings = await import('../src/settings.js');
    library = await import('../src/music/library.js');
    const db = await import('../src/music/library-db.js');
    await settings.load();
    await t.test('a nonpositive deep-cut limit cannot select a track', async () => {
      await library!.load();
      db.upsertTrackMeta('liked', { title: 'Fresh title', duration: 330 });
      for (const limit of [0, -1, 0.5, NaN]) {
        assert.deepEqual(db.deepCutTracks('2026-01-01T00:00:00Z', limit), [], `limit=${limit}`);
      }
      assert.equal(db.deepCutTracks('2026-01-01T00:00:00Z', 1).length, 1);
    });

    await t.test('liked tracks use refreshed indexed duration and retain the snapshot fallback', async () => {
      await library!.load();
      db.upsertTrackMeta('liked', { title: 'Fresh title', duration: 330 });
      const { router } = await import('../src/routes/library.js');
      const handle = router.stack.find(layer => layer.route?.path === '/library/liked')!.route!.stack.at(-1)!.handle;
      let response: any;
      const res = { status(code: number) { assert.equal(code, 200); return this; }, json(body: unknown) { response = body; } };
      await handle({ query: {} } as never, res as never, (() => {}) as never);
      assert.equal(response.rows.find((row: { id: string }) => row.id === 'liked').title, 'Fresh title');
      assert.equal(response.rows.find((row: { id: string }) => row.id === 'liked').duration, 330);
      assert.equal(response.rows.find((row: { id: string }) => row.id === 'unindexed').duration, 220);
    });

    await t.test('malformed Kokoro and Chatterbox blocks are rejected without changing settings', async () => {
      const before = structuredClone(settings.get().tts);
      for (const engine of ['kokoro', 'chatterbox']) {
        for (const value of [null, [], 'voice']) {
          await assert.rejects(settings.update({ tts: { [engine]: value } }), new RegExp(`tts\\.${engine} must be an object`));
          assert.deepEqual(settings.get().tts, before);
        }
      }
      await settings.update({ tts: { kokoro: {}, chatterbox: {} } });
      assert.deepEqual(settings.get().tts, before);
    });

    await t.test('failed jingle publication leaves neither a final WAV nor an atomic temp', async t => {
      const jingles = await import('../src/broadcast/jingles.js');
      const failure = t.mock.method(fsPromises, 'rename', async () => {
        assert.equal(readdirSync(join(state, 'jingles')).includes('fixture.wav'), false);
        throw new Error('rename fixture failed');
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(jingles.adopt(Buffer.from('fixture'), { filename: 'fixture.wav' }), /rename fixture failed/);
        assert.deepEqual(readdirSync(join(state, 'jingles')), []);
      } finally {
        failure.mock.restore();
        syncBuiltinESMExports();
      }
    });

    await t.test('the probe resolves redacted header names without case sensitivity on both legs', async () => {
      await settings.update({ llm: {
        provider: 'openai-compatible', baseUrl: 'https://primary.example/v1', model: 'fixture',
        headers: { 'X-Route-Key': 'primary-value' },
        fallback: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://backup.example/v1',
          model: 'fixture', headers: { 'X-Route-Key': 'backup-value' } },
      } });
      const { router } = await import('../src/routes/settings/llm.js');
      const handle = router.stack.find(layer => layer.route?.path === '/settings/llm/probe-compat')!.route!.stack.at(-1)!.handle;
      let sent: Headers | undefined;
      globalThis.fetch = (async (_url, init) => {
        sent = new Headers(init?.headers);
        return new Response(JSON.stringify({
          id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      for (const leg of ['primary', 'backup']) {
        let response: any;
        const req = { body: { apiKey: 'fixture', baseUrl: `https://${leg}.example/v1`, model: 'fixture', headers: { 'x-route-key': 'set' } } };
        await handle(req as never, { json(body: unknown) { response = body; } } as never, (() => {}) as never);
        assert.equal(response.ok, true);
        assert.equal(sent?.get('x-route-key'), `${leg}-value`);
      }
      await settings.update({ llm: {
        headers: { 'x-route-key': 'set' }, fallback: { headers: { 'x-route-key': 'set' } },
      } });
      assert.deepEqual(settings.get().llm.headers, { 'x-route-key': 'primary-value' });
      assert.deepEqual(settings.get().llm.fallback.headers, { 'x-route-key': 'backup-value' });
    });

    await t.test('a receipt storage failure leaves both hourly request budgets available', async () => {
      await settings.update({ llm: { pauseWhenEmpty: false }, requests: { cooldownSec: 5, perIpHourlyCap: 2, globalHourlyCap: 5 } });
      const receipts = await import('../src/broadcast/request-receipts.js');
      const { router } = await import('../src/routes/request.js');
      const { checkGlobalRateLimit } = await import('../src/middleware/ratelimit.js');
      const handle = router.stack.find(layer => layer.route?.path === '/request' && layer.route.methods.post)!.route!.stack.at(-1)!.handle;
      receipts.readReceipt('absent'); // Load the store before making its commit path unwritable.
      const receiptFile = join(state, 'request-receipts.json');
      mkdirSync(receiptFile);
      globalThis.fetch = (async () => new Response('offline fixture', { status: 503 })) as typeof fetch;
      const start = Date.parse('2026-01-01T12:00:00Z');
      try {
        for (let i = 0; i < 7; i++) {
          Date.now = () => start + i * 6_000;
          let status = 200;
          const req = { body: { text: 'Play a song', name: 'Listener' }, headers: { 'x-forwarded-for': '198.51.100.77' }, socket: {} };
          const res = { setHeader() {}, status(code: number) { status = code; return this; }, json() {} };
          await handle(req as never, res as never, (() => {}) as never);
          assert.equal(status, 503, `failed persistence attempt ${i + 1} must not reach an hourly cap`);
          assert.equal(checkGlobalRateLimit().ok, true);
        }
      } finally {
        Date.now = realNow;
        rmSync(receiptFile, { recursive: true });
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    library?.shutdown();
    rmSync(state, { recursive: true, force: true });
  }
});

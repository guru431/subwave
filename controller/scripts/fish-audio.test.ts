// Fish Audio S2.1 provider contract tests. All traffic stays on a loopback mock
// server: no credentials, account calls, or billable synthesis are involved.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { buildFishTtsRequest, listFishVoices, normalizeFishVoices, probeFishKey, shouldRetryFishStatus, synthesizeFish } from '../src/llm/internal/speech/fish-audio.js';

function validMp3Audio(): Buffer {
  // Two structurally valid consecutive MPEG-1 Layer III, 128 kbps, 44.1 kHz
  // frames. Payload bytes are silence-like test data; no decoder or provider
  // call is involved.
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64], 0);
  return Buffer.concat([frame, frame]);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('buildFishTtsRequest maps the S2.1 wire body and preserves expression cues', () => {
  assert.deepEqual(buildFishTtsRequest({
    text: '  [laughing] Hello from the night shift.  ',
    referenceId: 'voice_ref_123',
    temperature: 2,
    topP: -1,
    latency: 'balanced',
    speed: 1.25,
  }), {
    text: '[laughing] Hello from the night shift.',
    reference_id: 'voice_ref_123',
    format: 'mp3',
    temperature: 1,
    top_p: 0,
    latency: 'balanced',
    prosody: { speed: 1.25 },
  });
});

test('Fish retry policy is limited to 429 and 5xx', () => {
  assert.equal(shouldRetryFishStatus(429), true);
  assert.equal(shouldRetryFishStatus(500), true);
  assert.equal(shouldRetryFishStatus(599), true);
  for (const status of [400, 401, 403, 404, 422, 600]) {
    assert.equal(shouldRetryFishStatus(status), false, String(status));
  }
});

test('voice discovery classifies malformed provider JSON without exposing the key', async () => {
  await withServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"interrupted":');
  }, async origin => {
    await assert.rejects(listFishVoices('test-only-key', { origin }), (err: Error) => {
      assert.match(err.message, /Fish Audio voice discovery failed: unparseable response/);
      assert.ok(err.cause instanceof SyntaxError);
      assert.ok(!err.message.includes('test-only-key'));
      return true;
    });
  });
});

test('a failed audio file write cancels the provider body and closes the file', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-write-'));
  let cancelled = false;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(validMp3Audio()); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } }));
  const openMock = t.mock.method(fsPromises, 'open', async () => ({
    write: async () => { throw new Error('disk write fixture'); },
    close: async () => { closed = true; },
  }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(synthesizeFish({ apiKey: 'fixture', text: 'Fixture', referenceId: 'fixture', outPath: path.join(work, 'sample.mp3') }), /disk write fixture/);
    assert.equal(cancelled, true);
    assert.equal(closed, true);
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish retries bounded 429/5xx responses then streams MP3 atomically', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  const bodies: unknown[] = [];
  let calls = 0;
  try {
    await withServer(async (req, res) => {
      calls++;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/tts');
      assert.equal(req.headers.authorization, 'Bearer test-only-key');
      assert.equal(req.headers.model, 's2.1-pro-free');
      assert.match(String(req.headers['content-type']), /^application\/json/);
      bodies.push(await readJson(req));
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ message: 'slow down' }));
      } else if (calls === 2) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'warming up' }));
      } else {
        const frame = validMp3Audio();
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.write(frame.subarray(0, 37));
        res.end(frame.subarray(37));
      }
    }, async origin => {
      const result = await synthesizeFish({
        apiKey: 'test-only-key',
        model: 's2.1-pro-free',
        text: '[whispers] Contract test.',
        referenceId: 'voice-abc',
        temperature: 0.65,
        topP: 0.8,
        latency: 'low',
        speed: 0.9,
        outPath,
      }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 });
      assert.equal(result, outPath);
    });

    assert.equal(calls, 3);
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[2], {
      text: '[whispers] Contract test.',
      reference_id: 'voice-abc',
      format: 'mp3',
      temperature: 0.65,
      top_p: 0.8,
      latency: 'low',
      prosody: { speed: 0.9 },
    });
    assert.deepEqual(await readFile(outPath), validMp3Audio());
    assert.deepEqual(await readdir(work), ['sample.mp3']);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish rejects a successful non-audio response without leaving a file', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  try {
    await withServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'proxy returned JSON under HTTP 200' }));
    }, async origin => {
      await assert.rejects(
        synthesizeFish({
          apiKey: 'test-only-key',
          text: 'Wrong response type.',
          referenceId: 'voice-abc',
          outPath,
        }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 }),
        /Fish Audio returned non-MP3 content \(application\/json\)/,
      );
    });
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish rejects mislabeled or octet-stream junk without leaving a file', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  try {
    for (const contentType of ['audio/mpeg', 'application/octet-stream']) {
      await withServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': contentType });
        res.end(Buffer.from('{"not":"mp3"}'));
      }, async origin => {
        await assert.rejects(
          synthesizeFish({
            apiKey: 'test-only-key',
            text: 'Mislabeled response.',
            referenceId: 'voice-abc',
            outPath,
          }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 }),
          /Fish Audio returned invalid MP3 audio/,
        );
      });
    }
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish honours caller cancellation without leaving a partial file', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  try {
    await withServer(async (req, res) => {
      req.resume();
      await new Promise(resolve => setTimeout(resolve, 100));
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('ID3cancelled'));
    }, async origin => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10);
      await assert.rejects(
        synthesizeFish({
          apiKey: 'test-only-key',
          text: 'Cancelled preview.',
          referenceId: 'voice-abc',
          outPath,
        }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000, signal: ctrl.signal }),
        err => err instanceof DOMException && err.name === 'AbortError',
      );
    });
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish does not retry 4xx failures or leak the API key', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  let calls = 0;
  try {
    await withServer(async (req, res) => {
      calls++;
      await readJson(req);
      res.writeHead(401, { 'content-type': 'application/json' });
      // Defensive case: a broken proxy reflects credential material in its
      // error body. The adapter must redact it before constructing an Error.
      res.end(JSON.stringify({ message: 'invalid token: never-print-this-secret' }));
    }, async origin => {
      await assert.rejects(
        synthesizeFish({
          apiKey: 'never-print-this-secret',
          text: 'No retry.',
          referenceId: 'voice-abc',
          outPath,
        }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 }),
        err => {
          assert(err instanceof Error);
          assert.match(err.message, /Fish Audio TTS failed \(401\): invalid token: \[redacted\]/);
          assert.doesNotMatch(err.message, /never-print-this-secret/);
          return true;
        },
      );
    });
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('synthesizeFish redacts reflected secrets before truncating long provider errors', async () => {
  const apiKey = 'boundary-secret-abcdef';
  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `${'x'.repeat(495)}${apiKey}` }));
  }, async origin => {
    await assert.rejects(
      synthesizeFish({
        apiKey,
        text: 'Boundary redaction.',
        referenceId: 'voice-abc',
      }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 }),
      err => {
        assert(err instanceof Error);
        assert.doesNotMatch(err.message, /boundary|secret|abcdef/);
        assert.match(err.message, /\[reda/);
        return true;
      },
    );
  });
});

test('synthesizeFish exhausts its bounded retry budget without leaving a partial file', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  let calls = 0;
  try {
    await withServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'still unavailable' }));
    }, async origin => {
      await assert.rejects(synthesizeFish({
        apiKey: 'test-only-key',
        text: 'Retry budget.',
        referenceId: 'voice-abc',
        outPath,
      }, { origin, retryDelaysMs: [0, 0], timeoutMs: 5_000 }), /Fish Audio TTS failed \(500\)/);
    });
    assert.equal(calls, 3);
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('listFishVoices honours caller cancellation', async () => {
  await withServer(async (_req, res) => {
    await new Promise(resolve => setTimeout(resolve, 100));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 0, has_more: false, items: [] }));
  }, async origin => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(
      listFishVoices('discovery-key', { origin, timeoutMs: 5_000, signal: ctrl.signal }),
      err => err instanceof DOMException && err.name === 'AbortError',
    );
  });
});

test('probeFishKey uses documented, non-billable account discovery and redacts failures', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer probe-key');
    const url = new URL(req.url || '/', 'http://localhost');
    assert.equal(url.pathname, '/model');
    assert.equal(url.searchParams.get('self'), 'true');
    assert.equal(url.searchParams.get('page_size'), '1');
    assert.equal(url.searchParams.get('page_number'), '1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 0, has_more: false, items: [] }));
  }, async origin => {
    await probeFishKey('probe-key', { origin, timeoutMs: 5_000 });
  });

  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'rejected probe-secret' }));
  }, async origin => {
    await assert.rejects(
      probeFishKey('probe-secret', { origin, timeoutMs: 5_000 }),
      err => {
        assert(err instanceof Error);
        assert.match(err.message, /rejected \[redacted\]/);
        assert.doesNotMatch(err.message, /probe-secret/);
        return true;
      },
    );
  });
});

test('normalizeFishVoices keeps trained TTS voices and listFishVoices uses account discovery', async () => {
  const payload = {
    total: 4,
    has_more: false,
    items: [
      { _id: 'voice-1', type: 'tts', state: 'trained', title: 'Night Host', description: 'Warm late-night delivery' },
      { _id: 'voice-2', type: 'tts', state: 'trained', title: '', languages: ['en', 'ja'] },
      { _id: 'voice-3', type: 'tts', state: 'training', title: 'Not ready' },
      { _id: 'asr-1', type: 'asr', state: 'trained', title: 'Wrong type' },
    ],
  };
  assert.deepEqual(normalizeFishVoices(payload), [
    { id: 'voice-1', label: 'Night Host', hint: 'Warm late-night delivery' },
    { id: 'voice-2', label: 'voice-2', hint: 'en, ja' },
  ]);

  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer discovery-key');
    const url = new URL(req.url || '/', 'http://localhost');
    assert.equal(url.pathname, '/model');
    assert.equal(url.searchParams.get('self'), 'true');
    assert.equal(url.searchParams.get('page_size'), '100');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, async origin => {
    assert.deepEqual(await listFishVoices('discovery-key', { origin, timeoutMs: 5_000 }), [
      { id: 'voice-1', label: 'Night Host', hint: 'Warm late-night delivery' },
      { id: 'voice-2', label: 'voice-2', hint: 'en, ja' },
    ]);
  });
});

test('synthesizeFish aborted during a retry backoff rejects without waiting it out', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-fish-'));
  const outPath = path.join(work, 'sample.mp3');
  let calls = 0;
  try {
    await withServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'flaky' }));
    }, async origin => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 25);
      const started = Date.now();
      await assert.rejects(
        synthesizeFish({
          apiKey: 'test-only-key',
          text: 'Abort mid-backoff.',
          referenceId: 'voice-abc',
          outPath,
        }, { origin, retryDelaysMs: [1_000], timeoutMs: 5_000, signal: ctrl.signal }),
        err => err instanceof DOMException && err.name === 'AbortError',
      );
      // The 1s backoff never elapses — the sleep observes the abort signal
      // instead of letting a discarded preview line up one more attempt.
      assert.ok(Date.now() - started < 900, 'aborted rejection waited out the backoff');
    });
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('listFishVoices stops at its page ceiling when a server never runs dry', async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // has_more stays true forever and every item is filtered out (still in
    // training), so only the internal page cap can end discovery.
    res.end(JSON.stringify({
      total: 100_000,
      has_more: true,
      items: [{ _id: `pending-${calls}`, type: 'tts', state: 'training', title: 'Not ready' }],
    }));
  }, async origin => {
    assert.deepEqual(await listFishVoices('discovery-key', { origin, timeoutMs: 5_000 }), []);
  });
  assert.equal(calls, 10); // MAX_PAGES in fish-audio.ts
});

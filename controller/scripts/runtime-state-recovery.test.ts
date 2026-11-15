import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const localTmp = fileURLToPath(new URL('../../.tmp/', import.meta.url));
mkdirSync(localTmp, { recursive: true });
const state = mkdtempSync(join(localTmp, 'runtime-recovery-'));
process.env.STATE_DIR = state;
const { config } = await import('../src/config.js');
const receipts = await import('../src/broadcast/request-receipts.js');
const markers = await import('../src/broadcast/queue/voice-marker.js');
const archives = await import('../src/broadcast/archives.js');
const session = await import('../src/broadcast/session.js');
const voices = await import('../src/audio/voice-library.js');

after(() => {
  markers.resetVoiceMarkers();
  rmSync(state, { recursive: true, force: true });
});

test('invalid receipts are preserved and a fresh store remains usable', () => {
  const file = join(state, 'request-receipts.json');
  writeFileSync(file, '{"interrupted":');
  assert.equal(receipts.readReceipt('old'), null);
  const quarantined = readdirSync(state).find(name => name.startsWith('request-receipts.json.corrupt-'));
  assert.ok(quarantined);
  assert.equal(readFileSync(join(state, quarantined), 'utf8'), '{"interrupted":');
  receipts.saveReceipt('new', { phase: 'accepted' }, 1000);
  assert.equal(receipts.readReceipt('new', 1000)?.phase, 'accepted');
});

test('concurrent consumers of a voice marker receive the same air time', async () => {
  writeFileSync(config.liquidsoap.voicePlayingFile, '{}');
  const first = markers.awaitVoiceAir('shared-voice', 60_000);
  const second = markers.awaitVoiceAir('shared-voice', 60_000);
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: 'shared-voice', startedAt: 100 }));
  markers.pollVoiceMarker();
  // Reset makes an accidentally stranded first waiter settle immediately.
  markers.resetVoiceMarkers();
  assert.deepEqual(await Promise.all([first, second]), [100_000, 100_000]);
});

test('all consumers also receive a marker that arrived before registration', async () => {
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: 'already-aired', startedAt: 200 }));
  markers.pollVoiceMarker();
  const first = markers.awaitVoiceAir('already-aired', 60_000);
  const second = markers.awaitVoiceAir('already-aired', 60_000);
  markers.resetVoiceMarkers();
  assert.deepEqual(await Promise.all([first, second]), [200_000, 200_000]);
});

test('archive downloads resolve real paths on the current platform and reject escapes', () => {
  const rel = '2026-01-01/01-00.mp3';
  const target = join(state, 'archive', rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'fixture');
  assert.equal(archives.resolveEntry(rel), target);
  assert.equal(archives.resolveEntry('../01-00.mp3'), null);
  assert.equal(archives.resolveEntry('2026-01-01/../../01-00.mp3'), null);
});

test('heavy TTS deadlines include a stalled response body', async () => {
  const { speakRemote } = await import('../src/audio/ttsHeavyClient.js');
  const original = { url: config.ttsHeavy.url, requestTimeoutMs: config.ttsHeavy.requestTimeoutMs };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  config.ttsHeavy.url = `http://127.0.0.1:${address.port}`;
  config.ttsHeavy.requestTimeoutMs = 50;
  try {
    await assert.rejects(speakRemote({ engine: 'pocket-tts', text: 'Fixture', out: join(state, 'render.wav') }),
      /abort|timeout|deadline/i);
  } finally {
    Object.assign(config.ttsHeavy, original);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('session recovery preserves a malformed history before starting fresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = t.mock.method(console, 'warn', () => {});
  writeFileSync(config.session.currentFile, '{"lost-history":');
  const fresh = await session.recover({ at: '2026-01-01T12:00:00Z', dominantMood: 'calm' } as never);
  assert.ok(fresh.id);
  const preserved = readdirSync(state).find(name => name.startsWith('session.json.corrupt-'));
  assert.ok(preserved);
  assert.equal(readFileSync(join(state, preserved), 'utf8'), '{"lost-history":');
  assert.ok(warnings.mock.calls.some(call => String(call.arguments[0]).includes('recovery failed')));
  t.mock.timers.runAll();
  await new Promise(resolve => setImmediate(resolve));
});

test('failed voice adoption cannot publish a partial WAV under its final name', async t => {
  const renameMock = t.mock.method(fsPromises, 'rename', async () => {
    assert.deepEqual(await voices.scan(), [], 'an incomplete write must not be offered as a voice');
    throw new Error('rename fixture failed');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(voices.adoptVoice(Buffer.from('fixture'), { file: 'fixture.wav' }), /rename fixture failed/);
    assert.deepEqual(await voices.scan(), []);
    assert.deepEqual(readdirSync(config.voices.dir), []);
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
  }
});

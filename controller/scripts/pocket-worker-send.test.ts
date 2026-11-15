import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TTS_HEAVY_URL = '';
process.env.POCKET_TTS_REQUEST_TIMEOUT_MS = 'not-a-number';
const { PocketTtsWorker } = await import('../src/audio/pocketTts.js');
const { envIssues } = await import('../src/util/env.js');

test('PocketTTS malformed request timeout uses the normal env fallback', () => {
  assert.equal(envIssues().find(issue => issue.name === 'POCKET_TTS_REQUEST_TIMEOUT_MS')?.usedInstead, '120000');
});

test('an absent or exited PocketTTS worker refuses a send without a pending timer', async () => {
  const worker = new PocketTtsWorker();
  await assert.rejects(worker.send('missing', {}), /worker not running/);
  worker.proc = { stdin: { writable: true }, exitCode: 0, signalCode: null } as never;
  await assert.rejects(worker.send('exited', {}), /worker not running/);
  assert.equal(worker.requests.size, 0);
});

test('PocketTTS write failure settles the caller and clears its timeout', async () => {
  const worker = new PocketTtsWorker();
  worker.proc = {
    stdin: { writable: true, write: (_line: string, callback: (err: Error) => void) => callback(new Error('write fixture failed')) },
    exitCode: null, signalCode: null,
  } as never;
  await assert.rejects(worker.send('write-error', {}), /write fixture failed/);
  assert.equal(worker.requests.size, 0);
});

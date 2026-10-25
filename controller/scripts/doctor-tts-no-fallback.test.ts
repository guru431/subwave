// Fork, C05: with the substitution ban (tts.fallback.enabled: false, the fork's
// default — audio/tts-fallback.ts rescueForbidden) a down voice engine has NO
// Piper rescue: the DJ stays silent until it returns. The doctor used to say
// "will fall back to Piper" regardless, which is the opposite of what airs.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-doctor-tts-'));
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';

const { checkTts } = await import('../src/doctor/checks-services.js');

// No remote URL configured → remoteTts.isAvailable() is false: the engine is down.
async function configuredEngines(fallback: unknown) {
  const out = await checkTts({ tts: { defaultEngine: 'remote', fallback } } as any);
  const f = out.find((x) => x.label === 'configured engines');
  assert.ok(f, 'the configured-engines finding is reported');
  return f;
}

test('engine down + substitution banned → no Piper promise, silence named', async () => {
  const f = await configuredEngines({ enabled: false, engine: 'piper', voice: '' });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /unavailable: remote/);
  assert.match(f.detail, /silent/);
  assert.doesNotMatch(`${f.detail} ${f.hint}`, /Piper/);
});

test('engine down + fallback enabled → upstream wording kept', async () => {
  const f = await configuredEngines({ enabled: true, engine: 'piper', voice: '' });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /will fall back to Piper/);
});

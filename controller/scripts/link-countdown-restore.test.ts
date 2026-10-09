// Fork (C04): the link countdown `Queue.tracksUntilLink` across a restart.
//
// The field is drawn when the queue singleton is constructed — at IMPORT,
// before server.ts runs settings.load() — so it took the default (moderate)
// frequency instead of the persona's, and nothing saved it. After every
// deploy the first link could wait up to fifteen tracks, about an hour of air,
// whatever the persona's frequency. It is now saved in queue.json and restored
// by recover(), which runs after settings.load(): clamped into the CURRENT
// frequency's range, a fresh draw when there is nothing usable to restore.
// Run: npm test -- link-countdown-restore

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-link-countdown-'));

const { config } = await import('../src/config.js');
const settings = await import('../src/settings.js');
// Imported BEFORE settings.load(), the order server.ts boots in.
const { queue } = await import('../src/broadcast/queue.js');
const { linkIntervalMax, pickLinkInterval, restoredLinkInterval } = await import('../src/broadcast/queue/pure.js');

await settings.load();

async function setFrequency(frequency: string) {
  const personas = settings.get().personas;
  await settings.update({
    personas: personas.map((p: any, i: number) => (i === 0 ? { ...p, frequency, djMode: false } : p)),
  } as never);
  assert.equal(settings.effectiveFrequency(), frequency);
}

// recover() as a restart runs it, against a queue.json of our choosing (or none).
function restart(snapshot: Record<string, unknown> | null) {
  rmSync(config.queue.file, { force: true });
  if (snapshot) writeFileSync(config.queue.file, JSON.stringify({ upcoming: [], history: [], ...snapshot }));
  queue.recover();
  return queue.tracksUntilLink;
}

test('a restart with nothing saved draws from the persona frequency, not the import-time default', async () => {
  await setFrequency('chatty');
  queue.tracksUntilLink = 12;              // a moderate draw no chatty persona can make
  const fresh = restart(null);
  assert.ok(fresh >= 1 && fresh <= 5, `chatty interval, got ${fresh}`);
  queue.tracksUntilLink = 12;
  const old = restart({});                 // a queue.json written before the field existed
  assert.ok(old >= 1 && old <= 5, `chatty interval, got ${old}`);
});

test('the countdown is saved with the queue and survives a restart', async () => {
  await setFrequency('moderate');
  queue.tracksUntilLink = 3;
  rmSync(config.queue.file, { force: true });
  queue.persist();                         // debounced: written ~500 ms later
  for (let i = 0; i < 100 && !existsSync(config.queue.file); i++) await new Promise(r => setTimeout(r, 20));
  const saved = JSON.parse(readFileSync(config.queue.file, 'utf8'));
  assert.equal(saved.tracksUntilLink, 3);
  queue.tracksUntilLink = 9;
  queue.recover();
  assert.equal(queue.tracksUntilLink, 3);
});

test('a saved countdown is clamped into the current frequency', async () => {
  await setFrequency('chatty');
  assert.equal(restart({ tracksUntilLink: 18 }), 5, 'the persona turned chattier while the controller was down');
  assert.equal(restart({ tracksUntilLink: 2.6 }), 2);
  assert.equal(restart({ tracksUntilLink: -4 }), 0, 'already due stays due');
  for (const junk of [null, 'x', true]) {
    const v = restart({ tracksUntilLink: junk });  // null is how JSON writes Infinity
    assert.ok(v >= 1 && v <= 5, `fresh chatty draw for ${JSON.stringify(junk)}, got ${v}`);
  }
});

test('a silent persona never comes due, whatever was saved', async () => {
  await setFrequency('silent');
  assert.equal(restart({ tracksUntilLink: 3 }), Infinity);
  assert.equal(restoredLinkInterval(0), Infinity);
});

// pickLinkInterval at the top of its range: every draw is floor(r * k), so
// r just under 1 is the longest. Moderate first picks its rare long band
// (r < 0.15), then draws in it.
function longestDraw(f: string) {
  const seq = f === 'moderate' ? [0.1, 1 - 1e-9] : [1 - 1e-9];
  let i = 0;
  const real = Math.random;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try { return pickLinkInterval(); } finally { Math.random = real; }
}

test('linkIntervalMax is the longest interval pickLinkInterval draws', async () => {
  for (const f of ['quiet', 'moderate', 'chatty', 'aggressive']) {
    await setFrequency(f);
    assert.equal(longestDraw(f), linkIntervalMax(), f);
    assert.equal(linkIntervalMax(f), linkIntervalMax(), `${f} by name`);
  }
  assert.equal(linkIntervalMax('silent'), Infinity);
});

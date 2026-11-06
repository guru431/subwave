import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rotation diagnostic distinguishes block, show mismatch, cooldown and eligible without changing the queue', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rotation-diagnostic-'));
  process.env.STATE_DIR = dir;
  process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T12:00:00Z') });
  const fetch = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes('/rest/getGenres')
    ? new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', genres: { genre: [
      { value: 'Rock', songCount: 1 }, { value: 'Jazz', songCount: 1 },
    ] } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 503 });
  const settings = await import('../src/settings.js');
  const db = await import('../src/music/library-db.js');
  const library = await import('../src/music/library.js');
  const blocklist = await import('../src/music/blocklist.js');
  const { queue } = await import('../src/broadcast/queue.js');
  const { diagnoseTrackRotation } = await import('../src/music/track-rotation-diagnostic.js');
  try {
    await library.load();
    db.upsertTrackMeta('rock', { title: 'Rock', artist: 'Band', genres: ['Rock'], duration: 240 });
    db.upsertTrackMeta('jazz', { title: 'Jazz', artist: 'Other', genres: ['Jazz'], duration: 240 });
    await settings.update({ shows: [{ id: 'diag', name: 'Jazz show', personaId: settings.get().personas[0].id,
      genres: ['Jazz'], filtersStrict: true }], llm: { noRepeatWindow: 0 } } as never);
    const show = settings.get().shows.find(s => s.id === 'diag')!;
    const incompatible = await diagnoseTrackRotation('rock', show.id);
    assert(incompatible?.checks.some(c => c.code === 'show-genres'));
    assert.equal((await diagnoseTrackRotation('jazz', show.id))?.verdict, 'eligible');
    queue._recentPlays = [{ id: 'jazz', title: 'Jazz', artist: 'Other', endedAt: new Date(Date.now() - 60_000).toISOString() }];
    assert((await diagnoseTrackRotation('jazz', show.id))?.checks.some(c => c.code === 'track-cooldown'));
    await blocklist.add({ type: 'track', id: 'jazz', name: 'Jazz' });
    assert.equal((await diagnoseTrackRotation('jazz', show.id))?.verdict, 'blocked');
    assert.equal(queue.upcoming.length, 0);
    assert.equal(db.getTrack('jazz')?.taggedAt, null);
  } finally {
    globalThis.fetch = fetch;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

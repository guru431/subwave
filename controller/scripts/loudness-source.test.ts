import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('full-file loudness survives later excerpt analysis and missing measurements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loudness-source-'));
  process.env.STATE_DIR = dir;
  const db = await import('../src/music/library-db.js');
  const { requireDb } = await import('../src/music/library-db/handle.js');
  try {
    await db.open({ embeddingDim: 768, adoptStoredDim: true });
    db.upsertTrackMeta('a', { title: 'A', artist: 'Artist', duration: 200 });
    db.upsertTrackAnalysis('a', { loudnessLufs: -25, peakDb: -6 });
    const sql = requireDb();
    sql.prepare("UPDATE tracks SET loudness_lufs=-14, peak_db=-1, loudness_source='full' WHERE id='a'").run();
    for (const a of [{ loudnessLufs: -25, peakDb: -6 }, {}]) {
      db.upsertTrackAnalysis('a', a);
      assert.deepEqual(sql.prepare("SELECT loudness_lufs, peak_db FROM tracks WHERE id='a'").get(),
        { loudness_lufs: -14, peak_db: -1 });
    }
    const { canonicalId } = await import('../src/music/id-canonical.js');
    for (const [old, newFull] of [['e3b7fc2ae9447bbec37a13bf916e3cf6', false], ['a1b2c3d4e5f60718293a4b5c6d7e8f90', true]] as const) {
      const next = canonicalId(old);
      for (const id of [old, next]) db.upsertTrackMeta(id, { title: 'Same song', artist: 'Artist', duration: 200 });
      sql.prepare("UPDATE tracks SET loudness_lufs=-14, peak_db=-1, loudness_source='full' WHERE id=?").run(old);
      db.upsertTrackAnalysis(next, { loudnessLufs: -30, peakDb: -8 });
      if (newFull) sql.prepare("UPDATE tracks SET loudness_lufs=-12, peak_db=-2, loudness_source='full' WHERE id=?").run(next);
      db.adoptRotatedIds(new Set(['a', next]));
      assert.deepEqual(sql.prepare('SELECT loudness_lufs, peak_db, loudness_source FROM tracks WHERE id=?').get(next),
        { loudness_lufs: newFull ? -12 : -14, peak_db: newFull ? -2 : -1, loudness_source: 'full' });
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fork: the per-artist play stats were grouped by SQLite LOWER(), which folds
// ASCII only, while library.ts looks them up by JS toLowerCase(). "Кино" was
// stored under "Кино" and searched as "кино", so every Cyrillic artist with a
// capital letter lost artist_play_count / artist_last_played_days_ago in the
// picker tools — and read to the model as never played.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('Cyrillic artists keep their play stats whatever the case', async () => {
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-artist-play-cyr-'));

  const db = await import('../src/music/library-db.js');
  const library = await import('../src/music/library.js');
  const { slim } = await import('../src/llm/internal/tools/picker/slim.js');

  await library.load();
  db.upsertTrackMeta('gruppa-krovi', {
    title: 'Группа крови', artist: 'Кино', album: 'Группа крови', duration: 285,
  });

  const now = Date.now();
  const play = (trackId: string, artist: string, daysAgo: number) => db.recordPlay({
    trackId,
    title: 'Песня',
    artist,
    album: 'Альбом',
    playedAt: new Date(now - daysAgo * 86400000).toISOString(),
    source: 'ai',
    requestedBy: null,
    showId: null,
    showName: null,
  });
  play('zvezda', 'Кино', 3);
  play('kukushka', 'КИНО', 5);   // one artist, two spellings of case
  play('yesterday', 'The Beatles', 4);

  const kino = slim({ id: 'gruppa-krovi', title: 'Группа крови', artist: 'Кино' });
  assert.equal(kino.artist_play_count, 2);
  assert.equal(kino.artist_last_played_days_ago, 3);

  // Latin artists keep folding the same way they always did.
  const beatles = slim({ id: 'let-it-be', title: 'Let It Be', artist: 'the beatles' });
  assert.equal(beatles.artist_play_count, 1);

  library.shutdown();
});

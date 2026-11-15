import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'subwave-recipe-write-'));
process.env.STATE_DIR = state;
const recipes = await import('../src/music/playlist-recipes.js');
const settings = await import('../src/settings.js');
after(() => rmSync(state, { recursive: true, force: true }));

test('a refused recipe write leaves the published cache and disk at the last successful state', () => {
  const entry = recipes.upsert({
    playlistId: 'original', name: 'Original',
    recipe: { seedTrackIds: ['old'], knobs: {} as never, sources: {} as never },
  });
  const file = join(state, 'playlist-recipes.json');
  const original = readFileSync(file, 'utf8');
  // The store can be read, but the destination cannot be replaced.
  rmSync(file);
  mkdirSync(file);
  try {
    for (const write of [
      () => recipes.upsert({ ...entry, name: 'Changed' }),
      () => recipes.recordSync('original', 4),
      () => recipes.remove('original'),
      () => recipes.remapIds(new Map([['old', 'new']]), () => 'renamed'),
    ]) {
      assert.throws(write);
      assert.deepEqual(recipes.list(), [entry]);
      assert.equal(JSON.stringify({ version: 1, recipes: recipes.list() }, null, 2), original);
    }
  } finally {
    rmSync(file, { recursive: true });
  }
});

test('a non-object TTS fallback is refused before it can be merged into the saved slot', async () => {
  await settings.load();
  for (const fallback of ['bad', [], null, false, 3]) {
    await assert.rejects(settings.update({ tts: { fallback } } as never), /tts\.fallback must be an object/);
  }
});

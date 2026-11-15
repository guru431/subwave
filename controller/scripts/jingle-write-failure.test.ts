import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const localTmp = tmpdir();
mkdirSync(localTmp, { recursive: true });
const state = mkdtempSync(join(localTmp, 'jingle-write-failure-'));
process.env.STATE_DIR = state;
process.env.TTS_HEAVY_URL = '';
const jingles = await import('../src/broadcast/jingles.js');
const meta = join(state, 'jingles.json');
const playlist = join(state, 'jingles.m3u');
after(() => rmSync(state, { recursive: true, force: true }));

test('a failed metadata commit removes the new upload; a failed playlist keeps its API handle', async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = ''; // Deterministic raw-import path, without codec subprocesses.
  try {
    mkdirSync(meta);
    await assert.rejects(jingles.importAudio(Buffer.from('fixture'), { originalName: 'fixture.mp3' }));
    assert.deepEqual(readdirSync(join(state, 'jingles')), []);
    rmSync(meta, { recursive: true });

    mkdirSync(playlist);
    await assert.rejects(jingles.importAudio(Buffer.from('fixture'), { originalName: 'fixture.mp3' }));
    const listed = await jingles.list();
    assert.equal(listed.length, 1, 'a committed clip remains removable through the API');
    const stored = JSON.parse(readFileSync(meta, 'utf8'));
    assert.ok(stored.items[listed[0].filename]);
    assert.equal(readdirSync(join(state, 'jingles')).length, 1);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

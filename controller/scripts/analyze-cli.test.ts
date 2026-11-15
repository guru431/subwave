import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const value of ['abc', '--walk', '1tail', '0', '-4']) {
  test(`analysis limit ${value} refuses instead of starting an unlimited pass`, () => {
    const state = mkdtempSync(join(tmpdir(), 'subwave-analyze-cli-'));
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/music/analyze-library.ts', '--limit', value], {
        encoding: 'utf8', timeout: 3000,
        env: { ...process.env, STATE_DIR: state, NAVIDROME_URL: 'http://127.0.0.1:9' },
      });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /--limit requires a positive integer/);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
}

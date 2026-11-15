import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mode = process.argv[2];
if (mode === 'exit' || mode === 'no-text') {
  const state = mkdtempSync(join(tmpdir(), 'subwave-analyzer-start-'));
  const script = join(state, 'worker.cjs');
  const received = join(state, 'received');
  writeFileSync(script, mode === 'exit' ? 'process.exit(1)' : `
    console.log(JSON.stringify({ready: true, text_embedding_capable: false}));
    process.stdin.on('data', () => {
      require('fs').writeFileSync(${JSON.stringify(received)}, 'unexpected embed request');
      console.log(JSON.stringify({id: '1', ok: true, embeddings: [[1, 0]]}));
    });
  `);
  const { config } = await import('../src/config.js');
  config.analyzer.python = process.execPath;
  config.analyzer.workerScript = script;
  config.analyzer.urls = [];
  const analyzer = await import('../src/music/analyzer.js');
  try {
    assert.equal(await analyzer.embedTexts(['test'], { coldRetry: false }), null);
    assert.equal(await analyzer.embedTexts(['again'], { coldRetry: false }), null);
    assert.equal(existsSync(received), false, 'known incapable local workers receive no requests');
  } finally {
    analyzer.shutdown();
    rmSync(state, { recursive: true, force: true });
  }
} else {
  for (const scenario of ['exit', 'no-text']) {
    test(`local analyzer ${scenario} settles promptly without a stranded ready timer`, () => {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), scenario], {
        encoding: 'utf8', timeout: 3000,
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
    });
  }
}

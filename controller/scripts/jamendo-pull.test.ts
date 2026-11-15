// Standalone importer contracts, with in-memory I/O and no Jamendo requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../tools/jamendo/pull.mjs', import.meta.url), 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\r?$/gm, '')
  .replace(/\nmain\(\)\.catch\([\s\S]*$/, '');

interface ImporterApi {
  decodeEntities(input: string): string;
  fetchWithRetry(url: string): Promise<{ ok: boolean }>;
  writeManifestAndCredits(manifest: unknown[]): Promise<void>;
  downloadTrack(track: Record<string, unknown>): Promise<{ file: string; skipped: boolean }>;
}

function importer(argv: string[] = [], overrides: Record<string, unknown> = {}) {
  const files = new Map<string, unknown>();
  const delays: number[] = [];
  const context = {
    process: { argv: ['node', 'pull.mjs', '--out', '/library', ...argv], env: { JAMENDO_CLIENT_ID: 'fixture' } },
    console, Buffer, URL, Error,
    join: posix.join,
    mkdir: async () => {},
    existsSync: (path: string) => files.has(path),
    readFile: async (path: string) => files.get(path),
    writeFile: async (path: string, value: unknown) => { files.set(path, value); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)); files.delete(from); },
    rm: async (path: string) => { files.delete(path); },
    setTimeout: (fn: () => void, ms: number) => { delays.push(ms); fn(); },
    fetch: async () => ({ status: 200, ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }),
    NodeID3: { write: () => true },
    ...overrides,
  };
  const api = vm.runInNewContext(source + '\n({ decodeEntities, fetchWithRetry, writeManifestAndCredits, downloadTrack })', context, { timeout: 1_000 }) as ImporterApi;
  return { ...api, files, delays };
}

test('Jamendo preserves malformed numeric entities without losing the page', { timeout: 5_000 }, () => {
  const api = importer();
  assert.equal(api.decodeEntities('A&#39;s &#x1f3b5;'), "A's 🎵");
  assert.equal(api.decodeEntities('&#999999999; &#xD800;'), '&#999999999; &#xD800;');
});

test('Jamendo rejects invalid numeric arguments before importing', { timeout: 5_000 }, () => {
  for (const name of ['limit', 'concurrency']) {
    for (const value of ['abc', '0', '-1', '1.5', 'Infinity']) {
      assert.throws(() => importer([`--${name}`, value]), new RegExp(`--${name}.*positive integer`));
    }
    assert.throws(() => importer([`--${name}`]), new RegExp(`--${name}.*positive integer`));
  }
});

test('Jamendo retries temporary HTTP errors, but a permanent 404 fails once', { timeout: 5_000 }, async () => {
  let calls = 0;
  const permanent = importer([], { fetch: async () => { calls++; return { status: 404, ok: false }; } });
  await assert.rejects(permanent.fetchWithRetry('fixture'), /HTTP 404/);
  assert.equal(calls, 1);
  assert.equal(permanent.delays.length, 0);

  calls = 0;
  const temporary = importer([], { fetch: async () => ++calls === 1
    ? { status: 503, ok: false, headers: { get: () => null } }
    : { status: 200, ok: true, json: async () => ({ ok: true }) } });
  assert.equal((await temporary.fetchWithRetry('fixture')).ok, true);
  assert.equal(calls, 2);
  assert.equal(temporary.delays.length, 1);
});

test('Jamendo preserves the resume manifest and removes a failed staging file', { timeout: 5_000 }, async () => {
  const api = importer([], { writeFile: async (path: string) => {
    api.files.set(path, 'partial');
    throw new Error('disk full');
  } });
  api.files.set('/library/_manifest.json', '[{"id":1}]');
  await assert.rejects(api.writeManifestAndCredits([{ id: 2 }]), /disk full/);
  assert.equal(api.files.get('/library/_manifest.json'), '[{"id":1}]');
  assert.deepEqual([...api.files.keys()], ['/library/_manifest.json']);
});

test('Jamendo publishes only tagged audio and cleans up a failed tag write', { timeout: 5_000 }, async () => {
  const track = { id: 7, name: 'Song', artist_name: 'Artist', album_name: 'Album', audiodownload: 'fixture' };
  let fail = true;
  const api = importer([], { NodeID3: { write: (_tags: unknown, path: string) => {
    assert.ok(path.endsWith('.part'));
    return fail ? new Error('tag write failed') : true;
  } } });
  await assert.rejects(api.downloadTrack(track), /tag write failed/);
  assert.equal(api.files.size, 0);
  fail = false;
  const result = await api.downloadTrack(track);
  assert.equal(result.skipped, false);
  assert.deepEqual([...api.files.keys()], ['/library/Artist/Album/Song.mp3']);
});

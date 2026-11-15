// Raw persisted Icecast passwords are data in both the renderer and reader.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('listener admin auth preserves literal quotes, spaces and shell characters', { timeout: 5_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'subwave-icecast-secret-'));
  const stateDir = process.env.STATE_DIR;
  const envPassword = process.env.ICECAST_ADMIN_PASSWORD;
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (stateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = stateDir;
    if (envPassword === undefined) delete process.env.ICECAST_ADMIN_PASSWORD;
    else process.env.ICECAST_ADMIN_PASSWORD = envPassword;
    rmSync(directory, { recursive: true, force: true });
  });
  const password = ' "&|\\$()`<secret>\' ';
  writeFileSync(join(directory, 'icecast-secrets.env'), `ICECAST_ADMIN_PASSWORD=${password}\n`);
  process.env.STATE_DIR = directory;
  delete process.env.ICECAST_ADMIN_PASSWORD;
  const headers: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    headers.push(new Headers(init?.headers).get('authorization') || '');
    return new Response('', { status: 400 }); // disabled mount, no real server
  }) as typeof fetch;
  const { getConnections } = await import('../src/broadcast/listeners.js');
  const { config } = await import('../src/config.js');
  assert.deepEqual(await getConnections(), []);
  assert.equal(headers.length, 4);
  for (const header of headers) {
    assert.equal(Buffer.from(header.slice(6), 'base64').toString(), `${config.icecast.adminUser}:${password}`);
  }
});

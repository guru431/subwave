// Operator helper contracts; no desktop opener, Docker or network is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { cliImageTag } from '../../cli/src/version.ts';
import { openUrl } from '../../cli/src/util.ts';

test('image pins accept only complete published semver tags', { timeout: 5_000 }, () => {
  assert.equal(cliImageTag('v1.17.0'), '1.17.0');
  for (const version of ['1.17.0-rc.1', '1.17.0junk', '1.17.0+build', '1.17', '0.0.0']) {
    assert.equal(cliImageTag(version), null, version);
  }
});

test('Windows opener passes a URL as data and handles spawn failure', { timeout: 5_000 }, (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalSpawn = childProcess.spawn;
  const calls: unknown[][] = [];
  const child = Object.assign(new EventEmitter(), { unref() {} });
  childProcess.spawn = ((...args: unknown[]) => {
    calls.push(args);
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  const url = 'https://radio.example/?a=1&b=%COMSPEC%';
  assert.equal(openUrl(url), true);
  assert.equal(calls[0][0], 'rundll32.exe');
  assert.deepEqual(calls[0][1], ['url.dll,FileProtocolHandler', url]);
  assert.doesNotThrow(() => child.emit('error', new Error('ENOENT')));
  assert.equal(openUrl('file:///C:/Windows/test.cmd'), false);
  assert.equal(openUrl('invalid url'), false);
  assert.equal(calls.length, 1);
});

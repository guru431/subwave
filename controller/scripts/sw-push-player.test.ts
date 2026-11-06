import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('visible admin never suppresses chat push; visible player does, on Chromium and WebKit', async () => {
  const source = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
  for (const ua of ['AppleWebKit/600 Safari/600', 'AppleWebKit/600 Chrome/130']) {
    for (const windows of [
      [{ url: 'https://radio.test/admin', visibilityState: 'visible' }],
      [{ url: 'https://radio.test/admin', visibilityState: 'visible' }, { url: 'https://radio.test/listen', visibilityState: 'hidden' }],
      [{ url: 'https://radio.test/listen', visibilityState: 'visible' }],
    ]) {
      const handlers = new Map(); let shown = 0; let closed = 0;
      const self = { addEventListener: (name: string, handler: unknown) => handlers.set(name, handler),
        location: { origin: 'https://radio.test' }, navigator: { userAgent: ua },
        clients: { matchAll: async () => windows },
        registration: { showNotification: async () => { shown++; }, getNotifications: async () => [{ close: () => { closed++; } }] },
      };
      vm.runInNewContext(source, { self, URL });
      let done: Promise<void> = Promise.resolve();
      handlers.get('push')({ data: { json: () => ({}) }, waitUntil: (p: Promise<void>) => { done = p; } });
      await done;
      const player = windows.some(w => w.url.endsWith('/listen') && w.visibilityState === 'visible');
      assert.equal(shown - closed, player ? 0 : 1, `${ua}: ${JSON.stringify(windows)}`);
    }
  }
});

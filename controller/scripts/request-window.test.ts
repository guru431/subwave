// The request agent's window carries no earlier requests.
//
// Resolving «вулючи барбарики», the agent searched the library for the PREVIOUS
// listener's ask («Муцураев»): session.windowMessages() keeps every request
// turn, and the run's own tail line ("The request to resolve now — …") was
// coalesced onto a window already full of other people's requests. Two of 42
// requests on one station went that way. windowMessages({ omitRequests: true })
// drops both halves of every request turn — the event and the DJ's answer —
// and leaves the pick agent's default window exactly as it was.
//
// Runs against a temp STATE_DIR (the session persists there on a debounce), so
// STATE_DIR is set before session.js is imported, matching scripts/airing.test.ts.
// Run: `tsx scripts/request-window.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

async function main() {
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-request-window-'));
  const session = await import('../src/broadcast/session.js');

  session.start({ at: new Date().toISOString() } as any);
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Track started: Кино — Группа крови. Pick the next track.' });
  session.appendTurn({ role: 'event', kind: 'request', text: 'Listener "Вася" requests: "Муцураев"' });
  session.appendTurn({ role: 'dj', kind: 'request', text: 'Муцураева в коллекции нет, увы.' });
  session.appendTurn({ role: 'segment', kind: 'link', text: 'Группа крови — и три аккорда на всю страну.' });
  session.appendTurn({ role: 'event', kind: 'request', text: 'Listener "Петя" requests: "вулючи барбарики"' });

  const pick = session.windowMessages();
  const request = session.windowMessages({ omitRequests: true });
  const pickText = JSON.stringify(pick);
  const requestText = JSON.stringify(request);

  console.log('request agent window (omitRequests):');

  test('carries no request turn — neither the ask nor the answer', () => {
    assert.ok(!requestText.includes('Муцураев'), 'an earlier ask leaked into the window');
    assert.ok(!requestText.includes('барбарики'), 'the tail names the live request; the window must not');
  });

  test('keeps everything else the agent reads the station from', () => {
    assert.ok(requestText.includes('Группа крови'));
  });

  test('still opens on a user turn and alternates roles', () => {
    assert.equal(request[0]?.role, 'user');
    for (let i = 1; i < request.length; i++) {
      assert.notEqual(request[i].role, request[i - 1].role, `roles repeat at ${i}`);
    }
  });

  console.log('\npick agent window (default):');

  test('unchanged — requests stay visible to the pick agent', () => {
    assert.ok(pickText.includes('Муцураев'));
    assert.ok(pickText.includes('барбарики'));
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  // The session's debounced persist keeps a timer alive; exit explicitly.
  process.exit(failures ? 1 : 0);
}

main();

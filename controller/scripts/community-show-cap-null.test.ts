// Fork: a community show's track-length cap written as null. The live catalog
// spells "no cap of its own" as `maxTrackSeconds: null` on every show, and
// Number(null) is 0 — which a show reads as "unlimited", overriding the
// station's maxTrackSeconds instead of inheriting it. null must stay null.
// Only the catalog fetch is faked. Run: npm test -- community-show-cap-null

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-community-cap-'));

const CATALOG = {
  shows: [
    { slug: 'inherits', name: 'Inherits', maxTrackSeconds: null, minTrackLengthSeconds: null },
    { slug: 'absent', name: 'Absent' },
    { slug: 'capped', name: 'Capped', maxTrackSeconds: 600, minTrackLengthSeconds: 90 },
    { slug: 'unlimited', name: 'Unlimited', maxTrackSeconds: 0 },
  ],
  personas: [
    { slug: 'no-dials', soul: 'A host.', humour: null, warmth: null, localColour: null },
    { slug: 'dials', soul: 'A host.', humour: 0, warmth: 7 },
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(CATALOG), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

const { communityShows, communityPersonas } = await import('../src/community/registry.js');

after(() => { globalThis.fetch = realFetch; });

test('a null cap or floor is inherited, not read as 0', async () => {
  const shows = new Map((await communityShows()).map(s => [s.slug, s]));
  assert.equal(shows.size, 4);
  assert.equal(shows.get('inherits')!.maxTrackSeconds, null, 'null cap overrode the station as 0');
  assert.equal(shows.get('inherits')!.minTrackLengthSeconds, null);
  assert.equal(shows.get('absent')!.maxTrackSeconds, null);
  assert.equal(shows.get('absent')!.minTrackLengthSeconds, null);
});

test('a real cap survives, an explicit 0 included', async () => {
  const shows = new Map((await communityShows()).map(s => [s.slug, s]));
  assert.equal(shows.get('capped')!.maxTrackSeconds, 600);
  assert.equal(shows.get('capped')!.minTrackLengthSeconds, 90);
  assert.equal(shows.get('unlimited')!.maxTrackSeconds, 0);
});

// Same Number(null) in the persona dials: 0 is the far end of the dial, and the
// install route only falls back to neutral for an ABSENT dial.
test('a null persona dial is absent, not 0', async () => {
  const personas = new Map((await communityPersonas()).map(p => [p.slug, p]));
  const none = personas.get('no-dials')!;
  assert.equal(none.humour, undefined, 'null dial read as 0');
  assert.equal(none.warmth, undefined);
  assert.equal(none.localColour, undefined);
  const set = personas.get('dials')!;
  assert.equal(set.humour, 0);
  assert.equal(set.warmth, 7);
  assert.equal(set.localColour, undefined);
});

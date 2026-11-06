import assert from 'node:assert/strict';
import test from 'node:test';
import { runArtistGuard, artistRootKey } from '../src/broadcast/dj-agent/artist-guard.js';
import { runAlbumGuard } from '../src/broadcast/dj-agent/album-guard.js';

test('anchor re-pick honours the full hours window, then album re-pick preserves it', async () => {
  const anchor = { id: 'a', artist: 'Anchor', title: 'A', album: 'Old' };
  const recent = { id: 'r', artist: 'Recent', title: 'R', album: 'New' };
  const fresh = { id: 'f', artist: 'Fresh', title: 'F', album: 'Old' };
  const seen = new Map([anchor, recent, fresh].map(s => [s.id, s]));
  const roots = new Set([artistRootKey(anchor), artistRootKey(recent)]);
  const log = () => {};
  const artist = await runArtistGuard({
    song: anchor, object: { id: 'a' }, pickAnchor: anchor, seen,
    recentRoots: new Set([artistRootKey(anchor)]), windowRoots: roots, window: 1,
    repick: async alt => ({ id: [...alt.keys()][0] }),
    poolRescue: async () => 'empty', log, logEvent: log,
  });
  assert.equal(artist.kind, 'repicked');
  if (artist.kind !== 'repicked') return;
  assert.equal(artist.song.id, 'f');
  const album = await runAlbumGuard({
    song: artist.song, object: artist.object, seen, recentAlbums: new Set(['Old']),
    avoidArtistRoots: roots, preserveArtists: true, albumKeyOf: s => s.album, hours: 3,
    repick: async () => { assert.fail('album preference must not reintroduce a recent artist'); },
    log, logEvent: log,
  });
  assert.equal(album.kind, 'kept');
});

import * as library from './library.js';
import * as db from './library-db.js';
import * as blocklist from './blocklist.js';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import { artistWindowRoots } from '../broadcast/dj-agent/artist-guard.js';
import { prepareShowCandidateInputs } from './show-candidates.js';
import { applyStrictLocks } from './show-filter.js';
import { belowTrackFloor } from './track-floor.js';
import { albumKeyFor } from './album-facts.js';
import { artistRootKey, recencyWindowsForLibrary, trackKey } from './recency.js';
import { showNoRepeatGuard } from './show-recency.js';

export async function diagnoseTrackRotation(id: string, showId?: string) {
  await library.load();
  const track = db.getTrack(id);
  if (!track) return null;
  const s = settings.get();
  const show = showId ? s.shows?.find(sh => sh.id === showId) : settings.resolveActiveShow();
  if (showId && !show) throw new Error('Шоу не найдено');
  const inputs = await prepareShowCandidateInputs(show);
  const checks: Array<{ code: string; state: 'blocked' | 'temporary' | 'info' | 'unknown'; text: string }> = [];
  const lockLabels: Record<string, string> = { genres: 'жанр', eras: 'годы', moods: 'настроение', energies: 'энергия', vocals: 'вокал' };
  const add = (code: string, state: 'blocked' | 'temporary' | 'info' | 'unknown', text: string) => checks.push({ code, state, text });
  const hit = blocklist.hitOf(track);
  if (hit) add('blocklist', 'blocked', 'Абсолютная блокировка: трек исключён, включая заказы.');
  if (inputs.excludedIds?.has(id)) add('excluded-playlist', 'blocked', 'Трек в исключённом плейлисте выбранного шоу.');
  if (show?.playlistStrict && inputs.playlistRows && !inputs.playlistRows.some(t => t.id === id)) {
    add('show-playlist', 'blocked', 'Трек вне закреплённого строгого плейлиста шоу.');
  }
  if (belowTrackFloor(track, inputs.minTrackSec)) add('length', 'temporary', 'Короче минимума шоу. Агент исключает; резервный пул может смягчить при исчерпании.');
  for (const [key, lock] of Object.entries(inputs.locks)) {
    if (!applyStrictLocks([track], { [key]: lock }, { starve: true }).length) {
      add(`show-${key}`, show?.filtersStrict ? 'temporary' : 'info',
        `Не совпадает с ограничением «${lockLabels[key] || key}» выбранного шоу${show?.filtersStrict ? ': агент исключает, резервный пул может смягчить при исчерпании' : ' (мягкое предпочтение)'}.`);
    }
  }
  const stats = library.stats();
  const size = stats.mirrorTotal || stats.total;
  const windows = recencyWindowsForLibrary(stats.distinctArtists, size);
  const recent = queue.recentlyPlayed(windows.trackHours);
  if (recent.ids.has(id) || recent.keys.has(trackKey(track))) add('track-cooldown', 'temporary', `Песня внутри окна повторов ${windows.trackHours} ч; резервный пул может смягчить.`);
  const roots = artistWindowRoots(queue.recentArtistsSince(windows.artistHours), queue.neighbourArtistRoots(s.llm?.artistVarietyWindow ?? 5), queue.queuedArtistRoots());
  if (roots.has(artistRootKey(track))) add('artist-cooldown', 'temporary', `Артист внутри окна ${windows.artistHours} ч или уже в очереди; смягчение только при исчерпании.`);
  const noRepeat = showNoRepeatGuard(s.llm?.noRepeatWindow ?? 0, size, {
    show, playlistTracks: inputs.playlistRows, excludedIds: inputs.excludedIds,
    resolvedGenres: inputs.locks.genres, minTrackSec: inputs.minTrackSec,
  });
  const hard = queue.recentlyPlayedByCount(noRepeat.window);
  if (hard.ids.has(id) || hard.keys.has(trackKey(track))) add('hard-no-repeat', 'temporary', `Не повторять последние ${noRepeat.window} разных песен: жёсткое окно.`);
  if (queue.queuedIds().has(id)) add('queued', 'temporary', 'Уже в очереди или играет сейчас.');
  if (s.picker?.albumHours && queue.recentAlbumKeys(s.picker.albumHours).has(albumKeyFor(track))) add('album', 'temporary', 'Альбом внутри окна повторов; мягкое предпочтение.');
  if (!track.moods.length && !track.audioMoods.length) add('moods', 'unknown', 'Настроения не размечены.');
  if (!track.energy) add('energy', 'unknown', 'Энергия не размечена.');
  const indexes = { text: db.getVector(id) !== null, audio: db.hasAudioVector(id) };
  if (!indexes.text || !indexes.audio) add('indexes', 'unknown', 'Не все векторные индексы готовы; соответствующие пути похожести могут быть недоступны.');
  const lastAired = db.requireDb().prepare('SELECT MAX(played_at) AS at, COUNT(*) AS count FROM plays WHERE track_id = ?').get(id);
  return {
    verdict: checks.some(c => c.state === 'blocked') ? 'blocked' : checks.some(c => c.state === 'temporary') ? 'constrained' : 'eligible',
    summary: checks.some(c => c.state === 'blocked') ? 'Не допускается правилами.' : checks.some(c => c.state === 'temporary') ? 'Есть временные ограничения или предпочтения.' : 'Может попасть в эфир. Допуск не гарантирует выбор.',
    track: { id, artist: track.artist, title: track.title }, show: show ? { id: show.id, name: show.name } : null,
    shows: (s.shows || []).map(sh => ({ id: sh.id, name: sh.name })), checks, indexes, lastAired,
    warnings: [...inputs.warnings, 'История появления именно этого трека в кандидатах не записывается. Причина выбора LLM неизвестна.'],
  };
}

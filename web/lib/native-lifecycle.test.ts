import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the native hooks without loading React Native or requiring a device.
// Effects retain their dependency/cleanup semantics; clocks and I/O are explicit.
function hookHost() {
  const slots: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: Array<() => void> = [];
  let clock = 1_000_000;
  let sequence = 0;
  const intervals = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const host = {
    active: true,
    react: {
      useState(initial: unknown) {
        const i = cursor++;
        if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], (value: unknown) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value;
        }];
      },
      useRef(initial: unknown) {
        const i = cursor++;
        if (!(i in slots)) slots[i] = { current: initial };
        return slots[i];
      },
      useCallback(callback: unknown, deps: unknown[]) {
        const i = cursor++;
        const previous = slots[i] as { callback: unknown; deps: unknown[] } | undefined;
        if (previous && deps.every((value, j) => Object.is(value, previous.deps[j]))) return previous.callback;
        slots[i] = { callback, deps };
        return callback;
      },
      useEffect(callback: () => (() => void) | void, deps: unknown[]) {
        const i = effectCursor++;
        const previous = effects[i];
        if (previous && deps.every((value, j) => Object.is(value, previous.deps[j]))) return;
        pending.push(() => {
          previous?.cleanup?.();
          effects[i] = { deps, cleanup: callback() || undefined };
        });
      },
    },
    globals: {
      Date: class extends Date { static now() { return clock; } },
      setInterval(callback: () => void) { const id = ++sequence; intervals.set(id, callback); return id; },
      clearInterval(id: number) { intervals.delete(id); },
      setTimeout(callback: () => void, ms: number) {
        const id = ++sequence;
        timers.set(id, { at: clock + ms, callback });
        return id;
      },
      clearTimeout(id: number) { timers.delete(id); },
    },
    render<T>(callback: () => T): T {
      cursor = 0;
      effectCursor = 0;
      pending = [];
      const value = callback();
      for (const apply of pending) apply();
      return value;
    },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    advance(ms: number) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      }
    },
    now() { return clock; },
    unmount() { for (const effect of effects) effect?.cleanup?.(); },
  };
  return host;
}

function loadNative(path: string, modules: Record<string, unknown>, globals = {}) {
  const source = readFileSync(new URL(`../../app/src/${path}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  vm.runInNewContext(js, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected native dependency ${name}`);
      return modules[name];
    },
    ...globals,
  }, { timeout: 1000 });
  return exports;
}

test('native setup retries after updateOptions fails and reuses initialized player', { timeout: 3000 }, async () => {
  let setups = 0;
  let options = 0;
  const player = loadNative('audio/player.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    'react-native-track-player': {
      __esModule: true,
      default: {
        setupPlayer: async () => { if (++setups > 1) throw new Error('already initialized'); },
        updateOptions: async () => { if (++options === 1) throw new Error('temporary native failure'); },
      },
      Capability: { Play: 1, Pause: 2, Stop: 3 },
      RatingType: { Heart: 1 },
      AppKilledPlaybackBehavior: { StopPlaybackAndRemoveNotification: 1 },
    },
  });
  const setupPlayer = player.setupPlayer;
  assert.ok(setupPlayer);
  await assert.rejects(setupPlayer() as Promise<void>, /temporary native failure/);
  await setupPlayer();
  assert.equal(options, 2);
  await setupPlayer();
  assert.equal(options, 2, 'successful setup remains idempotent');
});

test('spectrum grows and shrinks bins without NaN, including while hidden', { timeout: 3000 }, () => {
  const host = hookHost();
  const hooks = loadNative('hooks/useSpectrum.ts', {
    react: host.react,
    '@/hooks/useAppActive': { useAppActive: () => host.active },
  }, host.globals);
  const useSpectrum = hooks.useSpectrum;
  assert.ok(useSpectrum);
  const render = (bins: number, visible = true) => host.render(() => useSpectrum(bins, true, 50, visible)) as number[];
  render(2);
  host.tick();
  render(5);
  host.tick();
  assert.equal(render(5).length, 5);
  assert.ok(render(5).every(Number.isFinite));
  render(1, false);
  assert.equal(render(1, false).length, 1);
  host.unmount();
});

test('buffered track promotion keeps its audible timestamp across background transitions', { timeout: 3000 }, async () => {
  const host = hookHost();
  const hooks = loadNative('hooks/useStationFeed.ts', {
    react: host.react,
    '@/hooks/useAppActive': { useAppActive: () => host.active },
    '@/lib/format': { DEFAULT_STATION_LOCALE: 'en-GB' },
  }, host.globals);
  let title = 'First';
  let startedAt = host.now() - 20_000;
  const api = {
    nowPlaying: async () => ({ nowPlaying: { title, artist: 'Artist' }, context: null, stream: { bufferSeconds: 10 } }),
    state: async () => ({ current: { title, startedAt: new Date(startedAt).toISOString() } }),
    session: async () => ({ session: null, messages: [] }),
  };
  const useStationFeed = hooks.useStationFeed;
  assert.ok(useStationFeed);
  let currentApi = api;
  const render = () => host.render(() => useStationFeed(currentApi, { backgroundPoll: true })) as {
    nowPlaying: { title: string } | null; trackStartedAt: number | null;
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  render();
  await settle();
  assert.equal(render().nowPlaying?.title, 'First');
  title = 'Second';
  startedAt = host.now();
  host.tick();
  await settle();
  assert.equal(render().nowPlaying?.title, 'First');
  host.active = false;
  render();
  await settle();
  assert.equal(render().nowPlaying?.title, 'First', 'background poll must preserve buffered promotion');
  host.advance(10_000);
  assert.equal(render().nowPlaying?.title, 'Second');
  assert.equal(render().trackStartedAt, startedAt + 10_000);
  host.active = true;
  title = 'Third';
  startedAt = host.now();
  render();
  await settle();
  assert.equal(render().nowPlaying?.title, 'Second');
  currentApi = {
    ...api,
    nowPlaying: async () => ({ nowPlaying: { title: 'Other station', artist: 'Artist' }, context: null, stream: { bufferSeconds: 0 } }),
  };
  render();
  await settle();
  assert.equal(render().nowPlaying?.title, 'Other station');
  host.advance(10_000);
  assert.equal(render().nowPlaying?.title, 'Other station', 'the old station promotion must be cancelled');
  host.unmount();
});

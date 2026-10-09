'use client';

import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { animate as motionAnimate, m, useAnimate } from 'motion/react';
import { cn } from '@/lib/cn';
import { useIsIOS } from '@/lib/hooks';
import { ruListeners } from '@/lib/ru';
import { SCALE_MAX, type SignalQuality } from '@/hooks/useSignal';
import type { PlayerStatus } from '@/hooks/usePlayer';

export interface TransportBarProps {
  tunedIn: boolean;
  status?: PlayerStatus;
  onTune: () => void;
  offline?: boolean;
  volume: number;
  setVolume: (v: number) => void;
  /** Increments on keyboard-only volume adjusts; knob drags don't tick it. */
  volumePulse?: number;
  muted: boolean;
  onToggleMute: () => void;
  /** Measured round-trip latency in ms (null before the first probe lands). */
  latencyMs: number | null;
  signalQuality: SignalQuality;
  /** Current station listener count — shown as text in the signal readout. */
  listeners: number | null;
}

const SCALE_NUMS = [0, 50, 100, 150, 200, 250];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
// Snap to whole-percent steps so the readout and rotation land on clean values.
const quantizeVolume = (n: number) => Math.round(clamp01(n) * 100) / 100;

const QUALITY_LABEL: Record<SignalQuality, string> = {
  offline: 'Нет эфира',
  idle: 'Ожидание',
  acquiring: 'Настройка',
  good: 'Хороший',
  fair: 'Средний',
  poor: 'Слабый',
};

// Honour reduced-motion for the imperative motion pulses (the CSS transitions
// are already gated in globals.css). Read at call time so a setting change
// mid-session is respected.
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default memo(function TransportBar({
  tunedIn,
  status = 'idle',
  onTune,
  offline = false,
  volume,
  setVolume,
  volumePulse,
  muted,
  onToggleMute,
  latencyMs,
  signalQuality,
  listeners,
}: TransportBarProps) {
  // iOS Safari makes HTMLMediaElement.volume read-only and ignores a Web Audio
  // GainNode inside an installed PWA, so the on-screen slider can't actually
  // attenuate there. Swap it for a hardware-volume hint instead of shipping a
  // dead control (issue #298). This covers the LEVEL only — muting rides the
  // element's native `muted` flag, which iOS does honour, so that button stays
  // on both branches.
  const iosVolumeLocked = useIsIOS();

  // Surfaced on the power ring so the player doesn't claim to play while
  // still silent.
  const connecting = status === 'connecting';

  // Parked at 0% before the first probe, pegged to the top when one failed.
  const needlePct =
    latencyMs != null
      ? Math.min(100, (Math.min(latencyMs, SCALE_MAX) / SCALE_MAX) * 100)
      : signalQuality === 'poor'
        ? 100
        : 0;
  const qualityLabel = QUALITY_LABEL[signalQuality];
  const latencyText = latencyMs != null ? `${latencyMs} ms` : '—';
  const qualityTone =
    signalQuality === 'idle' || signalQuality === 'offline' ? 'text-muted' : 'text-vermilion';

  // Fires on the tunedIn flip, not the click, so keyboard and media keys get
  // the same feedback.
  const [tuneScope, animateTune] = useAnimate<HTMLButtonElement>();
  const prevTunedInRef = useRef(tunedIn);
  useEffect(() => {
    if (prevTunedInRef.current === tunedIn) return;
    prevTunedInRef.current = tunedIn;
    if (!tuneScope.current || prefersReducedMotion()) return;
    animateTune(tuneScope.current, { scale: [1, 1.06, 1] }, { duration: 0.25, ease: [0.2, 0.7, 0.2, 1] });
  }, [tunedIn, animateTune, tuneScope]);

  // Короткий отклик на изменение громкости с клавиатуры. Масштабируется
  // ОБЁРТКА, а не сам ползунок, — иначе дёргался бы бегунок. Первый тик
  // после монтирования пропускается.
  const knobWrapRef = useRef<HTMLDivElement>(null);
  const firstPulseRef = useRef(true);
  useEffect(() => {
    if (firstPulseRef.current) {
      firstPulseRef.current = false;
      return;
    }
    if (volumePulse == null) return;
    const el = knobWrapRef.current;
    if (el && !prefersReducedMotion()) {
      motionAnimate(el, { scale: [1, 1.12, 1] }, { duration: 0.12, ease: [0.2, 0.7, 0.2, 1] });
    }
  }, [volumePulse]);

  // Throttled haptic tick on any volume change (drag or keyboard).
  const prevVolumeRef = useRef(volume);
  const lastVibrateRef = useRef(0);
  useEffect(() => {
    if (prevVolumeRef.current === volume) return;
    prevVolumeRef.current = volume;
    const now = Date.now();
    if (now - lastVibrateRef.current > 70 && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(4);
      lastVibrateRef.current = now;
    }
  }, [volume]);

  // Up/Down плеер слушает глобально (PlayerApp), независимо от фокуса. Нативный
  // ползунок обработал бы их ещё раз, и шаг удвоился бы. Остальное — Left/Right,
  // Home/End, PageUp/PageDown — его собственное и работает само.
  const onVolumeKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
  };

  const handleTune = () => {
    if (offline) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }
    onTune();
  };

  const handleMute = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(6);
    }
    onToggleMute();
  };

  // Shared by both branches — see iosVolumeLocked.
  const muteButton = (
    <button
      type="button"
      onClick={handleMute}
      aria-pressed={muted}
      aria-label={muted ? 'Включить звук' : 'Выключить звук'}
      title={muted ? 'Включить звук' : 'Выключить звук'}
      data-muted={muted ? 'true' : 'false'}
      className="fz-grille v3-focus h-9 w-9 lg:h-10 lg:w-10"
    />
  );

  return (
    <div
      // Safe-area insets live on the deck below, not here, so its background
      // fills to the screen edge with no page bg peeking through.
      className="absolute inset-x-0 bottom-0 z-20"
    >
      <div className="fz-deck relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch bg-[var(--fz-panel)] pt-3 pr-[env(safe-area-inset-right)] pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)] pl-[env(safe-area-inset-left)] [border-top:1px_solid_var(--fz-edge)]">
        <div className="relative flex flex-col items-center justify-center gap-1.5 px-2 pt-1 pb-2 md:px-5 md:pt-1 md:pb-2.5 lg:gap-2 lg:px-6 lg:pt-1.5 lg:pb-3">
          <span className="v3-caption hidden text-muted lg:block">Питание</span>
          <m.button
            ref={tuneScope}
            onClick={offline ? undefined : handleTune}
            disabled={offline}
            aria-disabled={offline}
            aria-pressed={tunedIn}
            aria-label={offline ? 'Эфир выключен' : tunedIn ? 'Выключить' : 'Включить'}
            title={offline ? 'Станция сейчас не в эфире' : tunedIn ? 'Выключить' : 'Включить'}
            data-tuned={tunedIn ? 'true' : 'false'}
            whileTap={offline ? undefined : { scale: 0.95 }}
            transition={{ duration: 0.09, ease: [0.2, 0.7, 0.2, 1] }}
            className="fz-power v3-focus h-10 w-10 md:h-11 md:w-11 lg:h-[50px] lg:w-[50px]"
          >
            <span className={cn('fz-ring', connecting && 'v3-connecting-pulse')} />
          </m.button>
        </div>

        <div className="relative flex min-w-0 items-center justify-center px-1 [border-left:1px_solid_var(--fz-line)] md:px-5 lg:px-6">
          <div className="flex w-full flex-col justify-center gap-1 font-mono lg:gap-1.5">
            <div className="flex items-baseline justify-between gap-1 lg:gap-4">
              <span className="text-[10px] font-semibold whitespace-nowrap text-ink lg:text-[12px] lg:tracking-[0.04em]">
                Сигнал · <b className={cn('font-bold', qualityTone)}>{qualityLabel}</b>
              </span>
              <span
                className="v3-tab-num text-[10px] whitespace-nowrap text-muted lg:text-[12px] lg:tracking-[0.08em]"
                title={listeners != null ? `${ruListeners(listeners)} · ${latencyText}` : latencyText}
                aria-label={listeners != null ? `${ruListeners(listeners)}, ${latencyText}` : latencyText}
              >
                {listeners != null ? `${listeners} ♪ · ${latencyText}` : latencyText}
              </span>
            </div>
            <div className="fz-scale h-8 lg:h-[42px]" aria-hidden="true">
              <div className="fz-ticks" />
              <div
                className="fz-needle"
                ref={(el) => { if (el) el.style.setProperty('--fz-needle-pos', `${needlePct}%`); }}
              >
                <div className="fz-grip" />
              </div>
              <div className="fz-nums">
                {SCALE_NUMS.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col items-center justify-center gap-1.5 px-2 pt-1 pb-2 [border-left:1px_solid_var(--fz-line)] md:px-5 md:pt-1 md:pb-2.5 lg:gap-2 lg:px-6 lg:pt-1.5 lg:pb-3">
          <span className="v3-caption hidden text-muted lg:block">Громкость</span>
          {iosVolumeLocked ? (
            // iOS does not permit volume changes from a web app. Render the
            // familiar control in its native disabled state, not a tappable-
            // looking imitation; VoiceOver explains the hardware route.
            // Fork (W05): it still mirrors the mute, which iOS does honour —
            // pinned at 100 it read as "sound on" while muted.
            <div className="flex items-center gap-2 lg:gap-4">
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : 100}
                disabled
                aria-label="Громкость на iPhone задаётся кнопками устройства"
                aria-valuetext={muted ? 'звук выключен' : undefined}
                className="h-10 w-[50px] cursor-not-allowed opacity-40 lg:h-[48px] lg:w-[136px]"
              />
              {muteButton}
            </div>
          ) : (
            <div className="flex items-center gap-3 lg:gap-4">
              {/* Обычный ползунок вместо круглой ручки апстрима: та отзывалась
                  только на вертикальное протягивание, и на ней спотыкались.
                  Нативный input даёт перетаскивание, клик по дорожке, клавиатуру
                  и озвучивание сам; accent-color красит заполненную часть и
                  бегунок в цвет станции. */}
              <div ref={knobWrapRef} className="flex items-center">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(volume * 100)}
                  onChange={(e) => setVolume(quantizeVolume(Number(e.currentTarget.value) / 100))}
                  onKeyDown={onVolumeKeyDown}
                  aria-label="Громкость"
                  aria-valuetext={`${Math.round(volume * 100)}%`}
                  // accent-color through a utility: inline styles are banned by
                  // the upstream lint (react/forbid-dom-props).
                  className="v3-focus h-10 w-[104px] cursor-pointer accent-[var(--accent)] lg:h-[48px] lg:w-[136px]"
                />
              </div>

              {muteButton}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

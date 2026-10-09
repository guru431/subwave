'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowUpRight, Radio } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { NowPlayingTrack, RequestResult, StationContext } from '@/lib/types';
import { REQUEST_NAME_MAX } from '@/lib/schemas.generated';
import { bindExact, bindPick, pickedSongId, type RequestPick } from '@/lib/requestPick';

const SUCCESS_HOLD_MS = 2800;
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 60000;

// Rules every 30px, as an arbitrary Tailwind `bg-[…]` utility because inline
// styles are banned project-wide. The textarea's `leading-[30px]` must match
// the stripe, and the low contrast keeps sub-pixel baseline drift from reading
// as broken.
const RULED_PAPER =
  'bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_29px,var(--separator-soft)_29px,var(--separator-soft)_30px)]';

// Shown the moment the booth accepts, so there's no dead time before feedback.
// The real on-air ack replaces it once the pick resolves.
function templatedAck(name: string): string {
  const n = name.trim();
  return n
    ? `Принято, ${n} — передаём в студию.`
    : 'Принято — передаём в студию.';
}

interface Suggestion {
  text: string;
  attribution: string;
}

// Ordered most-specific (current track) first, weakest (random) last, capped
// at 5. Each chip carries an attribution saying why it's offered.
function buildSuggestions(
  nowPlaying: NowPlayingTrack | null,
  context: StationContext | null,
): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const push = (text: string, attribution: string) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, attribution });
  };

  if (nowPlaying?.artist) {
    // The controller has a dedicated "more like this" path that picks another
    // song by the on-air artist, hence the artist-named attribution.
    push('more like this', `more ${nowPlaying.artist}`);
  }

  const festival = context?.festival?.name;
  if (festival) {
    push(`${festival.toLowerCase()} mood`, `festival`);
  }

  const vibe = context?.time?.vibe || context?.time?.show;
  if (vibe) {
    push(`${vibe} vibes`, `right now`);
  }

  const cond = context?.weather?.condition;
  const weatherMap: Record<string, string> = {
    clear: 'sunny afternoon',
    sunny: 'sunny afternoon',
    cloudy: 'overcast mood',
    rain: 'rainy day',
    rainy: 'rainy day',
    drizzle: 'rainy day',
    snow: 'snowy night',
    snowy: 'snowy night',
    fog: 'foggy morning',
    foggy: 'foggy morning',
    thunderstorm: 'stormy night',
  };
  if (cond && cond !== 'unknown') {
    push(weatherMap[cond] || `${cond} day`, `weather`);
  }

  push('surprise me', `random`);

  return out.slice(0, 5);
}

// Ответ комнаты на сверку набранного с коллекцией (GET /room/resolve).
// Контроллер в этом пути не участвует: у него весь поиск по библиотеке закрыт
// requireAdmin, а слушателю нужен публичный ответ «есть такой трек или нет».
interface ResolveCandidate {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
  duration: number | null;
}

interface ResolveResult {
  exact: ResolveCandidate | null;
  alternatives: ResolveCandidate[];
}

// Пауза после последнего нажатия клавиши: без неё каждая буква — запрос в
// Navidrome, а набирают тут с телефона.
const RESOLVE_DEBOUNCE_MS = 400;
// Короче трёх символов сверять нечего: ответом будет вся коллекция.
const RESOLVE_MIN_CHARS = 3;

export interface RequestDrawerProps {
  requestText: string;
  setRequestText: (text: string) => void;
  requesterName: string;
  setRequesterName: (name: string) => void;
  isSubmitting: boolean;
  onSubmit: (songId?: string) => Promise<RequestResult | null>;
  onPoll?: (requestId: string) => Promise<RequestResult | null>;
  onClose?: () => void;
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
}

export default function RequestDrawer({
  requestText, setRequestText,
  requesterName, setRequesterName,
  isSubmitting, onSubmit, onPoll, onClose,
  nowPlaying, context,
}: RequestDrawerProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Null while idle. On accept it holds a `pending` success card with the
  // templated ack; polling fills in the real track + on-air ack.
  const [result, setResult] = useState<RequestResult | null>(null);
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  // songId привязан к тексту, при котором выбран (lib/requestPick.ts): правка
  // человеком его отвязывает, подстановка альтернативы в поле — нет.
  const [pick, setPick] = useState<RequestPick | null>(null);
  const songId = pickedSongId(pick, requestText);

  // Сверка набранного с коллекцией. Ответ комнаты — «этот трек есть», «есть
  // похожие» или «нет ничего»; последнее НЕ запрещает отправку: ведущий умеет
  // разбирать настроение и намёк, а не только «артист — название».
  useEffect(() => {
    const query = requestText.trim();
    if (query.length < RESOLVE_MIN_CHARS) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/room/resolve?q=${encodeURIComponent(query)}`);
        if (!r.ok || cancelled) return;
        const body = (await r.json()) as ResolveResult;
        if (cancelled) return;
        setResolved(body);
        const exact = body.exact;
        if (exact) setPick((prev) => bindExact(prev, exact.id, query));
      } catch {
        // Комната недоступна — заказ всё равно уйдёт текстом, и каскад станции
        // его разберёт. Подсказка не обязательна для отправки.
        if (!cancelled) setResolved(null);
      }
    }, RESOLVE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [requestText]);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStopRef = useRef(false);

  useEffect(() => () => {
    pollStopRef.current = true;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const scheduleClose = () => {
    if (!onClose || closeTimerRef.current) return;
    closeTimerRef.current = setTimeout(() => {
      onClose();
      // Deferred past the close animation so the form doesn't flash back in
      // during the slide.
      setTimeout(() => setResult(null), 300);
    }, SUCCESS_HOLD_MS);
  };

  // While pending the templated ack card stays up; on resolve it morphs into
  // the real track + DJ ack, then auto-closes.
  const startPolling = (requestId: string) => {
    pollStopRef.current = false;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const tick = async () => {
      if (pollStopRef.current) return;
      if (Date.now() > deadline) { scheduleClose(); return; }
      const data = await onPoll?.(requestId);
      if (pollStopRef.current) return;
      if (data?.status === 'resolved') {
        setResult(prev => ({
          success: true,
          ack: data.ack || prev?.ack,
          track: data.track,
          queuePosition: data.queuePosition,
        }));
        scheduleClose();
        return;
      }
      if (data?.status === 'failed') {
        setResult({ success: false, message: data.message || 'Ничего не нашлось — попробуйте другие слова.' });
        return;
      }
      if (data?.status === 'unknown') { scheduleClose(); return; }
      // pending, or a transient network null — keep polling.
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  };

  const handleSubmit = async () => {
    // Capture before the await — onSubmit clears requestText on accept.
    const askedText = requestText.trim();
    const askedName = requesterName.trim();
    const data = await onSubmit(songId);
    if (!data) return;
    // 429 / 503 / network error — surface the miss banner, no polling.
    if (!data.success) {
      setResult(data);
      return;
    }
    setResult({
      success: true,
      pending: true,
      ack: templatedAck(askedName),
      requestText: askedText,
    });
    if (data.requestId && onPoll) {
      startPolling(data.requestId);
    } else {
      scheduleClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSend = !isSubmitting && !!requestText.trim();

  return (
    <m.div layout>
      <AnimatePresence mode="wait" initial={false}>
        {result?.success ? (
          <m.div
            key="success"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            <SuccessCard result={result} />
          </m.div>
        ) : (
          <m.div
            key="form"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            <div className="border border-ink bg-field/40 shadow-[3px_3px_0_var(--separator-strong)]">
              <div className="flex items-center justify-between border-b border-ink px-3.5 py-2">
                <span className="inline-flex items-center gap-2">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-vermilion" />
                  </span>
                  <span className="v3-tab-num text-[9px] tracking-[0.34em] text-ink uppercase">
                    Линия открыта
                  </span>
                </span>
                <span className="v3-tab-num inline-flex items-center gap-1.5 text-[9px] tracking-[0.34em] text-muted uppercase">
                  <Radio size={11} strokeWidth={1.75} />
                  Бланк заказа
                </span>
              </div>

              <div className="px-3.5 pt-3 pb-3.5">
                <label className="mb-2 block text-[9px] tracking-[0.3em] text-muted uppercase">
                  Дорогой ведущий —
                </label>
                {/* The textarea is borderless and transparent so only the
                    ruled paper below shows through. */}
                <div className={cn('relative border-l-2 border-l-vermilion pl-3', RULED_PAPER)}>
                  <textarea
                    ref={taRef}
                    value={requestText}
                    onChange={e => { setRequestText(e.target.value); if (result) setResult(null); }}
                    onKeyDown={onKeyDown}
                    placeholder={'поставьте что-нибудь для\nночной дороги…'}
                    rows={3}
                    /* 16px avoids iOS zoom-on-focus. 30px line-height matches the
                       ruled-paper stripe so text sits on the lines. */
                    className="block w-full resize-none border-0 bg-transparent p-0 [font-family:var(--font-display),Georgia,serif] text-[16px] leading-[30px] text-ink italic placeholder:text-muted/70 focus:outline-none"
                  />
                </div>

                <div className="mt-3 flex items-baseline gap-2 border-t border-soft-border pt-3">
                  <span className="[font-family:var(--font-display),Georgia,serif] text-[15px] leading-none text-muted italic">
                    —
                  </span>
                  <input
                    type="text"
                    value={requesterName}
                    onChange={e => setRequesterName(e.target.value)}
                    placeholder="подпись: ваше имя (необязательно)"
                    maxLength={REQUEST_NAME_MAX}
                    className="v3-tab-num min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] tracking-[0.04em] text-ink placeholder:text-muted/70 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Результат сверки скринридер объявляет сам: обёртка в DOM всегда,
                иначе живую область, появившуюся вместе с текстом, не озвучат. */}
            <div aria-live="polite">
              {resolved?.exact && (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  Нашёл в коллекции:{' '}
                  <span className="text-ink">{resolved.exact.artist} — {resolved.exact.title}</span>
                </p>
              )}
              {resolved && !resolved.exact && resolved.alternatives.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <p className="text-[11px] leading-relaxed text-muted">
                    Точного совпадения нет. Может быть, это:
                  </p>
                  {resolved.alternatives.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        const text = `${c.artist} — ${c.title}`;
                        setPick(bindPick(c.id, text));
                        setRequestText(text);
                        taRef.current?.focus();
                      }}
                      className={cn(
                        'v3-focus rounded border px-2 py-1 text-left text-[11px]',
                        songId === c.id
                          ? 'border-vermilion text-ink'
                          : 'border-soft-border text-muted',
                      )}
                    >
                      {c.artist} — {c.title}
                    </button>
                  ))}
                </div>
              )}
              {resolved && !resolved.exact && resolved.alternatives.length === 0 && (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  В коллекции такого нет. Можно всё равно отправить — ведущий читает
                  записку целиком и подберёт что-то близкое.
                </p>
              )}
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Опишите настроение, воспоминание, артиста. Ведущий прочтёт записку,
              поищет в коллекции и ответит вам в эфире.
            </p>

            <SuggestionChips
              nowPlaying={nowPlaying}
              context={context}
              onPick={text => { setRequestText(text); taRef.current?.focus(); }}
            />

            {result && !result.success && (
              <div className="mt-3 border border-[#c0392b] bg-[rgba(192,57,43,0.06)] px-3 py-2.5 text-xs leading-normal text-[#7a2218]">
                {result.message || 'Ничего не нашлось — попробуйте другие слова.'}
              </div>
            )}

            <m.button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              whileTap={{ scale: 0.97 }}
              className={cn(
                'v3-focus group mt-3.5 inline-flex w-full cursor-pointer items-center justify-center gap-2.5 border-0 bg-vermilion px-6 py-3.5 text-center font-[inherit] text-[13px] font-semibold tracking-[0.14em] text-bg uppercase shadow-[0_1px_0_var(--ink)] transition-opacity',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {isSubmitting ? 'Отправляем…' : 'Отправить в студию'}
              <ArrowUpRight
                size={16}
                strokeWidth={2.25}
                className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              />
            </m.button>

            <div className="mt-2 text-center text-[9px] tracking-[0.28em] text-muted uppercase">
              <span className="v3-tab-num">Enter</span> — отправить ·{' '}
              <span className="v3-tab-num">Shift + Enter</span> — новая строка
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}

interface SuccessCardProps {
  result: RequestResult;
}

function SuccessCard({ result }: SuccessCardProps) {
  const { ack, track, queuePosition, pending, requestText } = result;
  return (
    <div className="py-2">
      <div className="mb-[14px] flex items-center gap-2 text-[9px] tracking-[0.4em] text-vermilion uppercase">
        <span className="relative flex h-1.5 w-1.5">
          {pending && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-60" />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-vermilion" />
        </span>
        {pending ? 'На линии' : track ? 'В очереди' : 'Отвечено'}
      </div>

      {ack && (
        <div className="mb-[22px] border-l-2 border-l-vermilion pl-[14px] [font-family:var(--font-display),Georgia,'Times_New_Roman',serif] text-lg leading-snug text-ink italic">
          &ldquo;{ack}&rdquo;
        </div>
      )}

      {/* Skipped entirely on a resolved-but-no-track outcome (a conversational
          reply, not a music request): the ack quote above carries the whole
          answer, and an empty title/artist pair would read as a broken card. */}
      {(pending || track) && (
        <m.div layout className="border-y border-soft-border py-4">
          <div className="mb-1.5 text-[9px] tracking-[0.3em] text-muted uppercase">
            {pending ? 'Ведущий ищет' : 'Сейчас в студии'}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={pending ? 'pending' : 'resolved'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
            >
              {pending ? (
                <>
                  <div className="sw-pulse [font-family:var(--font-display),Georgia,'Times_New_Roman',serif] text-base leading-snug text-ink italic">
                    ищем ваш трек…
                  </div>
                  {requestText && (
                    <div className="mt-1 text-[13px] text-muted">
                      &ldquo;{requestText}&rdquo;
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-[22px] leading-tight font-semibold text-ink">
                    {track?.title}
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted">
                    {track?.artist}
                  </div>
                </>
              )}
            </m.div>
          </AnimatePresence>
        </m.div>
      )}

      {!pending && typeof queuePosition === 'number' && queuePosition > 0 && (
        <div className="v3-tab-num mt-[14px] text-[11px] tracking-[0.15em] text-muted uppercase">
          В очереди: №{queuePosition}
        </div>
      )}

      <div className="mt-[26px] text-[10px] tracking-[0.3em] text-muted uppercase">
        {pending ? 'Можно закрыть — заказ принят' : 'Закрываем…'}
      </div>
    </div>
  );
}

interface SuggestionChipsProps {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  onPick: (text: string) => void;
}

// Chips stagger in after the drawer's slide-in finishes (delayChildren: 0.12)
// so the row doesn't compete with the drawer entrance.
function SuggestionChips({ nowPlaying, context, onPick }: SuggestionChipsProps) {
  // Only the fields buildSuggestions reads: depending on the whole
  // nowPlaying/context objects would recompute on every poll cycle.
  const chips = useMemo(
    () => buildSuggestions(nowPlaying, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowPlaying?.artist, nowPlaying?.title, context?.festival?.name,
     context?.time?.vibe, context?.time?.show, context?.weather?.condition]
  );

  return (
    <div className="mt-3.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[9px] tracking-[0.3em] text-muted uppercase">
          На линии
        </span>
        <span className="h-px flex-1 bg-soft-border" />
      </div>
      <m.div
        className="flex flex-wrap gap-1.5"
        initial="hidden"
        animate="visible"
        variants={{
          hidden:  {},
          visible: { transition: { staggerChildren: 0.04, delayChildren: 0.12 } },
        }}
      >
        {chips.map(chip => (
          <m.button
            key={chip.text}
            type="button"
            onClick={() => onPick(chip.text)}
            variants={{
              hidden:  { opacity: 0, y: 4 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.18 } },
            }}
            whileTap={{ scale: 0.96 }}
            className="v3-focus group cursor-pointer border border-ink bg-transparent px-3 py-1.5 text-left font-[inherit] leading-tight text-ink transition-colors hover:bg-ink hover:text-bg"
            title={`Подсказано через ${chip.attribution}`}
          >
            <span className="block text-[11px] tracking-[0.08em]">
              {chip.text}
            </span>
            <span className="mt-[3px] block text-[8px] tracking-[0.22em] text-muted uppercase transition-colors group-hover:text-bg/70">
              {chip.attribution}
            </span>
          </m.button>
        ))}
      </m.div>
    </div>
  );
}

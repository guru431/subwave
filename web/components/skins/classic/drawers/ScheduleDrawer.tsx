'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { fmtClockMinute, normalizeStationLocale, zonedDayHour } from '@/lib/format';
import type {
  ActiveShow,
  ScheduleGrid,
  SchedulePayload,
  SchedulePersona,
  ScheduleShow,
  StationLocale,
  StationContext,
} from '@/lib/types';
import { useStationClient } from '@/lib/stationClient';

const DAY_LABELS = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

export interface ScheduleDrawerProps {
  /** What's on right now, fed from `useStationFeed` so the on-now card stays
   *  fresh without re-fetching `/schedule`. */
  activeShow: ActiveShow | null;
  /** Station context from `/now-playing`, for the location label. */
  context: StationContext | null;
}

interface Slot {
  hour: number;
  show: ScheduleShow | null;
  persona: SchedulePersona | null;
  /** Last hour of this run (inclusive) — used to render block ranges like
   *  `02:00–04:00`. Filled in during the dedupe pass. */
  endHour: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtHourRange(start: number, end: number, locale: StationLocale): string {
  return `${fmtHour(start, locale)} – ${fmtHour((end + 1) % 24, locale)}`;
}

function fmtHour(start: number, locale: StationLocale): string {
  if (locale === 'en-US') {
    const hour = start % 24;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return `${hour % 12 || 12}:00 ${suffix}`;
  }
  return `${pad2(start)}:00`;
}

/** Collapse adjacent same-show hours into a single row so a 4-hour block reads
 *  as one entry. Autonomous (null) hours are also collapsed. */
function collapseSlots(dayGrid: Array<string | null>, shows: ScheduleShow[], personas: SchedulePersona[]): Slot[] {
  const showById = new Map(shows.map(s => [s.id, s]));
  const personaById = new Map(personas.map(p => [p.id, p]));
  const out: Slot[] = [];
  let i = 0;
  while (i < 24) {
    const id = dayGrid[i] ?? null;
    let j = i;
    while (j + 1 < 24 && (dayGrid[j + 1] ?? null) === id) j++;
    const show = id ? showById.get(id) || null : null;
    const persona = show ? personaById.get(show.personaId) || null : null;
    out.push({ hour: i, endHour: j, show, persona });
    i = j + 1;
  }
  return out;
}

function endHourForCurrentBlock(grid: ScheduleGrid, day: number, hour: number): number {
  const dayGrid = grid[day];
  if (!Array.isArray(dayGrid)) return hour;
  const current = dayGrid[hour] ?? null;
  let h = hour;
  while (h + 1 < 24 && (dayGrid[h + 1] ?? null) === current) h++;
  return h;
}

export default function ScheduleDrawer({ activeShow, context }: ScheduleDrawerProps) {
  const client = useStationClient();
  const [data, setData] = useState<SchedulePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [viewDay, setViewDay] = useState<number>(() => new Date().getDay());
  // Stops the auto-sync below so a manual day pick sticks across ticks.
  const [userPickedDay, setUserPickedDay] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await client.schedule();
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // 1s rather than 60s because the station clock at the top needs sub-minute
  // ticks; only runs while the drawer is open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // viewDay seeds from the browser's day; snap to the station's today once the
  // schedule (and its timezone) lands, unless the listener picked a day.
  useEffect(() => {
    if (!data || userPickedDay) return;
    setViewDay(zonedDayHour(new Date(), data.timezone ?? null).dow);
  }, [data, userPickedDay]);

  // Station timezone, not the viewer's: the controller resolves the active
  // show off the same wall clock, so the on-now card names the show that is
  // actually on air (#418). Safe before `data` loads — zonedDayHour falls back
  // to local time on a nullish tz.
  const { dow: today, hour: currentHour } = zonedDayHour(now, data?.timezone ?? null);

  const daySlots = useMemo(() => {
    if (!data) return [];
    return collapseSlots(data.schedule[viewDay] ?? Array(24).fill(null), data.shows, data.personas);
  }, [data, viewDay]);

  // Drop everything before the next slot; mid-block, advance past this block.
  const upcomingSlots = useMemo(() => {
    if (!data || viewDay !== today) return daySlots;
    const blockEnd = endHourForCurrentBlock(data.schedule, today, currentHour);
    return daySlots.filter(s => s.hour > blockEnd);
  }, [data, daySlots, viewDay, today, currentHour]);

  const onNow = useMemo(() => {
    if (!data) return null;
    const todayGrid = data.schedule[today];
    if (!Array.isArray(todayGrid)) return null;
    const id = todayGrid[currentHour] ?? null;
    if (!id) return null;
    const show = data.shows.find(s => s.id === id) || null;
    if (!show) return null;
    const persona = data.personas.find(p => p.id === show.personaId) || null;
    const endHour = endHourForCurrentBlock(data.schedule, today, currentHour);
    return { show, persona, endHour };
  }, [data, today, currentHour]);

  if (err) {
    return (
      <div className="text-[13px] leading-relaxed text-[var(--danger)]">
        couldn’t load schedule: {err}
      </div>
    );
  }
  if (!data) {
    return <div className="text-[13px] text-muted italic">loading…</div>;
  }

  const hasAnyShow = data.shows.length > 0;
  const locale = normalizeStationLocale(data.locale);
  if (!hasAnyShow) {
    return (
      <div className="grid gap-6">
        <StationHeader
          now={now}
          timezone={data.timezone ?? null}
          locale={locale}
          location={context?.weather?.location ?? null}
        />
        <div className="text-[13px] leading-relaxed text-muted">
          No shows scheduled — the station is running autonomously. The DJ picks
          tracks by the time of day, the weather, and any festival on the
          calendar.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <StationHeader
        now={now}
        timezone={data.timezone ?? null}
        locale={locale}
        location={context?.weather?.location ?? null}
      />
      <OnNowCard onNow={onNow} activeShow={activeShow} locale={locale} />

      <section>
        <SectionLabel>
          {viewDay === today ? 'Сегодня в эфире' : `Расписание: ${DAY_LABELS[viewDay]}`}
        </SectionLabel>
        {upcomingSlots.length === 0 ? (
          <div className="text-[13px] text-muted">
            На сегодня больше ничего не запланировано.
          </div>
        ) : (
          <ul className="grid">
            {upcomingSlots.map(slot => (
              <ScheduleRow
                key={`${viewDay}-${slot.hour}`}
                slot={slot}
                isNow={viewDay === today && slot.hour <= currentHour && currentHour <= slot.endHour}
                locale={locale}
              />
            ))}
          </ul>
        )}
      </section>

      <DayTabs
        value={viewDay}
        today={today}
        onChange={d => {
          setUserPickedDay(true);
          setViewDay(d);
        }}
      />
    </div>
  );
}

function StationHeader({
  now,
  timezone,
  locale,
  location,
}: {
  now: Date;
  timezone: string | null;
  locale: StationLocale;
  location: string | null;
}) {
  // Falls back to the viewer's local TZ when the payload carries none.
  const time = fmtClockMinute(now, timezone, locale);
  return (
    <section className="flex items-end justify-between gap-4 border-b border-separator-soft pb-3">
      <div>
        <div className="text-[9px] tracking-[0.3em] text-muted uppercase">Время станции</div>
        <div className="v3-tab-num mt-1 text-2xl leading-none font-semibold text-ink">
          {time}
        </div>
      </div>
      {location && (
        <div className="text-right">
          <div className="text-[9px] tracking-[0.3em] text-muted uppercase">Город</div>
          <div className="mt-1 text-sm text-ink">{location}</div>
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-[10px] text-[9px] tracking-[0.3em] text-muted uppercase">
      {children}
    </div>
  );
}

function AvatarThumb({ avatar, name, tier }: { avatar: string; name: string; tier: 'lg' | 'sm' }) {
  // `avatar` is always a URL (the public endpoint serves a placeholder), so
  // this renders unconditionally with initials underneath while it loads. Two
  // fixed sizes rather than a dynamic one, so Tailwind can generate the classes
  // without a `style={…}` escape hatch.
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const px = tier === 'lg' ? 64 : 36;
  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden border border-ink bg-[var(--ink-softer)]',
        tier === 'lg' ? 'h-16 w-16' : 'h-9 w-9',
      )}
    >
      <span
        className={cn(
          'absolute inset-0 grid place-items-center font-extrabold text-muted',
          tier === 'lg' ? 'text-[16px]' : 'text-[12px]',
        )}
      >
        {initials || '?'}
      </span>
      {avatar && (
        <img
          src={avatar}
          alt=""
          width={px}
          height={px}
          className="relative h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function OnNowCard(props: {
  onNow: { show: ScheduleShow; persona: SchedulePersona | null; endHour: number } | null;
  activeShow: ActiveShow | null;
  locale: StationLocale;
}) {
  const { onNow, activeShow, locale } = props;
  const client = useStationClient();
  if (!onNow) {
    return (
      <section>
        <SectionLabel>Сейчас</SectionLabel>
        <div className="border border-separator-strong p-4">
          <div className="text-[15px] leading-tight font-semibold">Без ведущего</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">
            No host scheduled for this hour — the station is picking tracks on
            its own based on the time of day and the weather.
          </div>
        </div>
      </section>
    );
  }
  const personaName = onNow.persona?.name || activeShow?.persona?.name || 'Ведущий';
  // The controller emits avatar paths without the `/api` prefix so each
  // surface prepends its own origin; empty input stays empty so <img> falls
  // back to the initials placeholder.
  const avatar = client.resolve(onNow.persona?.avatar || activeShow?.persona?.avatar || '');
  // Only known for the LIVE show — /state exposes no future rosters, so
  // upcoming slots stay host-only.
  const guestNames = (activeShow?.guests || []).map(g => g?.name).filter(Boolean);
  return (
    <section>
      <SectionLabel>On now · until {fmtHour((onNow.endHour + 1) % 24, locale)}</SectionLabel>
      <div className="flex gap-4 border border-separator-strong p-4">
        <AvatarThumb avatar={avatar} name={personaName} tier="lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] tracking-[0.3em] text-vermilion uppercase">
            {personaName}
            {guestNames.length > 0 && (
              <span className="text-muted"> · with {guestNames.join(' & ')}</span>
            )}
          </div>
          <div className="mt-0.5 text-lg leading-tight font-semibold">
            {onNow.show.name}
          </div>
          {onNow.show.topic && (
            <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted">
              {onNow.show.topic}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ScheduleRow({ slot, isNow, locale }: { slot: Slot; isNow: boolean; locale: StationLocale }) {
  const client = useStationClient();
  const personaName = slot.persona?.name || (slot.show ? 'Ведущий' : null);
  const avatar = client.resolve(slot.persona?.avatar || '');
  const time = slot.hour === slot.endHour ? fmtHour(slot.hour, locale) : fmtHourRange(slot.hour, slot.endHour, locale);
  return (
    <li
      className={cn(
        'flex items-center gap-3 border-b border-separator-soft py-[11px]',
        isNow && 'bg-[var(--ink-softer)]',
      )}
    >
      <span className="v3-tab-num w-[88px] shrink-0 text-[11px] tracking-[0.2em] text-muted uppercase">
        {time}
      </span>
      {slot.show ? (
        <>
          <AvatarThumb avatar={avatar} name={personaName || '?'} tier="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm leading-tight text-ink">
              {slot.show.name}
            </div>
            {personaName && (
              <div className="truncate text-[11px] text-muted">{personaName}</div>
            )}
          </div>
        </>
      ) : (
        <span className="text-[11px] tracking-[0.2em] text-muted uppercase">
          autonomous
        </span>
      )}
    </li>
  );
}

function DayTabs({ value, today, onChange }: { value: number; today: number; onChange: (d: number) => void }) {
  return (
    <nav aria-label="День расписания" className="grid grid-cols-7 gap-1 border-t border-ink pt-3">
      {DAY_LABELS.map((label, i) => {
        const isActive = i === value;
        const isToday = i === today;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(i)}
            className={cn(
              'v3-focus py-2 text-[10px] tracking-[0.25em] uppercase',
              isActive
                ? 'border border-ink bg-ink text-bg'
                : 'border border-transparent text-muted hover:text-ink',
            )}
            aria-pressed={isActive}
          >
            {label}
            {isToday && !isActive && <span className="ml-1 text-vermilion">·</span>}
          </button>
        );
      })}
    </nav>
  );
}

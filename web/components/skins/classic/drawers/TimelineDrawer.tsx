'use client';

import type { ReactNode } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { relTime } from '@/lib/format';
import { ruAgo } from '@/lib/ru';
import { cn } from '@/lib/cn';
import { downloadUrl } from '@/lib/download';
import DislikeMenu from '../DislikeMenu';
import type { QueueEntry } from '@/lib/types';

export interface TimelineDrawerProps {
  upcoming?: QueueEntry[];
  history?: QueueEntry[];
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="pt-1 pb-[10px] text-[9px] tracking-[0.3em] text-muted uppercase">
      {children}
    </div>
  );
}

export default function TimelineDrawer({ upcoming, history }: TimelineDrawerProps) {
  const hasUpcoming = !!upcoming?.length;
  const hasHistory = !!history?.length;

  if (!hasUpcoming && !hasHistory) {
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        Пока ничего не прозвучало. Ведущий подбирает музыку сам — закажите трек, и он
        встанет первым в очередь.
      </div>
    );
  }

  return (
    <div>
      {hasUpcoming && (
        <div className={cn(hasHistory && 'mb-6')}>
          <SectionLabel>Дальше в эфире</SectionLabel>
          {upcoming?.map((t, i) => (
            <div
              key={`q-${i}`}
              className="flex items-baseline gap-[14px] border-b border-separator-strong py-[14px]"
            >
              <span className="v3-tab-num w-9 text-[28px] font-extralight text-muted">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-lg leading-tight font-semibold">{t.title}</div>
                <div className="mt-0.5 text-xs text-muted">{t.artist}</div>
                {t.requestedBy && (
                  <div className="mt-1 text-[9px] tracking-[0.3em] text-vermilion uppercase">
                    ↳ заказ: {t.requestedBy}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasHistory && (
        <div>
          <SectionLabel>Уже прозвучало</SectionLabel>
          {history?.map((t, i) => (
            <div
              key={`h-${i}`}
              className="flex items-baseline justify-between gap-3 border-b border-separator-soft py-[11px]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{t.title}</div>
                <div className="truncate text-[11px] text-muted">{t.artist}</div>
              </div>
              {t.t && (
                <span className="v3-tab-num shrink-0 text-[10px] tracking-eyebrow text-muted uppercase">
                  {ruAgo(relTime(t.t))}
                </span>
              )}
              {t.subsonic_id && (
                <span className="flex shrink-0 items-center gap-[10px]">
                  <DislikeMenu songId={t.subsonic_id} title={t.title} artist={t.artist} size={14} />
                  <a
                    href={downloadUrl(t.subsonic_id)}
                    download
                    aria-label={`Скачать: ${t.artist} — ${t.title}`}
                    title="Скачать"
                    className="v3-focus inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-muted transition-colors hover:text-ink"
                  >
                    <ArrowDownToLine size={14} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

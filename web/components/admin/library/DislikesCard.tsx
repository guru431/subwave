'use client';

// Dislikes (Blocked tab): listeners mark tracks and artists with 👎 in the
// player; the room (station/room) keeps the marks and turns them into block
// suggestions. A dislike never changes the air by itself — Block here is the
// only way it does. Two backends on purpose: suggestions and decisions come
// from /room/admin/dislikes (the room has the controller check this same Basic
// token), blocking and the "already blocked" filter from the controller.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Check, RefreshCw } from 'lucide-react';
import { useAdminAuth } from '../../../lib/adminAuth';
import {
  AdminResponseError, adminJson, adminResponse, useAdminQuery,
} from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { Card, Btn } from '../ui';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import {
  checkRows, parseSuggestions, reasonLine, withoutBlocked,
  type Suggestion, type Suggestions,
} from '@/lib/dislikeSuggestions';
import { useLibrary } from './LibraryContext';
import { libraryKeys } from './queries';
import { useAdminMutation } from './useAdminQuery';

// The room's refusals in the operator's words. Its 401 comes without
// WWW-Authenticate on purpose, so the browser never pops its own dialog.
const ROOM_ERRORS: Record<number, string> = {
  401: 'the room did not accept the admin sign-in — sign in again',
  429: 'too many wrong passwords — the controller locked sign-in for a while',
  502: "the room couldn't reach the controller",
};

const ROOM_UNREACHABLE = 'the room is unreachable';

// The room is not the controller, so these are plain fetches with the same
// Basic token, not adminFetch. The READ is inline in the query's `request`
// (scripts/audit-admin-query.mjs accepts a GET only there); this pair only
// builds headers and judges the answer.
function roomHeaders(auth: string | null, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Basic ${auth}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function roomBody(r: Response): Promise<unknown> {
  if (!r.ok) throw new Error(ROOM_ERRORS[r.status] ?? `the room answered ${r.status}`);
  return r.json();
}

async function roomDecide(auth: string | null, body: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch('/room/admin/dislikes/decide', {
      method: 'POST',
      headers: roomHeaders(auth, true),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(ROOM_UNREACHABLE);
  }
  return roomBody(r);
}

function Group({ label, items, busy, onBlock, onKeep }: {
  label: string;
  items: Suggestion[];
  busy: boolean;
  onBlock: (s: Suggestion) => void;
  onKeep: (s: Suggestion) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <div className="border-b border-dashed border-[var(--separator-strong)] px-4 py-2 text-[10px] tracking-wider text-muted uppercase">
        {label} · {items.length}
      </div>
      {items.map(s => (
        <div key={`${s.kind}:${s.key}`} className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
          <span className="lib-mtag shrink-0" title={`disliked ${s.kind}`}>{s.kind}</span>
          <div className="min-w-0 flex-1">
            <div className="lib-title">{s.kind === 'artist' ? s.artist : s.title}</div>
            <div className="lib-artist">
              {s.kind === 'track' && s.artist ? `${s.artist} · ` : ''}{reasonLine(s)}
            </div>
          </div>
          <span className="hidden text-[11px] text-muted sm:block" title="last dislike">
            {s.lastAt ? new Date(s.lastAt).toLocaleDateString('en-GB') : ''}
          </span>
          <Btn sm tone="accent" onClick={() => onBlock(s)} disabled={busy}>
            <Ban size={12} /> Block
          </Btn>
          <Btn sm onClick={() => onKeep(s)} disabled={busy} title="keep it on air — hidden until a newer dislike">
            <Check size={12} /> Keep
          </Btn>
        </div>
      ))}
    </>
  );
}

export function DislikesCard() {
  const { adminFetch, ready, restampBlockMarks } = useLibrary();
  const { auth, hydrated } = useAdminAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const q = useAdminQuery<Suggestions>({
    key: libraryKeys.dislikes(),
    adminFetch,
    enabled: ready && hydrated && !!auth,
    // Normalised inside the request (web/CLAUDE.md, rule 3): the cache holds
    // exactly what renders — suggestions minus whatever the blocklist catches.
    request: async (fetcher, signal) => {
      let r: Response;
      try {
        r = await fetch('/room/admin/dislikes', { headers: roomHeaders(auth), signal });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new Error(ROOM_UNREACHABLE);
      }
      const all = parseSuggestions(await roomBody(r));
      const tracks = checkRows(all);
      if (!tracks.length) return all;
      let j: { blocked?: Record<string, unknown> };
      try {
        j = await adminJson<{ blocked?: Record<string, unknown> }>(fetcher, '/library/blocklist/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks }),
        }, signal);
      } catch (err) {
        if (err instanceof AdminResponseError) throw new Error(`blocklist check failed (${err.status})`);
        throw err;
      }
      return withoutBlocked(all, j.blocked ?? {});
    },
  });

  // The controller half of Block. Toasts and the room's half stay in `block`.
  const blockMutation = useAdminMutation<void, Suggestion>({
    request: async (s, fetcher) => {
      try {
        await adminResponse(fetcher, '/library/blocklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: s.kind, trackId: s.songId }),
        });
      } catch (err) {
        if (!(err instanceof AdminResponseError)) throw err;
        // 409 = already on the list: for the operator that is the same success.
        if (err.status === 409) return;
        const { error } = err.body as { error?: unknown };
        throw new Error(typeof error === 'string' && error ? error : `block failed (${err.status})`);
      }
    },
    toastOnError: false,
  });

  const decide = (s: Suggestion, action: 'keep' | 'blocked') =>
    roomDecide(auth, { kind: s.kind, key: s.key, action });

  const block = async (s: Suggestion) => {
    setBusy(true);
    try {
      await blockMutation.mutateAsync(s);
      notify.ok(`“${s.kind === 'artist' ? s.artist : s.title}” will never air`);
      // The block stands even if the room can't record the decision: the
      // blocklist filter still hides the row; it would only come back after an
      // unblock, which is what this toast warns about.
      try {
        await decide(s, 'blocked');
      } catch (err) {
        notify.err(`blocked, but the room didn't record the decision: ${errorMessage(err)}`);
      }
      void qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
      await restampBlockMarks();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
      void q.refetch();
    }
  };

  const keep = async (s: Suggestion) => {
    setBusy(true);
    try {
      await decide(s, 'keep');
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
      void q.refetch();
    }
  };

  const data = q.data;
  const total = data ? data.artists.length + data.tracks.length : 0;

  return (
    <Card
      title="Dislikes"
      sub={data && total ? `${total} to review — a dislike never blocks by itself` : ''}
      right={
        <Btn sm onClick={() => { void q.refetch(); }} disabled={q.isFetching}>
          <RefreshCw size={11} /> {q.isFetching ? 'Loading…' : 'Refresh'}
        </Btn>
      }
      bodyClass="!p-0"
    >
      {q.isError ? (
        <div className="m-4">
          <ErrorState
            title="Can't load dislikes"
            error={errorMessage(q.error)}
            onRetry={() => { void q.refetch(); }}
            retrying={q.isFetching}
          >
            <p>Suggestions come from the chat room service; the rest of this tab works without it.</p>
          </ErrorState>
        </div>
      ) : !data ? (
        <SkeletonRows rows={3} className="m-4" />
      ) : total === 0 ? (
        <EmptyState
          compact
          title="No dislikes to review"
          description="Listeners mark tracks and artists with 👎 in the player."
        />
      ) : (
        <div className={cn(q.isFetching && 'opacity-60 transition-opacity')}>
          <Group label="Artists" items={data.artists} busy={busy}
            onBlock={s => { void block(s); }} onKeep={s => { void keep(s); }} />
          <Group label="Tracks" items={data.tracks} busy={busy}
            onBlock={s => { void block(s); }} onKeep={s => { void keep(s); }} />
        </div>
      )}
    </Card>
  );
}

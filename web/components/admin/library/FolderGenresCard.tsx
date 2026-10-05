'use client';

// Folder genres (Blocked tab): the genre a track WITHOUT a genre tag takes from
// its folder, or from the nearest parent folder that has one. Genre and
// Any-tag rules and genre shows read it. The tree shows only branches holding
// untagged tracks by default; the table is saved whole (PUT /library/folder-genres).

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { Card, Btn } from '../ui';
import { Input } from '../../ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { buildFolderTree, type FolderNode, type FolderStat } from '@/lib/folderTree';
import { FolderTree } from './FolderTree';
import { ValuesInput } from './BlockRulesCard';

type Table = Record<string, string[]>;

// Order-insensitive fingerprint of the assigned (non-empty) entries — what
// "is there anything to save" compares.
const fingerprint = (t: Table) =>
  JSON.stringify(Object.entries(t).filter(([, g]) => g.length).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function FolderGenresCard({ onChanged }: { onChanged?: () => void }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [root, setRoot] = useState<FolderNode | null | undefined>(undefined); // undefined = loading
  const [withoutPath, setWithoutPath] = useState(0);
  const [draft, setDraft] = useState<Table>({});
  const [saved, setSaved] = useState<Table>({});
  const [genres, setGenres] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [untaggedOnly, setUntaggedOnly] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/library/folders');
      if (!r.ok) throw new Error(`folders load failed (${r.status})`);
      const j = await r.json() as { folders?: FolderStat[]; withoutPath?: number };
      const list = j.folders || [];
      const table: Table = {};
      for (const f of list) if (f.genres?.length) table[f.path] = [...f.genres];
      setRoot(buildFolderTree(list));
      setWithoutPath(j.withoutPath || 0);
      setDraft(table);
      setSaved(table);
    } catch (e) {
      notify.err(errorMessage(e));
      setRoot(prev => prev ?? null);
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
    void (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (r.ok) {
          const j = await r.json() as { genres?: Array<{ value: string }> };
          setGenres((j.genres || []).map(g => g.value).filter(Boolean));
        }
      } catch {}
    })();
  }, [hydrated, needsAuth, load, adminFetch]);

  const save = async () => {
    setBusy(true);
    try {
      const entries = Object.entries(draft)
        .filter(([, g]) => g.length)
        .map(([folder, g]) => ({ folder, genres: g }));
      const r = await adminFetch('/library/folder-genres', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const j = await r.json().catch(() => ({})) as { purged?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(`Folder genres saved${j.purged ? ` — ${j.purged} queued track${j.purged === 1 ? '' : 's'} dropped` : ''}`);
      setEditing(null);
      await load();
      onChanged?.();
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  const dirty = fingerprint(draft) !== fingerprint(saved);
  const keep = untaggedOnly
    ? (n: FolderNode) => n.untagged > 0 || (draft[n.path]?.length ?? 0) > 0
    : undefined;
  const suggestions = [...new Set([...genres, ...Object.values(draft).flat()])];

  return (
    <Card
      title="Folder genres"
      sub="A track without a genre tag takes the genre of its folder, or of the nearest parent folder that has one. Genre and Any-tag rules and the genre filters of shows read it; Navidrome's own genre search does not."
      right={
        <Btn sm tone="accent" onClick={() => { void save(); }} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </Btn>
      }
    >
      {root === undefined ? (
        <SkeletonRows rows={3} />
      ) : root === null ? (
        <EmptyState
          compact
          title="No folders yet"
          description={<>Folders appear after Reconcile with Navidrome, once Navidrome reports real paths to the station.</>}
        />
      ) : (
        <div className="grid gap-3">
          {withoutPath > 0 && (
            <div className="field-hint">
              {withoutPath === 1 ? '1 track has' : `${withoutPath} tracks have`} no real path — folder rules and folder genres cannot see them.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="find a folder…"
              aria-label="find a folder"
              className="max-w-xs"
            />
            <label className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input type="checkbox" checked={untaggedOnly} onChange={() => setUntaggedOnly(v => !v)} />
              <span>Only folders with untagged tracks</span>
            </label>
          </div>
          <FolderTree
            root={root}
            query={query}
            keep={keep}
            renderMeta={n => {
              const assigned = draft[n.path] ?? [];
              return (
                <span className="flex items-center gap-2">
                  {n.untagged > 0 && (
                    <span className="mono-num text-[10px] text-muted" title="tracks without a genre tag, subfolders included">
                      {n.untagged} untagged
                    </span>
                  )}
                  {editing === n.path ? (
                    <span className="w-56">
                      <ValuesInput
                        id={`fg-${encodeURIComponent(n.path)}`}
                        values={assigned}
                        onChange={v => setDraft(d => ({ ...d, [n.path]: v }))}
                        placeholder="genre, Enter to add"
                        suggestions={suggestions}
                      />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing(n.path)}
                      className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-muted hover:text-ink hover:underline"
                    >
                      {assigned.length ? assigned.join(', ') : 'set genre'}
                    </button>
                  )}
                </span>
              );
            }}
          />
        </div>
      )}
    </Card>
  );
}

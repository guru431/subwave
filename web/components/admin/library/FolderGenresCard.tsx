'use client';

// Folder genres (Blocked tab): the genre a track WITHOUT a genre tag takes from
// its folder, or from the nearest parent folder that has one. Genre and
// Any-tag rules and genre shows read it. The tree shows only branches holding
// untagged tracks by default; the table is saved whole (PUT /library/folder-genres).

import { useMemo, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { AdminResponseError, adminJson } from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { Card, Btn } from '../ui';
import { Input } from '../../ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { buildFolderTree, type FolderNode } from '@/lib/folderTree';
import { FolderTree } from './FolderTree';
import { ValuesInput } from './BlockRulesCard';
import { libraryKeys, parseFolders, parseGenreNames, type FolderData } from './queries';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';

type Table = Record<string, string[]>;

// Order-insensitive fingerprint of the assigned (non-empty) entries — what
// "is there anything to save" compares.
const fingerprint = (t: Table) =>
  JSON.stringify(Object.entries(t).filter(([, g]) => g.length).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function FolderGenresCard({ onChanged }: { onChanged?: () => void }) {
  const { needsAuth, hydrated } = useAdminAuth();
  // Null = untouched: the editor follows the saved table, so a refetch (another
  // card's Retry, the post-save invalidation) never overwrites unsaved edits.
  const [draft, setDraft] = useState<Table | null>(null);
  const [query, setQuery] = useState('');
  const [untaggedOnly, setUntaggedOnly] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same keys and parses as BlockRulesCard's picker vocab: one cache entry each.
  const foldersQuery = useAdminQuery<FolderData>({
    key: libraryKeys.folders(),
    path: '/library/folders',
    parse: parseFolders,
    toastOnError: true,
  });
  const genresQuery = useAdminQuery<string[]>({
    key: libraryKeys.genres(),
    path: '/library/genres',
    parse: parseGenreNames,
  });
  const folderData = foldersQuery.data;
  const root = useMemo(() => buildFolderTree(folderData?.list ?? []), [folderData]);
  const saved = useMemo(() => {
    const table: Table = {};
    for (const f of folderData?.list ?? []) if (f.genres?.length) table[f.path] = [...f.genres];
    return table;
  }, [folderData]);
  const withoutPath = folderData?.withoutPath ?? 0;
  const table = draft ?? saved;

  type SaveReceipt = { purged?: number };
  const saveMutation = useAdminMutation<SaveReceipt, Table>({
    request: async (t, fetcher) => {
      const entries = Object.entries(t)
        .filter(([, g]) => g.length)
        .map(([folder, g]) => ({ folder, genres: g }));
      try {
        return await adminJson<SaveReceipt>(fetcher, '/library/folder-genres', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries }),
        });
      } catch (e) {
        if (!(e instanceof AdminResponseError)) throw e;
        const { error } = e.body as { error?: unknown };
        throw new Error(typeof error === 'string' && error ? error : `failed (${e.status})`);
      }
    },
    // The saved table is the cache: wait for the fresh read before the editor
    // drops its draft, or it would flash the old table in between.
    onDone: async (_receipt, _table, client) => {
      await client.invalidateQueries({ queryKey: libraryKeys.folders(), exact: true });
    },
    toastOnError: false,
  });

  const save = async () => {
    setBusy(true);
    try {
      const j = await saveMutation.mutateAsync(table);
      notify.ok(`Folder genres saved${j.purged ? ` — ${j.purged} queued track${j.purged === 1 ? '' : 's'} dropped` : ''}`);
      setEditing(null);
      setDraft(null);
      onChanged?.();
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  const dirty = fingerprint(table) !== fingerprint(saved);
  const keep = untaggedOnly
    ? (n: FolderNode) => n.untagged > 0 || (table[n.path]?.length ?? 0) > 0
    : undefined;
  const suggestions = [...new Set([...(genresQuery.data ?? []), ...Object.values(table).flat()])];

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
      {!folderData && foldersQuery.isError ? (
        <ErrorState
          title="Can't load folders"
          error={errorMessage(foldersQuery.error)}
          onRetry={() => { void foldersQuery.refetch(); }}
          retrying={foldersQuery.isFetching}
        />
      ) : !folderData ? (
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
              const assigned = table[n.path] ?? [];
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
                        onChange={v => setDraft(d => ({ ...(d ?? saved), [n.path]: v }))}
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

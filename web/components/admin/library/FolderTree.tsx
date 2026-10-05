'use client';

// The library's folders as a collapsible tree — the Blocked tab's folder picker
// (Folder rules) and the folder-genre editor share it. Tree building and
// filtering live in lib/folderTree (pure, tested); this only renders.

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { filterTree, type FolderNode } from '@/lib/folderTree';

export function FolderTree({ root, query = '', keep, checked, onToggle, renderMeta }: {
  root: FolderNode;
  query?: string;
  keep?: (n: FolderNode) => boolean;
  // Selectable mode when both are given. The root never gets a checkbox:
  // blocking the whole library would silence the station.
  checked?: string[];
  onToggle?: (path: string) => void;
  renderMeta?: (n: FolderNode) => ReactNode;
}) {
  // Expanded folders, by path. The root starts open; while searching, every
  // branch leading to a hit is open, so a match is never buried.
  const [open, setOpen] = useState<Set<string>>(() => new Set([root.path]));
  const shown = filterTree(root, query, keep);
  const searching = query.trim().length > 0;
  if (!shown) return <div className="field-hint">No folders match.</div>;

  const toggle = (path: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const renderNode = (n: FolderNode, depth: number): ReactNode => {
    const hasKids = n.children.length > 0;
    const expanded = hasKids && (searching || open.has(n.path));
    const selectable = !!checked && !!onToggle && depth > 0;
    const selected = selectable && (checked?.includes(n.path) ?? false);
    return (
      <div key={n.path || '/'} role="treeitem" aria-selected={selected}
        aria-expanded={hasKids ? expanded : undefined}>
        <div className="flex items-center gap-1.5 py-0.5 text-[12px]">
          {hasKids ? (
            <button
              type="button"
              onClick={() => toggle(n.path)}
              disabled={searching}
              aria-label={`${expanded ? 'collapse' : 'expand'} ${n.name}`}
              className="cursor-pointer border-0 bg-transparent p-0 leading-none text-muted hover:text-ink"
            >
              {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button>
          ) : (
            <span className="inline-block w-3" aria-hidden />
          )}
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggle?.(n.path)}
              aria-label={`select ${n.name}`}
            />
          )}
          <span className="min-w-0 flex-1 truncate" title={n.path}>{n.name}</span>
          {renderMeta?.(n)}
        </div>
        {/* A fixed 14px per level, applied to the CHILDREN wrapper rather than
            each row's own padding, so indentation compounds through normal
            box nesting instead of a computed `depth * 14` inline style. */}
        {expanded && (
          <div className="pl-[14px]">
            {n.children.map(c => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return <div role="tree" className="grid max-h-72 overflow-auto">{renderNode(shown, 0)}</div>;
}

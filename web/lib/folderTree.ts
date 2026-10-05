// The library's folders as a tree for the Blocked tab, built from the flat
// GET /library/folders list (every folder holding tracks plus its ancestors,
// counts cumulative). Pure and React-free — pinned by folderTree.test.ts.

export interface FolderStat {
  path: string;      // absolute, as Navidrome reports it to the station
  total: number;     // tracks beneath, subfolders included
  untagged: number;  // of those, tracks without a genre tag
  genres: string[];  // genres assigned to exactly this folder
}

export interface FolderNode extends FolderStat {
  name: string;
  children: FolderNode[];
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parentPath = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

function sortTree(n: FolderNode): void {
  n.children.sort((a, b) => a.name.localeCompare(b.name));
  n.children.forEach(sortTree);
}

// The chain of single-child folders from the top down to the library root
// (/mnt → /mnt/nas → … → Music) collapses into ONE root node named by its
// full path: nobody browses four empty levels to reach the music. A folder
// holding tracks of its own stops the collapse.
export function buildFolderTree(stats: readonly FolderStat[]): FolderNode | null {
  if (!stats.length) return null;
  const byPath = new Map<string, FolderNode>();
  for (const s of stats) {
    byPath.set(s.path, { ...s, genres: [...(s.genres ?? [])], name: baseName(s.path), children: [] });
  }
  const tops: FolderNode[] = [];
  for (const node of byPath.values()) {
    const parent = byPath.get(parentPath(node.path));
    if (parent) parent.children.push(node);
    else tops.push(node);
  }
  const [firstTop, ...otherTops] = tops;
  let root: FolderNode = firstTop && !otherTops.length
    ? firstTop
    : {
        path: '',
        name: '/',
        genres: [],
        children: tops,
        total: tops.reduce((n, t) => n + t.total, 0),
        untagged: tops.reduce((n, t) => n + t.untagged, 0),
      };
  for (;;) {
    const [only, ...rest] = root.children;
    if (!only || rest.length || only.total !== root.total) break;
    root = only;
  }
  sortTree(root);
  return { ...root, name: root.path || '/' };
}

// The tree narrowed for display. `keep` drops a node unless it or a descendant
// passes, so the path to a kept folder always shows. A search keeps every
// folder whose NAME contains the query (case-insensitive) with its kept subtree
// and the path to it; the root's own long path never counts as a hit, or every
// search would match everything.
export function filterTree(
  root: FolderNode,
  query: string,
  keep?: (n: FolderNode) => boolean,
): FolderNode | null {
  const q = query.trim().toLocaleLowerCase();
  const passes = keep ?? (() => true);
  const prune = (n: FolderNode): FolderNode | null => {
    const children = n.children.map(prune).filter((c): c is FolderNode => c !== null);
    return passes(n) || children.length ? { ...n, children } : null;
  };
  if (!q) return prune(root);
  const search = (n: FolderNode): FolderNode | null => {
    if (n.name.toLocaleLowerCase().includes(q)) return prune(n);
    const children = n.children.map(search).filter((c): c is FolderNode => c !== null);
    return children.length ? { ...n, children } : null;
  };
  const children = root.children.map(search).filter((c): c is FolderNode => c !== null);
  return children.length ? { ...root, children } : null;
}

// A folder path as a rule row shows it: relative to the collapsed root.
export function displayPath(root: FolderNode, path: string): string {
  return root.path && path.startsWith(`${root.path}/`) ? path.slice(root.path.length + 1) : path;
}

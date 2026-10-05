// Дерево папок вкладки Blocked (lib/folderTree.ts). Приём тот же, что у
// web/lib/roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/folderTree.test.ts

import assert from 'node:assert/strict';
import {
  buildFolderTree, displayPath, filterTree, untickablePaths, type FolderNode, type FolderStat,
} from './folderTree';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

const st = (path: string, total: number, untagged = 0, genres: string[] = []): FolderStat =>
  ({ path, total, untagged, genres });
const M = '/mnt/nas/Public/Music';
const LIB: FolderStat[] = [
  st('/mnt', 10, 6), st('/mnt/nas', 10, 6), st('/mnt/nas/Public', 10, 6), st(M, 10, 6),
  st(`${M}/Sorted`, 4, 0), st(`${M}/Sorted/Рок русский`, 4, 0),
  st(`${M}/Unsorted`, 6, 6), st(`${M}/Unsorted/!Помойка русская`, 4, 4, ['Поп']),
  st(`${M}/Unsorted/Юля Кошкина`, 2, 2),
];
const names = (n: FolderNode | null | undefined): string[] => (n ? n.children.map((c) => c.name) : []);

// assert.ok сужает тип, поэтому ниже обходимся без восклицательных знаков:
// правило линтера на них в вебе не проверено, а падать тест должен внятно.
function tree(stats: FolderStat[]): FolderNode {
  const t = buildFolderTree(stats);
  assert.ok(t, 'дерево построено');
  return t;
}

function filtered(root: FolderNode, q: string, keep?: (n: FolderNode) => boolean): FolderNode {
  const t = filterTree(root, q, keep);
  assert.ok(t, 'фильтр что-то оставил');
  return t;
}

console.log('buildFolderTree');

test('цепочка папок-одиночек от /mnt сворачивается в корень библиотеки', () => {
  const root = tree(LIB);
  assert.equal(root.path, M);
  assert.equal(root.name, M);
  assert.deepEqual(names(root), ['Sorted', 'Unsorted']);
});

test('папка со своими треками останавливает свёртку', () => {
  const root = tree([st('/a', 10), st('/a/b', 10), st('/a/b/c', 7)]);
  assert.equal(root.path, '/a/b');
  assert.deepEqual(names(root), ['c']);
});

test('дети отсортированы по имени', () => {
  const unsorted = tree(LIB).children.find((c) => c.name === 'Unsorted');
  assert.deepEqual(names(unsorted), ['!Помойка русская', 'Юля Кошкина']);
});

test('пустой список — нет дерева', () => {
  assert.equal(buildFolderTree([]), null);
});

console.log('filterTree');

test('поиск оставляет совпавшие папки и путь к ним, без учёта регистра и на кириллице', () => {
  const out = filtered(tree(LIB), 'помойка');
  assert.deepEqual(names(out), ['Unsorted']);
  assert.deepEqual(names(out.children[0]), ['!Помойка русская']);
});

test('длинный путь корня совпадением не считается', () => {
  assert.equal(filterTree(tree(LIB), 'mnt'), null);
});

test('keep убирает полностью размеченные ветви, но оставляет предков', () => {
  const out = filtered(tree(LIB), '', (n) => n.untagged > 0);
  assert.deepEqual(names(out), ['Unsorted']);
});

test('назначение для исчезнувшей папки остаётся видимым', () => {
  const stale = [...LIB, st(`${M}/Sorted/Переименовано`, 0, 0, ['Рок'])];
  const keep = (n: FolderNode) => n.untagged > 0 || n.genres.length > 0;
  const out = filtered(tree(stale), '', keep);
  assert.deepEqual(names(out), ['Sorted', 'Unsorted']);
  assert.deepEqual(names(out.children[0]), ['Переименовано']);
});

test('без запроса и без keep — всё дерево', () => {
  assert.deepEqual(names(filtered(tree(LIB), '')), ['Sorted', 'Unsorted']);
});

console.log('untickablePaths');

test('исчезнувшая папка правила попадает в список, живые — нет', () => {
  const gone = `${M}/Sorted/Переименовано`;
  assert.deepEqual(untickablePaths(tree(LIB), [`${M}/Sorted`, gone, `${M}/Unsorted/Юля Кошкина`]), [gone]);
});

test('корень и папки над ним флажка не имеют — попадают в список', () => {
  assert.deepEqual(untickablePaths(tree(LIB), [M, '/mnt/nas']), [M, '/mnt/nas']);
});

test('без дерева снять в нём нельзя ничего', () => {
  assert.deepEqual(untickablePaths(null, ['/a', '/b']), ['/a', '/b']);
});

console.log('displayPath');

test('путь внутри корня показывается от корня', () => {
  assert.equal(displayPath(tree(LIB), `${M}/Сборки`), 'Сборки');
});

test('путь вне корня показывается целиком', () => {
  assert.equal(displayPath(tree(LIB), '/elsewhere/x'), '/elsewhere/x');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

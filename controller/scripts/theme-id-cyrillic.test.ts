// A custom theme's id is derived from its name when the create form sends none
// (web/components/admin/settings/ThemeSection.tsx). slugifyThemeId keeps only
// [a-z0-9], so every all-Cyrillic name used to slug to the same "t-" and the
// second such theme silently overwrote the first file (fork fix, see
// station/docs/controller-changes.md, «Находки авто-ревью 2026-10-17»).

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-theme-id-'));
process.env.STATE_DIR = stateRoot;

const { slugifyThemeId, saveUserTheme } = await import('../src/themes.js');

const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

test('different Cyrillic names get different valid ids', () => {
  const a = slugifyThemeId('Ночь');
  const b = slugifyThemeId('Утро');
  assert.notEqual(a, b);
  assert.match(a, THEME_ID_RE);
  assert.match(b, THEME_ID_RE);
  // Mixed names keep their Latin part and still stay apart.
  assert.notEqual(slugifyThemeId('Ночь 2'), slugifyThemeId('Утро 2'));
  assert.match(slugifyThemeId('Очень длинное название темы для эфира vol 2'), THEME_ID_RE);
});

test('the same name maps to the same id, so a re-save stays an upsert', () => {
  assert.equal(slugifyThemeId('Ночь'), slugifyThemeId('Ночь'));
});

test('ASCII names and existing ids are unchanged', () => {
  assert.equal(slugifyThemeId('My Theme'), 'my-theme');
  assert.equal(slugifyThemeId('Neon 80s!'), 'neon-80s');
  // The edit path re-slugs the stored id; an id minted here must survive it.
  const id = slugifyThemeId('Ночь');
  assert.equal(slugifyThemeId(id), id);
});

test('two Cyrillic themes are saved as two files', async () => {
  const theme = { mode: 'dark', tokens: {} };
  await saveUserTheme({ ...theme, name: 'Ночь' });
  await saveUserTheme({ ...theme, name: 'Утро' });
  const files = readdirSync(path.join(stateRoot, 'themes')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2, `expected two theme files, got ${files.join(', ')}`);
});

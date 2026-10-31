// Authored prompt text, loaded from the .md files in llm/instructions/.
//
// WHY FILES. The agent system prompts are prose — editorial instructions to a
// model about how to run a radio station — and they were living inside TS
// template literals, interleaved with the conditional logic that assembles
// them. That made the prose hard to read as prose and its diffs hard to review:
// a wording change arrived as a patch to a `${}`-studded string, indistinguishable
// at a glance from a logic change. The same repo already treats this kind of
// text as text for operator skills (state/skills/<slug>/SKILL.md), so this
// follows that grain.
//
// WHAT DID NOT MOVE, DELIBERATELY. Only static blocks live in the .md files.
// The conditional assembly — which blocks apply to this persona, this show,
// this run — stays in TypeScript, because it is logic, and a template language
// with branches would be a worse version of the language it is written in.
// A section is a paragraph you could read aloud; anything with a decision in it
// is code.
//
// THESE ARE SOURCE, NOT OPERATOR CONFIG. They ship in the image (the controller
// runs from src/ via tsx, and both Dockerfiles COPY controller/src wholesale)
// and are NOT loaded from the state dir. That is on purpose: the picker prompt
// is coupled to the harness — the "one discovery round" paragraph has to agree
// with the provider's discovery budget (provider/capabilities.ts) — and unlike a
// skill, which merely fails to air a segment, a broken picker prompt breaks the
// station's core loop with no graceful degradation. Operator-facing prompt
// surfaces already exist and are separate: the persona souls, djHouseRules, and
// the SKILL.md briefs.
//
// Everything is read and validated ONCE at module load, so a malformed file or
// a missing section fails at boot rather than at 3am on a pick.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const INSTRUCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../instructions');

// A placeholder is `{lowerCamelIdentifier}`. Narrow on purpose: prompt prose is
// full of quotes, dashes and parentheses, and a looser pattern would turn an
// ordinary brace in the text into a substitution failure.
const PLACEHOLDER = /\{([a-z][A-Za-z0-9]*)\}/g;

// `## name` starts a section; everything up to the next `## ` is its body.
// Text before the first heading is the file's own preamble — a place to explain
// the file to a human — and is never addressable, so it can't reach a model.
function parseSections(src: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = src.split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (!name) continue;
    if (out.has(name)) throw new Error(`instructions: duplicate section "${name}" in ${file}`);
    if (!body) throw new Error(`instructions: empty section "${name}" in ${file}`);
    out.set(name, body);
  }
  if (!out.size) throw new Error(`instructions: ${file} defines no "## section" headings`);
  return out;
}

const FILES: Map<string, Map<string, string>> = (() => {
  const loaded = new Map<string, Map<string, string>>();
  for (const entry of readdirSync(INSTRUCTIONS_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    loaded.set(name, parseSections(readFileSync(join(INSTRUCTIONS_DIR, entry), 'utf8'), entry));
  }
  if (!loaded.size) throw new Error(`instructions: no .md files found in ${INSTRUCTIONS_DIR}`);
  return loaded;
})();

/**
 * One authored block, with `{placeholder}` values filled in.
 *
 * Throws on a missing file, a missing section, or a placeholder left
 * unsubstituted — all three are authoring slips, and a prompt that silently
 * ships the literal text "{topic}" to a model is worse than one that fails.
 */
export function instruction(file: string, section: string, vars: Record<string, string | number> = {}): string {
  const sections = FILES.get(file);
  if (!sections) throw new Error(`instructions: no such file "${file}.md" (have: ${[...FILES.keys()].join(', ')})`);
  const body = sections.get(section);
  if (body == null) throw new Error(`instructions: ${file}.md has no section "${section}" (have: ${[...sections.keys()].join(', ')})`);
  const missing: string[] = [];
  const filled = body.replace(PLACEHOLDER, (whole, key: string) => {
    const v = vars[key];
    if (v == null) missing.push(whole);
    return v == null ? whole : String(v);
  });
  if (missing.length) throw new Error(`instructions: ${file}.md section "${section}" left ${missing.join(', ')} unsubstituted`);
  return filled;
}

// The section names a file defines — for the load-time coverage test, which
// fails when a section is authored but never rendered by any call site (dead
// prompt text reads as live instruction to whoever edits it next).
export function sectionNames(file: string): string[] {
  const sections = FILES.get(file);
  if (!sections) throw new Error(`instructions: no such file "${file}.md"`);
  return [...sections.keys()];
}

export function instructionFiles(): string[] {
  return [...FILES.keys()];
}

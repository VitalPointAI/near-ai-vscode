// The copy lint's scanner (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads the product's user copy sources, counts the hits of each copy
// rule per file, and compares the counts with the checked-in baseline (src/test/copy-lint-baseline.json). A helper with no `.test` suffix, so it can be
// loaded without registering tests. Pure apart from reading files under the repository root; no vscode.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The copy rules, in the order GLOSSARY section 5 and D-41 number them (the compliance claim is rule 7, after the bare team rule). */
export const COPY_RULES = ['glossary', 'mode-word', 'brand', 'em-dash', 'provider-organization', 'bare-team', 'compliance-claim'] as const;
export type CopyRule = (typeof COPY_RULES)[number];

/** Counts per file (path from the repository root, forward slashes) and rule. A zero count is never stored. */
export type CopyCounts = Record<string, Partial<Record<CopyRule, number>>>;

/** One piece of user copy. `title` marks a panel or command title, which the brand rule also checks for a prefix. */
export interface CopyText {
  readonly text: string;
  readonly title?: boolean;
}

/** The repository root: this file compiles to dist/test/helpers. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const BASELINE_PATH = path.join(REPO_ROOT, 'src', 'test', 'copy-lint-baseline.json');

const EM_DASH = String.fromCharCode(0x2014);

/** What to use instead, per rule, for the ratchet's message. */
export const RULE_ADVICE: Readonly<Record<CopyRule, string>> = Object.freeze({
  glossary: 'the glossary\'s user word (.planning/research/coherence/GLOSSARY.md), or add an allowed-context row with its reason',
  'mode-word': 'term(concept, mode) from src/domain/org/terms.ts',
  brand: '"NEAR AI" and "VS Code", and a panel title with no brand prefix',
  'em-dash': 'a colon, a comma or two sentences',
  'provider-organization': '"your organization" (NEAR AI is only the provider)',
  'bare-team': '"agent team" for agents, the mode word from term() for people, or "Microsoft Teams"',
  'compliance-claim': 'a status with its evidence, never a claim that the product is compliant, certified or accredited'
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushString(out: CopyText[], value: unknown, title = false): void {
  if (typeof value === 'string' && value.length > 0) out.push(title ? { text: value, title: true } : { text: value });
}

/**
 * The user copy of a package manifest: command titles and categories, setting descriptions (plain, markdown, enum and deprecation), the configuration
 * section titles, view and view container names and titles, the package's display name and description, and the chat participant's names and command
 * descriptions.
 */
export function extractPackage(manifest: unknown): CopyText[] {
  const out: CopyText[] = [];
  if (!isRecord(manifest)) return out;
  pushString(out, manifest.displayName);
  pushString(out, manifest.description);
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {};
  for (const command of Array.isArray(contributes.commands) ? contributes.commands : []) {
    if (!isRecord(command)) continue;
    pushString(out, command.title, true);
    pushString(out, command.category);
  }
  const sections = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
  for (const section of sections) {
    if (!isRecord(section)) continue;
    pushString(out, section.title);
    for (const property of Object.values(isRecord(section.properties) ? section.properties : {})) {
      if (!isRecord(property)) continue;
      for (const key of ['description', 'markdownDescription', 'deprecationMessage', 'markdownDeprecationMessage']) pushString(out, property[key]);
      for (const key of ['enumDescriptions', 'markdownEnumDescriptions']) for (const item of Array.isArray(property[key]) ? property[key] as unknown[] : []) pushString(out, item);
    }
  }
  for (const group of ['views', 'viewsContainers']) {
    const table = contributes[group];
    for (const list of Object.values(isRecord(table) ? table : {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        if (!isRecord(entry)) continue;
        pushString(out, entry.name);
        pushString(out, entry.title);
      }
    }
  }
  for (const participant of Array.isArray(contributes.chatParticipants) ? contributes.chatParticipants : []) {
    if (!isRecord(participant)) continue;
    pushString(out, participant.fullName);
    pushString(out, participant.description);
    for (const command of Array.isArray(participant.commands) ? participant.commands : []) if (isRecord(command)) pushString(out, command.description);
  }
  return out;
}

function countOf(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** The hits of every rule in `texts`, all counted under `file`. Returns `{}` when nothing is hit, never a zero count. */
export function countHits(texts: readonly CopyText[], file: string): CopyCounts {
  const rules: Partial<Record<CopyRule, number>> = {};
  const add = (rule: CopyRule, count: number): void => { if (count > 0) rules[rule] = (rules[rule] ?? 0) + count; };
  for (const { text } of texts) add('em-dash', countOf(text, EM_DASH));
  return Object.keys(rules).length > 0 ? { [file]: rules } : {};
}

function mergeInto(target: CopyCounts, counts: CopyCounts): void {
  for (const [file, rules] of Object.entries(counts)) {
    const into = (target[file] ??= {});
    for (const [rule, count] of Object.entries(rules) as Array<[CopyRule, number]>) into[rule] = (into[rule] ?? 0) + count;
  }
}

/** Every copy source under `root`, counted per file and rule. */
export function scanRepository(root: string = REPO_ROOT): CopyCounts {
  const counts: CopyCounts = {};
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as unknown;
  mergeInto(counts, countHits(extractPackage(manifest), 'package.json'));
  return counts;
}

function line(file: string, rule: string, before: number, now: number): string {
  return `${file}  ${rule}  ${String(before)} -> ${String(now)}`;
}

/** Counts above the baseline (`increased`, always a failure) and baseline counts above today's (`stale`, a failure only when the baseline must be tight). */
export function compareWithBaseline(counts: CopyCounts, baseline: CopyCounts): { increased: string[]; stale: string[] } {
  const increased: string[] = [];
  const stale: string[] = [];
  const files = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  for (const file of files) {
    for (const rule of COPY_RULES) {
      const now = counts[file]?.[rule] ?? 0;
      const before = baseline[file]?.[rule] ?? 0;
      if (now > before) increased.push(line(file, rule, before, now));
      else if (now < before) stale.push(line(file, rule, before, now));
    }
  }
  return { increased, stale };
}

/** The failure message for increased counts: which rule, which file, what to use instead, and how a moved count is handled. */
export function increaseMessage(increased: readonly string[]): string {
  if (increased.length === 0) return 'no new copy lint hits';
  const rules = [...new Set(increased.map((entry) => entry.split('  ')[1] as CopyRule))];
  return [
    'New copy lint hits (file  rule  baseline -> now):',
    ...increased.map((entry) => `  ${entry}`),
    'Use instead:',
    ...rules.map((rule) => `  ${rule}: ${RULE_ADVICE[rule]}`),
    'A count that moved with code from another file moves in the baseline with it: the rule\'s total must not grow. Fix new copy, never raise the baseline.'
  ].join('\n');
}

/** The baseline file's text: files sorted, rules sorted, zero counts left out, two-space indent, a trailing newline. */
export function baselineText(counts: CopyCounts): string {
  const sorted: Record<string, Record<string, number>> = {};
  for (const file of Object.keys(counts).sort()) {
    const rules: Record<string, number> = {};
    for (const rule of Object.keys(counts[file]).sort() as CopyRule[]) {
      const count = counts[file][rule] ?? 0;
      if (count > 0) rules[rule] = count;
    }
    if (Object.keys(rules).length > 0) sorted[file] = rules;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function readBaseline(file: string = BASELINE_PATH): CopyCounts {
  return JSON.parse(readFileSync(file, 'utf8')) as CopyCounts;
}

/** The write mode: records the baseline from `counts` and then always fails, so a run with NEAR_AI_WRITE_BASELINE=1 can never pass silently. */
export function writeBaselineAndFail(file: string, counts: CopyCounts): never {
  writeFileSync(file, baselineText(counts));
  throw new Error('baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE');
}

// `applicability` (44.1-06, D-08 to D-10): the generated component applicability map.
//
//   applicability --check [--root <repository>]   exit 1 when the committed lock or readable page differs from what the rules give, or the map is incomplete
//   applicability --write [--root <repository>]   rewrite compliance/applicability/map.lock.json and docs/security/component-applicability.md
//
// The lock is what your organization's review signs (each component's section SHA-256); the page is for people and the assessor package.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, loadApplicability, lockText, renderPage, type MapSources } from '../applicability.ts';
import { loadComponents } from '../components.ts';
import { selectedIds } from '../profiles.ts';
import { loadResponsibilityTable } from '../responsibility.ts';
import { loadJson } from '../validate.ts';

export const LOCK_FILE = 'compliance/applicability/map.lock.json';
export const PAGE_FILE = 'docs/security/component-applicability.md';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = 'usage: applicability (--check | --write) [--root <repository>]\n';

export interface ApplicabilityIo { readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void }

type LevelConfig = Omit<MapSources['levels'][number], 'controls'>;

/** Reads the map's sources from a repository root: the levels with their selected controls, the responsibility table, the components and the rules. */
export function loadMapSources(root: string): MapSources {
  const dir = path.join(root, 'compliance');
  const configs = (loadJson(path.join(dir, 'levels.json')) as { levels: LevelConfig[] }).levels;
  const levels = configs.map((level) => ({ id: level.id, title: level.title, kind: level.kind, claim: level.claim, profile: level.profile, components: level.components, controls: selectedIds(path.join(dir, level.profile)) }));
  const { components, errors } = loadComponents(path.join(dir, 'components'));
  if (errors.length) throw new Error(errors.join('; '));
  const index = loadApplicability(path.join(dir, 'applicability'), levels.map((level) => level.id));
  if (!index) throw new Error(`${path.join(dir, 'applicability')} does not exist`);
  return { levels, components, responsibilityTable: loadResponsibilityTable(path.join(dir, 'responsibility', 'families.json')), rules: index.rules };
}

/** The first line where two texts differ, as a one-line description. */
export function firstDifference(file: string, expected: string, actual: string | undefined): string {
  if (actual === undefined) return `${file}: missing; run applicability --write`;
  const want = expected.split('\n');
  const have = actual.split('\n');
  for (let at = 0; at < Math.max(want.length, have.length); at++) {
    if (want[at] !== have[at]) return `${file}:${at + 1}: expected ${JSON.stringify(want[at] ?? '<end of file>').slice(0, 300)}, found ${JSON.stringify(have[at] ?? '<end of file>').slice(0, 300)}`;
  }
  return `${file}: differs`;
}

export async function run(args: readonly string[], io: ApplicabilityIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : undefined;
  const rootAt = args.indexOf('--root');
  const root = rootAt < 0 ? REPO_ROOT : args[rootAt + 1];
  const known = new Set(['--check', '--write', '--root', ...(rootAt < 0 ? [] : [root])]);
  if (!mode || (args.includes('--write') && args.includes('--check')) || !root || args.some((arg) => !known.has(arg))) { err(USAGE); return 2; }
  let expected: { file: string; text: string }[];
  try {
    const sources = loadMapSources(root);
    const lock = buildLock(sources);
    expected = [{ file: LOCK_FILE, text: lockText(lock) }, { file: PAGE_FILE, text: renderPage(lock, sources) }];
  } catch (error) {
    err(`applicability: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (mode === 'write') {
    for (const { file, text } of expected) { writeFileSync(path.join(root, file), text); out(`wrote ${file}\n`); }
    return 0;
  }
  const stale = expected.flatMap(({ file, text }) => {
    const target = path.join(root, file);
    const actual = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    return actual === text ? [] : [firstDifference(file, text, actual)];
  });
  for (const line of stale) err(`${line}\n`);
  if (stale.length) return 1;
  out('applicability map: the lock and the readable page are current\n');
  return 0;
}

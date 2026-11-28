// `coverage` (44.1-07, D-19, D-21): the compliance coverage measure and its ratchet.
//
//   coverage [--root <repository>]                              counts per level and component, from sources only
//   coverage --check [--root <repository>]                      exit 1 on a rise, an unrecorded fall, a statement without an acceptable rule, applicability drift,
//                                                               or generated supply-chain statements that differ from the generator (44.1-09)
//   coverage --write [--root <repository>]                      rewrite compliance/coverage/<component>.json from the current counts
//   coverage --work-list --component <id> [--root <repository>] that component's applicable pairs without a statement, Unclassified first
//   coverage --bundle <dir> [--previous <dir>]                  a Markdown table of cell states per component from a bundle, with the change
//
// The check runs in the required docs job; the bundle summary is report-only in the compliance job (Phase 44 D-07, D-41).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselinesFrom, checkCoverage, countCoverage, reportText, summaryTable, workList, type CoverageBaseline } from '../coverage.ts';
import { run as runApplicability } from './applicability.ts';
import { supplyChainProblems } from './supply-chain-statements.ts';
import { loadDashboardSources } from './bundle.ts';
import { loadJson } from '../validate.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = 'usage: coverage [--check | --write | --work-list --component <id> | --bundle <dir> [--previous <dir>]] [--root <repository>]\n';
export const BASELINE_DIR = 'compliance/coverage';

export interface CoverageIo { readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void }

const option = (args: readonly string[], name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };

function readBaselines(root: string): Map<string, CoverageBaseline> {
  const dir = path.join(root, BASELINE_DIR);
  const baselines = new Map<string, CoverageBaseline>();
  if (!existsSync(dir)) return baselines;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const value = loadJson(path.join(dir, file)) as Partial<CoverageBaseline>;
    const component = path.basename(file, '.json');
    if (value.component !== component || !Number.isSafeInteger(value.applicableWithoutStatement) || !Number.isSafeInteger(value.notApplicableAwaitingSignOff) || Object.keys(value).length !== 3) {
      throw new Error(`${BASELINE_DIR}/${file}: expected { component, applicableWithoutStatement, notApplicableAwaitingSignOff } naming ${component}`);
    }
    baselines.set(component, value as CoverageBaseline);
  }
  return baselines;
}

const readDashboard = (dir: string): { rows: [] } => loadJson(path.join(dir, 'dashboard', 'dashboard.json'), { maxBytes: 256 * 1024 * 1024 }) as { rows: [] };

export async function run(args: readonly string[], io: CoverageIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  const root = option(args, '--root') ?? REPO_ROOT;
  const modes = ['--check', '--write', '--work-list', '--bundle'].filter((mode) => args.includes(mode));
  const valued = new Set(['--root', '--component', '--bundle', '--previous']);
  const known = args.every((arg, index) => ['--check', '--write', '--work-list', ...valued].includes(arg) || valued.has(args[index - 1] ?? ''));
  if (!known || modes.length > 1 || (args.includes('--work-list') && !option(args, '--component')) || (args.includes('--previous') && !args.includes('--bundle'))) { err(USAGE); return 2; }
  try {
    if (args.includes('--bundle')) {
      const bundle = option(args, '--bundle');
      if (!bundle) { err(USAGE); return 2; }
      const previous = option(args, '--previous');
      const before = previous && existsSync(path.join(previous, 'dashboard', 'dashboard.json')) ? readDashboard(previous) : undefined;
      out(summaryTable(readDashboard(bundle), before));
      return 0;
    }
    const loaded = loadDashboardSources(path.join(root, 'compliance'));
    if (!loaded.responsibilityTable) throw new Error('compliance/responsibility/families.json did not load');
    const sources = { ...loaded, responsibilityTable: loaded.responsibilityTable, levels: loaded.levels.map((level) => ({ ...level, profile: level.profile ?? '' })) };
    if (args.includes('--work-list')) {
      const component = option(args, '--component')!;
      if (!sources.components.some((entry) => entry.id === component)) { err(`coverage: unknown component ${component}\n`); return 2; }
      for (const pair of workList(sources, component)) out(`${pair.control}\t${pair.levels.join(', ')}\n`);
      return 0;
    }
    const report = countCoverage(sources);
    if (args.includes('--write')) {
      const dir = path.join(root, BASELINE_DIR);
      mkdirSync(dir, { recursive: true });
      for (const baseline of baselinesFrom(report).values()) writeFileSync(path.join(dir, `${baseline.component}.json`), `${JSON.stringify(baseline, null, 2)}\n`);
      out(`wrote ${Object.keys(report.totals).length} baselines under ${BASELINE_DIR}\n`);
      return 0;
    }
    if (args.includes('--check')) {
      const applicability: string[] = [];
      const code = await runApplicability(['--check', '--root', root], { stdout: () => {}, stderr: (text) => { applicability.push(...text.split('\n').filter(Boolean)); } });
      if (code !== 0 && applicability.length === 0) applicability.push(`applicability --check exited ${code}`);
      const problems = [...checkCoverage(report, readBaselines(root), code === 0 ? [] : applicability), ...supplyChainProblems(root).map((problem) => `supply-chain: ${problem}`)];
      for (const problem of problems) err(`${problem}\n`);
      if (problems.length) return 1;
      out(`coverage: every baseline is current (${Object.keys(report.totals).length} components), every statement has an acceptable rule, and the applicability map is current\n`);
      return 0;
    }
    out(reportText(report));
    return 0;
  } catch (error) {
    err(`coverage: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

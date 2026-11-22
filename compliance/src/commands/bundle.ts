import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBundle, type BundleInputs } from '../bundle.ts';
import type { FetchJson } from '../collectors/types.ts';
import { loadComponents } from '../components.ts';
import type { DashboardBuildInput } from '../dashboard.ts';
import { loadEvidenceRules } from '../evidenceRuleFiles.ts';
import { loadGaps, loadPoam } from '../gaps.ts';
import type { ImportReport } from '../import/itsp-10-033-01.ts';
import { selectedIds } from '../profiles.ts';
import { loadJson } from '../validate.ts';

function option(args: readonly string[], name: string): string | undefined { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
function githubFetch(token: string): FetchJson { return async (url, init = {}) => {
  if (!url.startsWith('https://api.github.com/')) throw new Error('refused non-GitHub API URL');
  const response = await fetch(url, { method: init.method, headers: { ...init.headers, authorization: `Bearer ${token}` } });
  if (!response.ok) { const error = Object.assign(new Error(`GitHub returned ${response.status}`), { status: response.status }); throw error; }
  return response.json();
}; }

type LevelConfig = Omit<DashboardBuildInput['levels'][number], 'controls' | 'overlays'> & {
  readonly profile: string;
  readonly attachedTo?: readonly string[];
};

function loadDashboardSources(repoRoot: string): Pick<DashboardBuildInput, 'levels' | 'components' | 'rules' | 'gapRegister'> {
  const root = path.join(repoRoot, 'compliance');
  const { levels } = loadJson(path.join(root, 'levels.json')) as { levels: readonly LevelConfig[] };
  if (levels.length === 0) throw new Error('compliance levels are empty');
  const { components, errors } = loadComponents(path.join(root, 'components'));
  if (errors.length) throw new Error(errors.join('; '));
  const report = loadJson(path.join(root, 'import-reports', 'itsp-10-033-01.json')) as ImportReport;
  const profileDifferences = report.differences.map(({ control, en, fr }) => `${control.toUpperCase()}: English selection: ${en} / French selection: ${fr}`);
  return {
    levels: levels.map((level) => {
      const controls = selectedIds(path.join(root, level.profile));
      if (controls.length === 0) throw new Error(`compliance level ${level.id} selects no controls`);
      const overlays = levels.filter((other) => other.attachedTo?.includes(level.id)).map((other) => other.id);
      return { id: level.id, title: level.title, kind: level.kind, profile: level.profile, claim: level.claim, components: level.components, controls, overlays,
        ...(level.id === 'protected-b' && profileDifferences.length ? { notes: { profileDifferences } } : {}) };
    }),
    components,
    rules: loadEvidenceRules(path.join(root, 'evidence-rules')),
    gapRegister: {
      gaps: loadGaps(path.join(root, 'gaps.json')),
      poam: loadPoam(path.join(root, 'poam')),
      attestationsDir: path.join(root, 'attestations'),
    },
  };
}

export async function run(args: readonly string[]): Promise<number> {
  const inputFile = option(args, '--inputs'); const out = option(args, '--out'); const previous = option(args, '--previous');
  if (!inputFile || !out) return 2;
  try {
    const inputs = JSON.parse(readFileSync(inputFile, 'utf8')) as BundleInputs;
    const runUrl = inputs.runUrl ?? (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined);
    const token = process.env.GITHUB_TOKEN; const fetchJson = token ? githubFetch(token) : undefined;
    const repoRoot = path.resolve(inputs.repoRoot || '.');
    const dashboard = loadDashboardSources(repoRoot);
    await runBundle({ ...inputs, ...(runUrl ? { runUrl } : {}), repoRoot, dashboard }, out, { fetchJson, ...(previous ? { previous: path.resolve(previous) } : {}) });
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

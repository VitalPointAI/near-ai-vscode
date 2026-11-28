// `supply-chain-statements` (44.1-09, D-15): the supply-chain statements generated from the component inventory.
//
//   supply-chain-statements [--root <repository>]           what the generator gives, per component, and each pair it skips with the reason
//   supply-chain-statements --check [--root <repository>]   exit 1 when a component file or the rule file differs from what the generator gives
//   supply-chain-statements --write [--root <repository>]   rewrite the generated part of each component file and compliance/evidence-rules/supply-chain.json
//
// `coverage --check` runs the same drift check (supplyChainProblems) in the required docs job once the generated statements are adopted.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from '../inventory.ts';
import { RULE_FILE, STATEMENT_SUFFIX, driftProblems, generate, mapApplicable, type ComponentFile, type SupplyChainOutput } from '../supplyChainStatements.ts';
import { loadDashboardSources } from './bundle.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = 'usage: supply-chain-statements [--check | --write] [--root <repository>]\n';
const COMPONENT_DIR = 'compliance/components';
const BUILD_SCRIPT = 'deploy/bundle/build.mjs';

export interface SupplyChainIo { readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void }

/** The tools the offline bundle carries, read from build.mjs's SITE_TOOLS without running it (it needs packages the docs job has not installed). */
function bundleTools(root: string): string[] {
  const match = /export const SITE_TOOLS = Object\.freeze\(\[([^\]]*)\]\)/.exec(readFileSync(path.join(root, BUILD_SCRIPT), 'utf8'));
  if (!match) throw new Error(`${BUILD_SCRIPT}: SITE_TOOLS not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((tool) => tool[1]);
}

function componentFiles(root: string): ComponentFile[] {
  return readdirSync(path.join(root, COMPONENT_DIR)).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ file: `${COMPONENT_DIR}/${name}`, text: readFileSync(path.join(root, COMPONENT_DIR, name), 'utf8') }));
}

const readRules = (root: string): string | undefined => existsSync(path.join(root, RULE_FILE)) ? readFileSync(path.join(root, RULE_FILE), 'utf8') : undefined;

/** Reads every source of the generator under root and runs it. */
export function generateFor(root: string): { readonly output: SupplyChainOutput; readonly current: ComponentFile[] } {
  const loaded = loadDashboardSources(path.join(root, 'compliance'));
  if (!loaded.responsibilityTable) throw new Error('compliance/responsibility/families.json did not load');
  const coverageSources = { ...loaded, responsibilityTable: loaded.responsibilityTable, levels: loaded.levels.map((level) => ({ ...level, profile: level.profile ?? '' })) };
  const current = componentFiles(root);
  const output = generate({ inventory: loadInventory(root), bundleTools: bundleTools(root), componentFiles: current, applicable: mapApplicable(coverageSources) });
  return { output, current };
}

/**
 * The drift problems coverage --check reports. Empty until the generated statements are adopted (the rule file exists or a component file holds
 * a generated statement); from then on, removing them also lowers coverage, which the ratchet refuses.
 */
export function supplyChainProblems(root: string): string[] {
  const rulesText = readRules(root);
  const current = componentFiles(root);
  if (rulesText === undefined && !current.some((file) => file.text.includes(`${STATEMENT_SUFFIX}"`))) return [];
  return driftProblems(generateFor(root).output, current, rulesText);
}

function report(output: SupplyChainOutput): string {
  const lines = ['# Generated supply-chain statements', '', '| Component | Generated | Skipped |', '|---|---|---|'];
  for (const component of [...new Set([...output.generated, ...output.skipped].map((pair) => pair.component))].sort()) {
    const made = output.generated.filter((pair) => pair.component === component).map((pair) => pair.control);
    const reasons = new Map<string, string[]>();
    for (const pair of output.skipped.filter((item) => item.component === component)) reasons.set(pair.reason, [...(reasons.get(pair.reason) ?? []), pair.control]);
    lines.push(`| ${component} | ${made.join(', ') || 'none'} | ${[...reasons].map(([reason, controls]) => `${reason}: ${controls.join(', ')}`).join('; ')} |`);
  }
  lines.push('', `${output.generated.length} statements generated, ${output.skipped.length} pairs skipped.`);
  return `${lines.join('\n')}\n`;
}

export async function run(args: readonly string[], io: SupplyChainIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  const known = args.every((arg, index) => ['--check', '--write', '--root'].includes(arg) || args[index - 1] === '--root');
  if (!known || (args.includes('--check') && args.includes('--write')) || (args.includes('--root') && !args[args.indexOf('--root') + 1])) { err(USAGE); return 2; }
  const at = args.indexOf('--root');
  const root = at < 0 ? REPO_ROOT : args[at + 1];
  try {
    const { output, current } = generateFor(root);
    if (args.includes('--write')) {
      output.files.forEach((file, index) => { if (file.text !== current[index].text) writeFileSync(path.join(root, file.file), file.text); });
      writeFileSync(path.join(root, RULE_FILE), output.rulesText);
      out(`supply-chain-statements: ${output.generated.length} statements and their rules written; ${output.skipped.length} pairs skipped\n`);
      return 0;
    }
    if (args.includes('--check')) {
      const problems = driftProblems(output, current, readRules(root));
      for (const problem of problems) err(`${problem}\n`);
      if (problems.length) return 1;
      out(`supply-chain-statements: the ${output.generated.length} generated statements and their rules are current\n`);
      return 0;
    }
    out(report(output));
    return 0;
  } catch (error) {
    err(`supply-chain-statements: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

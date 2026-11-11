import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// PERF-06: deterministic verifier scripts for research and writing projects, so most verification is a cheap script run instead of a model reading the
// whole report again. Each uses only node:fs, node:path and node:url, reads files inside the project, writes nothing, and never reaches the network, so
// it passes the unattended content check (src/agent/unattended.ts) and runs without a card for sub-agents. The scaffold never overwrites a file.
//
// They are plain JavaScript modules kept here as text (no backticks or template placeholders inside, so they embed safely). Each exports run(root, args)
// returning { ok, problems } and runs as a command line script; verify-all.mjs runs all three in one process.

const SHARED = String.raw`import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The report's Markdown files: the folders or files named on the command line, else report/, else docs/, else the project's top-level .md files. */
export function reportFiles(root, args) {
  const named = (args || []).filter((arg) => !arg.startsWith('-'));
  const starts = named.length ? named.map((item) => resolve(root, item)) : ['report', 'docs'].map((dir) => join(root, dir)).filter((dir) => existsSync(dir)).slice(0, 1);
  const found = [];
  const walk = (item) => {
    const info = statSync(item);
    if (info.isDirectory()) { for (const name of readdirSync(item)) if (!name.startsWith('.') && name !== 'node_modules') walk(join(item, name)); }
    else if (/\.(md|markdown|txt)$/i.test(item)) found.push(item);
  };
  if (starts.length) starts.forEach(walk);
  else for (const name of readdirSync(root)) if (/\.md$/i.test(name) && !/^(README|CHANGELOG|AGENTS|CLAUDE)\.md$/i.test(name)) found.push(join(root, name));
  return found.sort();
}

export function report(name, problems) {
  if (problems.length) { console.log(name + ': ' + problems.length + ' problem(s)'); for (const problem of problems) console.log('  - ' + problem); }
  else console.log(name + ': ok');
  return { ok: problems.length === 0, problems };
}

export const isMain = (url) => Boolean(process.argv[1]) && url === pathToFileURL(resolve(process.argv[1])).href;
export const shown = (root, file) => relative(root, file).split('\\').join('/');
export { readFileSync, existsSync, join };
`;

const CITATIONS = String.raw`// Citation resolution: every [^note] reference has exactly one definition, every definition is used and names a source (a link or a source id
// listed in sources.json beside the report), and no two notes share an identifier. Reads only.
import { existsSync, isMain, join, readFileSync, report, reportFiles, shown } from './shared.mjs';

export function run(root, args) {
  const problems = [];
  const files = reportFiles(root, args);
  if (!files.length) problems.push('no report files found (pass a folder or file, or keep the report in report/)');
  const registryFile = join(root, 'report', 'sources.json');
  const registry = existsSync(registryFile) ? new Set(Object.keys(JSON.parse(readFileSync(registryFile, 'utf8')))) : undefined;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const where = shown(root, file);
    const definitions = new Map();
    for (const match of text.matchAll(/^\[\^([^\]\s]+)\]:\s*(.*)$/gm)) {
      if (definitions.has(match[1])) problems.push(where + ': note [^' + match[1] + '] is defined twice');
      definitions.set(match[1], match[2].trim());
    }
    const used = new Set();
    for (const match of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      used.add(match[1]);
      if (!definitions.has(match[1])) problems.push(where + ': [^' + match[1] + '] is cited but never defined');
    }
    for (const [id, body] of definitions) {
      if (!used.has(id)) problems.push(where + ': note [^' + id + '] is defined but never cited');
      const linked = /\bhttps?:\/\/\S+/.test(body);
      const listed = registry !== undefined && [...body.matchAll(/\b[A-Za-z][\w.-]*\b/g)].some((word) => registry.has(word[0]));
      if (!body) problems.push(where + ': note [^' + id + '] is empty');
      else if (!linked && !listed) problems.push(where + ': note [^' + id + '] names no source (no link' + (registry ? ' and no id from report/sources.json' : '') + ')');
    }
  }
  return report('citations', problems);
}

if (isMain(import.meta.url)) { const result = run(process.cwd(), process.argv.slice(2)); if (!result.ok) process.exitCode = 1; }
`;

const FIGURES = String.raw`// Figure recompute: each figure in report/figures.json is recomputed from its inputs and compared with its stated value, and its printed text must
// appear in the report. A figure: { "id": "...", "value": 12.5, "inputs": [10, 2.5], "formula": "sum" | "mean" | "product" | "ratio" | "pct-change",
// "decimals": 1, "text": "12.5%" }. Figures without a formula are only checked for their text. Reads only.
import { existsSync, isMain, join, readFileSync, report, reportFiles, shown } from './shared.mjs';

const FORMULAS = {
  sum: (values) => values.reduce((total, value) => total + value, 0),
  mean: (values) => values.reduce((total, value) => total + value, 0) / values.length,
  product: (values) => values.reduce((total, value) => total * value, 1),
  ratio: (values) => values[0] / values[1],
  'pct-change': (values) => ((values[1] - values[0]) / values[0]) * 100
};

export function run(root, args) {
  const problems = [];
  const flag = (args || []).find((arg) => arg.startsWith('--figures='));
  const file = flag ? join(root, flag.slice('--figures='.length)) : join(root, 'report', 'figures.json');
  if (!existsSync(file)) return report('figures', ['no figures file at ' + shown(root, file) + ' (list each computed figure there to have it recomputed)']);
  const figures = JSON.parse(readFileSync(file, 'utf8'));
  const text = reportFiles(root, (args || []).filter((arg) => !arg.startsWith('--'))).map((item) => readFileSync(item, 'utf8')).join('\n');
  for (const figure of Array.isArray(figures) ? figures : []) {
    const id = figure.id || '(unnamed)';
    if (figure.formula) {
      const compute = FORMULAS[figure.formula];
      if (!compute) { problems.push(id + ': unknown formula ' + figure.formula); continue; }
      if (!Array.isArray(figure.inputs) || figure.inputs.some((value) => typeof value !== 'number')) { problems.push(id + ': inputs must be numbers'); continue; }
      const decimals = Number.isInteger(figure.decimals) ? figure.decimals : 2;
      const expected = Number(compute(figure.inputs).toFixed(decimals));
      if (Math.abs(expected - Number(figure.value)) > Math.pow(10, -decimals) / 2) problems.push(id + ': stated ' + figure.value + ' but ' + figure.formula + ' of ' + JSON.stringify(figure.inputs) + ' is ' + expected);
    }
    if (figure.text && !text.includes(String(figure.text))) problems.push(id + ': "' + figure.text + '" does not appear in the report');
  }
  return report('figures', problems);
}

if (isMain(import.meta.url)) { const result = run(process.cwd(), process.argv.slice(2)); if (!result.ok) process.exitCode = 1; }
`;

const PATHS = String.raw`// Internal-path leak check: the report must not show where it was made. Flags home-directory paths, file: links, the project's planning and agent
// folders, worktree paths, and loopback or private network addresses. Reads only.
import { isMain, readFileSync, report, reportFiles, shown } from './shared.mjs';

const SLASH = String.fromCharCode(47);
const HOMES = ['home', 'Users', 'root'].map((name) => SLASH + name + SLASH);
const PATTERNS = [
  [new RegExp('(?:^|[\\s(\'"])(?:' + HOMES.map((home) => home.split(SLASH).join('\\' + SLASH)).join('|') + ')[\\w.-]+', 'm'), 'a home-directory path'],
  [/[A-Za-z]:\\Users\\/, 'a Windows home-directory path'],
  [/\bfile:\S+/, 'a file: link'],
  [/(?:^|[\s(\x60'"])\.planning[\\/]|\.near-ai[\\/]|\.claude[\\/]worktrees/, 'a planning or agent folder'],
  [/\blocalhost\b|\b127\.0\.0\.1\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b/, 'a local or private network address']
];

export function run(root, args) {
  const problems = [];
  for (const file of reportFiles(root, args)) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [pattern, what] of PATTERNS) if (pattern.test(line)) problems.push(shown(root, file) + ':' + (index + 1) + ': ' + what + ': ' + line.trim().slice(0, 120));
    });
  }
  return report('internal paths', problems);
}

if (isMain(import.meta.url)) { const result = run(process.cwd(), process.argv.slice(2)); if (!result.ok) process.exitCode = 1; }
`;

const ALL = String.raw`// Runs every research verifier in one process: citation resolution, figure recompute, and the internal-path leak check. Exit code 1 when any fails.
// Usage: node scripts/verify/verify-all.mjs [report folder or files]
import { run as citations } from './check-citations.mjs';
import { run as figures } from './check-figures.mjs';
import { run as paths } from './check-internal-paths.mjs';
import { isMain } from './shared.mjs';

export function run(root, args) {
  const results = [citations(root, args), figures(root, args), paths(root, args)];
  return { ok: results.every((result) => result.ok), problems: results.flatMap((result) => result.problems) };
}

if (isMain(import.meta.url)) { const result = run(process.cwd(), process.argv.slice(2)); console.log(result.ok ? 'all research verifiers passed' : 'research verifiers found problems'); if (!result.ok) process.exitCode = 1; }
`;

const README = `# Research verifiers

Deterministic checks for the report, scaffolded by NEAR AI (PERF-06). They read files only, never reach the network, and write nothing, so agents run
them without asking. Run them from the project root:

- \`node scripts/verify/verify-all.mjs\` runs all three (exit code 1 when any finds a problem);
- \`node scripts/verify/check-citations.mjs\`: every \`[^note]\` is defined once, used, and names a source (a link, or an id in \`report/sources.json\`);
- \`node scripts/verify/check-figures.mjs\`: every figure in \`report/figures.json\` recomputes from its inputs and appears in the report;
- \`node scripts/verify/check-internal-paths.mjs\`: no home-directory paths, file links, planning folders or private addresses in the report.

Each takes report folders or files as arguments; by default it reads \`report/\` (or \`docs/\`). NEAR AI never overwrites them. You may edit
them, but an edited verifier no longer matches the hash recorded when it was scaffolded, so agents ask before running it until you run
**NEAR AI: Trust Research Verifiers**, which shows what changed and asks before recording the new versions.
`;

/** The scaffold's files, relative to the project root. */
export const VERIFIER_FILES: Record<string, string> = {
  'scripts/verify/shared.mjs': SHARED,
  'scripts/verify/check-citations.mjs': CITATIONS,
  'scripts/verify/check-figures.mjs': FIGURES,
  'scripts/verify/check-internal-paths.mjs': PATHS,
  'scripts/verify/verify-all.mjs': ALL,
  'scripts/verify/README.md': README
};

/**
 * Where the scaffold records the SHA-256 of each file it wrote. It sits in .planning/.near-ai/, which an agent cannot write without asking, so a changed
 * verifier (or a changed helper it imports) is recognised and asks before it runs unattended (src/agent/unattended.ts).
 */
export const VERIFIER_MANIFEST = path.join('.planning', '.near-ai', 'verifiers.json');

/** Scaffolded verifier files whose contents no longer match their recorded hash (or the template, when none is recorded), relative to the root. */
export async function changedVerifiers(root: string): Promise<string[]> {
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse(await readFile(path.join(root, VERIFIER_MANIFEST), 'utf8')) as Record<string, string>; } catch { manifest = {}; }
  const changed: string[] = [];
  for (const [relative, template] of Object.entries(VERIFIER_FILES)) {
    const text = await readFile(path.join(root, relative), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const recorded = manifest[relative] ?? createHash('sha256').update(template, 'utf8').digest('hex');
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== recorded) changed.push(relative);
  }
  return changed;
}

/**
 * Records the current contents of the given scaffolded verifiers as trusted (review of PR 34). Only the command "NEAR AI: Trust Research Verifiers"
 * calls it, after the person confirmed the list; an agent cannot, because the manifest sits where agent writes always ask. Returns what was recorded.
 */
export async function trustVerifiers(root: string, files: string[]): Promise<string[]> {
  const manifestFile = path.join(root, VERIFIER_MANIFEST);
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, string>; } catch { manifest = {}; }
  const recorded: string[] = [];
  for (const relative of files) {
    if (!(relative in VERIFIER_FILES)) continue;
    const text = await readFile(path.join(root, relative), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    manifest[relative] = createHash('sha256').update(text, 'utf8').digest('hex');
    recorded.push(relative);
  }
  if (recorded.length) {
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return recorded;
}

/** Writes the verifier scripts that are not there yet, never overwriting, and records the hash of each one it wrote. Returns those files. */
export async function writeVerifierScaffold(root: string): Promise<string[]> {
  const written: string[] = [];
  const manifestFile = path.join(root, VERIFIER_MANIFEST);
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, string>; } catch { manifest = {}; }
  for (const [relative, content] of Object.entries(VERIFIER_FILES)) {
    const file = path.join(root, relative);
    if (await stat(file).then(() => true, () => false)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    manifest[relative] = createHash('sha256').update(content, 'utf8').digest('hex');
    written.push(relative);
  }
  if (written.length) {
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return written;
}

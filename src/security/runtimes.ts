import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Severity } from './osv';
import { compareVersions } from './osv';

// The language runtimes a project declares (engines, .nvmrc, requires-python, …) and the ones
// installed on this machine for the languages it uses, checked against endoflife.date: a runtime
// past its end of life gets no security fixes; one behind its latest patch may be missing some.

export type Runtime = 'node' | 'python' | 'php' | 'go' | 'ruby' | 'rust' | 'dotnet';
export interface RuntimeVersion { runtime: Runtime; version: string; source: string; kind: 'declared' | 'installed' }
export interface RuntimeFinding { runtime: RuntimeVersion; severity: Severity; summary: string; url: string }

const PRODUCT: Record<Runtime, string> = { node: 'nodejs', python: 'python', php: 'php', go: 'go', ruby: 'ruby', rust: 'rust', dotnet: 'dotnet' };
const LABEL: Record<Runtime, string> = { node: 'Node.js', python: 'Python', php: 'PHP', go: 'Go', ruby: 'Ruby', rust: 'Rust', dotnet: '.NET' };
const COMMANDS: Record<Runtime, [string, string[]]> = { node: ['node', ['--version']], python: ['python3', ['--version']], php: ['php', ['-r', 'echo PHP_VERSION;']], go: ['go', ['version']], ruby: ['ruby', ['-v']], rust: ['rustc', ['--version']], dotnet: ['dotnet', ['--version']] };

const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8').catch(() => undefined);
const lowest = (spec: string) => /(\d+(?:\.\d+){0,2})/.exec(spec)?.[1];

/** Runtime versions the project itself pins or declares support for. */
export async function declaredRuntimes(root: string): Promise<RuntimeVersion[]> {
  const found: RuntimeVersion[] = [];
  const add = (runtime: Runtime, spec: string | undefined, source: string) => { const version = spec && lowest(spec); if (version) found.push({ runtime, version, source, kind: 'declared' }); };
  const pkg = await read(root, 'package.json');
  if (pkg) { try { add('node', (JSON.parse(pkg) as { engines?: { node?: string } }).engines?.node, 'package.json engines.node'); } catch { /* not JSON */ } }
  for (const file of ['.nvmrc', '.node-version']) add('node', (await read(root, file))?.trim().replace(/^v/, ''), file);
  add('python', (await read(root, '.python-version'))?.trim(), '.python-version');
  add('python', /requires-python\s*=\s*"([^"]+)"/.exec((await read(root, 'pyproject.toml')) ?? '')?.[1], 'pyproject.toml requires-python');
  add('python', /python-([\d.]+)/.exec((await read(root, 'runtime.txt')) ?? '')?.[1], 'runtime.txt');
  const composer = await read(root, 'composer.json');
  if (composer) { try { add('php', (JSON.parse(composer) as { require?: { php?: string } }).require?.php, 'composer.json require.php'); } catch { /* not JSON */ } }
  const goMod = await read(root, 'go.mod');
  add('go', /^toolchain\s+go([\d.]+)/m.exec(goMod ?? '')?.[1] ?? /^go\s+([\d.]+)/m.exec(goMod ?? '')?.[1], 'go.mod');
  add('rust', /channel\s*=\s*"(\d[\d.]*)"/.exec((await read(root, 'rust-toolchain.toml')) ?? '')?.[1] ?? (await read(root, 'rust-toolchain'))?.trim().match(/^\d[\d.]*$/)?.[0], 'rust-toolchain');
  const global = await read(root, 'global.json');
  if (global) { try { add('dotnet', (JSON.parse(global) as { sdk?: { version?: string } }).sdk?.version, 'global.json sdk.version'); } catch { /* not JSON */ } }
  add('ruby', (await read(root, '.ruby-version'))?.trim().replace(/^ruby-/, ''), '.ruby-version');
  for (const line of ((await read(root, '.tool-versions')) ?? '').split('\n')) {
    const [tool, version] = line.trim().split(/\s+/);
    const runtime = ({ nodejs: 'node', python: 'python', php: 'php', golang: 'go', ruby: 'ruby', rust: 'rust', dotnet: 'dotnet' } as Record<string, Runtime>)[tool];
    if (runtime) add(runtime, version, '.tool-versions');
  }
  return found;
}

/** Installed runtime versions for the given languages, from their own --version output. */
export async function installedRuntimes(runtimes: Iterable<Runtime>, run: (command: string, args: string[]) => Promise<string> = defaultRun): Promise<RuntimeVersion[]> {
  const out: RuntimeVersion[] = [];
  for (const runtime of new Set(runtimes)) {
    const [command, args] = COMMANDS[runtime];
    const text = await run(command, args).catch(() => '');
    const version = /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1];
    if (version) out.push({ runtime, version, source: `${command} on this machine`, kind: 'installed' });
  }
  return out;
}

function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5_000, windowsHide: true }, (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}${stderr}`))));
}

type Release = { name: string; isEol: boolean; eolFrom?: string | null; latest?: { name?: string } | null; isMaintained?: boolean };

/** The release line a version belongs to, e.g. 22 for Node 22.15.0 and 3.12 for Python 3.12.4. */
function releaseFor(runtime: Runtime, version: string, releases: Release[]): Release | undefined {
  const parts = version.split('.');
  const candidates = runtime === 'node' ? [parts[0]] : [parts.slice(0, 2).join('.'), parts[0]];
  for (const candidate of candidates) { const release = releases.find((entry) => entry.name === candidate); if (release) return release; }
  return undefined;
}

/** Checks runtimes against endoflife.date (one request per runtime). */
export async function checkRuntimes(runtimes: RuntimeVersion[], options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<RuntimeFinding[]> {
  const fetchFn = options.fetch ?? fetch;
  const releases = new Map<Runtime, Release[]>();
  for (const runtime of new Set(runtimes.map((entry) => entry.runtime))) {
    const response = await fetchFn(`https://endoflife.date/api/v1/products/${PRODUCT[runtime]}`, { headers: { 'user-agent': 'NEAR-AI-VSCode' }, signal: options.signal ?? AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`endoflife.date returned HTTP ${response.status} for ${PRODUCT[runtime]}.`);
    releases.set(runtime, ((await response.json()) as { result?: { releases?: Release[] } }).result?.releases ?? []);
  }
  const findings: RuntimeFinding[] = [];
  for (const entry of runtimes) {
    const release = releaseFor(entry.runtime, entry.version, releases.get(entry.runtime) ?? []);
    const url = `https://endoflife.date/${PRODUCT[entry.runtime]}`;
    const label = `${LABEL[entry.runtime]} ${entry.version}`;
    if (!release) continue;
    if (release.isEol) {
      findings.push({ runtime: entry, severity: entry.kind === 'installed' ? 'high' : 'medium', url, summary: entry.kind === 'installed' ? `${label} (${entry.source}) reached end of life${release.eolFrom ? ` on ${release.eolFrom}` : ''} and gets no security fixes.` : `${entry.source} allows ${label}, which reached end of life${release.eolFrom ? ` on ${release.eolFrom}` : ''}. Require a supported version.` });
      continue;
    }
    const latest = release.latest?.name;
    if (entry.kind === 'installed' && latest && compareVersions(latest, entry.version) > 0) findings.push({ runtime: entry, severity: 'low', url, summary: `${label} (${entry.source}) is behind the latest ${release.name}.x patch, ${latest}; patch releases often include security fixes.` });
  }
  return findings;
}

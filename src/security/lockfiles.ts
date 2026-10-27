import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

// Dependencies with exact versions, read from a project's lockfiles (and pinned manifests where a
// language has no lockfile), as package URLs (purl) that OSV.dev understands.

export type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'Packagist' | 'RubyGems' | 'NuGet' | 'Maven';

export interface Component {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  purl: string;
  /** Workspace-relative lockfile it came from, and the 1-based line where it appears. */
  source: string;
  line?: number;
  development?: boolean;
}

export interface LockfileReport { components: Component[]; files: string[]; notes: string[] }

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'vendor', 'dist', 'build', 'out', 'target', '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt', 'coverage', '.planning', 'Pods', '.gradle', '.idea', '.vscode-test', 'bower_components', '.tox', '.cache']);
const MAX_DEPTH = 4;
const MAX_FILES = 60;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const PARSERS: Record<string, (text: string, file: string) => Omit<Component, 'source' | 'line'>[]> = {
  'package-lock.json': npmLock, 'npm-shrinkwrap.json': npmLock, 'yarn.lock': yarnLock, 'pnpm-lock.yaml': pnpmLock,
  'poetry.lock': tomlPackages('PyPI'), 'uv.lock': tomlPackages('PyPI'), 'pdm.lock': tomlPackages('PyPI'), 'Pipfile.lock': pipfileLock,
  'go.mod': goMod, 'Cargo.lock': tomlPackages('crates.io'), 'composer.lock': composerLock, 'Gemfile.lock': gemfileLock,
  'packages.lock.json': nugetLock, 'gradle.lockfile': gradleLock, 'pom.xml': pomXml
};
const REQUIREMENTS = /^requirements(?:[-_.][\w.-]+)?\.txt$/i;

export function purlFor(ecosystem: Ecosystem, name: string, version: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%2F/gi, '/');
  const segment = (value: string) => encodeURIComponent(value);
  switch (ecosystem) {
    case 'npm': return name.startsWith('@') ? `pkg:npm/%40${segment(name.slice(1).split('/')[0])}/${segment(name.split('/')[1] ?? '')}@${segment(version)}` : `pkg:npm/${segment(name)}@${segment(version)}`;
    case 'PyPI': return `pkg:pypi/${segment(normalizePython(name))}@${segment(version)}`;
    case 'Go': return `pkg:golang/${encode(name)}@${segment(version)}`;
    case 'crates.io': return `pkg:cargo/${segment(name)}@${segment(version)}`;
    case 'Packagist': return `pkg:composer/${encode(name)}@${segment(version)}`;
    case 'RubyGems': return `pkg:gem/${segment(name)}@${segment(version)}`;
    case 'NuGet': return `pkg:nuget/${segment(name)}@${segment(version)}`;
    case 'Maven': { const [group, artifact] = name.split(':'); return `pkg:maven/${encode(group)}/${segment(artifact)}@${segment(version)}`; }
  }
}

const normalizePython = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
const make = (ecosystem: Ecosystem, name: string, version: string, development?: boolean) => ({ ecosystem, name, version, purl: purlFor(ecosystem, name, version), ...(development ? { development } : {}) });

/** Finds and reads every supported lockfile in the project. */
export async function readLockfiles(root: string): Promise<LockfileReport> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < MAX_DEPTH && !SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(full, depth + 1); }
      else if (entry.isFile() && (PARSERS[entry.name] || REQUIREMENTS.test(entry.name))) files.push(full);
    }
  };
  await walk(root, 0);
  const notes: string[] = [];
  const byPurl = new Map<string, Component>();
  // pom.xml and requirements*.txt only matter where no lockfile resolves the same ecosystem.
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const directories = new Set(files.filter((file) => /package-lock|pnpm-lock|yarn\.lock|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|gradle\.lockfile/.test(path.basename(file))).map((file) => `${path.dirname(file)}:${/gradle/.test(file) ? 'maven' : /lock\.json|yarn|pnpm/.test(file) ? 'npm' : 'python'}`));
  for (const file of files.sort()) {
    const name = path.basename(file);
    if (name === 'pom.xml' && directories.has(`${path.dirname(file)}:maven`)) continue;
    if (REQUIREMENTS.test(name) && directories.has(`${path.dirname(file)}:python`)) continue;
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) { notes.push(`${relative(file)} is over 20 MB and was skipped.`); continue; }
    const text = await readFile(file, 'utf8');
    let parsed: Omit<Component, 'source' | 'line'>[];
    try {
      parsed = REQUIREMENTS.test(name) ? requirements(text, notes, relative(file)) : PARSERS[name](text, file);
    } catch (error) {
      notes.push(`${relative(file)} could not be read: ${(error as Error).message}`);
      continue;
    }
    for (const component of parsed) {
      if (!component.version || byPurl.has(component.purl)) continue;
      byPurl.set(component.purl, { ...component, source: relative(file), line: lineOf(text, component.name, component.version) });
    }
  }
  return { components: [...byPurl.values()].sort((a, b) => a.purl.localeCompare(b.purl)), files: files.map(relative), notes };
}

function lineOf(text: string, name: string, version: string): number | undefined {
  const lines = text.split('\n');
  const short = name.includes(':') ? name.split(':')[1] : name;
  let fallback: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(short)) continue;
    fallback ??= index + 1;
    if (lines.slice(index, index + 6).some((line) => line.includes(version))) return index + 1;
  }
  return fallback;
}

function npmLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: string; dev?: boolean; link?: boolean; name?: string }>; dependencies?: Record<string, NpmV1> };
  const out: Omit<Component, 'source' | 'line'>[] = [];
  if (lock.packages) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || entry.link || !entry.version || !key.includes('node_modules/')) continue;
      const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (/^\d/.test(entry.version)) out.push(make('npm', name, entry.version, entry.dev));
    }
    return out;
  }
  const visit = (dependencies: Record<string, NpmV1> | undefined) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      if (entry.version && /^\d/.test(entry.version)) out.push(make('npm', name, entry.version, entry.dev));
      visit(entry.dependencies);
    }
  };
  visit(lock.dependencies);
  return out;
}
type NpmV1 = { version?: string; dev?: boolean; dependencies?: Record<string, NpmV1> };

function yarnLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const out: Omit<Component, 'source' | 'line'>[] = [];
  const blocks = text.split(/\n(?=\S)/);
  for (const block of blocks) {
    const [header, ...body] = block.split('\n');
    if (!header.endsWith(':') || header.startsWith('#') || header.startsWith('__metadata')) continue;
    const spec = header.slice(0, -1).split(',')[0].trim().replace(/^"|"$/g, '');
    const at = spec.indexOf('@', 1);
    if (at < 1) continue;
    const name = spec.slice(0, at);
    const range = spec.slice(at + 1);
    if (/^(?:workspace|link|portal|file|patch|exec|git|github|https?):/.test(range) || /@(?:workspace|link|portal|file):/.test(spec)) continue;
    const version = body.map((line) => /^\s+version:?\s+"?([^"\s]+)"?/.exec(line)?.[1]).find(Boolean);
    if (version && /^\d/.test(version)) out.push(make('npm', name, version));
  }
  return out;
}

function pnpmLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const out: Omit<Component, 'source' | 'line'>[] = [];
  const section = /\npackages:\n([\s\S]*?)(?:\n\S|$)/.exec(`\n${text}`)?.[1] ?? '';
  const lines = section.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const key = /^ {2}'?\/?([^'\s][^']*?)'?:\s*$/.exec(lines[index])?.[1];
    if (!key) continue;
    const clean = key.replace(/\(.*$/, '').replace(/_[^/@]*$/, '');
    let name: string; let version: string;
    const at = clean.lastIndexOf('@');
    if (at > 0) { name = clean.slice(0, at); version = clean.slice(at + 1); }
    else { const slash = clean.lastIndexOf('/'); name = clean.slice(0, slash); version = clean.slice(slash + 1); }
    let dev = false;
    for (let next = index + 1; next < lines.length && /^ {4}/.test(lines[next]); next += 1) if (/^ {4}dev: true/.test(lines[next])) dev = true;
    if (name && /^\d/.test(version)) out.push(make('npm', name, version, dev));
  }
  return out;
}

function tomlPackages(ecosystem: Ecosystem): (text: string) => Omit<Component, 'source' | 'line'>[] {
  return (text) => text.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap((block) => {
    const body = block.split(/^\[/m)[0];
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const source = /^source\s*=\s*(.+)$/m.exec(body)?.[1] ?? '';
    // A crate without a registry source, or a uv/pdm editable or virtual root, is the project itself.
    if (!name || !version) return [];
    if (ecosystem === 'crates.io' && !/registry\+/.test(source)) return [];
    if (/editable|virtual|path\s*=|directory\s*=/.test(source)) return [];
    const dev = ecosystem === 'PyPI' && /^category\s*=\s*"dev"/m.test(body);
    return [make(ecosystem, name, version, dev)];
  });
}

function pipfileLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const lock = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
  return (['default', 'develop'] as const).flatMap((group) => Object.entries(lock[group] ?? {}).map(([name, entry]) => (entry.version?.startsWith('==') ? make('PyPI', name, entry.version.slice(2), group === 'develop') : undefined)).filter((item): item is ReturnType<typeof make> => Boolean(item)));
}

function requirements(text: string, notes: string[], file: string): Omit<Component, 'source' | 'line'>[] {
  const out: Omit<Component, 'source' | 'line'>[] = [];
  let unpinned = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.+!_-]+)\s*(?:;.*)?$/.exec(line);
    if (match) out.push(make('PyPI', match[1], match[2]));
    else unpinned += 1;
  }
  if (unpinned) notes.push(`${file} has ${unpinned} requirement(s) without an exact version (==), so they can't be checked; pin them or use a lockfile.`);
  return out;
}

function goMod(text: string): Omit<Component, 'source' | 'line'>[] {
  const out: Omit<Component, 'source' | 'line'>[] = [];
  const add = (line: string) => { const match = /^\s*([^\s/][^\s]*)\s+(v[^\s]+)/.exec(line.replace(/\/\/.*$/, '')); if (match) out.push(make('Go', match[1], match[2])); };
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) block[1].split('\n').forEach(add);
  for (const single of text.matchAll(/^require\s+([^\s(][^\n]*)$/gm)) add(single[1]);
  return out;
}

function composerLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const lock = JSON.parse(text) as { packages?: Array<{ name: string; version: string }>; 'packages-dev'?: Array<{ name: string; version: string }> };
  const version = (value: string) => value.replace(/^v(?=\d)/, '');
  return [...(lock.packages ?? []).map((entry) => make('Packagist', entry.name, version(entry.version))), ...(lock['packages-dev'] ?? []).map((entry) => make('Packagist', entry.name, version(entry.version), true))].filter((entry) => /^\d/.test(entry.version));
}

function gemfileLock(text: string): Omit<Component, 'source' | 'line'>[] {
  // The specs list ends at a blank line, the next section, or the end of the file (not of a line).
  const specs = /^GEM\n(?:[ \t]+remote:.*\n)+[ \t]+specs:\n([\s\S]*?)(?=\n\S|\n\n|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return [...specs.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/gm)].map((match) => make('RubyGems', match[1], match[2].replace(/-(?:x86|x64|arm|aarch|universal|java|mingw|mswin|darwin|linux)[\w-]*$/, '')));
}

function nugetLock(text: string): Omit<Component, 'source' | 'line'>[] {
  const lock = JSON.parse(text) as { dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>> };
  return Object.values(lock.dependencies ?? {}).flatMap((framework) => Object.entries(framework).filter(([, entry]) => entry.resolved && entry.type !== 'Project').map(([name, entry]) => make('NuGet', name, entry.resolved!)));
}

function gradleLock(text: string): Omit<Component, 'source' | 'line'>[] {
  return [...text.matchAll(/^([\w.-]+):([\w.-]+):([^=\s]+)=([^\n]*)$/gm)].map((match) => make('Maven', `${match[1]}:${match[2]}`, match[3], !/runtimeClasspath|compileClasspath/.test(match[4])));
}

function pomXml(text: string): Omit<Component, 'source' | 'line'>[] {
  const properties = new Map<string, string>();
  for (const block of text.matchAll(/<properties>([\s\S]*?)<\/properties>/g)) for (const property of block[1].matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) properties.set(property[1], property[2].trim());
  const resolve = (value: string) => value.replace(/\$\{([^}]+)\}/g, (match, key: string) => properties.get(key) ?? match);
  return [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap((match) => {
    const field = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(match[1])?.[1]?.trim();
    const group = field('groupId'); const artifact = field('artifactId'); const version = field('version') && resolve(field('version')!);
    if (!group || !artifact || !version || version.includes('${') || /^\[|,/.test(version)) return [];
    return [make('Maven', `${resolve(group)}:${resolve(artifact)}`, version, field('scope') === 'test')];
  });
}

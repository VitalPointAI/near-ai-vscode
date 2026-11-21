#!/usr/bin/env node
// Refreshes the public, hash-verified compliance dashboard without rebuilding the docs site.
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const siteDefault = resolve(here, '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const option = (name) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; };
const confined = (root, path) => { const item = resolve(root, path); const rel = relative(root, item); return rel && !rel.startsWith('..') && !rel.includes(`..${join('x', 'y').slice(1, 2)}`); };
async function walk(dir, root = dir) {
  const files = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name); const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in bundle: ${relative(root, path)}`);
    if (stat.isDirectory()) files.push(...await walk(path, root));
    else if (stat.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error(`Refusing non-regular file in bundle: ${relative(root, path)}`);
  }
  return files;
}

export async function verifyBundleDir(dir) {
  const root = await realpath(dir); const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !/^[0-9a-f]{7,64}$/.test(manifest.commit ?? '')) throw new Error('Invalid bundle manifest');
  const expected = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !confined(root, entry.path)) throw new Error(`Unsafe manifest path: ${entry?.path ?? ''}`);
    if (expected.has(entry.path)) throw new Error(`Duplicate manifest path: ${entry.path}`);
    expected.add(entry.path);
    const path = resolve(root, entry.path); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Manifest entry is not a regular file: ${entry.path}`);
    const content = await readFile(path);
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`Hash mismatch: ${entry.path}`);
  }
  const actual = new Set((await walk(root)).filter((path) => path !== 'manifest.json'));
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) throw new Error('Bundle files do not exactly match manifest');
  if (!expected.has('dashboard/dashboard.json')) throw new Error('Bundle has no dashboard/dashboard.json');
  return { root, manifest };
}
async function atomicWrite(path, content) { await mkdir(dirname(path), { recursive: true }); const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`); await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); }
async function copyDashboard(bundle, site, refresh) {
  const dashboardRoot = join(bundle, 'dashboard'); const sources = ['dashboard.json', ...(await walk(dashboardRoot)).filter((path) => path.startsWith('text/'))];
  for (const target of [join(site, 'static/compliance'), join(site, 'build/compliance')]) {
    if (target.includes('/build/') && !(await lstat(join(site, 'build')).then(() => true).catch(() => false))) continue;
    for (const source of sources) await atomicWrite(join(target, source), await readFile(join(dashboardRoot, source)));
    await atomicWrite(join(target, 'refresh.json'), `${JSON.stringify(refresh, null, 2)}\n`);
  }
}
function run(command, args) { const result = spawnSync(command, args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || `${command} failed`); return result.stdout; }
async function newestGithubBundle(repo) {
  const runs = ['ci.yml', 'compliance-scheduled.yml'].flatMap((workflow) => JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', workflow, '--status', 'success', '--limit', '1', '--json', 'databaseId,createdAt,headSha,event'])));
  const selected = runs.filter((run) => run.event === 'push' || run.event === 'schedule').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!selected) throw new Error('No successful main or scheduled compliance bundle was found');
  const dir = await mkdtemp(join(tmpdir(), 'near-ai-compliance-bundle-')); run('gh', ['run', 'download', String(selected.databaseId), '--repo', repo, '--name', 'compliance-bundle', '--dir', dir]);
  return { dir, source: `GitHub run ${selected.databaseId}`, commit: selected.headSha };
}
export async function refresh({ fromDir = option('from-dir'), siteDir = option('site-dir') ?? siteDefault, release = option('release'), repo = option('repo') ?? 'VitalPointAI/near-ai-vscode' } = {}) {
  let downloaded; let source = fromDir ? 'local bundle' : ''; let commit;
  try {
    if (!fromDir) { downloaded = await newestGithubBundle(repo); fromDir = downloaded.dir; source = downloaded.source; commit = downloaded.commit; }
    const verified = await verifyBundleDir(fromDir); commit ??= verified.manifest.commit;
    let attestation = 'none'; let note = 'Daily and merge bundles are hash-verified; their attestation is none by design.';
    if (release) { const help = spawnSync('gh', ['attestation', '--help'], { encoding: 'utf8' }); if (help.status === 0) { run('gh', ['attestation', 'verify', release, '--repo', repo]); attestation = 'verified'; note = 'Release package attestation verified.'; } else { attestation = 'not-checked'; note = 'Attestation was not checked: upgrade gh to a version with gh attestation.'; } }
    await copyDashboard(verified.root, resolve(siteDir), { source, commit, fetchedAt: new Date().toISOString(), manifest: 'verified', attestation, note });
    return { commit, attestation };
  } finally { if (downloaded) await rm(downloaded.dir, { recursive: true, force: true }); }
}
if (import.meta.url === `file://${process.argv[1]}`) refresh().then(({ commit, attestation }) => console.log(`Refreshed verified dashboard at ${commit.slice(0, 12)} (attestation: ${attestation}).`)).catch((error) => { console.error(`Compliance refresh refused: ${error.message}`); process.exitCode = 1; });

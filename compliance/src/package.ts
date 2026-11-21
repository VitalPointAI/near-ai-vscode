import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadComponents } from './components.ts';
import { buildSsp, type SspInput } from './oscalSsp.ts';
import { renderReadme, renderSspMarkdown } from './readable.ts';
import { assertNoSecrets } from './redact.ts';
import { lintPage } from './wordLint.ts';
import { loadJson, validateOscal } from './validate.ts';

export interface PackageLevel { readonly id: string; readonly title: string; readonly profile: string; readonly components: readonly string[]; readonly kind?: string }
export interface PackageOptions { readonly release: string; readonly bundle: string; readonly out: string; readonly sourceRoot?: string; readonly levels?: readonly PackageLevel[]; readonly resolved?: string; readonly sboms?: readonly string[] }
export interface PackageResult { readonly directory: string; readonly verify: () => void }
const stable = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const files = (dir: string, root = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const file = path.join(dir, entry.name); return entry.isDirectory() ? files(file, root) : entry.isFile() ? [path.relative(root, file)] : []; }).sort();
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const safeRelease = (release: string) => { if (!/^v?[0-9A-Za-z][0-9A-Za-z._-]*$/.test(release)) throw new Error('invalid release tag'); return release; };

/** Build a deterministic, redacted assessor package. It never modifies the supplied evidence bundle. */
export function buildPackage(options: PackageOptions): PackageResult {
  const root = path.resolve(options.sourceRoot ?? 'compliance'); const bundle = path.resolve(options.bundle); const release = safeRelease(options.release);
  const destination = path.resolve(options.out, `compliance-package-${release}`); rmSync(destination, { recursive: true, force: true }); mkdirSync(path.join(destination, 'oscal/ssp'), { recursive: true });
  const dashboard = existsSync(path.join(bundle, 'dashboard', 'dashboard.json')) ? loadJson(path.join(bundle, 'dashboard', 'dashboard.json')) as any : { generatedAt: '2026-11-21T00:00:00.000Z', commit: 'unknown', rows: [], levels: [] };
  const levels: readonly PackageLevel[] = options.levels ?? (dashboard.levels ?? []).filter((level: any) => level.kind === 'level');
  const loaded = existsSync(path.join(root, 'components')) ? loadComponents(path.join(root, 'components')) : { components: [], errors: [] };
  if (loaded.errors.length) throw new Error(loaded.errors.join('; '));
  for (const level of levels) {
    const input: SspInput = { level, rows: dashboard.rows ?? [], components: loaded.components, generatedAt: dashboard.generatedAt };
    const ssp = buildSsp(input); const valid = validateOscal(ssp, 'system-security-plan', { ours: true }); if (!valid.ok) throw new Error(`invalid SSP ${level.id}: ${valid.errors.join('; ')}`);
    writeFileSync(path.join(destination, 'oscal/ssp', `${level.id}.json`), stable(ssp));
    mkdirSync(path.join(destination, 'readable'), { recursive: true }); writeFileSync(path.join(destination, 'readable', `${level.id}-ssp.md`), renderSspMarkdown(input));
  }
  cpSync(bundle, path.join(destination, 'evidence/bundle'), { recursive: true, dereference: false });
  for (const sbom of options.sboms ?? []) cpSync(sbom, path.join(destination, 'evidence', path.basename(sbom)));
  const commit = typeof dashboard.commit === 'string' ? dashboard.commit : 'unknown'; writeFileSync(path.join(destination, 'README.md'), renderReadme(release, commit));
  const readmeHits = lintPage(readFileSync(path.join(destination, 'README.md'), 'utf8')); if (readmeHits.length) throw new Error(`README copy lint: ${readmeHits.map((hit) => hit.phrase).join(', ')}`);
  assertNoSecrets(destination);
  const sums = files(destination).map((relative) => `${digest(path.join(destination, relative))}  ${relative.split(path.sep).join('/')}`).join('\n'); writeFileSync(path.join(destination, 'SHA256SUMS'), `${sums}\n`);
  return { directory: destination, verify: () => { for (const line of readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) { const [hash, relative] = line.split(/  /); if (!relative || digest(path.join(destination, relative)) !== hash) throw new Error(`SHA256SUMS verification failed: ${relative ?? ''}`); } } };
}

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateOurs } from './validate.ts';

export interface ManifestFile { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface BundleManifest { readonly schemaVersion: 1; readonly createdAt: string; readonly commit: string; readonly files: readonly ManifestFile[] }

const slash = (file: string) => file.split(path.sep).join('/');
const within = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);

/** Enumerate plain files only. A symlink is always a verification failure: it could change after hashing. */
function filesUnder(dir: string, root = path.resolve(dir)): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.resolve(dir, entry.name);
    if (!within(root, file)) throw new Error(`bundle path escapes output directory: ${entry.name}`);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`bundle contains symlink: ${slash(path.relative(root, file))}`);
    if (stat.isDirectory()) files.push(...filesUnder(file, root));
    else if (stat.isFile()) files.push(file);
    else throw new Error(`bundle contains unsupported file: ${slash(path.relative(root, file))}`);
  }
  return files;
}

function entry(root: string, file: string): ManifestFile {
  const relative = slash(path.relative(root, file));
  if (!relative || relative.startsWith('/') || relative.split('/').some((part) => part === '..' || part === '.')) throw new Error(`invalid bundle path: ${relative}`);
  const data = readFileSync(file);
  return { path: relative, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

/** Write manifest last, deliberately excluding itself. */
export function writeManifest(dir: string, options: { readonly createdAt: string; readonly commit: string } = { createdAt: new Date().toISOString(), commit: '0000000' }): BundleManifest {
  const root = path.resolve(dir);
  const manifestFile = path.join(root, 'manifest.json');
  const files = filesUnder(root).filter((file) => path.resolve(file) !== manifestFile).map((file) => entry(root, file)).sort((a, b) => a.path.localeCompare(b.path));
  const manifest: BundleManifest = { schemaVersion: 1, createdAt: options.createdAt, commit: options.commit, files };
  const valid = validateOurs(manifest, 'bundle-manifest');
  if (!valid.ok) throw new Error(`invalid manifest: ${valid.errors.join('; ')}`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Verify a manifest against the complete directory, including unexpected files. */
export function verifyManifest(dir: string): { readonly ok: boolean; readonly errors: readonly string[] } {
  const root = path.resolve(dir); const manifestFile = path.join(root, 'manifest.json');
  try {
    if (!lstatSync(manifestFile).isFile()) return { ok: false, errors: ['manifest.json is not a regular file'] };
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BundleManifest;
    const valid = validateOurs(manifest, 'bundle-manifest');
    if (!valid.ok) return { ok: false, errors: valid.errors };
    const actual = new Map(filesUnder(root).filter((file) => path.resolve(file) !== manifestFile).map((file) => { const value = entry(root, file); return [value.path, value] as const; }));
    const expected = new Map(manifest.files.map((value) => [value.path, value]));
    const errors: string[] = [];
    for (const value of manifest.files) {
      const current = actual.get(value.path);
      if (!current) errors.push(`${value.path}: missing`);
      else if (current.bytes !== value.bytes || current.sha256 !== value.sha256) errors.push(`${value.path}: changed`);
    }
    for (const file of actual.keys()) if (!expected.has(file)) errors.push(`${file}: unexpected`);
    return { ok: errors.length === 0, errors };
  } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
}

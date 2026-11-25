// The release evidence folder (48.2-05, D-02, D-15, D-16): everything a release proves about itself, in one folder the release key signs.
//
//   bundle/dashboard/   the release's evidence bundle dashboard: dashboard.json, judgement.json (with the image scan layered in), control text
//   sbom/sterling-image-sbom.cdx.json   the image's CycloneDX SBOM
//   scan/grype.json, scan/db-status.json   the Grype report and the status of the database it used
//   package/<name>, package/<name>.sha256   the compliance package and its checksum, when the release has one
//   documents/road-to-production.md, documents/gaps.json   the road-to-production page and the gap register as published
//   manifest.json   sterling-evidence/1, written last; checkEvidenceManifest (judgement.ts) is its one definition, here and in the session
//
// A release with no compliance package has `package: none`, and with no bundle as well `bundle: none`; the SBOM and the scan are never
// optional. Every input is checked before anything is written; files are 0644 and folders 0755 by an explicit chmod, whatever the umask.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { imageScanObservation, sbomImageDigest } from './collectors/imageScan.ts';
import { checkEvidenceManifest, EVIDENCE_FORMAT, EVIDENCE_JUDGEMENT_FILE, EVIDENCE_MANIFEST_FILE, JUDGEMENT_FORMAT, type EvidenceManifest, type EvidenceManifestFile, type Judgement, type MeasuredEvidenceFile } from './judgement.ts';
import { verifyManifest, type BundleManifest } from './manifest.ts';
import type { Observation, RuleResult } from './model.ts';
import { evaluateObservationRule } from './rules.ts';
import { FUTURE_TOLERANCE_MS } from './status.ts';
import { validateOurs } from './validate.ts';

/** The subject of the release image's scan observation; 48.2-15's evidence rules name it. */
export const RELEASE_IMAGE_SUBJECT = 'sterling-image';
/** The largest input file the folder takes. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export interface ReleaseEvidenceInput {
  readonly out: string;
  /** The release version, three numbers. */
  readonly release: string;
  /** The release build time, ISO. */
  readonly builtAt: string;
  /** The image digest the SBOM and the scan describe (`sha256:<64 hex>`, the SBOM's metadata.component.version). */
  readonly subject: string;
  readonly sbom: string;
  readonly scan: string;
  readonly dbStatus: string;
  /** The verified evidence bundle; absent for a release with no bundle (`bundle: none`). */
  readonly bundleDir?: string;
  /** The release commit; required without a bundle, and equal to the bundle's commit with one. */
  readonly commit?: string;
  readonly packageFile?: string;
  readonly packageSha256?: string;
  readonly roadToProduction?: string;
  readonly gaps?: string;
  readonly now?: Date;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A regular input file's bytes: no link, no folder, nothing over MAX_INPUT_BYTES. */
function readInput(file: string, what: string): Buffer {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new Error(`the ${what} ${file} does not exist`);
  if (stat.isSymbolicLink()) throw new Error(`the ${what} ${file} is a link; give the file itself`);
  if (!stat.isFile()) throw new Error(`the ${what} ${file} is not a regular file`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`the ${what} ${file} is larger than 64 MiB`);
  return readFileSync(file);
}

/** Every regular file under `dir`, relative, sorted; a link or any other kind of entry is refused. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(dir, relative));
    if (stat.isSymbolicLink()) throw new Error(`the bundle holds a link: ${relative}`);
    if (stat.isDirectory()) return filesUnder(dir, relative);
    if (!stat.isFile()) throw new Error(`the bundle holds an entry that is not a file: ${relative}`);
    return [relative];
  });
}

/** The judgement with the release image's scan observation evaluated into every rule on its collector and subject, as release evidence. */
function withObservation(judgement: Judgement, observation: Observation, context: { readonly commit: string; readonly collectedAt: string }): Judgement {
  return {
    ...judgement,
    rows: judgement.rows.map((row) => ({
      ...row,
      components: row.components.map((component) => {
        const results: Record<string, RuleResult> = { ...component.results };
        for (const rule of Object.values(component.rulesByStatement).flat()) {
          if (rule.kind !== 'observation' || rule.observation?.collector !== observation.collector || rule.observation.subject !== observation.subject) continue;
          results[rule.id] = evaluateObservationRule(rule, [observation], context);
        }
        return { ...component, results };
      }),
    })),
  };
}

/** Writes the release evidence folder after checking every input; returns its manifest. Nothing is written when a check fails. */
export function writeReleaseEvidence(input: ReleaseEvidenceInput): EvidenceManifest {
  const now = input.now ?? new Date();
  if (!/^\d+\.\d+\.\d+$/.test(input.release)) throw new Error('the release must be three numbers, for example 0.5.0');
  if (!ISO.test(input.builtAt) || Number.isNaN(Date.parse(input.builtAt))) throw new Error('the build time must be an ISO time, for example 2026-11-25T10:00:00Z');
  if (Date.parse(input.builtAt) - now.getTime() > FUTURE_TOLERANCE_MS) throw new Error('the build time is in the future');
  if (!/^sha256:[0-9a-f]{64}$/.test(input.subject)) throw new Error('the subject must be the image digest, sha256:<64 hex>');
  if (input.commit !== undefined && !/^[0-9a-f]{40}$/.test(input.commit)) throw new Error('the commit must be a 40-character lower-case SHA');
  const outStat = lstatSync(input.out, { throwIfNoEntry: false });
  if (outStat && (!outStat.isDirectory() || outStat.isSymbolicLink())) throw new Error(`the output folder ${input.out} is not a folder`);
  if (outStat && readdirSync(input.out).length > 0) throw new Error(`the output folder ${input.out} is not empty`);
  if ((input.packageFile === undefined) !== (input.packageSha256 === undefined)) throw new Error('a package needs its checksum file, and a checksum file its package');

  // The image: the SBOM names it, the scan must be of it, and the scan observation is dated by its database.
  const sbom = readInput(input.sbom, 'SBOM');
  const scan = readInput(input.scan, 'Grype report');
  const dbStatus = readInput(input.dbStatus, 'database status');
  if (sbomImageDigest(sbom.toString('utf8')) !== input.subject) throw new Error('the SBOM describes another image than the subject');
  const observation = imageScanObservation(scan.toString('utf8'), dbStatus.toString('utf8'), { subject: RELEASE_IMAGE_SUBJECT, sbom: sbom.toString('utf8') });

  // The bundle: verified against its own manifest; its dashboard folder is carried, its judgement with the scan layered in.
  const files = new Map<string, Buffer>();
  let commit = input.commit;
  if (input.bundleDir !== undefined) {
    const stat = lstatSync(input.bundleDir, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`the bundle ${input.bundleDir} is not a folder`);
    const verified = verifyManifest(input.bundleDir);
    if (!verified.ok) throw new Error(`the bundle does not verify against its manifest: ${verified.errors.join('; ')}`);
    const manifest = JSON.parse(readFileSync(path.join(input.bundleDir, 'manifest.json'), 'utf8')) as BundleManifest;
    if (commit !== undefined && manifest.commit !== commit) throw new Error('the bundle is for another commit than the release');
    commit = manifest.commit;
    const dashboard = path.join(input.bundleDir, 'dashboard');
    for (const relative of filesUnder(dashboard)) files.set(`bundle/dashboard/${relative}`, readInput(path.join(dashboard, relative), 'bundle file'));
    const judgementBytes = files.get(EVIDENCE_JUDGEMENT_FILE);
    if (!judgementBytes) throw new Error('the bundle has no judgement (dashboard/judgement.json); build it with this release of the compliance package');
    const judgement = JSON.parse(judgementBytes.toString('utf8')) as Judgement;
    if (judgement?.format !== JUDGEMENT_FORMAT) throw new Error('the bundle judgement is in a format this release does not read');
    const layered = withObservation(judgement, observation, { commit: manifest.commit, collectedAt: input.builtAt });
    files.set(EVIDENCE_JUDGEMENT_FILE, Buffer.from(`${JSON.stringify(layered, null, 2)}\n`));
  }
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('a release with no bundle needs its commit');

  files.set('sbom/sterling-image-sbom.cdx.json', sbom);
  files.set('scan/grype.json', scan);
  files.set('scan/db-status.json', dbStatus);

  if (input.packageFile !== undefined && input.packageSha256 !== undefined) {
    const name = path.basename(input.packageFile);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('the package file name must be plain letters, digits and . _ -');
    const bytes = readInput(input.packageFile, 'package');
    const checksum = readInput(input.packageSha256, 'package checksum');
    const recorded = /^([0-9a-f]{64})(?:\s|$)/.exec(checksum.toString('utf8').trim())?.[1];
    if (recorded !== sha256(bytes)) throw new Error('the package does not match its checksum file');
    files.set(`package/${name}`, bytes);
    files.set(`package/${name}.sha256`, checksum);
  }
  if (input.roadToProduction !== undefined) files.set('documents/road-to-production.md', readInput(input.roadToProduction, 'road-to-production page'));
  if (input.gaps !== undefined) {
    const bytes = readInput(input.gaps, 'gap register');
    let register: unknown;
    try { register = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('the gap register is not JSON'); }
    const valid = validateOurs(register, 'gaps');
    if (!valid.ok) throw new Error(`the gap register fails its schema: ${valid.errors[0] ?? 'invalid'}`);
    files.set('documents/gaps.json', bytes);
  }

  const entries: EvidenceManifestFile[] = [...files].map(([file, bytes]) => ({ path: file, sha256: sha256(bytes), size: bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
  const manifest: EvidenceManifest = {
    format: EVIDENCE_FORMAT, release: input.release, commit, builtAt: input.builtAt, subject: input.subject,
    bundle: input.bundleDir !== undefined ? 'included' : 'none', package: input.packageFile !== undefined ? 'included' : 'none', files: entries,
  };
  const measured: MeasuredEvidenceFile[] = entries.map(({ path: file, sha256: digest, size }) => ({ path: file, sha256: digest, size }));
  const checked = checkEvidenceManifest(manifest, measured);
  if (!checked.ok) throw new Error(`the release evidence would not pass its own check: ${checked.reason} ${checked.file}`);

  // Every check has passed: write the files, then the manifest last.
  const root = path.resolve(input.out);
  const folders = new Set<string>([root]);
  mkdirSync(root, { recursive: true });
  for (const [file, bytes] of files) {
    const target = path.join(root, file);
    for (let folder = path.dirname(target); folder !== root && !folders.has(folder); folder = path.dirname(folder)) folders.add(folder);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(target, 0o644);
  }
  for (const folder of folders) chmodSync(folder, 0o755);
  const manifestFile = path.join(root, EVIDENCE_MANIFEST_FILE);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  chmodSync(manifestFile, 0o644);
  return manifest;
}

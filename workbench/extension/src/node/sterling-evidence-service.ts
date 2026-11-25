import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type {
  EvidenceComponent, EvidenceFreshness, EvidenceLevel, EvidenceRow, EvidenceSnapshot, ReleaseDidNotVerifyReason, ReleaseEvidence, SterlingEvidenceService
} from '../common/sterling-evidence.js';
import { defaultAppRoot } from './team-preview-reader.js';

/** Where the release image carries its own evidence (D-15); `STERLING_RELEASE_EVIDENCE_DIR` points elsewhere for tests and local runs. */
export const DEFAULT_RELEASE_EVIDENCE_DIR = '/opt/sterling/evidence';

type Measured = { readonly path: string; readonly size: number; readonly sha256: string } | { readonly path: string; readonly link: true };
type ManifestCheck = { readonly ok: true; readonly manifest: { readonly release: string; readonly commit: string; readonly builtAt: string; readonly bundle: 'included' | 'none' } }
  | { readonly ok: false; readonly reason: ReleaseDidNotVerifyReason; readonly file: string };
type JudgedRow = Omit<EvidenceRow, 'source' | 'asOf' | 'freshness' | 'components'> & { readonly components: readonly (EvidenceComponent & { readonly evidence: readonly { readonly collectedAt: string }[] })[] };
type Judgement = { readonly format: string; readonly head: string; readonly levels: readonly EvidenceLevel[] };
/** What engine/compliance.cjs (compliance/src/judgement.ts, bundled by tools/build-engine.mjs) exports and this service calls. */
interface ComplianceEngine {
  readonly JUDGEMENT_FORMAT: string;
  readonly EVIDENCE_MANIFEST_FILE: string;
  readonly EVIDENCE_JUDGEMENT_FILE: string;
  checkEvidenceManifest(manifest: unknown, files: readonly Measured[]): ManifestCheck;
  rejudge(judgement: Judgement, options: { readonly now: Date }): { readonly rows: readonly JudgedRow[] };
  rowFreshness(row: JudgedRow, head: string, now: Date): { readonly asOf?: string; readonly freshness: EvidenceFreshness };
}

export interface EvidenceServiceOptions {
  readonly evidenceDir?: string;
  readonly appRoot?: string;
  /** The clock, in milliseconds; Date.now unless a test injects one. */
  readonly now?: () => number;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: unknown })?.code as string | undefined;

/** Every entry under `dir` except the top manifest: each regular file measured, each link (or other non-regular entry) reported as a link. */
async function measure(dir: string, prefix = ''): Promise<Measured[]> {
  const measured: Measured[] = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(dir, path));
    if (stat.isDirectory()) measured.push(...await measure(dir, path));
    else if (!stat.isFile()) measured.push({ path, link: true });
    else {
      const bytes = await readFile(join(dir, path));
      measured.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return measured;
}

/**
 * The backend evidence service (D-01, D-11, D-18). It reads the release evidence folder, hashes every file, checks the set against the
 * folder's sterling-evidence/1 manifest with the engine's own checkEvidenceManifest, and re-judges the release's judgement with the engine's
 * rejudge against the clock at every call. No trust key is configured yet (48.2-04 adds signatures), so a release that checks out is Not
 * verified and none of its rows counts as Met; one that does not is Did not verify and nothing from it is returned. The engine is loaded on
 * first use from the app root, so a missing bundle never stops the backend.
 */
export function createEvidenceService(options: EvidenceServiceOptions = {}): SterlingEvidenceService {
  const evidenceDir = resolve(options.evidenceDir ?? process.env.STERLING_RELEASE_EVIDENCE_DIR ?? DEFAULT_RELEASE_EVIDENCE_DIR);
  const engineFile = resolve(options.appRoot ?? defaultAppRoot(), 'engine', 'compliance.cjs');
  const clock = options.now ?? Date.now;
  let engine: ComplianceEngine | undefined;
  const loadEngine = (): ComplianceEngine | undefined => {
    try {
      engine ??= createRequire(engineFile)(engineFile) as ComplianceEngine;
    } catch {
      return undefined;
    }
    return engine;
  };

  async function readRelease(now: Date): Promise<ReleaseEvidence> {
    try {
      if (!(await lstat(evidenceDir)).isDirectory()) return { verification: 'did-not-verify', reason: 'symlink', file: '.' };
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return { verification: 'none' };
      return { verification: 'did-not-verify', reason: 'unreadable', file: '.' };
    }
    const compliance = loadEngine();
    if (!compliance) return { verification: 'did-not-verify', reason: 'unreadable', file: 'engine/compliance.cjs' };
    const manifestFile = compliance.EVIDENCE_MANIFEST_FILE;
    let files: Measured[];
    let manifest: unknown;
    try {
      const all = await measure(evidenceDir);
      const top = all.find((file) => file.path === manifestFile);
      if (!top) return { verification: 'did-not-verify', reason: 'missing', file: manifestFile };
      if ('link' in top) return { verification: 'did-not-verify', reason: 'symlink', file: manifestFile };
      files = all.filter((file) => file !== top);
      manifest = JSON.parse(await readFile(join(evidenceDir, manifestFile), 'utf8'));
    } catch {
      return { verification: 'did-not-verify', reason: 'unreadable', file: manifestFile };
    }
    const checked = compliance.checkEvidenceManifest(manifest, files);
    if (!checked.ok) return { verification: 'did-not-verify', reason: checked.reason, file: checked.file };
    const release = checked.manifest;
    const layer = { verification: 'not-verified' as const, reason: 'no-trust-key' as const, version: release.release, commit: release.commit, asOf: release.builtAt };
    if (release.bundle === 'none') return { ...layer, levels: [], rows: [] };
    const judgementFile = compliance.EVIDENCE_JUDGEMENT_FILE;
    try {
      const judgement = JSON.parse(await readFile(join(evidenceDir, judgementFile), 'utf8')) as Judgement;
      if (judgement?.format !== compliance.JUDGEMENT_FORMAT) return { verification: 'did-not-verify', reason: 'format', file: judgementFile };
      const judged = compliance.rejudge(judgement, { now });
      const rows: EvidenceRow[] = judged.rows.map((row) => ({ ...row, source: 'release' as const, ...compliance.rowFreshness(row, judgement.head, now) }));
      const levels = judgement.levels.map(({ id, title, claim }) => ({ id, title, claim }));
      return { ...layer, levels, rows };
    } catch {
      return { verification: 'did-not-verify', reason: 'format', file: judgementFile };
    }
  }

  return {
    async getEvidence(): Promise<EvidenceSnapshot> {
      const now = new Date(clock());
      return { judgedAt: now.toISOString(), release: await readRelease(now) };
    }
  };
}

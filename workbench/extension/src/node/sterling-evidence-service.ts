import { createHash, createPublicKey } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type {
  EvidenceAnchor, EvidenceLevel, EvidenceRow, EvidenceSnapshot, ReleaseDidNotVerifyReason, ReleaseEvidence, ReleaseNotVerifiedReason, SterlingEvidenceService
} from '../common/sterling-evidence.js';
import { defaultAppRoot } from './team-preview-reader.js';

/** Where the release image carries its own evidence (D-15); `STERLING_RELEASE_EVIDENCE_DIR` points elsewhere for tests and local runs. */
export const DEFAULT_RELEASE_EVIDENCE_DIR = '/opt/sterling/evidence';
/** Where configuration mounts the trust anchors and the release evidence signatures (D-17, D-22): never the image, never the evidence. */
export const DEFAULT_EVIDENCE_DIR = '/etc/sterling/evidence';
/** How often the trust anchors and signatures are read again, so a newly delivered signature or a changed key shows without a restart. */
export const TRUST_RECHECK_MS = 30_000;

type Measured = { readonly path: string; readonly size: number; readonly sha256: string } | { readonly path: string; readonly link: true };
type ManifestCheck = { readonly ok: true; readonly manifest: { readonly release: string; readonly commit: string; readonly builtAt: string; readonly bundle: 'included' | 'none' } }
  | { readonly ok: false; readonly reason: ReleaseDidNotVerifyReason; readonly file: string };
type JudgedRow = Omit<EvidenceRow, 'source' | 'verification'>;
type Judgement = { readonly format: string; readonly head: string; readonly levels: readonly EvidenceLevel[] };
type SigstoreCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'bundle-format' | 'not-key-mode' | 'key' | 'key-type' | 'digest' | 'signature' };
/** What engine/compliance.cjs (tools/compliance-entry.ts, bundled by tools/build-engine.mjs) exports and this service calls. */
interface ComplianceEngine {
  readonly JUDGEMENT_FORMAT: string;
  readonly EVIDENCE_MANIFEST_FILE: string;
  readonly EVIDENCE_JUDGEMENT_FILE: string;
  checkEvidenceManifest(manifest: unknown, files: readonly Measured[]): ManifestCheck;
  rejudge(judgement: Judgement, options: { readonly now: Date; readonly builtAt?: string }): { readonly rows: readonly JudgedRow[]; readonly clock?: 'clock-behind-build' };
  verifySigstoreBundle(content: Uint8Array, bundle: unknown, publicKeyPem: string): SigstoreCheck;
  publicKeyFingerprint(pem: string): string | undefined;
}

/** The evidence settings (D-17): the two folders and your organization's site key, the same value admission checks every image against. */
export interface EvidenceSettings {
  readonly releaseDir: string;
  readonly trustDir: string;
  /** STERLING_ORGANIZATION_PUBLIC_KEY: one ECDSA P-256 public key in PEM form, at a site; absent on a single computer. */
  readonly organizationPublicKey?: string;
}

const PEM_PUBLIC_KEY = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/;

/**
 * Reads the evidence settings from the environment. An invalid STERLING_ORGANIZATION_PUBLIC_KEY throws one plain sentence that begins with
 * the setting's name; the backend prints it and stops, as it does for its hosting settings, because Retry cannot fix configuration.
 * 48.2-17's site environment contract test reads the variable through this function.
 */
export function readEvidenceSettings(env: Readonly<Record<string, string | undefined>>): EvidenceSettings {
  const releaseDir = resolve(env.STERLING_RELEASE_EVIDENCE_DIR || DEFAULT_RELEASE_EVIDENCE_DIR);
  const trustDir = resolve(env.STERLING_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR);
  const pem = env.STERLING_ORGANIZATION_PUBLIC_KEY;
  if (pem === undefined || pem.trim() === '') return { releaseDir, trustDir };
  let curve: string | undefined;
  try {
    const key = createPublicKey({ key: pem, format: 'pem' });
    curve = key.type === 'public' && key.asymmetricKeyType === 'ec' ? key.asymmetricKeyDetails?.namedCurve : undefined;
  } catch {
    curve = undefined;
  }
  if (!PEM_PUBLIC_KEY.test(pem.trim()) || curve !== 'prime256v1') {
    throw new Error('STERLING_ORGANIZATION_PUBLIC_KEY must be your organization’s site key: one ECDSA P-256 public key in PEM form.');
  }
  return { releaseDir, trustDir, organizationPublicKey: pem };
}

export interface EvidenceServiceOptions {
  /** The settings; read from the process environment with readEvidenceSettings when absent. */
  readonly settings?: EvidenceSettings;
  readonly appRoot?: string;
  /** The clock, in milliseconds; Date.now unless a test injects one. */
  readonly now?: () => number;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: unknown })?.code as string | undefined;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Every entry under `dir`: each regular file measured, each link (or other non-regular entry) reported as a link. */
async function measure(dir: string, prefix = ''): Promise<Measured[]> {
  const measured: Measured[] = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(dir, path));
    if (stat.isDirectory()) measured.push(...await measure(dir, path));
    else if (!stat.isFile()) measured.push({ path, link: true });
    else {
      const bytes = await readFile(join(dir, path));
      measured.push({ path, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  return measured;
}

/** A configuration file's text, or undefined when it is absent. Only a regular file counts: a link in the trust folder is ignored. */
async function configFile(dir: string, name: string): Promise<string | undefined> {
  try {
    const path = join(dir, name);
    if (!(await lstat(path)).isFile()) return undefined;
    return await readFile(path, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** The release folder as read once at start: the image is read-only, so its content is hashed once (D-30). */
type ReleaseRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string }
  | { readonly kind: 'checked'; readonly manifestBytes: Buffer; readonly manifest: Extract<ManifestCheck, { ok: true }>['manifest']; readonly judgement?: Judgement };

/** The outcome of the trust check: which anchor vouches for the release, or why none does. */
type TrustOutcome =
  | { readonly verification: 'verified'; readonly anchor: EvidenceAnchor }
  | { readonly verification: 'not-verified'; readonly reason: ReleaseNotVerifiedReason; readonly anchor?: EvidenceAnchor }
  | { readonly verification: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string };

/**
 * The backend evidence service (D-01, D-06, D-11, D-17, D-18). At its first call it reads the release evidence folder once (the image is
 * read-only), hashes every file and checks the set against the sterling-evidence/1 manifest with the engine's own checkEvidenceManifest. It
 * then checks the trust: anchors come only from the configuration folder (`organization.pub`, your organization's site key, which must
 * equal STERLING_ORGANIZATION_PUBLIC_KEY; or, with no `organization.pub`, a `supplier.pub` the person mounted), never from the image or the
 * evidence; the release's Sigstore bundle (`release-<version>.sigstore.json`, beside the anchor) must verify over the manifest with that
 * anchor. Verified, Not verified (content shown, nothing counts as Met) or Did not verify (nothing shown). The trust files are read again
 * every 30 seconds, and the outcome is recomputed whenever they change. Rows are re-judged with the engine's rejudge at every call; a clock
 * earlier than the release build is the clock case, never a refusal. Nothing here reaches the network.
 */
export function createEvidenceService(options: EvidenceServiceOptions = {}): SterlingEvidenceService {
  const settings = options.settings ?? readEvidenceSettings(process.env);
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

  let release: Promise<ReleaseRead> | undefined;
  let trust: { readonly key: string; readonly outcome: TrustOutcome; readonly checkedAt: string; readonly readAt: number } | undefined;

  async function readRelease(compliance: ComplianceEngine): Promise<ReleaseRead> {
    const dir = settings.releaseDir;
    try {
      if (!(await lstat(dir)).isDirectory()) return { kind: 'did-not-verify', reason: 'symlink', file: '.' };
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? { kind: 'none' } : { kind: 'did-not-verify', reason: 'unreadable', file: '.' };
    }
    const manifestFile = compliance.EVIDENCE_MANIFEST_FILE;
    let manifestBytes: Buffer;
    let checked: ManifestCheck;
    try {
      const all = await measure(dir);
      const top = all.find((file) => file.path === manifestFile);
      if (!top) return { kind: 'did-not-verify', reason: 'missing', file: manifestFile };
      if ('link' in top) return { kind: 'did-not-verify', reason: 'symlink', file: manifestFile };
      manifestBytes = await readFile(join(dir, manifestFile));
      if (sha256(manifestBytes) !== top.sha256) return { kind: 'did-not-verify', reason: 'unreadable', file: manifestFile };
      checked = compliance.checkEvidenceManifest(JSON.parse(manifestBytes.toString('utf8')), all.filter((file) => file !== top));
    } catch {
      return { kind: 'did-not-verify', reason: 'unreadable', file: manifestFile };
    }
    if (!checked.ok) return { kind: 'did-not-verify', reason: checked.reason, file: checked.file };
    if (checked.manifest.bundle === 'none') return { kind: 'checked', manifestBytes, manifest: checked.manifest };
    const judgementFile = compliance.EVIDENCE_JUDGEMENT_FILE;
    try {
      const judgement = JSON.parse(await readFile(join(dir, judgementFile), 'utf8')) as Judgement;
      if (judgement?.format !== compliance.JUDGEMENT_FORMAT) return { kind: 'did-not-verify', reason: 'format', file: judgementFile };
      return { kind: 'checked', manifestBytes, manifest: checked.manifest, judgement };
    } catch {
      return { kind: 'did-not-verify', reason: 'format', file: judgementFile };
    }
  }

  /** The trust outcome for a checked release, from the anchor and signature files read now. */
  function checkTrust(compliance: ComplianceEngine, read: Extract<ReleaseRead, { kind: 'checked' }>, files: Readonly<Record<'organization' | 'supplier' | 'signature', string | undefined>>, signatureFile: string): TrustOutcome {
    let anchor: EvidenceAnchor;
    let pem: string;
    if (files.organization !== undefined) {
      if (settings.organizationPublicKey === undefined) return { verification: 'not-verified', reason: 'anchor-unconfirmed', anchor: 'organization' };
      const mounted = compliance.publicKeyFingerprint(files.organization);
      if (mounted === undefined || mounted !== compliance.publicKeyFingerprint(settings.organizationPublicKey)) return { verification: 'did-not-verify', reason: 'anchor-mismatch', file: 'organization.pub' };
      anchor = 'organization';
      pem = files.organization;
    } else if (files.supplier !== undefined) {
      anchor = 'supplier';
      pem = files.supplier;
    } else {
      return { verification: 'not-verified', reason: 'no-trust-key' };
    }
    if (files.signature === undefined) return { verification: 'not-verified', reason: 'no-signature', anchor };
    let bundle: unknown;
    try {
      bundle = JSON.parse(files.signature);
    } catch {
      return { verification: 'did-not-verify', reason: 'signature', file: signatureFile };
    }
    const verified = compliance.verifySigstoreBundle(read.manifestBytes, bundle, pem);
    if (verified.ok) return { verification: 'verified', anchor };
    return { verification: 'did-not-verify', reason: verified.reason === 'digest' ? 'other-manifest' : 'signature', file: signatureFile };
  }

  async function currentTrust(compliance: ComplianceEngine, read: Extract<ReleaseRead, { kind: 'checked' }>, now: number) {
    if (trust && now - trust.readAt < TRUST_RECHECK_MS) return trust;
    const signatureFile = `release-${read.manifest.release}.sigstore.json`;
    const files = {
      organization: await configFile(settings.trustDir, 'organization.pub'),
      supplier: await configFile(settings.trustDir, 'supplier.pub'),
      signature: await configFile(settings.trustDir, signatureFile),
    };
    const key = sha256(Buffer.from(JSON.stringify([files.organization ?? null, files.supplier ?? null, files.signature ?? null])));
    // The outcome is never kept across a change of the anchor or signature files.
    if (trust && trust.key === key) return trust = { ...trust, readAt: now };
    return trust = { key, outcome: checkTrust(compliance, read, files, signatureFile), checkedAt: new Date(now).toISOString(), readAt: now };
  }

  async function releaseLayer(now: Date): Promise<ReleaseEvidence> {
    const compliance = loadEngine();
    if (!compliance) return { verification: 'did-not-verify', reason: 'unreadable', file: 'engine/compliance.cjs' };
    release ??= readRelease(compliance);
    const read = await release;
    if (read.kind === 'none') return { verification: 'none' };
    if (read.kind === 'did-not-verify') return { verification: 'did-not-verify', reason: read.reason, file: read.file };
    let checkedTrust;
    try {
      checkedTrust = await currentTrust(compliance, read, now.getTime());
    } catch {
      return { verification: 'did-not-verify', reason: 'unreadable', file: settings.trustDir };
    }
    const { outcome, checkedAt } = checkedTrust;
    if (outcome.verification === 'did-not-verify') return { verification: 'did-not-verify', reason: outcome.reason, file: outcome.file };
    const layer = {
      ...outcome, version: read.manifest.release, commit: read.manifest.commit, asOf: read.manifest.builtAt, checkedAt,
    };
    if (!read.judgement) return { ...layer, levels: [], rows: [] };
    try {
      const judged = compliance.rejudge(read.judgement, { now, builtAt: read.manifest.builtAt });
      const rows: EvidenceRow[] = judged.rows.map((row) => ({ ...row, source: 'release' as const, verification: outcome.verification }));
      const levels = read.judgement.levels.map(({ id, title, claim }) => ({ id, title, claim }));
      return { ...layer, ...(judged.clock ? { clock: judged.clock } : {}), levels, rows };
    } catch {
      return { verification: 'did-not-verify', reason: 'format', file: compliance.EVIDENCE_JUDGEMENT_FILE };
    }
  }

  return {
    async getEvidence(): Promise<EvidenceSnapshot> {
      const now = new Date(clock());
      return { judgedAt: now.toISOString(), release: await releaseLayer(now) };
    }
  };
}

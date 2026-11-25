import { createHash, createPublicKey } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  EVIDENCE_MOUNT_FILES, releaseSignatureFile,
  type ControlTextResult, type EvidenceAnchor, type EvidenceComponent, type EvidenceFreshness, type EvidenceLevel, type EvidenceResult, type EvidenceRow,
  type EvidenceSnapshot, type EvidenceSourceName, type EvidenceState, type ProjectionLayer, type ReleaseDidNotVerifyReason, type ReleaseEvidence,
  type ReleaseNotVerifiedReason, type SiteFileOutcome, type SiteLayer, type SterlingEvidenceService
} from '../common/compliance-evidence.js';
import { refreshRecordMatches } from '../common/sterling-evidence.js';
import { defaultAppRoot } from './team-preview-reader.js';

/** Where the release image carries its own evidence (D-15); `STERLING_RELEASE_EVIDENCE_DIR` points elsewhere for tests and local runs. */
export const DEFAULT_RELEASE_EVIDENCE_DIR = '/opt/sterling/evidence';
/** Where configuration mounts the trust anchors, the release evidence signatures and the site files (D-17, D-22): never the image. */
export const DEFAULT_EVIDENCE_DIR = '/etc/sterling/evidence';
/** How often the mounted sources are read again (D-22): a changed file reaches the view within one check. */
export const SOURCE_CHECK_MS = 30_000;
/** How often the rows are judged again whatever the files do, so evidence ages by the clock (D-01, D-25). */
export const REJUDGE_MS = 60_000;
/** How long a long poll waits for a change before it answers with the same revision (D-25). */
export const LONG_POLL_MS = 55_000;
/** The trust check of 48.2-04 (an alias kept for its tests): the anchor and signature files are read again at the source check. */
export const TRUST_RECHECK_MS = SOURCE_CHECK_MS;

const MAX_MOUNT_FILE_BYTES = 1024 * 1024;
const MAX_MOUNT_FILES = 64;
const MAX_PROJECTION_BYTES = 32 * 1024 * 1024;
const CONTROL_TEXT_FILE = /^text\/[a-z0-9][a-z0-9-]*\/[a-z0-9]+\.json$/;

type Measured = { readonly path: string; readonly size: number; readonly sha256: string } | { readonly path: string; readonly link: true };
type ManifestCheck = { readonly ok: true; readonly manifest: { readonly release: string; readonly commit: string; readonly builtAt: string; readonly bundle: 'included' | 'none'; readonly package: 'included' | 'none' } }
  | { readonly ok: false; readonly reason: ReleaseDidNotVerifyReason; readonly file: string };
type Judgement = { readonly format: string; readonly head: string; readonly levels: readonly EvidenceLevel[] };
type JudgedComponent = Omit<EvidenceComponent, 'evidence' | 'applicability' | 'facts'> & { readonly evidence: readonly (Omit<EvidenceResult, 'source'> & { readonly source: string })[]; readonly applicability?: unknown };
type JudgedRow = { readonly level: string; readonly control: string; readonly label: string; readonly title: string; readonly state: EvidenceState; readonly reasonText: string; readonly gap?: string; readonly textFile?: string; readonly components: readonly JudgedComponent[]; readonly asOf?: string; readonly freshness: EvidenceFreshness };
type SigstoreCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'bundle-format' | 'not-key-mode' | 'key' | 'key-type' | 'digest' | 'signature' };
type SiteVerification = { readonly sources: readonly SiteFileOutcome[]; readonly observations: readonly unknown[]; readonly policy?: unknown; readonly notes: readonly string[] };
type ResultFreshnessOptions = { readonly head: string; readonly now: Date };
/** What engine/compliance.cjs (tools/compliance-entry.ts, bundled by tools/build-engine.mjs) exports and this service calls. */
interface ComplianceEngine {
  readonly JUDGEMENT_FORMAT: string;
  readonly EVIDENCE_MANIFEST_FILE: string;
  readonly EVIDENCE_JUDGEMENT_FILE: string;
  readonly EXCHANGE_IDS: readonly string[];
  checkEvidenceManifest(manifest: unknown, files: readonly Measured[]): ManifestCheck;
  rejudge(judgement: Judgement, options: { readonly now: Date; readonly builtAt?: string; readonly observations?: readonly unknown[]; readonly policy?: unknown }): { readonly rows: readonly JudgedRow[]; readonly clock?: 'clock-behind-build'; readonly policy: { readonly clamped: readonly string[]; readonly refused?: string } };
  freshnessOf(result: unknown, options: ResultFreshnessOptions & { readonly windows?: unknown; readonly ageing?: unknown; readonly clockUnknown?: boolean }): 'current' | 'ageing' | 'out-of-date' | 'unknown';
  effectivePolicy(policy?: unknown): { readonly windows: Readonly<Record<string, number | 'head'>>; readonly ageing: unknown };
  verifySigstoreBundle(content: Uint8Array, bundle: unknown, publicKeyPem: string): SigstoreCheck;
  publicKeyFingerprint(pem: string): string | undefined;
  verifySiteEvidence(input: { readonly files: Record<string, unknown>; readonly organizationKey?: string; readonly now: Date; readonly exchangeIds?: readonly string[] }): SiteVerification;
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

/** The timers the service runs on; tests pass fake ones, and nothing runs until start() or waitForEvidence(). */
export interface EvidenceTimers {
  setInterval(callback: () => unknown, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const REAL_TIMERS: EvidenceTimers = {
  setInterval: (callback, ms) => { const handle = setInterval(callback, ms); handle.unref?.(); return handle; },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface EvidenceServiceOptions {
  /** The settings; read from the process environment with readEvidenceSettings when absent. */
  readonly settings?: EvidenceSettings;
  readonly appRoot?: string;
  /** The clock, in milliseconds; Date.now unless a test injects one. */
  readonly now?: () => number;
  readonly timers?: EvidenceTimers;
  /** The README's mounted public projection (D-26); `<appRoot>/lib/frontend/compliance` by default. */
  readonly projectionDir?: string;
}

/** The service with its lifecycle: start() runs the 30-second source check (which re-judges every 60 seconds); dispose() stops it. */
export interface EvidenceService extends SterlingEvidenceService {
  start(): void;
  dispose(): void;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: unknown })?.code as string | undefined;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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

/**
 * The files of a configuration folder: regular files only, at most MAX_MOUNT_FILES of at most MAX_MOUNT_FILE_BYTES each, by name. A kubelet
 * projected volume puts its files behind links into a timestamped folder (..data), so a link to a regular file inside the folder counts.
 */
async function readMount(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => !name.startsWith('.')).sort().slice(0, MAX_MOUNT_FILES);
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return files;
    throw error;
  }
  const root = await realpath(dir);
  for (const name of names) {
    try {
      const path = join(dir, name);
      const real = await realpath(path);
      if (!real.startsWith(`${root}/`)) continue;
      const target = await stat(real);
      if (!target.isFile() || target.size > MAX_MOUNT_FILE_BYTES) continue;
      files.set(name, await readFile(real));
    } catch {
      // A file that vanished between the listing and the read is read again at the next check.
    }
  }
  return files;
}

/** The release folder as read once (the image is read-only, D-30). */
type ReleaseRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string }
  | { readonly kind: 'checked'; readonly manifestBytes: Buffer; readonly listed: ReadonlySet<string>; readonly manifest: Extract<ManifestCheck, { ok: true }>['manifest']; readonly judgement?: Judgement; readonly textIndex: ReadonlySet<string>; readonly scanBuiltAt?: string };

/** The outcome of the release trust check: which anchor vouches for the release, or why none does. */
type TrustOutcome =
  | { readonly verification: 'verified'; readonly anchor: EvidenceAnchor }
  | { readonly verification: 'not-verified'; readonly reason: ReleaseNotVerifiedReason; readonly anchor?: EvidenceAnchor }
  | { readonly verification: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string };

/** The anchor in the mount against the site key in the session's environment (48.2-04, D-17). */
type Anchor = { readonly kind: 'organization'; readonly pem: string } | { readonly kind: 'supplier'; readonly pem: string } | { readonly kind: 'none' } | { readonly kind: 'unconfirmed' } | { readonly kind: 'mismatch' };

/** The published projection as read at a source check. */
type ProjectionRead = { readonly kind: 'none' } | { readonly kind: 'read'; readonly dashboard: Buffer; readonly refresh?: Buffer; readonly key: string };

/**
 * The backend evidence service (D-01, D-04, D-06, D-11, D-17, D-18, D-22, D-24 to D-26).
 *
 * The release folder in the image is read and checked once against its sterling-evidence/1 manifest. The configuration mount (trust anchors,
 * release signatures and the site files) and the README's projection are read at start and every 30 seconds, compared by content, and on a
 * change verified again: the release signature with the anchor from configuration only, the site files through the site trust document
 * your site key signs. The rows are judged with the engine's rejudge, layering the verified site observations over the release's and
 * applying the site's freshness policy, at every change and every 60 seconds whatever the files do; a new revision is issued whenever the
 * view model differs, and every waiting long poll gets it. Nothing reaches the network; nothing outlives its own time.
 */
export function createEvidenceService(options: EvidenceServiceOptions = {}): EvidenceService {
  const settings = options.settings ?? readEvidenceSettings(process.env);
  const appRoot = options.appRoot ?? defaultAppRoot();
  const engineFile = resolve(appRoot, 'engine', 'compliance.cjs');
  const projectionDir = resolve(options.projectionDir ?? join(appRoot, 'lib', 'frontend', 'compliance'));
  const clock = options.now ?? Date.now;
  const timers = options.timers ?? REAL_TIMERS;
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
  let mount: Map<string, Buffer> | undefined;
  let mountKey = '';
  let projection: ProjectionRead = { kind: 'none' };
  let sourcesReadAt = Number.NEGATIVE_INFINITY;
  let judgedAt = Number.NEGATIVE_INFINITY;
  let trust: { readonly key: string; readonly outcome: TrustOutcome; readonly checkedAt: string } | undefined;
  let snapshot: EvidenceSnapshot | undefined;
  let snapshotKey = '';
  let revision = 0;
  let chain: Promise<void> = Promise.resolve();
  let interval: unknown;
  const waiters = new Set<{ readonly resolve: (value: EvidenceSnapshot) => void; readonly timer: unknown }>();

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
    let listed: Set<string>;
    try {
      const all = await measure(dir);
      const top = all.find((file) => file.path === manifestFile);
      if (!top) return { kind: 'did-not-verify', reason: 'missing', file: manifestFile };
      if ('link' in top) return { kind: 'did-not-verify', reason: 'symlink', file: manifestFile };
      manifestBytes = await readFile(join(dir, manifestFile));
      if (sha256(manifestBytes) !== top.sha256) return { kind: 'did-not-verify', reason: 'unreadable', file: manifestFile };
      const rest = all.filter((file) => file !== top);
      listed = new Set(rest.map(({ path }) => path));
      checked = compliance.checkEvidenceManifest(JSON.parse(manifestBytes.toString('utf8')), rest);
    } catch {
      return { kind: 'did-not-verify', reason: 'unreadable', file: manifestFile };
    }
    if (!checked.ok) return { kind: 'did-not-verify', reason: checked.reason, file: checked.file };
    let textIndex = new Set<string>();
    if (listed.has('bundle/dashboard/dashboard.json')) {
      try {
        const dashboard = JSON.parse(await readFile(join(dir, 'bundle/dashboard/dashboard.json'), 'utf8')) as { textIndex?: { file?: unknown }[] };
        textIndex = new Set((dashboard.textIndex ?? []).map(({ file }) => file).filter((file): file is string => typeof file === 'string'));
      } catch {
        textIndex = new Set();
      }
    }
    let scanBuiltAt: string | undefined;
    if (listed.has('scan/db-status.json')) {
      try {
        const built = Date.parse((JSON.parse(await readFile(join(dir, 'scan/db-status.json'), 'utf8')) as { built?: string }).built ?? '');
        if (!Number.isNaN(built)) scanBuiltAt = new Date(built).toISOString();
      } catch {
        scanBuiltAt = undefined;
      }
    }
    const base = { kind: 'checked' as const, manifestBytes, listed, manifest: checked.manifest, textIndex, ...(scanBuiltAt ? { scanBuiltAt } : {}) };
    if (checked.manifest.bundle === 'none') return base;
    const judgementFile = compliance.EVIDENCE_JUDGEMENT_FILE;
    try {
      const judgement = JSON.parse(await readFile(join(dir, judgementFile), 'utf8')) as Judgement;
      if (judgement?.format !== compliance.JUDGEMENT_FORMAT) return { kind: 'did-not-verify', reason: 'format', file: judgementFile };
      return { ...base, judgement };
    } catch {
      return { kind: 'did-not-verify', reason: 'format', file: judgementFile };
    }
  }

  /** organization.pub against the site key in the environment; supplier.pub only when there is no organization.pub. */
  function anchorOf(compliance: ComplianceEngine, files: ReadonlyMap<string, Buffer>): Anchor {
    const organization = files.get(EVIDENCE_MOUNT_FILES.organizationKey)?.toString('utf8');
    if (organization !== undefined) {
      if (settings.organizationPublicKey === undefined) return { kind: 'unconfirmed' };
      const mounted = compliance.publicKeyFingerprint(organization);
      if (mounted === undefined || mounted !== compliance.publicKeyFingerprint(settings.organizationPublicKey)) return { kind: 'mismatch' };
      return { kind: 'organization', pem: organization };
    }
    const supplier = files.get(EVIDENCE_MOUNT_FILES.supplierKey)?.toString('utf8');
    return supplier !== undefined ? { kind: 'supplier', pem: supplier } : { kind: 'none' };
  }

  /** The release trust outcome from the anchor and the release's signature file (48.2-04). */
  function checkTrust(compliance: ComplianceEngine, read: Extract<ReleaseRead, { kind: 'checked' }>, anchor: Anchor, signatureText: string | undefined, signatureFile: string): TrustOutcome {
    if (anchor.kind === 'mismatch') return { verification: 'did-not-verify', reason: 'anchor-mismatch', file: EVIDENCE_MOUNT_FILES.organizationKey };
    if (anchor.kind === 'unconfirmed') return { verification: 'not-verified', reason: 'anchor-unconfirmed', anchor: 'organization' };
    if (anchor.kind === 'none') return { verification: 'not-verified', reason: 'no-trust-key' };
    if (signatureText === undefined) return { verification: 'not-verified', reason: 'no-signature', anchor: anchor.kind };
    let bundle: unknown;
    try {
      bundle = JSON.parse(signatureText);
    } catch {
      return { verification: 'did-not-verify', reason: 'signature', file: signatureFile };
    }
    const verified = compliance.verifySigstoreBundle(read.manifestBytes, bundle, anchor.pem);
    if (verified.ok) return { verification: 'verified', anchor: anchor.kind };
    return { verification: 'did-not-verify', reason: verified.reason === 'digest' ? 'other-manifest' : 'signature', file: signatureFile };
  }

  /** Reads the mount and the projection; true when anything changed since the last read. */
  async function readSources(now: number): Promise<boolean> {
    const files = await readMount(settings.trustDir);
    const key = sha256(Buffer.from(JSON.stringify([...files].map(([name, bytes]) => [name, sha256(bytes)]))));
    let projectionRead: ProjectionRead = { kind: 'none' };
    try {
      const stat = await lstat(join(projectionDir, 'dashboard.json'));
      if (stat.isFile() && stat.size <= MAX_PROJECTION_BYTES) {
        const dashboard = await readFile(join(projectionDir, 'dashboard.json'));
        const refresh = await readFile(join(projectionDir, 'refresh.json')).catch(() => undefined);
        projectionRead = { kind: 'read', dashboard, ...(refresh ? { refresh } : {}), key: sha256(Buffer.concat([dashboard, Buffer.from('\0'), refresh ?? Buffer.alloc(0)])) };
      }
    } catch {
      projectionRead = { kind: 'none' };
    }
    sourcesReadAt = now;
    const projectionKey = projectionRead.kind === 'read' ? projectionRead.key : '';
    const changed = mount === undefined || key !== mountKey || projectionKey !== (projection.kind === 'read' ? projection.key : '');
    mount = files;
    mountKey = key;
    projection = projectionRead;
    return changed;
  }

  /** The release layer's rows as cells: each result with its source and freshness, each cell with its sources, verification and display. */
  function cells(rows: readonly JudgedRow[], verification: 'verified' | 'not-verified'): EvidenceRow[] {
    return rows.map((row) => {
      const components: EvidenceComponent[] = row.components.map((component) => {
        const { applicability, ...rest } = component as JudgedComponent & { applicability?: { class?: unknown; reasonText?: unknown } };
        const excluded = isRecord(applicability) && applicability.class === 'not-applicable' && component.state === 'not-applicable';
        return {
          ...rest,
          evidence: component.evidence.map((result) => ({ ...result, source: result.source as EvidenceSourceName })),
          ...(isRecord(applicability) ? { applicability: { class: String(applicability.class), reasonText: String(applicability.reasonText ?? component.reasonText) } } : {}),
          ...(excluded ? { facts: 'not-applicable' as const } : {}),
        };
      });
      const sources = [...new Set(components.filter(({ facts }) => facts !== 'not-applicable').flatMap(({ evidence }) => evidence.map(({ source }) => source)))];
      const reason = (row as { reason?: unknown }).reason;
      return {
        level: row.level, control: row.control, label: row.label, title: row.title, state: row.state, ...(typeof reason === 'string' ? { reason } : {}), reasonText: row.reasonText,
        ...(row.gap ? { gap: row.gap } : {}), ...(row.textFile ? { textFile: row.textFile } : {}),
        components, source: 'release' as const, sources, ...(row.asOf ? { asOf: row.asOf } : {}), freshness: row.freshness, verification,
        displayState: verification === 'verified' ? row.state : 'not-verified' as const,
      };
    });
  }

  /** The site layer and the observations and policy it gives the judgement. */
  function siteLayer(compliance: ComplianceEngine, files: ReadonlyMap<string, Buffer>, anchor: Anchor, now: Date): { layer: Omit<SiteLayer, 'policy'>; observations: readonly unknown[]; policy?: unknown } {
    const names = { trust: EVIDENCE_MOUNT_FILES.trust, live: EVIDENCE_MOUNT_FILES.live, export: EVIDENCE_MOUNT_FILES.export, rescan: EVIDENCE_MOUNT_FILES.rescan, agreements: EVIDENCE_MOUNT_FILES.agreements };
    const present = Object.values(names).some((name) => files.has(name));
    if (!present) return { layer: { verification: 'none', files: [], notes: [] }, observations: [] };
    if (anchor.kind === 'mismatch') return { layer: { verification: 'did-not-verify', reason: 'anchor-mismatch', files: [], notes: [] }, observations: [] };
    if (anchor.kind === 'unconfirmed') return { layer: { verification: 'not-verified', reason: 'anchor-unconfirmed', files: [], notes: [] }, observations: [] };
    if (anchor.kind !== 'organization') return { layer: { verification: 'not-verified', reason: 'no-site-key', files: [], notes: [] }, observations: [] };
    const document = files.get(names.trust);
    const signature = files.get(EVIDENCE_MOUNT_FILES.trustSignature);
    let bundle: unknown;
    try { bundle = signature ? JSON.parse(signature.toString('utf8')) : undefined; } catch { bundle = undefined; }
    const siteFiles: Record<string, unknown> = {};
    if (document) siteFiles.trust = { document, bundle };
    for (const file of ['live', 'export', 'rescan', 'agreements'] as const) {
      const bytes = files.get(names[file]);
      if (bytes) siteFiles[file] = bytes;
    }
    const verified = compliance.verifySiteEvidence({ files: siteFiles, organizationKey: anchor.pem, now, exchangeIds: compliance.EXCHANGE_IDS });
    const trustOutcome = verified.sources.find(({ file }) => file === 'trust');
    const others = verified.sources.filter(({ file }) => file !== 'trust');
    let site: string | undefined;
    if (trustOutcome?.verification === 'verified' && document) {
      try { site = (JSON.parse(document.toString('utf8')) as { site?: string }).site; } catch { site = undefined; }
    }
    const signed = others.flatMap((outcome) => outcome.verification === 'verified' ? [outcome.signedAt] : []).sort();
    return {
      layer: {
        verification: trustOutcome?.verification ?? 'not-verified',
        ...(trustOutcome && trustOutcome.verification !== 'verified' ? { reason: trustOutcome.reason } : {}),
        ...(site ? { site } : {}), ...(signed.length ? { lastUpdate: signed[signed.length - 1] } : {}),
        files: verified.sources, notes: verified.notes,
      },
      observations: verified.observations,
      ...(verified.policy !== undefined ? { policy: verified.policy } : {}),
    };
  }

  /** The projection layer (D-26): Not verified, with its rows' recorded states shown as "Not verified" and never counted. */
  function projectionLayer(compliance: ComplianceEngine, now: Date): ProjectionLayer | undefined {
    if (projection.kind !== 'read') return undefined;
    let dashboard: { commit?: unknown; generatedAt?: unknown; levels?: unknown; rows?: unknown };
    let record: unknown;
    try {
      dashboard = JSON.parse(projection.dashboard.toString('utf8'));
      record = projection.refresh ? JSON.parse(projection.refresh.toString('utf8')) : undefined;
    } catch {
      return { verification: 'did-not-verify', reason: 'format' };
    }
    if (!refreshRecordMatches(record, dashboard.commit)) return { verification: 'did-not-verify', reason: 'no-refresh-record' };
    if (!Array.isArray(dashboard.rows) || !Array.isArray(dashboard.levels) || typeof dashboard.commit !== 'string') return { verification: 'did-not-verify', reason: 'format' };
    const head = dashboard.commit;
    const rows: EvidenceRow[] = (dashboard.rows as JudgedRow[]).map((row) => {
      const components: EvidenceComponent[] = (row.components ?? []).map((component) => ({
        component: component.component, responsibility: component.responsibility, state: component.state, reasonText: component.reasonText,
        ...(component.statement ? { statement: component.statement } : {}),
        evidence: (component.evidence ?? []).map((result) => ({ ...result, source: 'projection' as const, freshness: compliance.freshnessOf(result, { head, now }) })),
      }));
      const results = components.flatMap(({ evidence }) => evidence);
      const rank = { current: 0, ageing: 1, 'out-of-date': 2, unknown: 3 } as const;
      const worst = results.reduce<EvidenceFreshness>((acc, { freshness }) => acc === 'none' || rank[freshness as keyof typeof rank] > rank[acc as keyof typeof rank] ? freshness : acc, 'none');
      const asOf = results.map(({ collectedAt }) => collectedAt).sort()[0];
      return {
        level: row.level, control: row.control, label: row.label, title: row.title, state: row.state, reasonText: row.reasonText,
        ...(row.gap ? { gap: row.gap } : {}), ...(row.textFile ? { textFile: row.textFile } : {}),
        components, source: 'projection' as const, sources: results.length ? ['projection' as const] : [], ...(asOf ? { asOf } : {}), freshness: worst,
        verification: 'not-verified' as const, displayState: 'not-verified' as const,
      };
    });
    const levels = (dashboard.levels as EvidenceLevel[]).map(({ id, title, claim }) => ({ id, title, claim }));
    const refresh = record as { source: string; fetchedAt: string };
    return { verification: 'not-verified', reason: 'host-checked-not-signed', source: refresh.source, commit: head, fetchedAt: refresh.fetchedAt,
      generatedAt: typeof dashboard.generatedAt === 'string' ? dashboard.generatedAt : '', levels, rows };
  }

  /** Computes the view model from the sources as last read, judged at `now`. */
  async function judge(now: Date): Promise<Omit<EvidenceSnapshot, 'revision'>> {
    const compliance = loadEngine();
    const judgedAtText = now.toISOString();
    const noPolicy = { source: 'release-defaults' as const, reason: 'no-site-policy' as const, clamped: [] };
    const files = mount ?? new Map<string, Buffer>();
    const siteFileNames = [EVIDENCE_MOUNT_FILES.organizationKey, EVIDENCE_MOUNT_FILES.trust, EVIDENCE_MOUNT_FILES.live, EVIDENCE_MOUNT_FILES.export, EVIDENCE_MOUNT_FILES.rescan, EVIDENCE_MOUNT_FILES.agreements];
    // A site, or a single computer (UI-SPEC P1): the view chooses its guidance by this.
    const setting = settings.organizationPublicKey !== undefined || siteFileNames.some((name) => files.has(name)) ? 'site' as const : 'single-computer' as const;
    if (!compliance) return { judgedAt: judgedAtText, setting, release: { verification: 'did-not-verify', reason: 'unreadable', file: 'engine/compliance.cjs' }, site: { verification: 'none', files: [], notes: [], policy: noPolicy } };
    release ??= readRelease(compliance);
    const read = await release;
    const anchor = anchorOf(compliance, files);
    const site = siteLayer(compliance, files, anchor, now);
    const projected = projectionLayer(compliance, now);
    const effective = compliance.effectivePolicy(site.policy);
    const head = read.kind === 'checked' && read.judgement ? read.judgement.head : '';
    const ageOf = (collectedAt: string, window: string, clockUnknown = false) =>
      compliance.freshnessOf({ rule: 'view', passed: true, reason: 'met', collectedAt, window }, { head, now, windows: effective.windows, ageing: effective.ageing, clockUnknown });
    const siteFacts = (): Partial<SiteLayer> => {
      if (site.layer.verification !== 'verified') return {};
      const windows: Readonly<Record<string, string>> = { 'site-live': 'live', deployment: 'settings', 'image-scan': 'vulnerability', 'site-agreements': 'document' };
      const observations = site.observations as readonly { readonly collector: string; readonly collectedAt: string }[];
      const items = { current: 0, ageing: 0, outOfDate: 0 };
      for (const { collector, collectedAt } of observations) {
        const freshness = ageOf(collectedAt, windows[collector] ?? 'head');
        if (freshness === 'current') items.current += 1;
        else if (freshness === 'ageing') items.ageing += 1;
        else if (freshness === 'out-of-date') items.outOfDate += 1;
      }
      const live = observations.filter(({ collector }) => collector === 'site-live').map(({ collectedAt }) => collectedAt).sort();
      const lastCollected = live[live.length - 1];
      const exportFile = site.layer.files.find(({ file, verification }) => file === 'export' && verification === 'verified');
      const rescan = observations.find(({ collector }) => collector === 'image-scan');
      const reviews = observations.filter(({ collector }) => collector === 'site-agreements').map(({ collectedAt }) => Date.parse(collectedAt)).sort((a, b) => a - b);
      const document = effective.windows.document;
      const liveWindow = effective.windows.live;
      return {
        items, ...(lastCollected ? { lastCollected, outOfDate: ageOf(lastCollected, 'live') === 'out-of-date' } : {}),
        ...(typeof liveWindow === 'number' ? { liveOutOfDateHours: Math.round(liveWindow / 3_600_000) } : {}),
        ...(exportFile && exportFile.verification === 'verified' ? { exportSignedAt: exportFile.signedAt } : {}),
        ...(rescan ? { rescanBuiltAt: rescan.collectedAt } : {}),
        ...(reviews.length && typeof document === 'number' ? { agreementsNextReview: new Date(reviews[0]! + document).toISOString() } : {}),
      };
    };
    const withLayers = (releaseLayer: ReleaseEvidence, policy: SiteLayer['policy']): Omit<EvidenceSnapshot, 'revision'> =>
      ({ judgedAt: judgedAtText, setting, release: releaseLayer, site: { ...site.layer, ...siteFacts(), policy }, ...(projected ? { projection: projected } : {}) });
    const sitePolicy = site.policy !== undefined ? { source: 'site' as const, clamped: [] } : noPolicy;
    if (read.kind === 'none') return withLayers({ verification: 'none' }, sitePolicy);
    if (read.kind === 'did-not-verify') return withLayers({ verification: 'did-not-verify', reason: read.reason, file: read.file }, sitePolicy);
    const signatureFile = releaseSignatureFile(read.manifest.release);
    const signatureText = files.get(signatureFile)?.toString('utf8');
    const trustKey = sha256(Buffer.from(JSON.stringify([anchor, signatureText ?? null])));
    // The outcome is never kept across a change of the anchor or signature files; checkedAt says when it was last computed.
    if (!trust || trust.key !== trustKey) trust = { key: trustKey, outcome: checkTrust(compliance, read, anchor, signatureText, signatureFile), checkedAt: judgedAtText };
    const { outcome, checkedAt } = trust;
    if (outcome.verification === 'did-not-verify') return withLayers({ verification: 'did-not-verify', reason: outcome.reason, file: outcome.file }, sitePolicy);
    const clockBehind = Date.parse(read.manifest.builtAt) - now.getTime() > 5 * 60_000;
    const scan = read.scanBuiltAt ? { scan: { builtAt: read.scanBuiltAt, freshness: ageOf(read.scanBuiltAt, 'vulnerability', clockBehind) } } : {};
    const layer = { ...outcome, version: read.manifest.release, commit: read.manifest.commit, asOf: read.manifest.builtAt, checkedAt, ...scan, bundle: read.manifest.bundle, package: read.manifest.package };
    if (!read.judgement) return withLayers({ ...layer, ...(clockBehind ? { clock: 'clock-behind-build' as const } : {}), levels: [], rows: [] }, sitePolicy);
    try {
      const judged = compliance.rejudge(read.judgement, { now, builtAt: read.manifest.builtAt, observations: site.observations, ...(site.policy !== undefined ? { policy: site.policy } : {}) });
      const policy = site.policy === undefined ? noPolicy
        : judged.policy.refused ? { source: 'release-defaults' as const, reason: 'site-policy-refused' as const, clamped: [] }
        : { source: 'site' as const, clamped: judged.policy.clamped };
      const levels = read.judgement.levels.map(({ id, title, claim }) => ({ id, title, claim }));
      return withLayers({ ...layer, ...(judged.clock ? { clock: judged.clock } : {}), levels, rows: cells(judged.rows, outcome.verification) }, policy);
    } catch {
      return withLayers({ verification: 'did-not-verify', reason: 'format', file: compliance.EVIDENCE_JUDGEMENT_FILE }, sitePolicy);
    }
  }

  /** Reads the sources when due, judges when they changed or when a re-judge is due, and issues a new revision when the model differs. */
  async function refresh(): Promise<void> {
    const now = clock();
    const changed = now - sourcesReadAt >= SOURCE_CHECK_MS ? await readSources(now) : false;
    if (!snapshot || changed || now - judgedAt >= REJUDGE_MS) {
      const model = await judge(new Date(now));
      judgedAt = now;
      const { judgedAt: _at, ...comparable } = model;
      const key = JSON.stringify(comparable);
      if (!snapshot || key !== snapshotKey) {
        revision += 1;
        snapshotKey = key;
        snapshot = { revision, ...model };
        for (const waiter of [...waiters]) {
          waiters.delete(waiter);
          timers.clearTimeout(waiter.timer);
          waiter.resolve(snapshot);
        }
      } else {
        snapshot = { ...snapshot, judgedAt: model.judgedAt };
      }
    }
  }
  /** One refresh at a time, in call order: a check asked for while one runs reads the sources again after it. */
  function check(): Promise<void> {
    const next = chain.then(() => refresh());
    chain = next.catch(() => undefined);
    return next;
  }

  async function controlText(file: string): Promise<ControlTextResult> {
    if (!CONTROL_TEXT_FILE.test(file) || file.split('/').some((part) => part === '..' || part === '.')) return { kind: 'refused' };
    await check();
    const compliance = loadEngine();
    if (!compliance || !release) return { kind: 'refused' };
    const read = await release;
    const readJson = async (path: string): Promise<unknown> => {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_MOUNT_FILE_BYTES * 8) throw new Error('not a plain control text file');
      return JSON.parse(await readFile(path, 'utf8'));
    };
    if (read.kind === 'checked') {
      if (snapshot?.release.verification === 'did-not-verify' || !read.listed.has(`bundle/dashboard/${file}`) || !read.textIndex.has(file)) return { kind: 'refused' };
      try { return { kind: 'ready', source: 'release', text: await readJson(join(settings.releaseDir, 'bundle', 'dashboard', file)) }; } catch { return { kind: 'refused' }; }
    }
    if (read.kind === 'did-not-verify' || snapshot?.projection?.verification !== 'not-verified' || projection.kind !== 'read') return { kind: 'refused' };
    try {
      const dashboard = JSON.parse(projection.dashboard.toString('utf8')) as { textIndex?: { file?: unknown }[] };
      if (!(dashboard.textIndex ?? []).some((entry) => entry.file === file)) return { kind: 'refused' };
      return { kind: 'ready', source: 'projection', text: await readJson(join(projectionDir, file)) };
    } catch {
      return { kind: 'refused' };
    }
  }

  const service: EvidenceService = {
    start(): void {
      interval ??= timers.setInterval(() => check(), SOURCE_CHECK_MS);
    },
    dispose(): void {
      if (interval !== undefined) timers.clearInterval(interval);
      interval = undefined;
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        timers.clearTimeout(waiter.timer);
        if (snapshot) waiter.resolve(snapshot);
      }
    },
    async getEvidence(): Promise<EvidenceSnapshot> {
      await check();
      return snapshot!;
    },
    waitForEvidence(afterRevision: number): Promise<EvidenceSnapshot> {
      service.start();
      // Any other revision than the caller's is news (a restarted backend counts from 1 again).
      if (snapshot && snapshot.revision !== afterRevision) return Promise.resolve(snapshot);
      return new Promise((resolveWait) => {
        const waiter = {
          resolve: resolveWait,
          timer: timers.setTimeout(() => {
            waiters.delete(waiter);
            void check().then(() => resolveWait(snapshot!), () => resolveWait(snapshot!));
          }, LONG_POLL_MS),
        };
        waiters.add(waiter);
        void check().then(() => {
          if (waiters.has(waiter) && snapshot && snapshot.revision !== afterRevision) {
            waiters.delete(waiter);
            timers.clearTimeout(waiter.timer);
            resolveWait(snapshot);
          }
        }, () => undefined);
      });
    },
    getControlText: controlText,
  };
  return service;
}

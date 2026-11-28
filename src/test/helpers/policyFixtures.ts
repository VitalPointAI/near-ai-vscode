// Fixtures for policy bundle v2 (Phase 41): deterministic Ed25519 keys made at test time from a label, a fixed clock, the starting rules as a v2 document,
// a document with every section and optional key, and the one signer for each layer. Fictional names only; no key material is written in this file.
// The key technique (a PKCS8 prefix and a seed from SHA-256 of a label) is copied from replicaWorld's fixedSigner, not imported, so the gate's tests stay
// apart from the replica helpers.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { MAX_DAYS_BY_KIND, SUBJECT_FOR_KIND } from '../../domain/gate/authorizations';
import type { AuthorizationBody, AuthorizationKind, AuthorizationScope, AuthorizationSubject, NamedPerson } from '../../domain/gate/authorizations';
import { defaultBundlePayload } from '../../domain/gate/bundle';
import { SCALE_PRESETS } from '../../domain/gate/labels';
import { parseModelsSection } from '../../domain/gate/models';
import type { ModelsSection } from '../../domain/gate/models';
import { SHIPPED_PASSPORTS } from '../../domain/gate/shippedPassports';
import { MAX_ORGANIZATION_LAYER_BYTES, documentFromBundle } from '../../domain/gate/policyDocument';
import type { PolicyDocument, PolicyLayerName } from '../../domain/gate/policyDocument';
import { fingerprintOf } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { signPayload } from '../../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../../domain/team/signedPayload';

/** 2026-11-20T00:00:00.000Z, the clock every Phase 41 fixture uses. */
export const FIXED_NOW = Date.parse('2026-11-20T00:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

// The 16-byte PKCS8 header of an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFor(label: string): PayloadSigner {
  const seed = createHash('sha256').update(`policy-fixture/${label}`, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

/** Your organization's issuer key in a test: the same key for the same label on every run. */
export function issuerKey(label = 'organization-issuer'): PayloadSigner {
  return keyFor(`issuer/${label}`);
}

/** This device's key in a test: the same key for the same label on every run. */
export function deviceKey(label = 'this-device'): PayloadSigner {
  return keyFor(`device/${label}`);
}

/** A key source that knows exactly these keys as active (fingerprint and public key both match) and nothing else. */
export function activeKeys(...signers: PayloadSigner[]): KeyStatusLookup {
  return (key) => (signers.some((signer) => signer.fingerprint === key.fingerprint && signer.publicKey === key.publicKey) ? { state: 'active' } : { state: 'unknown' });
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface PolicyDocumentOptions {
  readonly key: PayloadSigner;
  readonly layer?: PolicyLayerName;
  readonly now?: number;
}

/** The starting rules as a v2 document issued by `key` at `now` (FIXED_NOW by default): documentFromBundle of the default payload, with the layer set. */
export function policyDocumentFor(options: PolicyDocumentOptions): PolicyDocument {
  const bundle = defaultBundlePayload({ issuer: { fingerprint: options.key.fingerprint, publicKey: options.key.publicKey }, now: options.now ?? FIXED_NOW });
  const document = documentFromBundle(bundle);
  if (options.layer === undefined || options.layer === document.layer) return document;
  return Object.freeze({ ...document, layer: options.layer });
}

export interface FullDocumentOptions {
  readonly layer?: PolicyLayerName;
}

/**
 * A plain (JSON) document with every section and every optional key the parsers accept, issued by `key`. Your organization's layer by default (no
 * parent); a personal or project layer names a parent. 41-02 enumerates the accepted keys from it.
 */
export function fullDocumentFor(key: PayloadSigner, options: FullDocumentOptions = {}): Record<string, unknown> {
  const layer = options.layer ?? 'organization';
  const base = plain(policyDocumentFor({ key })) as unknown as Record<string, any>;
  const document: Record<string, any> = {
    ...base,
    layer,
    minClient: '0.4.40',
    requires: ['agents@1', 'authorizations@1', 'endpoints@1', 'export-control@1', 'labels@1', 'layers@1', 'limits@1', 'models@1', 'onboarding@1', 'people@1', 'residency@1'],
    labels: { ...base['labels'], routing: { ...base['labels'].routing, compartments: { ...base['labels'].routing.compartments, PROJECT_X: 'attested-cloud' } } },
    agents: {
      ...base['agents'],
      mcp: { unattended: ['git'], labelCeilings: { git: { scale: 'org', level: 'Internal', compartments: [], releasability: [] } } },
      requireAccreditedDevice: true
    },
    endpoints: fixtureEndpoints(),
    authorizations: fixtureAuthorizations(key),
    models: fixtureModelsSection(),
    residency: { v: 1, required: ['CA', 'EU'], byLevel: { 'ca-protected/Protected B': ['CA'] } },
    onboarding: {
      v: 1,
      contacts: [
        { topic: 'export-control', name: 'Export control desk', how: 'exports@example.org' },
        { topic: 'security', name: 'Security desk', how: 'security@example.org' }
      ],
      locked: { canada: true },
      kindsOfWork: ['staff', 'software'],
      defaultScale: 'ca-protected',
      discovery: {
        networks: [{ id: 'head-office', dnsSuffix: 'corp.example.org', gateway: '10.20.0.1' }],
        announce: false,
        scanRanges: [{ cidr: '10.20.0.0/24', network: 'head-office' }],
        personalApprovals: true
      }
    },
    limits: { v: 1, spend: { dailyNanoUsd: 5_000_000_000, vaultHoursPerDay: 8, hubDailyNanoUsd: 50_000_000_000 } },
    people: { v: 1, clearances: base['people'].clearances, signers: [signerEntry(key)], organization: fixtureOrganizationBlock() },
    exportControl: exportControlExample(),
    reserved: { v: 1, anchorRoots: [{ root: 'a'.repeat(64), proof: ['b'.repeat(64)] }], statusLists: [{ uri: 'https://status.example.org/list', purpose: 'revocation' }], maxOfflineAge: { 'org/Restricted': 86400 } }
  };
  if (layer !== 'organization') document['parent'] = { hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
  return document;
}

/** The id of the one passport the fixtures' models section holds. */
export const FIXTURE_PASSPORT_ID = 'example-model-7b';

/**
 * One model passport with every key the passport parser accepts (fictional model, developer, references and hashes), valid at FIXED_NOW. Any field can be
 * replaced; the result is plain JSON.
 */
export function fixturePassport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIXTURE_PASSPORT_ID,
    match: ['example/model-7b*'],
    developer: 'Example Labs',
    origin: 'CA',
    lineage: { family: 'example', base: 'example/base-7b', teachers: [{ model: 'example/teacher-70b', origin: 'CA', method: 'distillation' }], method: 'pretrain+sft' },
    licence: { id: 'apache-2.0', obligations: ['attribution'], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] },
    hosting: ['local', 'org-plain'],
    artifact: { format: 'gguf', sha256: '1'.repeat(64), quantization: 'q4_k_m', remoteCode: false },
    evaluation: { report: 'EVAL-2026-0001', sha256: '2'.repeat(64), at: new Date(FIXED_NOW - DAY_MS).toISOString() },
    maxTier: 'T3',
    issuedAt: new Date(FIXED_NOW).toISOString(),
    expiresAt: new Date(FIXED_NOW + 300 * DAY_MS).toISOString(),
    reevaluateOn: ['artifact-change', 'quantization'],
    ...overrides
  };
}

/** A models section with every key the parser accepts and every default filled: one passport, a default, a local catalogue entry and an order. */
export function fixtureModelsSection(): Record<string, unknown> {
  return {
    v: 1,
    mode: 'report',
    unknownMaxTier: 'T0',
    tierByLevel: { 'ca-protected/Protected B': 'T2' },
    tierByProject: { staff: 'T2' },
    passports: [fixturePassport()],
    defaults: { standard: FIXTURE_PASSPORT_ID },
    localCatalogue: [{
      passport: FIXTURE_PASSPORT_ID,
      artifacts: [{
        format: 'gguf', quantization: 'q4_k_m', source: 'https://models.example.org/example-model-7b.gguf', sha256: '1'.repeat(64), sizeBytes: 4_000_000_000,
        licence: { id: 'apache-2.0', url: 'https://licences.example.org/apache-2.0' }
      }],
      minFitBand: 'laptop-16gb'
    }],
    order: [FIXTURE_PASSPORT_ID]
  };
}

/** Your organization's evaluation of a model's exact files (74.1 D-16), fictional: the report's id, its hash and its date. */
export const FIXTURE_EVALUATION = Object.freeze({ report: 'EVAL-EXAMPLE-2026-0042', sha256: '4'.repeat(64), at: '2026-11-01T00:00:00.000Z' });

/**
 * A models section in `mode` whose passports are the shipped rows with these ids, each carrying your organization's evaluation (74.1 D-16, C-4): under
 * enforce a model takes any role above research only after that evaluation, and no shipped row carries one. Your organization's passport replaces the
 * shipped row by id, so everything else is the shipped row's. `extra` adds other keys of the section (an order, defaults).
 */
export function evaluatedModels(mode: 'enforce' | 'report', ids: readonly string[], extra: Record<string, unknown> = {}): ModelsSection {
  const passports = ids.map((id) => {
    const shipped = SHIPPED_PASSPORTS.find((passport) => passport.id === id);
    if (shipped === undefined) throw new Error(`no shipped passport ${id}`);
    return { ...JSON.parse(JSON.stringify(shipped)) as Record<string, unknown>, evaluation: { ...FIXTURE_EVALUATION } };
  });
  const parsed = parseModelsSection({ v: 1, mode, unknownMaxTier: 'T0', passports, ...extra }, SCALE_PRESETS);
  if (!parsed.ok) throw new Error(`evaluatedModels: ${parsed.reason} ${parsed.path}`);
  return parsed.value;
}

/** A people.organization block with every setting written (D-40): corporate by default, military allowed, nothing turned on that a mode lacks. */
export function fixtureOrganizationBlock(): Record<string, unknown> {
  return {
    mode: 'corporate',
    allowedModes: ['corporate', 'military'],
    projectMayChoose: true,
    settings: { acting: false, dualHatting: false, enrolAtReport: true, guests: false, maxDelegationDepth: 1, mayDecline: false, overdueDays: 3, temporary: false }
  };
}

/** One endpoint of every class, sorted by id, each at the highest ceiling its class and host may hold (fictional hosts). */
export function fixtureEndpoints(): Array<Record<string, unknown>> {
  return [
    { id: 'closed-api', class: 'closed-api', host: 'api.example.com', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['org/Public'] },
    { id: 'enclave-example-org', class: 'org-tee', host: 'enclave.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Restricted'], attestation: 'org-tee-v1' },
    { id: 'forwarder', class: 'forwarded', host: 'router.example.com', scheme: 'https', tlsPins: [], region: 'unstated', maxLabel: ['org/Public'] },
    { id: 'lab-example-org', class: 'org-plain', host: '*.lab.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted'] },
    { id: 'laptop', class: 'local', host: 'localhost', scheme: 'http-loopback', tlsPins: [], region: 'CA', maxLabel: ['ca-classified/Top Secret', 'ca-protected/Protected C', 'nato/Cosmic Top Secret', 'org/Restricted'], provider: 'ollama' },
    { id: 'models-example-org', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: ['d'.repeat(64), 'e'.repeat(64)], region: 'CA', maxLabel: ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Restricted'] },
    { id: 'nearai-private', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['ca-protected/Protected B', 'org/Confidential'], provider: 'nearai' },
    { id: 'vendor-enclave', class: 'vendor-tee', host: 'enclave.example.net', scheme: 'https', tlsPins: [], region: 'EU', maxLabel: ['ca-protected/Protected B', 'org/Confidential'], attestation: 'vendor-tee-v1' },
    { id: 'vendor-region', class: 'vendor-region', host: 'ca.example.net', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected A', 'org/Internal'], provider: 'example' }
  ];
}

/** The fictional person every fixture authorization names. */
export const NAMED_PERSON: NamedPerson = Object.freeze({ name: 'Alex Example', role: 'Security officer' });

/** A people.signers entry for a key, under the fixtures' named person unless another is given. */
export function signerEntry(key: PayloadSigner, person: NamedPerson = NAMED_PERSON): Record<string, string> {
  return { name: person.name, role: person.role, publicKey: key.publicKey, fingerprint: key.fingerprint };
}

const DEFAULT_SUBJECT_VALUE: Readonly<Record<string, string>> = Object.freeze({
  endpoint: 'models-example-org', model: 'example/model-7b', device: 'dev-0123456789abcdef0123456789abcdef', item: 'docs/plan.md', person: 'person-0142'
});

/** The scope and conditions an export kind needs when a test gives none: one CGP decision, assessed to examine; or a CGP service your organization runs. */
const EXPORT_DEFAULTS: Readonly<Partial<Record<AuthorizationKind, { scope: AuthorizationScope; conditions: unknown }>>> = Object.freeze({
  'export-person': { scope: { regimes: ['CGP'] }, conditions: { CGP: { basis: 'assessed', extent: ['examine'] } } },
  'export-endpoint': {
    scope: { regimes: ['CGP'] },
    conditions: { regimes: ['CGP'], region: 'CA', operator: 'your-organization', access: 'Only people assessed or exempt under the CGR.', plaintext: 'processes' }
  }
});

/** The exportControl example of CGP-ITAR 6.4, with fictional references. */
export function exportControlExample(): Record<string, unknown> {
  return {
    v: 1,
    regimes: ['CGP', 'EAR', 'ITAR'],
    officials: [
      { regime: 'CGP', position: 'designated-official' },
      { regime: 'EAR', position: 'empowered-official' },
      { regime: 'ITAR', position: 'empowered-official' }
    ],
    registration: { CGP: { registered: true, reference: 'CGP-REG-0001', endsOn: null } },
    suggestRules: 'standard',
    agentNetwork: 'refuse',
    retention: { neverAutoPrune: true },
    incidents: { contacts: ['export-control'] }
  };
}

/** The export-person example of CGP-ITAR 7.1 (fictional ids): CGP assessed to examine, possess and transfer, and ITAR as a Canadian registered person. */
export function exportPersonExample(): AuthorizationBody {
  return authorizationFor({
    kind: 'export-person',
    id: 'xp-2026-0142',
    subject: { person: 'person-0142' },
    scope: { regimes: ['CGP', 'ITAR'], projects: ['project-alpha'], labels: ['ca-protected/Protected B'] },
    conditions: {
      CGP: { basis: 'assessed', extent: ['examine', 'possess', 'transfer'] },
      ITAR: { basis: 'canadian-registered-person', authority: '126.5', excludes: ['supplement-1-note-12'] }
    },
    evidence: 'SEC-FILE-2026-0142',
    days: 365
  });
}

export interface AuthorizationOptions {
  readonly kind: AuthorizationKind;
  readonly subject?: AuthorizationSubject;
  /** Length in days; the kind's maximum by default (30 for a kind with none). */
  readonly days?: number;
  readonly id?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly scope?: AuthorizationScope;
  readonly conditions?: unknown;
  readonly evidence?: string;
  readonly namedPerson?: NamedPerson;
  readonly revokedBy?: string;
}

/** An authorization body of one kind, issued at FIXED_NOW by the fixtures' named person, with every field overridable. */
export function authorizationFor(options: AuthorizationOptions): AuthorizationBody {
  const issuedAt = options.issuedAt ?? new Date(FIXED_NOW).toISOString();
  const days = options.days ?? MAX_DAYS_BY_KIND[options.kind] ?? 30;
  const subjectKind = SUBJECT_FOR_KIND[options.kind];
  const exportDefaults = EXPORT_DEFAULTS[options.kind];
  const body: Record<string, unknown> = {
    v: 1,
    id: options.id ?? `${options.kind}-1`,
    kind: options.kind,
    subject: options.subject ?? { [subjectKind]: DEFAULT_SUBJECT_VALUE[subjectKind] },
    scope: options.scope ?? exportDefaults?.scope ?? {},
    conditions: options.conditions ?? exportDefaults?.conditions ?? [],
    evidence: options.evidence ?? 'TRA-2026-11-0042',
    namedPerson: options.namedPerson ?? NAMED_PERSON,
    issuedAt,
    expiresAt: options.expiresAt ?? new Date(Date.parse(issuedAt) + days * DAY_MS).toISOString()
  };
  if (options.revokedBy !== undefined) body['revokedBy'] = options.revokedBy;
  return body as unknown as AuthorizationBody;
}

/** One authorization envelope (purpose policy-authorization), signed by `key` at the body's issuedAt. */
export function signAuthorization(body: AuthorizationBody | Record<string, unknown>, key: PayloadSigner): SignedPayload<AuthorizationBody> {
  return signPayload(key, 'policy-authorization', body as AuthorizationBody, { now: () => new Date(String((body as { issuedAt: string }).issuedAt)) });
}

/** One signed authorization of every kind, sorted by id, as plain JSON (one of them revoked, so revokedBy is present). */
export function fixtureAuthorizations(key: PayloadSigner): unknown[] {
  const bodies: AuthorizationBody[] = [
    authorizationFor({ kind: 'accredited-device', id: 'accredited-device-1' }),
    authorizationFor({ kind: 'declassify', id: 'declassify-1', conditions: ['Only the summary section.'], revokedBy: 'declassify-2' }),
    authorizationFor({
      kind: 'protected-b', id: 'protected-b-1', subject: { endpoint: 'models-example-org' },
      scope: { projects: ['project-alpha'], labels: ['ca-protected/Protected B'], uses: ['chat', 't1'] }, conditions: ['Pinned connection only.']
    }),
    authorizationFor({
      kind: 'export-endpoint', id: 'export-endpoint-1', subject: { endpoint: 'nearai-private' }, scope: { regimes: ['ITAR'] },
      conditions: {
        regimes: ['ITAR'], region: 'US', operator: 'Example Provider (DDTC M-00000)', access: 'Only US persons.', crypto: 'FIPS 140-3 certificate 0000; keys held by members.',
        plaintext: 'processes', legalBasis: 'Opinion EX-2026-07 on file.'
      }
    }),
    { ...exportPersonExample(), id: 'export-person-1' },
    authorizationFor({ kind: 'residency-exception', id: 'residency-exception-1', subject: { endpoint: 'vendor-enclave' } }),
    authorizationFor({ kind: 't1-risk', id: 't1-risk-1' })
  ];
  bodies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return bodies.map((body) => plain(signAuthorization(body, key)));
}

/** Your organization's layer signed by its issuer with the one signer (purpose org-policy-layer, up to 1 MiB), at the document's own issuedAt. */
export function signOrganizationLayer(doc: PolicyDocument | Record<string, unknown>, key: PayloadSigner): SignedPayload {
  return signPayload(key, 'org-policy-layer', doc, { now: () => new Date(String((doc as { issuedAt: string }).issuedAt)), maxBytes: MAX_ORGANIZATION_LAYER_BYTES });
}

export interface EnrolmentFileOptions {
  readonly issuer: PayloadSigner;
  /** The signed first organization layer; the starting rules as your organization's layer by default. */
  readonly layer?: SignedPayload;
  readonly serial?: number;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}

/**
 * The text of an enrolment file (D-11): an org-enrolment envelope signed by the issuer key itself, naming the fictional Example Organization and its
 * security desk, the issuer's key, the dates, a serial and the first organization layer.
 */
export function enrolmentFileFor(options: EnrolmentFileOptions): string {
  const issuedAt = options.issuedAt ?? new Date(FIXED_NOW).toISOString();
  const layer = options.layer ?? signOrganizationLayer(policyDocumentFor({ key: options.issuer, layer: 'organization' }), options.issuer);
  const payload = {
    v: 1,
    organization: { name: 'Example Organization', contacts: [{ topic: 'security', name: 'Security desk', how: 'security@example.org' }] },
    issuer: { publicKey: options.issuer.publicKey },
    issuedAt,
    expiresAt: options.expiresAt ?? new Date(Date.parse(issuedAt) + 365 * DAY_MS).toISOString(),
    serial: options.serial ?? 1,
    layer
  };
  return JSON.stringify(signPayload(options.issuer, 'org-enrolment', payload, { now: () => new Date(issuedAt) }));
}

/** The personal layer signed by this device with the one signer (purpose policy-bundle), at the document's own issuedAt (D-12's repeat check). */
export function signPersonalLayer(doc: PolicyDocument | Record<string, unknown>, key: PayloadSigner): SignedPayload {
  return signPayload(key, 'policy-bundle', doc, { now: () => new Date(String((doc as { issuedAt: string }).issuedAt)) });
}

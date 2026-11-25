// Policy bundle v2: one normalised policy document read from two wire forms (FND-01, FND-02, Phase 41 D-04 to D-10, D-15, D-49). Pure: no I/O, no clock
// (the caller passes `now`), no vscode, no package.
// `bundleVersion: 1` is today's bundle (read by the unchanged parseBundle, then mapped by documentFromBundle); `bundleVersion: 2` is the sectioned form with a
// layer, an optional parent and the features it needs in `requires`. Defaults are filled, so a parsed document is its own v2 wire form: its JSON copy parses
// to an equal document. bundleViewOf projects a document onto today's PolicyBundle names for the consumers that still read them; a view is never signed
// (D-49), because a v2 layer turned into today's view loses its sections.
// verifyPolicyLayer is the v2 reader of a signed layer: the personal layer under `policy-bundle` (256 KiB) and your organization's layer under
// `org-policy-layer` (1 MiB, D-09), each against the one key source its caller passes (D-15; this file never combines sources).
// Imported values are used only inside functions, never at module load.
import { BUNDLE_VERSION, CLOCK_SKEW_MS, UPDATE_REASONS, bundleHash, checkNumbers, checkRequires, effectiveNow, failedClosed, needsRenewal, needsUpdateSentence,
  parseBundle, parseIssuer, parseTimestamp, payloadReason, shapeReason, FINGERPRINT_PATTERN, HEX_64 } from './bundle';
import type { BundleIssuer, BundleState, PolicyBundle } from './bundle';
import { LEGAL_BASIS_EXEMPT_CLASSES, parseAuthorizations } from './authorizations';
import type { AuthorizationBody, ExportEndpointConditions } from './authorizations';
import { migrateLocalHosts, parseEndpoints } from './endpoints';
import type { PolicyEndpoint } from './endpoints';
import { ALWAYS_REQUIRED_FEATURES, POLICY_SECTIONS, featureForSection } from './features';
import type { FeatureId } from './features';
import { parseModelsSection } from './models';
import type { ModelsSection } from './models';
import { parsePeopleSection } from '../org/peopleSection';
import type { PeopleSection } from '../org/peopleSection';
import {
  parseAgentsSection, parseExportControlSection, parseLabelsSection, parseLimitsSection, parseOnboardingSection, parseReservedSection, parseResidencySection
} from './sections';
import type { AgentsSection, ExportControlSection, LabelsSection, LimitsSection, OnboardingSection, ReservedSection, ResidencySection } from './sections';
import { parseCredentialsSection } from './credentialsSection';
import type { CredentialsSection } from './credentialsSection';
import { parseAgreementsSection } from './agreementsSection';
import type { AgreementsSection } from './agreementsSection';
import { parseClassificationSection } from './classificationSection';
import type { ClassificationSection } from './classificationSection';
import { parseLabelInteropSection } from './labelInteropSection';
import type { LabelInteropTable } from './labelInteropSection';
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
import type { Fields, Parsed, Refusal } from './shape';
import { MAX_PAYLOAD_BYTES, verifyPayload } from '../team/signedPayload';
import type { PayloadSignerRef, SignedPayload } from '../team/signedPayload';
import type { KeyStatusLookup } from '../team/keyStatus';
import { GATE_VOCABULARY_VERSION } from './vocabulary';

/** The wire version of a sectioned policy. */
export const POLICY_DOCUMENT_VERSION = 2;

/** Who signs a layer: your organization's issuer, this device, or (from 32.1 and 33.1) the project's lead. A v1 bundle is a personal layer. */
export const POLICY_LAYERS = Object.freeze(['organization', 'personal', 'project'] as const);
export type PolicyLayerName = (typeof POLICY_LAYERS)[number];

/** An organization layer may be up to 1 MiB (passports and endpoints need room); the personal layer keeps the 256 KiB of MAX_PAYLOAD_BYTES (D-09). */
export const MAX_ORGANIZATION_LAYER_BYTES = 1024 * 1024;

/** `minClient`: a release number, three parts of at most four digits, used only to word the update sentence (D-05, D-07). */
export const MIN_CLIENT_PATTERN = /^(0|[1-9][0-9]{0,3})(\.(0|[1-9][0-9]{0,3})){2}$/;

/** The layer a personal or project layer narrows: the organization layer's hash and its issuer's fingerprint. Never on an organization layer. */
export interface PolicyParent {
  readonly hash: string;
  readonly issuer: string;
}

export interface PolicyDocument {
  readonly bundleVersion: 2;
  readonly vocabulary: 1;
  readonly issuer: BundleIssuer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly layer: PolicyLayerName;
  readonly parent?: PolicyParent;
  /** Sorted and unique; always holds layers@1, labels@1, agents@1 and the feature of every section present. */
  readonly requires: readonly FeatureId[];
  readonly minClient?: string;
  readonly labels: LabelsSection;
  readonly agents: AgentsSection;
  /** Where AI may run (D-24). Absent means no place beyond this computer is named, today's behaviour with no local hosts. */
  readonly endpoints?: readonly PolicyEndpoint[];
  /** Exceptions, each signed by a named person (D-29); parsed for shape here and verified against one key source by verifyAuthorization (D-15). */
  readonly authorizations?: readonly SignedPayload<AuthorizationBody>[];
  readonly models?: ModelsSection;
  readonly residency?: ResidencySection;
  readonly people?: PeopleSection;
  readonly onboarding?: OnboardingSection;
  readonly limits?: LimitsSection;
  readonly reserved?: ReservedSection;
  /** Export-controlled technical data (D-60), report mode: parsed and signed, read by nothing that decides in this phase. */
  readonly exportControl?: ExportControlSection;
  /** Trusted issuers, status lists, freshness and sensitivity requirements (Phase 71, D-12). With it, the reserved statusLists and maxOfflineAge are empty. */
  readonly credentials?: CredentialsSection;
  /** Agreements with other organizations (Phase 71, D-12). */
  readonly agreements?: AgreementsSection;
  /** How a label may be proposed and raised (Phase 70.1, D-16): thresholds, the system-high, markings and the classifier roles. */
  readonly classification?: ClassificationSection;
  /** How your organization's labels are written for allies (Phase 45.1, D-02). Absent means no label can be sent to a partner. */
  readonly labelInterop?: LabelInteropTable;
}

const ENVELOPE_REQUIRED = ['bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'layer', 'requires', 'labels', 'agents'] as const;
const ENVELOPE_OPTIONAL = [
  'parent', 'minClient', 'endpoints', 'authorizations', 'models', 'residency', 'people', 'onboarding', 'limits', 'reserved', 'exportControl', 'credentials', 'agreements',
  'classification',
  'labelInterop'
] as const;

function has(value: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseLayer(value: unknown, path: string): Parsed<PolicyLayerName> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = POLICY_LAYERS.find((layer) => layer === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function parseParent(value: unknown, path: string): Parsed<PolicyParent> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['hash', 'issuer']);
  if (keys !== undefined) return keys;
  const hash = ownValue(value, 'hash');
  if (typeof hash !== 'string' || !HEX_64.test(hash)) return refused('wrong-type', childPath(path, 'hash'));
  const issuer = ownValue(value, 'issuer');
  if (typeof issuer !== 'string' || !FINGERPRINT_PATTERN.test(issuer)) return refused('wrong-type', childPath(path, 'issuer'));
  return { ok: true, value: Object.freeze({ hash, issuer }) };
}

/** `requires` after checkRequires accepted every id: also sorted and unique, so one meaning has one hash. */
function parseRequiresList(value: unknown, path: string): Parsed<readonly FeatureId[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  for (let index = 1; index < value.length; index += 1) {
    const before = value[index - 1] as string;
    const here = value[index] as string;
    if (here === before) return refused('duplicate', `${path}[${String(index)}]`);
    if (here < before) return refused('not-sorted', `${path}[${String(index)}]`);
  }
  return { ok: true, value: Object.freeze([...(value as FeatureId[])]) };
}

/** The `minClient` of a payload, read without trusting anything else in it; undefined when absent or not a release number. Never throws. */
export function minClientOf(payload: unknown): string | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const value = ownValue(payload, 'minClient');
    return typeof value === 'string' && MIN_CLIENT_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads either wire form into one document. Order (D-04, S6): every number, the bundle version (1 goes to parseBundle and documentFromBundle), the
 * vocabulary, the features in `requires` before any unknown key (so a newer policy says "update"), the envelope keys, labels first (their scales feed every
 * other section), the other sections, and last the check that `requires` names every section used (missing: `malformed`).
 */
export function parsePolicyDocument(value: unknown, path = ''): Parsed<PolicyDocument> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const numbers = checkNumbers(value, path, 0);
  if (numbers !== undefined) return numbers;
  const version = ownValue(value, 'bundleVersion');
  if (version === BUNDLE_VERSION) {
    const bundle = parseBundle(value, path);
    return bundle.ok ? { ok: true, value: documentFromBundle(bundle.value) } : bundle;
  }
  if (typeof version === 'number' && version !== POLICY_DOCUMENT_VERSION) return refused('unknown-version', childPath(path, 'bundleVersion'));
  const vocabulary = ownValue(value, 'vocabulary');
  if (typeof vocabulary === 'number' && vocabulary !== GATE_VOCABULARY_VERSION) return refused('unknown-version', childPath(path, 'vocabulary'));
  const requiresCheck = checkRequires(value, path);
  if (requiresCheck !== undefined) return requiresCheck;
  const keys = checkKeys(value, path, ENVELOPE_REQUIRED, ENVELOPE_OPTIONAL);
  if (keys !== undefined) return keys;
  if (version !== POLICY_DOCUMENT_VERSION) return refused('wrong-type', childPath(path, 'bundleVersion'));
  if (vocabulary !== GATE_VOCABULARY_VERSION) return refused('wrong-type', childPath(path, 'vocabulary'));
  const issuer = parseIssuer(ownValue(value, 'issuer'), childPath(path, 'issuer'));
  if (!issuer.ok) return issuer;
  const issuedAt = parseTimestamp(ownValue(value, 'issuedAt'), childPath(path, 'issuedAt'));
  if (!issuedAt.ok) return issuedAt;
  const expiresAt = parseTimestamp(ownValue(value, 'expiresAt'), childPath(path, 'expiresAt'));
  if (!expiresAt.ok) return expiresAt;
  if (parseIsoMillis(expiresAt.value) <= parseIsoMillis(issuedAt.value)) return refused('wrong-type', childPath(path, 'expiresAt'));
  const layer = parseLayer(ownValue(value, 'layer'), childPath(path, 'layer'));
  if (!layer.ok) return layer;
  const out: Record<string, unknown> = {
    bundleVersion: POLICY_DOCUMENT_VERSION, vocabulary: GATE_VOCABULARY_VERSION, issuer: issuer.value, issuedAt: issuedAt.value, expiresAt: expiresAt.value, layer: layer.value
  };
  if (has(value, 'parent')) {
    // Your organization's layer is the top: it narrows nothing, so it names no parent.
    if (layer.value === 'organization') return refused('not-allowed-here', childPath(path, 'parent'));
    const parent = parseParent(ownValue(value, 'parent'), childPath(path, 'parent'));
    if (!parent.ok) return parent;
    out['parent'] = parent.value;
  }
  const requires = parseRequiresList(ownValue(value, 'requires'), childPath(path, 'requires'));
  if (!requires.ok) return requires;
  out['requires'] = requires.value;
  if (has(value, 'minClient')) {
    const minClient = ownValue(value, 'minClient');
    if (typeof minClient !== 'string' || !MIN_CLIENT_PATTERN.test(minClient)) return refused('wrong-type', childPath(path, 'minClient'));
    out['minClient'] = minClient;
  }
  const sections = parseSections(value, path, out);
  if (sections !== undefined) return sections;
  // Last: every section used is named in `requires`, or the policy is malformed (D-06).
  for (const feature of requiredFeaturesOf(out)) {
    if (!requires.value.includes(feature)) return refused('missing-field', childPath(path, 'requires'));
  }
  return { ok: true, value: Object.freeze(out) as unknown as PolicyDocument };
}

/** Reads the sections into `out`, labels first. Returns the first refusal, or undefined when every section is right. */
function parseSections(value: Fields, path: string, out: Record<string, unknown>): Refusal | undefined {
  const labels = parseLabelsSection(ownValue(value, 'labels'), childPath(path, 'labels'));
  if (!labels.ok) return labels;
  out['labels'] = labels.value;
  const scales = labels.value.scales;
  const agents = parseAgentsSection(ownValue(value, 'agents'), scales, childPath(path, 'agents'));
  if (!agents.ok) return agents;
  out['agents'] = agents.value;
  if (has(value, 'endpoints')) {
    const endpoints = parseEndpoints(ownValue(value, 'endpoints'), scales, childPath(path, 'endpoints'));
    if (!endpoints.ok) return endpoints;
    out['endpoints'] = endpoints.value;
  }
  if (has(value, 'authorizations')) {
    const authorizations = parseAuthorizations(ownValue(value, 'authorizations'), childPath(path, 'authorizations'));
    if (!authorizations.ok) return authorizations;
    out['authorizations'] = authorizations.value;
  }
  if (has(value, 'models')) {
    const models = parseModelsSection(ownValue(value, 'models'), scales, childPath(path, 'models'));
    if (!models.ok) return models;
    out['models'] = models.value;
  }
  if (has(value, 'residency')) {
    const residency = parseResidencySection(ownValue(value, 'residency'), scales, childPath(path, 'residency'));
    if (!residency.ok) return residency;
    out['residency'] = residency.value;
  }
  if (has(value, 'people')) {
    const people = parsePeopleSection(ownValue(value, 'people'), scales, childPath(path, 'people'));
    if (!people.ok) return people;
    out['people'] = people.value;
  }
  if (has(value, 'credentials')) {
    const credentials = parseCredentialsSection(ownValue(value, 'credentials'), scales, childPath(path, 'credentials'));
    if (!credentials.ok) return credentials;
    out['credentials'] = credentials.value;
  }
  if (has(value, 'agreements')) {
    const agreements = parseAgreementsSection(ownValue(value, 'agreements'), scales, childPath(path, 'agreements'));
    if (!agreements.ok) return agreements;
    out['agreements'] = agreements.value;
  }
  if (has(value, 'labelInterop')) {
    const labelInterop = parseLabelInteropSection(ownValue(value, 'labelInterop'), scales, childPath(path, 'labelInterop'));
    if (!labelInterop.ok) return labelInterop;
    out['labelInterop'] = labelInterop.value;
  }
  if (has(value, 'onboarding')) {
    const onboarding = parseOnboardingSection(ownValue(value, 'onboarding'), scales, childPath(path, 'onboarding'));
    if (!onboarding.ok) return onboarding;
    out['onboarding'] = onboarding.value;
  }
  if (has(value, 'limits')) {
    const limits = parseLimitsSection(ownValue(value, 'limits'), childPath(path, 'limits'));
    if (!limits.ok) return limits;
    out['limits'] = limits.value;
  }
  if (has(value, 'reserved')) {
    const reserved = parseReservedSection(ownValue(value, 'reserved'), scales, childPath(path, 'reserved'));
    if (!reserved.ok) return reserved;
    out['reserved'] = reserved.value;
  }
  if (has(value, 'exportControl')) {
    const exportControl = parseExportControlSection(ownValue(value, 'exportControl'), scales, childPath(path, 'exportControl'));
    if (!exportControl.ok) return exportControl;
    out['exportControl'] = exportControl.value;
  }
  if (has(value, 'classification')) {
    const classification = parseClassificationSection(ownValue(value, 'classification'), scales, childPath(path, 'classification'));
    if (!classification.ok) return classification;
    out['classification'] = classification.value;
  }
  return checkReservedSlots(out, path) ?? checkLegalBasis(out, path);
}

/**
 * D-12: with a credentials section, the reserved v1 slots for status lists and offline ages must be empty, so each is set in one place (Phase 70's
 * OFFL-03 slot is filled by credentials@1).
 */
function checkReservedSlots(out: Readonly<Record<string, unknown>>, path: string): Refusal | undefined {
  const reserved = out['reserved'] as ReservedSection | undefined;
  if (out['credentials'] === undefined || reserved === undefined) return undefined;
  if (reserved.statusLists.length > 0) return refused('not-allowed-here', childPath(childPath(path, 'reserved'), 'statusLists'));
  if (Object.keys(reserved.maxOfflineAge).length > 0) return refused('not-allowed-here', childPath(childPath(path, 'reserved'), 'maxOfflineAge'));
  return undefined;
}

/**
 * D-61: an export-endpoint record for a place this document lists, of a class your organization does not run (anything but local, org-plain and org-tee),
 * must cite its legal basis. A record for a place another layer lists is checked where both are known (composition, 41-02).
 */
function checkLegalBasis(out: Readonly<Record<string, unknown>>, path: string): Refusal | undefined {
  const endpoints = (out['endpoints'] ?? []) as readonly PolicyEndpoint[];
  const authorizations = (out['authorizations'] ?? []) as readonly SignedPayload<AuthorizationBody>[];
  for (let index = 0; index < authorizations.length; index += 1) {
    const body = (authorizations[index] as SignedPayload<AuthorizationBody>).payload;
    if (body.kind !== 'export-endpoint' || !('endpoint' in body.subject)) continue;
    const id = body.subject.endpoint;
    const endpoint = endpoints.find((entry) => entry.id === id);
    if (endpoint === undefined || LEGAL_BASIS_EXEMPT_CLASSES.includes(endpoint.class)) continue;
    if ((body.conditions as ExportEndpointConditions).legalBasis === undefined) {
      return refused('missing-field', `${childPath(path, 'authorizations')}[${String(index)}].payload.conditions.legalBasis`);
    }
  }
  return undefined;
}

/** The features a document with these sections must name: layers@1, labels@1, agents@1 and the feature of every section present, sorted. */
function requiredFeaturesOf(document: Readonly<Record<string, unknown>>): FeatureId[] {
  const out = new Set<FeatureId>(ALWAYS_REQUIRED_FEATURES);
  for (const section of POLICY_SECTIONS) {
    const feature = featureForSection(section);
    if (feature !== undefined && Object.prototype.hasOwnProperty.call(document, section) && document[section] !== undefined) out.add(feature);
  }
  return [...out].sort();
}

/**
 * A v1 bundle as a v2 document (D-04, POLICY-SCHEMA 3): a personal layer; `ceiling` to `agents` (requireAccreditedDevice false); scales, mappings,
 * defaultLabel and routing without localHosts to `labels`; `localHosts` to `endpoints` through migrateLocalHosts (D-27, omitted when it makes none);
 * `clearances` to `people.clearances`; the reserved fields to `reserved`; `requires` the sorted
 * union of the bundle's own and the features of the sections it now has. The stored bytes and their hash never change: this is a reading, not a rewrite.
 */
export function documentFromBundle(bundle: PolicyBundle): PolicyDocument {
  const ceiling = bundle.ceiling;
  const mcp = ceiling.mcpLabelCeilings === undefined
    ? Object.freeze({ unattended: ceiling.unattendedMcp })
    : Object.freeze({ unattended: ceiling.unattendedMcp, labelCeilings: ceiling.mcpLabelCeilings });
  const document: Record<string, unknown> = {
    bundleVersion: POLICY_DOCUMENT_VERSION,
    vocabulary: GATE_VOCABULARY_VERSION,
    issuer: bundle.issuer,
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
    layer: 'personal',
    labels: Object.freeze({
      v: 1,
      scales: bundle.scales,
      mappings: bundle.mappings,
      defaultLabel: bundle.defaultLabel,
      routing: Object.freeze({ levels: bundle.routing.levels, handling: bundle.routing.handling, compartments: bundle.routing.compartments })
    }),
    agents: Object.freeze({ v: 1, maxMode: ceiling.maxMode, contexts: ceiling.contexts, mcp, requireAccreditedDevice: false }),
    ...endpointsOf(bundle),
    people: Object.freeze({ v: 1, clearances: bundle.clearances }),
    reserved: Object.freeze({ v: 1, anchorRoots: bundle.anchorRoots, statusLists: bundle.statusLists, maxOfflineAge: bundle.maxOfflineAge })
  };
  const requires = new Set<string>([...(bundle.requires ?? []), ...requiredFeaturesOf(document)]);
  document['requires'] = Object.freeze([...requires].sort());
  return Object.freeze(document) as unknown as PolicyDocument;
}

function endpointsOf(bundle: PolicyBundle): { endpoints?: readonly PolicyEndpoint[] } {
  const migrated = migrateLocalHosts(bundle.routing, bundle.scales);
  return migrated.endpoints.length === 0 ? {} : { endpoints: migrated.endpoints };
}

/** The hosts of your organization's plain servers, sorted: what a v1 view calls `localHosts`. */
function localHostsOf(doc: PolicyDocument): readonly string[] {
  return Object.freeze((doc.endpoints ?? []).filter((endpoint) => endpoint.class === 'org-plain').map((endpoint) => endpoint.host).sort());
}

/**
 * A document projected onto today's PolicyBundle names (bundleVersion 1), for the consumers that read them until 41-09 and 41-14 switch: `clearances` from
 * people (none when absent), `localHosts` the org-plain hosts sorted, the reserved fields (empty when absent), and no `requires`. A view is read, never signed (D-49).
 */
export function bundleViewOf(doc: PolicyDocument): PolicyBundle {
  const agents = doc.agents;
  const ceiling = agents.mcp.labelCeilings === undefined
    ? Object.freeze({ maxMode: agents.maxMode, contexts: agents.contexts, unattendedMcp: agents.mcp.unattended })
    : Object.freeze({ maxMode: agents.maxMode, contexts: agents.contexts, unattendedMcp: agents.mcp.unattended, mcpLabelCeilings: agents.mcp.labelCeilings });
  const routing = doc.labels.routing;
  return Object.freeze({
    bundleVersion: BUNDLE_VERSION,
    vocabulary: GATE_VOCABULARY_VERSION,
    issuer: doc.issuer,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    ceiling,
    scales: doc.labels.scales,
    mappings: doc.labels.mappings,
    clearances: doc.people?.clearances ?? Object.freeze([]),
    routing: Object.freeze({ levels: routing.levels, handling: routing.handling, compartments: routing.compartments, localHosts: localHostsOf(doc) }),
    defaultLabel: doc.labels.defaultLabel,
    anchorRoots: doc.reserved?.anchorRoots ?? Object.freeze([]),
    statusLists: doc.reserved?.statusLists ?? Object.freeze([]),
    maxOfflineAge: doc.reserved?.maxOfflineAge ?? Object.freeze({})
  }) as PolicyBundle;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Verifying a signed layer (D-09, D-12, D-15, D-49)

export type PolicyLayerPurpose = 'policy-bundle' | 'org-policy-layer';

export interface VerifyPolicyLayerOptions {
  /** `policy-bundle` for the personal layer (and every v1 bundle), `org-policy-layer` for your organization's layer. */
  readonly purpose: PolicyLayerPurpose;
  /** The one key source for this layer (D-15): this device's own key history for the personal layer, the pinned issuer for your organization's. */
  readonly status: KeyStatusLookup;
  /** Epoch milliseconds from the wall clock. */
  readonly now: number;
  /** Epoch milliseconds of the last time this layer was seen valid, so turning the clock back never revives an expired layer. */
  readonly lastValidAt?: number;
}

export type PolicyLayerState =
  | {
    readonly state: 'valid';
    readonly document: PolicyDocument;
    /** The wire form that was signed: 1 for a stored v1 bundle (read as v2), 2 for a sectioned layer. */
    readonly wireVersion: 1 | 2;
    /** bundleHash of the signed payload, so a stored v1 bundle keeps the hash it always had. */
    readonly hash: string;
    readonly signer: PayloadSignerRef;
    readonly expiresAt: string;
    readonly renewDue: boolean;
  }
  | Extract<BundleState, { state: 'failed-closed' }>;

/** The layer each purpose may carry: a policy-bundle envelope holds a personal layer, an org-policy-layer envelope your organization's. */
const LAYER_FOR_PURPOSE: Readonly<Record<PolicyLayerPurpose, PolicyLayerName>> = Object.freeze({ 'policy-bundle': 'personal', 'org-policy-layer': 'organization' });

/**
 * Turns a stored layer envelope into a valid layer or one failed-closed state with one plain sentence. Never throws. The size cap follows the purpose
 * (1 MiB for your organization's layer, 256 KiB otherwise); a policy written for a newer version is worded by its `minClient`; the purpose and the layer
 * must agree (else `malformed`); then the repeat check (issuer is the signer, issuedAt is signedAt), clock-behind and expiry as verifyBundleEnvelope does.
 */
export function verifyPolicyLayer(envelope: unknown, options: VerifyPolicyLayerOptions): PolicyLayerState {
  if (envelope === undefined) return failedClosed('missing');
  const effective = effectiveNow(options.now, options.lastValidAt);
  if (Number.isNaN(effective)) return failedClosed('clock-behind', 'The clock gave no valid time.');
  const maxBytes = options.purpose === 'org-policy-layer' ? MAX_ORGANIZATION_LAYER_BYTES : MAX_PAYLOAD_BYTES;
  const verdict = verifyPayload<unknown>(envelope, { purpose: options.purpose, status: options.status, maxBytes });
  if (!verdict.ok) return failedClosed(payloadReason(verdict.reason));
  const parsed = parsePolicyDocument(verdict.payload);
  if (!parsed.ok) {
    const reason = shapeReason(parsed);
    const failed = failedClosed(reason, parsed.message);
    const minClient = minClientOf(verdict.payload);
    return UPDATE_REASONS.has(reason) && minClient !== undefined ? { ...failed, sentence: needsUpdateSentence(minClient) } : failed;
  }
  const document = parsed.value;
  if (document.layer !== LAYER_FOR_PURPOSE[options.purpose]) return failedClosed('malformed', 'The layer does not match the purpose it was signed for.');
  if (document.issuer.fingerprint !== verdict.signer.fingerprint || document.issuer.publicKey !== verdict.signer.publicKey || document.issuedAt !== verdict.signedAt) {
    return failedClosed('signer-mismatch');
  }
  if (parseIsoMillis(document.issuedAt) > effective + CLOCK_SKEW_MS) return failedClosed('clock-behind');
  if (effective >= parseIsoMillis(document.expiresAt)) return failedClosed('expired');
  const wire = isRecord(verdict.payload) ? ownValue(verdict.payload, 'bundleVersion') : undefined;
  return {
    state: 'valid',
    document,
    wireVersion: wire === BUNDLE_VERSION ? 1 : 2,
    hash: bundleHash(verdict.payload),
    signer: verdict.signer,
    expiresAt: document.expiresAt,
    renewDue: needsRenewal(document, options.now, options.lastValidAt)
  };
}

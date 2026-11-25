// The site export (48-02, D-13, D-16): readers that turn the read-only outputs compliance/site-export/collect.sh gathered on a site into the
// allow-listed facts of collectors/deployment.ts, and the envelope that carries them, signed in the extension's signed-payload format
// (signed.ts) for SITE_EXPORT_PURPOSE. Each reader keeps only what its fact needs: names, realm contents, secrets and log text stay behind.
// The formats are the upstream outputs of the products Phase 47 chose (47 D-53); 48-09 runs them on the rig and fixes any difference.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { matchRules } from '../../scripts/lib/workflow.mjs';
import { PAYLOAD_VERSION, canonicalize, fingerprintOf, isStrictBase64url, signingInput, verifyEnvelope } from './signed.ts';
import {
  REGISTRY_KINDS, SITE_EXPORT_PURPOSE, SITE_EXPORT_SCHEMA, VERSION_PATTERN, parseExportPayload,
  type SiteExportPayload, type SiteFacts
} from './collectors/deployment.ts';
import { SiteExportError, readKyvernoPolicies, readPolicyReports, type ImagePolicies } from './kyvernoImages.ts';

// The Kyverno image policy readers live in kyvernoImages.ts (no loader), shared with the live site collector (48.2-09); re-exported here.
export { SiteExportError, readKyvernoPolicies, readPolicyReports, type ImagePolicies };

const MIB = 1024 * 1024;
/** Every file the command reads from the collected folder, with the most bytes it reads of each. */
export const SOURCE_FILES = Object.freeze({
  'keycloak-realm.json': 4 * MIB,
  'keycloak-serverinfo.json': 8 * MIB,
  'keycloak-clients.json': 4 * MIB,
  'counts.json': 64 * 1024,
  'openbao-status.json': 64 * 1024,
  'openbao-audit.json': 1 * MIB,
  'kubernetes-audit-policy.yaml': 1 * MIB,
  'nodes-fips.json': 1 * MIB,
  'kyverno-clusterpolicies.json': 16 * MIB,
  'kyverno-policyreports.json': 32 * MIB,
  'images.json': 16 * MIB,
  'workbench-fips.json': 1 * MIB
} as const);
export type SourceFile = keyof typeof SOURCE_FILES;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown, source: string, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new SiteExportError(source, `${what} is not a list`);
  return value;
};

/** Reads one collected file: a regular file (not a link) inside the folder, no larger than its cap. */
export function readSource(dir: string, name: SourceFile): Buffer {
  const file = path.join(dir, name);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new SiteExportError(name, 'is missing from the collected folder');
  }
  if (!stat.isFile()) throw new SiteExportError(name, 'is not a regular file');
  const cap = SOURCE_FILES[name];
  if (stat.size > cap) throw new SiteExportError(name, `is larger than ${cap} bytes`);
  const bytes = readFileSync(file);
  if (bytes.length > cap) throw new SiteExportError(name, `is larger than ${cap} bytes`);
  return bytes;
}

function parseSourceJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new SiteExportError(name, 'is not JSON');
  }
}

const binaryFlag = (value: unknown, source: string, what: string): boolean => {
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  throw new SiteExportError(source, `${what} is not 1 or 0`);
};

// ---- Keycloak realm (admin REST: GET /admin/realms/{realm} and GET /admin/realms/{realm}/authentication/flows/{alias}/executions) ----------

/** The realm fields that bind a flow (RealmRepresentation). */
export const BOUND_FLOW_FIELDS = Object.freeze(['browserFlow', 'registrationFlow', 'directGrantFlow', 'resetCredentialsFlow', 'clientAuthenticationFlow', 'dockerAuthenticationFlow', 'firstBrokerLoginFlow'] as const);
/** Authenticator provider ids that take a password, or set one. */
export const PASSWORD_AUTHENTICATORS: readonly string[] = Object.freeze(['auth-username-password-form', 'auth-password-form', 'direct-grant-validate-password', 'idp-username-password-form', 'basic-auth', 'reset-password']);
/** Authenticator provider ids that take a one-time code, or set one up. */
export const OTP_AUTHENTICATORS: readonly string[] = Object.freeze(['auth-otp-form', 'auth-conditional-otp-form', 'direct-grant-validate-otp', 'basic-auth-otp', 'reset-otp']);

export interface KeycloakRealmFacts {
  readonly passwordAuthenticators: number;
  readonly otpAuthenticators: number;
  readonly userEventsEnabled: boolean;
  readonly adminEventsEnabled: boolean;
}

/**
 * Counts the executions with a password or OTP authenticator whose requirement is not DISABLED, across every flow the realm binds. The
 * collected file is `{ realm: <realm representation>, flowExecutions: { <flow alias>: <executions list> } }`; a bound flow with no executions
 * list is an error, so a flow left out of the collection cannot hide an authenticator. Flows the realm does not bind are not counted.
 */
export function readKeycloakRealm(doc: unknown, source = 'keycloak-realm.json'): KeycloakRealmFacts {
  if (!isRecord(doc) || !isRecord(doc.realm) || !isRecord(doc.flowExecutions)) throw new SiteExportError(source, 'expected { realm, flowExecutions }');
  const realm = doc.realm;
  const executions = doc.flowExecutions;
  if (typeof realm.eventsEnabled !== 'boolean' || typeof realm.adminEventsEnabled !== 'boolean') throw new SiteExportError(source, 'eventsEnabled and adminEventsEnabled must be true or false');
  let password = 0;
  let otp = 0;
  const seen = new Set<string>();
  for (const field of BOUND_FLOW_FIELDS) {
    const alias = realm[field];
    if (alias === undefined || alias === null) continue;
    if (typeof alias !== 'string' || alias === '') throw new SiteExportError(source, `${field} is not a flow alias`);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const list = Object.hasOwn(executions, alias) ? executions[alias] : undefined;
    if (!Array.isArray(list)) throw new SiteExportError(source, `the flow bound as ${field} has no executions list`);
    for (const execution of list) {
      if (!isRecord(execution) || typeof execution.requirement !== 'string') throw new SiteExportError(source, `an execution of the flow bound as ${field} has no requirement`);
      if (execution.requirement === 'DISABLED' || typeof execution.providerId !== 'string') continue;
      if (PASSWORD_AUTHENTICATORS.includes(execution.providerId)) password += 1;
      if (OTP_AUTHENTICATORS.includes(execution.providerId)) otp += 1;
    }
  }
  if (seen.size === 0) throw new SiteExportError(source, 'the realm binds no flow');
  return { passwordAuthenticators: password, otpAuthenticators: otp, userEventsEnabled: realm.eventsEnabled, adminEventsEnabled: realm.adminEventsEnabled };
}

// ---- Keycloak server info (admin REST: GET /admin/serverinfo) -------------------------------------------------------------------------

/** `cryptoInfo.cryptoProvider` is the simple class name of the crypto provider the server runs (Keycloak FipsMode, ServerInfoAdminResource). */
export const KEYCLOAK_CRYPTO_PROVIDERS = Object.freeze({
  Fips1402StrictCryptoProvider: 'strict',
  FIPS1402Provider: 'non-strict',
  DefaultCryptoProvider: 'disabled'
} as const);
const UPSTREAM_VERSION = /^\d+\.\d+\.\d+$/;
const RED_HAT_VERSION = /^\d+\.\d+\.\d+\.redhat-\d+$/;

/** The version, which build it is (an upstream release, the Red Hat build, or something else) and the FIPS mode. */
export function readKeycloakServerInfo(doc: unknown, source = 'keycloak-serverinfo.json'): Pick<SiteFacts['keycloak'], 'distribution' | 'version' | 'fipsMode'> {
  if (!isRecord(doc) || !isRecord(doc.systemInfo) || !isRecord(doc.cryptoInfo)) throw new SiteExportError(source, 'expected { systemInfo, cryptoInfo }');
  const version = doc.systemInfo.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new SiteExportError(source, 'systemInfo.version is not a version');
  const provider = doc.cryptoInfo.cryptoProvider;
  if (typeof provider !== 'string' || !Object.hasOwn(KEYCLOAK_CRYPTO_PROVIDERS, provider)) throw new SiteExportError(source, 'cryptoInfo.cryptoProvider is not a provider this tool knows');
  const distribution = UPSTREAM_VERSION.test(version) ? 'upstream' : RED_HAT_VERSION.test(version) ? 'redhat' : 'other';
  return { distribution, version, fipsMode: KEYCLOAK_CRYPTO_PROVIDERS[provider as keyof typeof KEYCLOAK_CRYPTO_PROVIDERS] };
}

// ---- Keycloak clients (admin REST: GET /admin/realms/{realm}/clients) -----------------------------------------------------------------

/** Clients the load-test harness makes carry this prefix; none may exist in a production realm. */
export const LOAD_TEST_CLIENT_PREFIX = 'loadtest-';

export function readKeycloakClients(doc: unknown, source = 'keycloak-clients.json'): Pick<SiteFacts['keycloak'], 'loadTestClients'> {
  let loadTestClients = 0;
  for (const client of listOf(doc, source, 'the client list')) {
    if (!isRecord(client) || typeof client.clientId !== 'string') throw new SiteExportError(source, 'a client has no clientId');
    if (client.clientId.startsWith(LOAD_TEST_CLIENT_PREFIX)) loadTestClients += 1;
  }
  return { loadTestClients };
}

// ---- Last-day counts from the log store (OpenSearch GET /<index>/_count, one response per stream) ---------------------------------------

export const COUNT_STREAMS = Object.freeze(['keycloak', 'openbao', 'kubernetes', 'registry'] as const);
/** The counts cover the last day. */
export const COUNT_WINDOW_HOURS = 24;

export interface StreamCounts {
  readonly keycloak: number;
  readonly openbao: number;
  readonly kubernetes: number;
  readonly registry: number;
  readonly registryKind: SiteFacts['registry']['kind'];
}

/** `{ windowHours: 24, registryKind, streams: { <stream>: <_count response> } }`. A response with a failed shard is an error, not a smaller count. */
export function readCounts(doc: unknown, source = 'counts.json'): StreamCounts {
  if (!isRecord(doc) || !isRecord(doc.streams)) throw new SiteExportError(source, 'expected { windowHours, registryKind, streams }');
  if (doc.windowHours !== COUNT_WINDOW_HOURS) throw new SiteExportError(source, `windowHours must be ${COUNT_WINDOW_HOURS}`);
  if (typeof doc.registryKind !== 'string' || !(REGISTRY_KINDS as readonly string[]).includes(doc.registryKind)) throw new SiteExportError(source, `registryKind must be one of ${REGISTRY_KINDS.join(', ')}`);
  const counts: Record<string, number> = {};
  for (const stream of COUNT_STREAMS) {
    const response = Object.hasOwn(doc.streams, stream) ? doc.streams[stream] : undefined;
    if (!isRecord(response) || !Number.isSafeInteger(response.count) || (response.count as number) < 0) throw new SiteExportError(source, `the ${stream} stream has no count`);
    if (response.timed_out === true || (isRecord(response._shards) && response._shards.failed !== 0)) throw new SiteExportError(source, `the ${stream} count is partial`);
    counts[stream] = response.count as number;
  }
  return { keycloak: counts.keycloak, openbao: counts.openbao, kubernetes: counts.kubernetes, registry: counts.registry, registryKind: doc.registryKind as StreamCounts['registryKind'] };
}

// ---- OpenBao (`bao status -format=json`, the sys/seal-status fields; `bao read -format=json sys/audit`) --------------------------------

export function readOpenBaoStatus(doc: unknown, source = 'openbao-status.json'): Pick<SiteFacts['openbao'], 'version' | 'sealType'> {
  if (!isRecord(doc) || typeof doc.type !== 'string') throw new SiteExportError(source, 'has no seal type');
  if (typeof doc.version !== 'string' || !VERSION_PATTERN.test(doc.version)) throw new SiteExportError(source, 'version is not a version');
  const sealType = doc.type === 'pkcs11' || doc.type === 'shamir' || doc.type === 'transit' ? doc.type : 'other';
  return { version: doc.version, sealType };
}

/** Counts the enabled audit devices: the `data` map of `bao read sys/audit`, or the bare map the API returns. */
export function readOpenBaoAudit(doc: unknown, source = 'openbao-audit.json'): Pick<SiteFacts['openbao'], 'auditDevices'> {
  if (!isRecord(doc)) throw new SiteExportError(source, 'is not an object');
  const devices = isRecord(doc.data) ? doc.data : doc;
  for (const device of Object.values(devices)) {
    if (!isRecord(device) || typeof device.type !== 'string') throw new SiteExportError(source, 'an audit device has no type');
  }
  return { auditDevices: Object.keys(devices).length };
}

// ---- Kubernetes audit policy (audit.k8s.io/v1 Policy, as the RKE2 server reads it) -----------------------------------------------------

/** The Theia Cloud custom resources whose records must be audited. */
export const THEIA_CLOUD_GROUP = 'theia.cloud';
const AUDIT_LEVELS = Object.freeze(['None', 'Metadata', 'Request', 'RequestResponse']);
const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** Whether a rule's resource selector covers every request for the resource (`all`), only some (`some`), or none. */
function selects(rule: Record<string, unknown>, resource: string): 'all' | 'some' | 'none' {
  if (rule.resources === undefined || rule.resources === null || (Array.isArray(rule.resources) && rule.resources.length === 0)) {
    return nonEmpty(rule.nonResourceURLs) ? 'none' : 'all';
  }
  if (!Array.isArray(rule.resources)) return 'none';
  let found: 'all' | 'some' | 'none' = 'none';
  for (const entry of rule.resources) {
    if (!isRecord(entry) || (entry.group ?? '') !== THEIA_CLOUD_GROUP) continue;
    const names = entry.resources;
    const covers = names === undefined || names === null || (Array.isArray(names) && (names.length === 0 || names.includes(resource) || names.includes('*')));
    if (!covers) continue;
    if (!nonEmpty(entry.resourceNames)) return 'all';
    found = 'some';
  }
  return found;
}

/**
 * Whether every record of one Theia Cloud resource is audited. Rules are read in order, first match wins (Kubernetes audit policy): a rule that
 * selects every request for the resource decides it (audited unless its level is None); a narrower rule (by user, group, verb, namespace or
 * resource name) at level None may drop some records, so it decides "not audited"; a narrower rule at another level does not decide.
 */
function audited(rules: readonly Record<string, unknown>[], resource: string): boolean {
  for (const rule of rules) {
    const selection = selects(rule, resource);
    if (selection === 'none') continue;
    const narrowed = selection === 'some' || nonEmpty(rule.users) || nonEmpty(rule.userGroups) || nonEmpty(rule.verbs) || nonEmpty(rule.namespaces);
    if (!narrowed) return rule.level !== 'None';
    if (rule.level === 'None') return false;
  }
  return false;
}

export function readAuditPolicy(bytes: Buffer, source = 'kubernetes-audit-policy.yaml'): Pick<SiteFacts['kubernetes'], 'auditPolicySha256' | 'sessionsAudited' | 'workspacesAudited'> {
  let doc: unknown;
  try {
    doc = parseYaml(bytes.toString('utf8'), { maxAliasCount: 0 });
  } catch {
    throw new SiteExportError(source, 'is not YAML');
  }
  if (!isRecord(doc) || doc.apiVersion !== 'audit.k8s.io/v1' || doc.kind !== 'Policy') throw new SiteExportError(source, 'is not an audit.k8s.io/v1 Policy');
  const rules = listOf(doc.rules, source, 'rules');
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.level !== 'string' || !AUDIT_LEVELS.includes(rule.level)) throw new SiteExportError(source, 'a rule has no valid level');
  }
  const typed = rules as Record<string, unknown>[];
  return { auditPolicySha256: createHash('sha256').update(bytes).digest('hex'), sessionsAudited: audited(typed, 'sessions'), workspacesAudited: audited(typed, 'workspaces') };
}

// ---- Nodes (/proc/sys/crypto/fips_enabled read on each node) ----------------------------------------------------------------------------

export function readNodesFips(doc: unknown, source = 'nodes-fips.json'): Pick<SiteFacts['kubernetes'], 'nodes' | 'fipsNodes'> {
  if (!isRecord(doc)) throw new SiteExportError(source, 'expected { nodes }');
  const nodes = listOf(doc.nodes, source, 'nodes');
  let fipsNodes = 0;
  for (const node of nodes) {
    if (!isRecord(node)) throw new SiteExportError(source, 'a node entry is not an object');
    if (binaryFlag(node.fipsEnabled, source, 'fipsEnabled')) fipsNodes += 1;
  }
  return { nodes: nodes.length, fipsNodes };
}

// ---- Kyverno admission (ImageValidatingPolicy, ClusterPolicy with verifyImages) and policy reports (wgpolicyk8s.io PolicyReport) ---------

// ---- Images (cosign verify and cosign verify-attestation per digest in the lock list) --------------------------------------------------

const DIGEST_REF = /@sha256:([0-9a-f]{64})$/;
const SBOM_PREDICATE = /^https:\/\/(?:spdx\.dev\/Document|cyclonedx\.org\/bom)(?:\/v[0-9.]+)?$/;
const PROVENANCE_PREDICATE = /^https:\/\/slsa\.dev\/provenance\/v[0-9.]+$/;

/** `cosign verify` output: every signature names exactly this manifest digest. */
function signatureVerified(value: unknown, digest: string): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isRecord(entry) && isRecord(entry.critical) && isRecord(entry.critical.image) && entry.critical.image['docker-manifest-digest'] === `sha256:${digest}`);
}

/** Verified attestation statements: one with the predicate type has this digest as a subject. */
function attested(value: unknown, digest: string, predicate: RegExp): boolean {
  return Array.isArray(value) && value.some((statement) => isRecord(statement) && typeof statement.predicateType === 'string' && predicate.test(statement.predicateType)
    && Array.isArray(statement.subject) && statement.subject.some((subject) => isRecord(subject) && isRecord(subject.digest) && subject.digest.sha256 === digest));
}

/**
 * `{ images: [{ ref, signature, sbom, provenance }] }` for every image in the lock list: `signature` is the JSON `cosign verify` printed, `sbom`
 * and `provenance` the statements (predicate type and subjects) of the attestations `cosign verify-attestation` verified, each null when the
 * verification failed. An entry counts only for its own digest.
 */
export function readImages(doc: unknown, source = 'images.json'): SiteFacts['images'] {
  if (!isRecord(doc)) throw new SiteExportError(source, 'expected { images }');
  const images = listOf(doc.images, source, 'images');
  const seen = new Set<string>();
  let signatureCount = 0;
  let sbom = 0;
  let provenance = 0;
  for (const image of images) {
    if (!isRecord(image) || typeof image.ref !== 'string') throw new SiteExportError(source, 'an image has no ref');
    const match = DIGEST_REF.exec(image.ref);
    if (!match) throw new SiteExportError(source, 'an image ref is not pinned by a sha256 digest');
    if (seen.has(image.ref)) throw new SiteExportError(source, 'an image is listed twice');
    seen.add(image.ref);
    const digest = match[1];
    if (signatureVerified(image.signature, digest)) signatureCount += 1;
    if (attested(image.sbom, digest, SBOM_PREDICATE)) sbom += 1;
    if (attested(image.provenance, digest, PROVENANCE_PREDICATE)) provenance += 1;
  }
  return { locked: images.length, signatureVerified: signatureCount, sbomVerified: sbom, provenanceVerified: provenance };
}

// ---- Session pods (`node -p "crypto.getFips()"` in a sample of session pods) -----------------------------------------------------------

export function readWorkbenchFips(doc: unknown, source = 'workbench-fips.json'): SiteFacts['workbench'] {
  if (!isRecord(doc)) throw new SiteExportError(source, 'expected { samples }');
  const samples = listOf(doc.samples, source, 'samples');
  let fips = 0;
  for (const sample of samples) {
    if (!isRecord(sample)) throw new SiteExportError(source, 'a sample is not an object');
    if (binaryFlag(sample.getFips, source, 'getFips')) fips += 1;
  }
  return { sampledSessions: samples.length, fipsSessions: fips };
}

// ---- The facts of one collected folder -------------------------------------------------------------------------------------------------

/** Reads every collected file and returns the facts. Nothing else in the folder is read. */
export function readSiteFacts(dir: string): SiteFacts {
  const json = (name: SourceFile): unknown => parseSourceJson(readSource(dir, name), name);
  const realm = readKeycloakRealm(json('keycloak-realm.json'));
  const server = readKeycloakServerInfo(json('keycloak-serverinfo.json'));
  const clients = readKeycloakClients(json('keycloak-clients.json'));
  const counts = readCounts(json('counts.json'));
  const status = readOpenBaoStatus(json('openbao-status.json'));
  const audit = readOpenBaoAudit(json('openbao-audit.json'));
  const policy = readAuditPolicy(readSource(dir, 'kubernetes-audit-policy.yaml'));
  const nodes = readNodesFips(json('nodes-fips.json'));
  const policies = readKyvernoPolicies(json('kyverno-clusterpolicies.json'));
  const reports = readPolicyReports(json('kyverno-policyreports.json'), policies);
  const images = readImages(json('images.json'));
  const workbench = readWorkbenchFips(json('workbench-fips.json'));
  return {
    keycloak: { ...server, ...realm, ...clients, eventsLastDay: counts.keycloak },
    openbao: { ...status, ...audit, auditEventsLastDay: counts.openbao },
    kubernetes: { ...policy, auditEventsLastDay: counts.kubernetes, ...nodes },
    registry: { kind: counts.registryKind, enforcingImagePolicies: policies.enforcingImagePolicies, ...reports, auditEventsLastDay: counts.registry },
    images,
    workbench
  };
}

// ---- The envelope ----------------------------------------------------------------------------------------------------------------------

/** The envelope before its signature: everything the signer signs. */
export interface UnsignedExport {
  readonly v: typeof PAYLOAD_VERSION;
  readonly purpose: typeof SITE_EXPORT_PURPOSE;
  readonly signer: { readonly fingerprint: string; readonly publicKey: string };
  readonly signedAt: string;
  readonly payload: SiteExportPayload;
}

export interface SignedExport extends UnsignedExport {
  readonly sig: string;
}

/** Refuses an envelope whose text the repository's secret detector flags (every rule, the allow marker ignored); names only the rules. */
export function assertNoSecretText(envelope: Readonly<Record<string, unknown>>): void {
  const found = matchRules(canonicalize(envelope)) as string[];
  if (found.length > 0) throw new Error(`the export would carry text the secret scan flags (secret rule ${found.join(', ')}); nothing was written`);
}

/**
 * The unsigned envelope for one export. Its signing time is the export time, which the collector requires, so the 7-day window runs from
 * when the facts were collected. `publicKey` is the signer's raw Ed25519 public key in base64url.
 */
export function buildUnsignedExport(site: string, generatedAt: string, facts: SiteFacts, publicKey: string): UnsignedExport {
  if (!isStrictBase64url(publicKey, 32)) throw new Error('the public key must be a raw Ed25519 key in base64url');
  const payload = parseExportPayload({ schema: SITE_EXPORT_SCHEMA, site, generatedAt, facts });
  const unsigned: UnsignedExport = { v: PAYLOAD_VERSION, purpose: SITE_EXPORT_PURPOSE, signer: { fingerprint: fingerprintOf(Buffer.from(publicKey, 'base64url')), publicKey }, signedAt: generatedAt, payload };
  assertNoSecretText({ ...unsigned });
  return unsigned;
}

/** Checks a parsed unsigned envelope (for example one an external signer is given back) and returns it typed. */
export function parseUnsignedExport(value: unknown): UnsignedExport {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'payload,purpose,signedAt,signer,v') throw new Error('this is not an unsigned site export');
  if (value.v !== PAYLOAD_VERSION || value.purpose !== SITE_EXPORT_PURPOSE || !isRecord(value.signer) || typeof value.signedAt !== 'string') throw new Error('this is not an unsigned site export');
  const { publicKey } = value.signer;
  if (typeof publicKey !== 'string') throw new Error('this is not an unsigned site export');
  const payload = parseExportPayload(value.payload);
  const rebuilt = buildUnsignedExport(payload.site, payload.generatedAt, payload.facts, publicKey);
  if (canonicalize({ ...rebuilt }) !== canonicalize(value)) throw new Error('this is not an unsigned site export');
  return rebuilt;
}

/** The raw 32-byte Ed25519 public key of a key object, in base64url. */
export function rawPublicKey(key: ReturnType<typeof createPublicKey>): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the key is not an Ed25519 key');
  return Buffer.from(key.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64url');
}

/** Attaches a detached signature, verifying it over the exact signing input before returning the envelope. */
export function attachSignature(unsigned: UnsignedExport, signature: Buffer): SignedExport {
  if (signature.length !== 64) throw new Error('an Ed25519 signature is 64 bytes');
  const envelope: SignedExport = { ...unsigned, sig: signature.toString('base64url') };
  const verdict = verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys: [unsigned.signer], now: new Date(Date.parse(unsigned.signedAt)) });
  if (!verdict.ok) throw new Error(verdict.message);
  return envelope;
}

/** Signs an unsigned export with a PKCS#8 PEM Ed25519 private key, which must be the key the envelope names. */
export function signExport(unsigned: UnsignedExport, privateKeyPem: string): SignedExport {
  const privateKey = createPrivateKey(privateKeyPem);
  if (rawPublicKey(createPublicKey(privateKey)) !== unsigned.signer.publicKey) throw new Error('the private key does not match the public key the export names');
  return attachSignature(unsigned, edSign(null, signingInput(SITE_EXPORT_PURPOSE, { ...unsigned }), privateKey));
}

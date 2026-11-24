// The site export (48-02, D-13, D-16): readers that turn the read-only outputs compliance/site-export/collect.sh gathered on a site into the
// allow-listed facts of collectors/deployment.ts, and the envelope that carries them, signed in the extension's signed-payload format
// (signed.ts) for SITE_EXPORT_PURPOSE. Each reader keeps only what its fact needs: names, realm contents, secrets and log text stay behind.
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { PAYLOAD_VERSION, fingerprintOf, isStrictBase64url, signingInput } from './signed.ts';
import { SITE_EXPORT_PURPOSE, SITE_EXPORT_SCHEMA, parseExportPayload, type SiteExportPayload, type SiteFacts } from './collectors/deployment.ts';

/** A reader's refusal; `source` names the collected file. */
export class SiteExportError extends Error {
  public readonly source: string;
  public constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'SiteExportError';
    this.source = source;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- Keycloak realm (admin REST: GET /admin/realms/{realm} and GET /admin/realms/{realm}/authentication/flows/{alias}/executions) ----------

/** The realm fields that bind a flow (RealmRepresentation). */
export const BOUND_FLOW_FIELDS = Object.freeze(['browserFlow', 'registrationFlow', 'directGrantFlow', 'resetCredentialsFlow', 'clientAuthenticationFlow', 'dockerAuthenticationFlow', 'firstBrokerLoginFlow'] as const);
/** Authenticator provider ids that take a password, or set one. */
export const PASSWORD_AUTHENTICATORS = Object.freeze(['auth-username-password-form', 'auth-password-form', 'direct-grant-validate-password', 'idp-username-password-form', 'basic-auth', 'reset-password']);
/** Authenticator provider ids that take a one-time code, or set one up. */
export const OTP_AUTHENTICATORS = Object.freeze(['auth-otp-form', 'auth-conditional-otp-form', 'direct-grant-validate-otp', 'basic-auth-otp', 'reset-otp']);

export interface KeycloakRealmFacts {
  readonly passwordAuthenticators: number;
  readonly otpAuthenticators: number;
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
  return { passwordAuthenticators: password, otpAuthenticators: otp };
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

/**
 * The unsigned envelope for one export. Its signing time is the export time, which the collector requires, so the 7-day window runs from
 * when the facts were collected. `publicKey` is the signer's raw Ed25519 public key in base64url.
 */
export function buildUnsignedExport(site: string, generatedAt: string, facts: SiteFacts, publicKey: string): UnsignedExport {
  if (!isStrictBase64url(publicKey, 32)) throw new Error('the public key must be a raw Ed25519 key in base64url');
  const payload = parseExportPayload({ schema: SITE_EXPORT_SCHEMA, site, generatedAt, facts });
  return { v: PAYLOAD_VERSION, purpose: SITE_EXPORT_PURPOSE, signer: { fingerprint: fingerprintOf(Buffer.from(publicKey, 'base64url')), publicKey }, signedAt: generatedAt, payload };
}

/** The raw 32-byte Ed25519 public key of a key object, in base64url. */
export function rawPublicKey(key: ReturnType<typeof createPublicKey>): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the key is not an Ed25519 key');
  return Buffer.from(key.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64url');
}

/** Signs an unsigned export with a PKCS#8 PEM Ed25519 private key, which must be the key the envelope names. */
export function signExport(unsigned: UnsignedExport, privateKeyPem: string): SignedExport {
  const privateKey = createPrivateKey(privateKeyPem);
  if (rawPublicKey(createPublicKey(privateKey)) !== unsigned.signer.publicKey) throw new Error('the private key does not match the public key the export names');
  const sig = edSign(null, signingInput(SITE_EXPORT_PURPOSE, { ...unsigned }), privateKey).toString('base64url');
  return { ...unsigned, sig };
}

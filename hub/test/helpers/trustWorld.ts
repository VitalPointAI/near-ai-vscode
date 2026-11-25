// Your organization's trust data for the hub's trust tests (71-09): the Example Organization of the extension's credential tests (a root, an
// officer, members, status-list keys), its signed rules with the credentials section, and did:webvh logs built at run time. Fictional names only;
// every key is made at run time. A helper with no `.test` suffix, so it registers no tests.
import { buildOrganizationLayer } from '@ext/domain/gate/enrolment';
import { buildGenesisEntry, buildUpdateEntry, nextKeyHash, verifyWebvhLog } from '@ext/domain/did/didWebvh';
import type { WebvhState } from '@ext/domain/did/didWebvh';
import { REVOCATIONS, SUSPENSIONS, makeWorld, newKey } from '@ext/test/helpers/credentialWorld';
import type { Key, World } from '@ext/test/helpers/credentialWorld';
import { issuerKey, policyDocumentFor } from '@ext/test/helpers/policyFixtures';
import type { OrganizationSource } from '../../src/store/trustStore';

/** The hub's clock in the trust tests: inside the lists' and credentials' validity. */
export const TRUST_NOW = Date.parse('2026-11-24T12:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;
export const REVOCATION_ROUTE = '/v1/trust/status/revocation-1';
export const SUSPENSION_ROUTE = '/v1/trust/status/suspension-1';
export { REVOCATIONS, SUSPENSIONS };

export interface TrustWorld {
  world: World;
  organization: OrganizationSource;
}

/** The Example Organization and its rules signed by its policy issuer key, valid at TRUST_NOW. */
export async function makeTrustWorld(requiredBySensitivity: Record<string, string[]> = {}, now: number = TRUST_NOW): Promise<TrustWorld> {
  const world = await makeWorld(requiredBySensitivity);
  const issuer = issuerKey();
  const doc = policyDocumentFor({ key: issuer });
  const credentials = JSON.parse(JSON.stringify(world.section)) as Record<string, unknown>;
  const layer = buildOrganizationLayer(issuer, { labels: doc.labels, agents: doc.agents, credentials }, { now: now - DAY, days: 90 });
  return { world, organization: { text: JSON.stringify(layer), key: issuer.publicKey } };
}

function documentFor(assertionKey: string): (did: string) => Record<string, unknown> {
  return (did) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, controller: did,
    verificationMethod: [{ id: `${did}#issuing`, type: 'Multikey', controller: did, publicKeyMultibase: assertionKey }],
    authentication: [`${did}#issuing`], assertionMethod: [`${did}#issuing`]
  });
}

export interface PersonLog {
  did: string;
  /** The log text: one entry per line, each ending in a newline. */
  log: string;
  state: WebvhState;
  update: Key;
  next: Key;
  issuing: Key;
  /** The log with one more entry, signed by the given key (the pre-committed next key by default). */
  extend(signer?: Key, versionTime?: string): Promise<string>;
}

/** A person's did:webvh log at hq.example.org/<path>, with pre-rotation on so an update by a key not committed to is refused. */
export async function personLog(path: string[], versionTime = '2026-11-01T00:00:00Z'): Promise<PersonLog> {
  const update = newKey();
  const next = newKey();
  const issuing = newKey();
  const genesis = await buildGenesisEntry(
    { domain: 'hq.example.org', path, updateKeys: [update.multikey], nextKeyHashes: [nextKeyHash(next.multikey)], portable: false, versionTime, document: documentFor(issuing.multikey) },
    update.signer,
  );
  const log = `${genesis.line}\n`;
  const verified = verifyWebvhLog(log, { now: TRUST_NOW });
  if (!verified.ok) throw new Error(verified.reason);
  const state = verified.state;
  return {
    did: genesis.did,
    log,
    state,
    update,
    next,
    issuing,
    async extend(signer = next, time = '2026-11-10T00:00:00Z') {
      const after = newKey();
      const entry = await buildUpdateEntry(state, { parameters: { updateKeys: [signer.multikey], nextKeyHashes: [nextKeyHash(after.multikey)] }, versionTime: time, document: documentFor(issuing.multikey) }, signer.signer);
      return `${log}${entry.line}\n`;
    },
  };
}

/** An ISO time without milliseconds, as credentials and lists carry them. */
export const isoAt = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

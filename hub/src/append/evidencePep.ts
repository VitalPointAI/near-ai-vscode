// The hub as an enforcement point for cited evidence (Phase 71, 71-09; D-09, D-11, D-16, DCAC-04). An entry that relies on a person's attributes
// carries `evidence` (credential hashes) and `status` ({ list, hash, validFrom } per list checked) in its data. For every such entry the hub can
// open (base-stream bodies; other cells stay ciphertext and their readers check them), the hub runs the fold's own checkEvidence on exactly the
// cited data, then checkFreshness against its newest lists at its own clock: a citation of a list older than the newest by more than the grace is
// refused 'stale-evidence'. Any entry kind is covered, so 33.1's kinds need no hub change.
//
// Where the cited data comes from. Credentials travel as sealed blobs in the entry's own cell (D-09): the client names them in the append's blobRefs
// for that entry (D-69), and the hub opens each with the entry's cell key. Lists come from the hub's own trust store, by hash. The member's DID is
// the issuer of the cited DeviceBindingCredential that binds the writing device's key; checkEvidence then requires that key to be the member's at
// the entry's time (member-key) and every cited credential to be about that DID. The clock is credentialClock: the entry's signed time, never later
// than the hub's witness time.
//
// Without your organization's verified rules the hub cannot judge evidence; it stores such entries as today and the clients judge them (an entry is
// refused only for a fault the hub can prove, checks.ts).
import { credentialClock } from '@ext/domain/credentials/clock';
import { EVIDENCE_REFUSALS, checkEvidence } from '@ext/domain/credentials/evidence';
import type { EvidenceCitation, EvidenceRefusal } from '@ext/domain/credentials/evidence';
import { checkFreshness } from '@ext/domain/credentials/freshness';
import { credentialHash, readCredential } from '@ext/domain/credentials/profile';
import { DEVICE_BINDING_TYPE } from '@ext/domain/credentials/types';
import { didKeyFromDevice } from '@ext/domain/did/didKey';
import type { CitedStatus, TrustStore } from '../store/trustStore';

const HASH = /^[0-9a-f]{64}$/;
const MAX_CITED_CREDENTIALS = 64;
const MAX_CITED_LISTS = 16;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type EvidenceOutcome =
  | { ok: true; checked: false }
  | { ok: true; checked: true; cited: CitedStatus[] }
  | { ok: false; reason: 'stale-evidence' | 'evidence-malformed' | 'evidence-refused'; evidence?: EvidenceRefusal; message?: string };

/** True when the opened data claims to rely on evidence: a record with its own `evidence` key. */
export function carriesEvidence(data: unknown): boolean {
  return isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'evidence');
}

/** The citation in an entry's data, or undefined when it is not in the shape PLAN-IDS.md gives. */
export function citationOf(data: unknown): EvidenceCitation | undefined {
  if (!isRecord(data)) return undefined;
  const { evidence, status } = data;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_CITED_CREDENTIALS || !evidence.every((hash) => typeof hash === 'string' && HASH.test(hash))) return undefined;
  if (!Array.isArray(status) || status.length > MAX_CITED_LISTS) return undefined;
  const lists: Array<{ list: string; hash: string; validFrom: string }> = [];
  for (const item of status) {
    if (!isRecord(item) || Object.keys(item).length !== 3) return undefined;
    const { list, hash, validFrom } = item;
    if (typeof list !== 'string' || list.length > 2048 || typeof hash !== 'string' || !HASH.test(hash) || typeof validFrom !== 'string' || validFrom.length > 64) return undefined;
    lists.push({ list, hash, validFrom });
  }
  return { evidence: [...(evidence as string[])], status: lists };
}

export interface EvidenceInput {
  /** The opened body's data. */
  data: unknown;
  /** The body's signed time (ISO). */
  at: string;
  /** The writing device's Ed25519 public key (base64url), from the roster. */
  devicePublicKey: string;
  /** The plaintext of the blobs the append names for this entry, opened with the entry's cell key. */
  blobs: readonly Buffer[];
}

/** Checks one entry's cited evidence at the hub's clock. */
export function checkEntryEvidence(input: EvidenceInput, trust: TrustStore, now: number): EvidenceOutcome {
  const policy = trust.policy(now);
  if (!policy.ok) return { ok: true, checked: false };
  const citation = citationOf(input.data);
  if (citation === undefined) return { ok: false, reason: 'evidence-malformed' };

  const credentials: Record<string, unknown> = {};
  for (const bytes of input.blobs) {
    try {
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      credentials[credentialHash(value)] = value;
    } catch {
      // A blob that is not a credential is not cited evidence; a cited hash it does not give stays credential-missing.
    }
  }
  const lists: Record<string, unknown> = {};
  for (const cited of citation.status) {
    const body = trust.listByHash(cited.hash);
    if (body !== undefined) lists[cited.hash] = body;
  }

  let deviceDid: string;
  try {
    deviceDid = didKeyFromDevice(input.devicePublicKey);
  } catch {
    return refused('member-key');
  }
  const memberKey = deviceDid.slice('did:key:'.length);
  let member: string | undefined;
  for (const hash of citation.evidence) {
    const read = readCredential(credentials[hash], policy.scales, { signed: true });
    if (read.ok && read.value.type === DEVICE_BINDING_TYPE && read.value.claims.id === deviceDid) member = read.value.issuer;
  }
  if (member === undefined) return refused('member-key');

  const signedAt = credentialClock(Date.parse(input.at), now).at;
  const result = checkEvidence(citation, {
    credentials,
    lists,
    policy: { section: policy.section, scales: policy.scales },
    didState: { states: trust.didStates(now) },
    member,
    memberKey,
    signedAt,
  });
  if (!result.ok) return refused(result.reason);
  const fresh = checkFreshness(citation, trust.newest(now), undefined, policy.section, now, 'connected');
  if (!fresh.ok) return { ok: false, reason: 'stale-evidence', message: fresh.message };

  const cited: CitedStatus[] = [];
  for (const credential of result.credentials) {
    if (credential.claims.id !== member) continue;
    for (const entry of credential.status) cited.push({ list: entry.statusListCredential, index: entry.statusListIndex, purpose: entry.statusPurpose });
  }
  return { ok: true, checked: true, cited };
}

function refused(reason: EvidenceRefusal): EvidenceOutcome {
  return { ok: false, reason: 'evidence-refused', evidence: reason, message: EVIDENCE_REFUSALS[reason] };
}

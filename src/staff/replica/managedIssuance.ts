import { HASH_PATTERN, STREAM_ID_PATTERN, sha256Hex, writerIdOf } from '../../domain/replica/entry';
import { isRosterWriterAt, rosterView } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt, deviceKeyOf } from '../../domain/replica/rosterMembers';
import { certifiedWriter } from '../../domain/replica/sessionKeys';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../../domain/team/canonical';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import { MANAGED_HANDOFF_LIFETIME_MS } from './managedSync';

interface Issuance {
  v: 1;
  handle: string;
  project: string;
  recipient: string;
  roster: string;
  entry: string;
  root: string;
  digest: string;
  authority: string;
  signer: string;
  certificate: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface ManagedIssuer { authority: string; signer: PayloadSigner }
export interface IssuedManagedArtifact { issuance: Issuance; signature: string; artifact: Record<string, unknown> }

const issuanceBytes = (issuance: Issuance): Buffer => canonicalBytes(['near-ai/managed-handoff-issuance/1', issuance]);
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const artifactEntry = (artifact: Record<string, unknown>): unknown => isRecord(artifact.opening) ? artifact.opening.entry : artifact.entry;

/** Only a live device authority, or its exact currently admitted session key, may issue. */
function issuerDeadline(roster: RosterState, issuance: Pick<Issuance, 'authority' | 'signer' | 'certificate' | 'roster'>, time: number): number | undefined {
  const issued = roster.positionOf.get(issuance.roster);
  const head = roster.positions.length - 1;
  if (issued === undefined || !isRosterWriterAt(roster, issuance.authority, issued) || !isRosterWriterAt(roster, issuance.authority, head)) return undefined;
  const writer = writerIdOf(issuance.signer);
  if (issuance.certificate === null) return writer === issuance.authority &&
    deviceKeyOf(roster.members, writer)?.publicKey === issuance.signer ? time + MANAGED_HANDOFF_LIFETIME_MS : undefined;
  const certificate = roster.sessions.get(writer);
  if (certificate?.hash !== issuance.certificate || certificate.device !== issuance.authority || certificate.sessionKey !== issuance.signer) return undefined;
  const view = rosterView(roster);
  const certifiedAt = roster.positionOf.get(certificate.roster);
  if (certifiedAt === undefined || certifiedAt > issued) return undefined;
  if (certifiedWriter(view, writer, issuance.roster) === undefined || certifiedWriter(view, writer, roster.positions[head]) === undefined) return undefined;
  const expires = Date.parse(certificate.notAfter);
  return expires > time ? Math.min(expires, time + MANAGED_HANDOFF_LIFETIME_MS) : undefined;
}

export function prepareManagedIssuance(roster: RosterState, issuer: ManagedIssuer, recipient: string, now: number, artifact: Record<string, unknown>) {
  const revision = roster.accessRevision;
  if (!isTime(now) || !Number.isSafeInteger(now + MANAGED_HANDOFF_LIFETIME_MS) || revision === undefined ||
      artifactEntry(artifact) !== revision.entry || !isStrictBase64url(issuer.signer.publicKey, 32)) return undefined;
  const signer = issuer.signer.publicKey;
  const writer = writerIdOf(signer);
  const certificate = writer === issuer.authority ? null : roster.sessions.get(writer)?.hash;
  if (certificate === undefined) return undefined;
  const artifactBytes = canonicalBytes(artifact);
  const frozen = JSON.parse(artifactBytes.toString('utf8')) as Record<string, unknown>;
  const binding = { v: 1 as const, project: roster.anchor.project, recipient, roster: roster.positions[roster.positions.length - 1],
    entry: revision.entry, root: revision.root, digest: sha256Hex(artifactBytes), authority: issuer.authority, signer, certificate, issuedAt: now };
  const expiresAt = issuerDeadline(roster, binding, now);
  if (expiresAt === undefined) return undefined;
  return { binding, expiresAt,
    issue(handle: string): IssuedManagedArtifact | undefined {
      if (!isHash(handle)) return undefined;
      const issuance = { ...binding, handle, expiresAt };
      const signature = issuer.signer.sign(issuanceBytes(issuance));
      return verifySignature(issuanceBytes(issuance), signature, signer) ? { issuance, signature, artifact: frozen } : undefined;
    }
  };
}

/** Check the exact packet's private binding before it can be staged. Roster authority is checked before promotion. */
export function readManagedIssuance(value: unknown, scope: { project: string; recipient: string; handle: string; now: number; expectedExpiry?: number }): IssuedManagedArtifact | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !isRecord(value.issuance) || !isRecord(value.artifact) || typeof value.signature !== 'string') return undefined;
  const meta = value.issuance;
  if (Object.keys(meta).length !== 13 || meta.v !== 1 || !isHash(meta.handle) || meta.handle !== scope.handle ||
      typeof meta.project !== 'string' || !STREAM_ID_PATTERN.test(meta.project) || meta.project !== scope.project ||
      !isHash(meta.recipient) || meta.recipient !== scope.recipient || !isHash(meta.roster) || !isHash(meta.entry) || !isHash(meta.root) ||
      !isHash(meta.digest) || !isHash(meta.authority) || typeof meta.signer !== 'string' || !isStrictBase64url(meta.signer, 32) ||
      (meta.certificate !== null && !isHash(meta.certificate)) || !isTime(meta.issuedAt) || !isTime(meta.expiresAt) ||
      !isTime(scope.now) || meta.issuedAt > scope.now || meta.expiresAt <= scope.now || meta.expiresAt - meta.issuedAt > MANAGED_HANDOFF_LIFETIME_MS ||
      (scope.expectedExpiry !== undefined && meta.expiresAt !== scope.expectedExpiry) || artifactEntry(value.artifact) !== meta.entry) return undefined;
  const issuance = meta as unknown as Issuance;
  try {
    if (sha256Hex(canonicalBytes(value.artifact)) !== issuance.digest || !verifySignature(issuanceBytes(issuance), value.signature, issuance.signer)) return undefined;
  } catch { return undefined; }
  return { issuance, signature: value.signature, artifact: value.artifact };
}

export function managedIssuanceCurrent(roster: RosterState, { issuance }: IssuedManagedArtifact, now: Date, historical = false): boolean {
  const time = now.getTime();
  const cited = roster.positionOf.get(issuance.roster);
  const entry = roster.positionOf.get(issuance.entry);
  const deadline = issuerDeadline(roster, issuance, time);
  const issuedDeadline = issuerDeadline(roster, issuance, issuance.issuedAt);
  return isTime(time) && issuance.issuedAt <= time && time < issuance.expiresAt && deadline !== undefined && issuedDeadline !== undefined &&
    issuance.expiresAt <= issuedDeadline && issuance.project === roster.anchor.project && roster.pending.length === 0 &&
    cited !== undefined && entry !== undefined && entry <= cited && roster.accessHistory.get(issuance.entry)?.root === issuance.root &&
    (historical || roster.accessRevision?.entry === issuance.entry) && deviceAt(roster.members, issuance.recipient, roster.positions.length - 1) !== undefined;
}

/** An early packet may wait privately if its issuer is already trusted on this device. */
export function managedIssuerKnown(roster: RosterState, { issuance }: IssuedManagedArtifact, now: Date): boolean {
  const time = now.getTime();
  return isTime(time) && time < issuance.expiresAt && issuerDeadline(roster, { ...issuance, roster: roster.positions[roster.positions.length - 1] }, time) !== undefined;
}

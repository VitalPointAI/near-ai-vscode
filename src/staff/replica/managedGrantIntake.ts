import type { ReplicaStore, StoreRefused } from './store';
import type { RosterState } from '../../domain/replica/roster';
import { sha256Hex } from '../../domain/replica/entry';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { openManagedGrantArtifact, verifySelectedManagedArtifact } from './managedGrantDelivery';
import { managedIssuanceCurrent, managedIssuerKnown } from './managedIssuance';

type DeliveryDevice = Parameters<typeof openManagedGrantArtifact>[1];
type Evidence = readonly { hash: string; value: unknown }[];
type Checked = NonNullable<ReturnType<typeof verifySelectedManagedArtifact>>;
type FileIntake = { verified: Checked } | StoreRefused | { refused: 'welcome-refused' };

const MAX_WAITING_FILES = 16;
const refused = { refused: 'welcome-refused' as const };
const digest = (value: unknown): string => sha256Hex(canonicalBytes(value));

function pendingManagedPacket(value: unknown, deadline: number, digest: string) {
  return { managedPendingPacket: value, deadline, digest };
}

async function putCurrent(store: ReplicaStore, artifact: unknown, expected: string, deadline: number, clock: () => Date) {
  return store.putAccessEvidence(artifact, expected, () => clock().getTime() < deadline);
}

/** Keep an early delivery sealed. Only authorized and selected live evidence enters the fold. */
export async function ingestManagedDelivery(store: ReplicaStore, roster: RosterState, entries: Evidence, device: DeliveryDevice,
  value: unknown, source: 'file' | 'peer', clock: () => Date): Promise<FileIntake> {
  const now = clock();
  const issued = openManagedGrantArtifact(roster.anchor.project, device, value, now);
  if (issued === undefined) return refused;
  const deadline = issued.issuance.expiresAt;
  const expected = await store.appendSnapshot();
  if (managedIssuanceCurrent(roster, issued, now)) {
    const checked = verifySelectedManagedArtifact(roster, device.writer, issued.artifact, now);
    if (checked === undefined) return refused;
    const stored = await putCurrent(store, issued.artifact, expected, deadline, clock);
    return 'ok' in stored ? { verified: checked } : stored;
  }
  if (source !== 'file' || roster.positionOf.has(issued.issuance.entry) || !managedIssuerKnown(roster, issued, now)) return refused;
  const pending = pendingManagedPacket(value, deadline, issued.issuance.digest);
  if (entries.some(({ hash }) => hash === digest(pending))) return { verified: true };
  const placed = new Set(entries.map(({ hash }) => hash));
  const waiting = entries.filter(({ value }) => pendingValue(value, now, placed) !== undefined);
  if (waiting.length >= MAX_WAITING_FILES) return refused;
  const stored = await putCurrent(store, pending, expected, deadline, clock);
  return 'ok' in stored ? { verified: true } : stored;
}

function pendingValue(value: unknown, now: Date, placed: ReadonlySet<string>) {
  return isRecord(value) && Object.keys(value).length === 3 && Number.isSafeInteger(value.deadline) &&
    (value.deadline as number) > now.getTime() && typeof value.digest === 'string' && !placed.has(value.digest) ? { packet: value.managedPendingPacket, deadline: value.deadline, digest: value.digest } : undefined;
}

export async function promoteManagedDeliveries(store: ReplicaStore, roster: RosterState, evidence: Evidence, device: DeliveryDevice, clock: () => Date): Promise<boolean> {
  let changed = false;
  const seen = new Set(evidence.map(({ hash }) => hash));
  for (const { value } of evidence) {
    const now = clock();
    const pending = pendingValue(value, now, seen);
    if (pending === undefined) continue;
    const issued = openManagedGrantArtifact(roster.anchor.project, device, pending.packet, now);
    if (issued === undefined || issued.issuance.digest !== pending.digest || issued.issuance.expiresAt !== pending.deadline || !managedIssuanceCurrent(roster, issued, now) ||
        verifySelectedManagedArtifact(roster, device.writer, issued.artifact, now) === undefined) continue;
    const identity = digest(issued.artifact);
    if (seen.has(identity)) continue;
    const expected = await store.appendSnapshot();
    const result = await putCurrent(store, issued.artifact, expected, issued.issuance.expiresAt, clock);
    if ('refused' in result) break;
    seen.add(identity);
    changed = true;
  }
  return changed;
}

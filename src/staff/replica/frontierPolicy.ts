import { createHash } from 'node:crypto';
import { effectiveNow } from '../../domain/gate/bundle';
import { dominates } from '../../domain/gate/dominance';
import { parseClearance, parseLabel } from '../../domain/gate/labels';
import { openLabel } from '../../domain/replica/cellKeys';
import { isRosterWriterAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { committedGrant, epochAt } from '../../domain/replica/rosterCells';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import type { KeyRing } from '../../domain/replica/rosterView';
import { isRecord } from '../../domain/team/validate';
import { composeLayers } from '../../domain/gate/layers';
import { canonicalBytes } from '../../domain/team/canonical';
import { BUNDLE_LOCK_FILE, gateDir, readCommittedFrontierPersonal } from '../../gate/bundleStore';
import { readLastValid } from '../../gate/clockMarker';
import { OrganizationStore } from '../../gate/organizationStore';
import type { SecretStorageLike } from '../../services/auth';
import { withFileLock } from '../../services/stateMirrorLock';
import { identityDir } from '../../team/identity';
import { KEY_HISTORY_LOCK_FILE, readKeyHistory } from '../../team/keyHistory';

async function readSource(storage: string, secrets: SecretStorageLike, now: () => Date) {
  const marker = await readLastValid(secrets);
  if (!marker.present || marker.at === undefined || marker.hash === undefined || marker.pending !== undefined) return undefined;
  const instant = effectiveNow(now().getTime(), marker.at);
  if (!Number.isSafeInteger(instant) || instant < 0) return undefined;
  const history = await readKeyHistory(identityDir(storage), secrets);
  if (!history.ok || history.head === undefined) return undefined;
  const personal = await readCommittedFrontierPersonal(storage, secrets, instant, marker, history.lookup);
  if (personal === undefined) return undefined;
  const organization = await new OrganizationStore(storage, secrets).readCommittedFrontierLayer(instant);
  if (organization === undefined) return undefined;
  const source = {
    instant,
    personalEnvelope: personal.envelope,
    personalHistoryHead: history.head,
    personalSigner: personal.signer,
    personalSignerStatus: personal.status,
    organizationEnvelope: organization.envelope,
    organizationPin: organization.pin,
    effective: composeLayers({ personal: personal.document, organization: organization.document }).effective
  };
  const identity = createHash('sha256').update(canonicalBytes([
    marker, history.head, personal.envelope, personal.signer, personal.status, organization.envelope, organization.pin
  ])).digest('hex');
  return { source, identity };
}

type PolicySource = NonNullable<Awaited<ReturnType<typeof readSource>>>['source'];
type PolicySourceCapture = () => Promise<{ source: PolicySource; recheck: () => Promise<boolean> } | undefined>;

/**
 * Holds the existing bundle -> key-history lock order. The trusted frontier caller takes the replica lock
 * before calling capture, so the effective instant and signed policy snapshot come from the same guard.
 */
export async function withFrontierPolicySource<T>(
  storage: string, secrets: SecretStorageLike, now: () => Date,
  work: (capture: PolicySourceCapture) => T | Promise<T>
): Promise<T | undefined> {
  try {
    return await withFileLock(gateDir(storage), BUNDLE_LOCK_FILE, () =>
      withFileLock(identityDir(storage), KEY_HISTORY_LOCK_FILE, async () => {
        let active = true;
        let started = false;
        try {
          return await work(async () => {
            if (!active || started) return undefined;
            started = true;
            const captured = await readSource(storage, secrets, now);
            if (!active || captured === undefined) return undefined;
            const { instant } = captured.source;
            return {
              source: Object.freeze(captured.source),
              recheck: async () => {
                if (!active) return false;
                const current = await readSource(storage, secrets, now).catch(() => undefined);
                return active && current !== undefined && current.source.instant >= instant && current.identity === captured.identity;
              }
            };
          });
        } finally {
          active = false;
        }
      }));
  } catch {
    return undefined;
  }
}


/** Checks just the signed founding label and exact custodian's placed wrap at the selected fence. */
export function hasFrontierCustody(
  roster: RosterState, stream: string, writer: string, keys: KeyRing, source: PolicySource
): boolean {
  const position = roster.positions.length - 1;
  if (stream === roster.anchor.project || !isRosterWriterAt(roster, writer, position)) return false;
  const device = deviceAt(roster.members, writer, position);
  const epoch = epochAt(roster.cells, stream, position);
  if (device === undefined || epoch === undefined) return false;
  const foundingHash = committedGrant(roster.cells, stream, epoch);
  const founding = roster.cells.cells.get(stream)?.grants.find((grant) =>
    grant.founding && grant.epoch === epoch && grant.hash === foundingHash && grant.from <= position);
  if (founding === undefined || founding.grant.pages !== undefined || !founding.writers.includes(writer)) return false;
  const key = keys(stream, epoch);
  const clearanceData = memberAt(roster.members, device.member, position)?.clearance;
  if (key === undefined || !isRecord(clearanceData)) return false;
  const { scales, mappings } = source.effective.labels;
  const { handling: _handling, ...declared } = clearanceData;
  const clearance = parseClearance(declared, scales);
  const label = parseLabel(openLabel(key, stream, epoch, founding.grant.labelSealed), scales);
  return label.ok && clearance.ok && dominates(clearance.value, label.value, { scales, mappings, now: source.instant });
}

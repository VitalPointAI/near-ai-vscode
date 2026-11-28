import { createHash } from 'node:crypto';
import { verifyOrganizationLayer } from '../domain/gate/enrolment';
import { verifyPolicyLayer } from '../domain/gate/policyDocument';
import { effectiveNow } from '../domain/gate/bundle';
import { dominates } from '../domain/gate/dominance';
import { parseClearance, parseLabel } from '../domain/gate/labels';
import { openLabel } from '../domain/replica/cellKeys';
import { isRosterWriterAt } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { committedGrant, epochAt } from '../domain/replica/rosterCells';
import { deviceAt, memberAt } from '../domain/replica/rosterMembers';
import type { KeyRing } from '../domain/replica/rosterView';
import { isRecord } from '../domain/team/validate';
import { composeLayers } from '../domain/gate/layers';
import { canonicalBytes } from '../domain/team/canonical';
import { BUNDLE_LOCK_FILE, gateDir, readCommittedFrontierPersonal } from './bundleStore';
import { readLastValid } from './clockMarker';
import { OrganizationStore } from './organizationStore';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { identityDir } from '../team/identity';
import { KEY_HISTORY_LOCK_FILE, readKeyHistory, readKeyHistoryPrefix } from '../team/keyHistory';

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
export function frontierCustody(
  roster: RosterState, stream: string, writer: string, keys: KeyRing, source: Pick<PolicySource, 'effective' | 'instant'>,
  position = roster.positions.length - 1
): { epoch: number; grant: string; label: string } | undefined {
  if (stream === roster.anchor.project || !isRosterWriterAt(roster, writer, position)) return undefined;
  const device = deviceAt(roster.members, writer, position);
  const epoch = epochAt(roster.cells, stream, position);
  if (device === undefined || epoch === undefined) return undefined;
  const foundingHash = committedGrant(roster.cells, stream, epoch);
  const founding = roster.cells.cells.get(stream)?.grants.find((grant) =>
    grant.founding && grant.epoch === epoch && grant.hash === foundingHash && grant.from <= position);
  if (founding === undefined || founding.grant.pages !== undefined || !founding.writers.includes(writer)) return undefined;
  const key = keys(stream, epoch);
  const clearanceData = memberAt(roster.members, device.member, position)?.clearance;
  if (key === undefined || !isRecord(clearanceData)) return undefined;
  const { scales, mappings } = source.effective.labels;
  const { handling: _handling, ...declared } = clearanceData;
  const clearance = parseClearance(declared, scales);
  const label = parseLabel(openLabel(key, stream, epoch, founding.grant.labelSealed), scales);
  if (!label.ok || !clearance.ok || !dominates(clearance.value, label.value, { scales, mappings, now: source.instant })) return undefined;
  return { epoch, grant: founding.hash, label: createHash('sha256').update(founding.grant.labelSealed).digest('hex') };
}


/** Re-verifies the exact retained envelopes against verified personal continuity and the current organization pin. */
export async function reopenFrontierPolicy(
  saved: unknown, current: PolicySource, storage: string, secrets: SecretStorageLike
) {
  if (!isRecord(saved) || !isRecord(saved.personalHistoryHead) || !isRecord(saved.organizationPin) ||
    typeof saved.instant !== 'number' || !Number.isSafeInteger(saved.instant) || saved.instant < 0) return undefined;
  const { seq, hash } = saved.personalHistoryHead;
  if (typeof seq !== 'number' || typeof hash !== 'string') return undefined;
  const history = await readKeyHistoryPrefix(identityDir(storage), secrets, { seq, hash });
  if (history === undefined || history.current.head?.hash !== current.personalHistoryHead.hash ||
    history.current.head.seq !== current.personalHistoryHead.seq) return undefined;
  const pin = saved.organizationPin;
  const trusted = current.organizationPin;
  if (typeof pin.publicKey !== 'string' || typeof pin.serial !== 'number' || !Number.isSafeInteger(pin.serial) || pin.serial < 1 ||
    trusted.serial < pin.serial || pin.enrolledAt !== trusted.enrolledAt || typeof pin.lastIssuedAt !== 'string' ||
    typeof pin.layerHash !== 'string' || pin.pending !== undefined) return undefined;
  const originalIssue = Date.parse(pin.lastIssuedAt);
  const trustedIssue = Date.parse(trusted.lastIssuedAt);
  const sameIssuer = pin.publicKey === trusted.publicKey;
  if (!Number.isFinite(originalIssue) || trustedIssue < originalIssue ||
    (sameIssuer && trustedIssue === originalIssue && trusted.layerHash !== pin.layerHash)) return undefined;
  if (!sameIssuer) {
    const source = { publicKey: pin.publicKey, serial: pin.serial, layerHash: pin.layerHash, lastIssuedAt: pin.lastIssuedAt, enrolledAt: pin.enrolledAt };
    if (!await new OrganizationStore(storage, secrets).verifiesAcceptedHandover(source, trusted, saved.instant, current.instant)) return undefined;
  }
  const personal = verifyPolicyLayer(saved.personalEnvelope, { purpose: 'policy-bundle', status: history.current.lookup, now: saved.instant });
  const organization = verifyOrganizationLayer(saved.organizationEnvelope, {
    issuerPublicKey: pin.publicKey, lastIssuedAt: pin.lastIssuedAt, now: saved.instant
  });
  if (personal.state !== 'valid' || personal.wireVersion !== 2 || !isRecord(saved.personalSigner) || !isRecord(saved.personalSignerStatus) ||
    !canonicalBytes(personal.signer).equals(canonicalBytes(saved.personalSigner)) ||
    !canonicalBytes(history.captured.lookup(personal.signer)).equals(canonicalBytes(saved.personalSignerStatus)) || !organization.ok ||
    organization.hash !== pin.layerHash || organization.issuedAt !== pin.lastIssuedAt) return undefined;
  return {
    instant: saved.instant,
    effective: composeLayers({ personal: personal.document, organization: organization.document }).effective
  };
}

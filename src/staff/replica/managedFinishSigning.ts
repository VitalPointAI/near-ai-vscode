import { MAX_GRANT_WRAPS, grantHash, grantProblem, readGrant } from '../../domain/replica/cellKeys';
import type { CellGrant, RekeyReason } from '../../domain/replica/cellKeys';
import { wrapFormatOf } from '../../domain/replica/cellWrapV2';
import { HASH_PATTERN, REPLICA_SIGNED_AT, STREAM_ID_PATTERN, prepareEntrySigning, sha256Hex, writerIdOf } from '../../domain/replica/entry';
import { buildGrantPagesAsync, grantPagePlan, readGrantPages } from '../../domain/replica/grantPages';
import type { BuildEntryInput } from '../../domain/replica/entry';
import type { WrapDevice } from '../../domain/replica/grantPages';
import { accessPermitBytes, accessRevisionId } from '../../domain/replica/rotationProof';
import type { AccessPermit, SignedAccessPermit } from '../../domain/replica/rotationProof';
import { CELL_REKEY_REASONS } from '../../domain/replica/kindSchemas/roster';
import type { SessionCertificate } from '../../domain/replica/sessionKeys';
import { canonicalBytes, fingerprintOf, isStrictBase64url, verifySignature } from '../../domain/team/canonical';
import { payloadSigningInput } from '../../domain/team/signedPayload';
import type { AsyncPayloadSigner, SignedPayload, SignRefused } from '../../domain/team/signedPayload';

export interface FinishContext {
  readonly project: string;
  readonly writer: string;
  readonly predecessor: string;
  readonly accessEntry: string;
  readonly accessRoot: string;
  readonly priorRevision?: string | null;
  readonly oldEpoch: number;
  readonly reason: RekeyReason;
  readonly evidence: string;
  readonly policy: string | null;
  readonly routing?: string;
  readonly label?: string;
  readonly recipients: readonly (WrapDevice & { format: 1 | 2 })[];
  readonly continuity: readonly { cell: string; epoch: number; devices: readonly string[]; sessions: readonly SessionCertificate[] }[];
}

interface FinishIntent {
  actionBytes(): Buffer;
  unsignedGrant(): CellGrant;
}

interface GrantIntent {
  context: FinishContext;
  action: Buffer;
  grant: CellGrant;
}

const intents = new WeakMap<FinishIntent, GrantIntent>();
const refusal = (): SignRefused => ({ refused: 'This key change needs a current confirmation for the exact part and signing step.' });

function validContinuity(context: FinishContext, grant: CellGrant): boolean {
  if (context.continuity.length > 0 && context.priorRevision == null) return false;
  return context.continuity.every(({ cell, epoch, devices, sessions }, index) => {
    if (!STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || epoch < 1 ||
        (cell === grant.cell && epoch !== grant.epoch) || (index > 0 && cell <= context.continuity[index - 1].cell) ||
        !devices.every((device, at) => HASH_PATTERN.test(device) && (at === 0 || device > devices[at - 1]))) return false;
    const writers = new Set(devices);
    for (const session of sessions) {
      if (!HASH_PATTERN.test(session.hash) || !HASH_PATTERN.test(session.writer) || !devices.includes(session.device) ||
          !Number.isFinite(Date.parse(session.notAfter)) || !isStrictBase64url(session.sessionKey, 32) ||
          writerIdOf(session.sessionKey) !== session.writer || writers.has(session.writer)) return false;
      writers.add(session.writer);
    }
    return true;
  });
}

/** A private, immutable copy of the exact unsigned rekey and its selected authorization. */
export function createFinishIntent(context: FinishContext, grant: CellGrant): FinishIntent | undefined {
  if (!STREAM_ID_PATTERN.test(context.project) || !STREAM_ID_PATTERN.test(grant.cell) ||
      ![context.writer, context.predecessor, context.accessEntry, context.accessRoot, context.evidence].every((value) => HASH_PATTERN.test(value)) ||
      (context.priorRevision != null && !HASH_PATTERN.test(context.priorRevision)) || (context.policy !== null && !HASH_PATTERN.test(context.policy)) || !CELL_REKEY_REASONS.includes(context.reason) ||
      !Number.isSafeInteger(context.oldEpoch) || context.oldEpoch < 1 || !Number.isSafeInteger(grant.epoch) ||
      grant.epoch !== context.oldEpoch + 1 || grant.roster !== context.predecessor || grant.pages !== undefined ||
      grant.wraps.length === 0 || grant.wraps.length > MAX_GRANT_WRAPS || grant.wraps.length !== context.recipients.length) return undefined;
  if (!validContinuity(context, grant)) return undefined;
  const recipients = context.recipients;
  if (!recipients.every(({ writer, format }, index) => {
    const wrap = grant.wraps[index];
    const actual = wrapFormatOf(wrap.wrap);
    return HASH_PATTERN.test(writer) && writer === wrap.writer && (index === 0 || writer > recipients[index - 1].writer) &&
      actual.ok && actual.format === format;
  })) return undefined;
  const draft: CellGrant = { cell: grant.cell, epoch: grant.epoch, roster: grant.roster, labelSealed: grant.labelSealed, wraps: grant.wraps.map(({ writer, wrap }) => ({ writer, wrap })) };
  const pages = grantPagePlan(draft);
  if ([...pages.others, pages.single ?? pages.founding([])].some((page) => grantProblem(page) !== undefined)) return undefined;
  const action = canonicalBytes({ purpose: 'near-ai/cell-access/1/hosted-finish', project: context.project, writer: context.writer,
    predecessor: context.predecessor, accessEntry: context.accessEntry, accessRoot: context.accessRoot, priorRevision: context.priorRevision ?? null, oldEpoch: context.oldEpoch,
    reason: context.reason, evidence: context.evidence, policy: context.policy, routing: context.routing ?? null, label: context.label ?? null, recipients, continuity: context.continuity,
    cell: draft.cell, epoch: draft.epoch, grant: sha256Hex(canonicalBytes(draft)) });
  const intent: FinishIntent = { actionBytes: () => Buffer.from(action), unsignedGrant: () => ({ ...draft, wraps: draft.wraps.map((wrap) => ({ ...wrap })) }) };
  const bound = JSON.parse(action.toString('utf8')) as FinishContext;
  intents.set(intent, { context: bound, action, grant: draft });
  return Object.freeze(intent);
}

type FinishRole = 'child' | 'founding' | 'permit';
interface Step { bytes: Buffer; accept(signature: string): boolean }

function finishRekey(context: FinishContext, grant: CellGrant, founding: SignedPayload<CellGrant>) {
  const operation = { cell: grant.cell, epoch: grant.epoch, reason: context.reason, grant: grantHash(founding) };
  const revision = accessRevisionId(context.project, context.priorRevision ?? null, context.predecessor, 'cell.rekey', operation);
  const permits = context.continuity.flatMap(({ cell, epoch, devices, sessions }) => {
    const base = { project: context.project, revision, predecessor: context.predecessor, cell, epoch, authority: context.writer };
    return [...devices.map((device) => ({ ...base, device, writer: device, certificate: null })),
      ...sessions.map(({ device, writer, hash }) => ({ ...base, device, writer, certificate: hash }))];
  });
  const address = ({ cell, device, writer }: AccessPermit): string => `${cell}/${device}/${writer}`;
  permits.sort((a, b) => address(a) < address(b) ? -1 : address(a) === address(b) ? 0 : 1);
  if (new Set(permits.map(address)).size !== permits.length) return undefined;
  return { operation, revision, permits };
}

/** Each adapter step is checked against the frozen draft and the verified prefix. */
export function createFinishGrantScope(intent: FinishIntent, signer: AsyncPayloadSigner, action: string, stillCurrent: () => Promise<boolean>) {
  const draft = intents.get(intent);
  const plan = draft === undefined ? undefined : grantPagePlan(draft.grant);
  const { fingerprint, publicKey, sign } = signer;
  const children: SignedPayload<CellGrant>[] = [];
  const verified: SignedAccessPermit[] = [];
  let rekey: ReturnType<typeof finishRekey>;
  let inFlight = false;
  let entrySigned = false;
  const approved = (): boolean => draft !== undefined && isStrictBase64url(publicKey, 32) && fingerprintOf(Buffer.from(publicKey, 'base64url')) === fingerprint &&
    signer.sign === sign && signer.publicKey === publicKey && signer.fingerprint === fingerprint &&
    writerIdOf(publicKey) === draft.context.writer && signer.canSignAction?.(action, Buffer.from(draft.action)) === true;
  const current = async (): Promise<boolean> => approved() && await stillCurrent() && approved();

  function next(role: FinishRole, index: number): Step | undefined {
    if (plan === undefined || draft === undefined) return undefined;
    if (rekey !== undefined) {
      const permit = rekey.permits[verified.length];
      if (role !== 'permit' || permit === undefined || index !== verified.length) return undefined;
      const bytes = accessPermitBytes(permit);
      return { bytes, accept(signature) {
        if (!verifySignature(bytes, signature, publicKey)) return false;
        verified.push({ permit, signature });
        return true;
      } };
    }
    const child = children.length < plan.others.length;
    if (child ? role !== 'child' || index !== children.length : role !== 'founding' || index !== 0) return undefined;
    const payload = child ? plan.others[index] : plan.single ?? plan.founding(children.map(grantHash));
    const unsigned = { v: 1 as const, purpose: 'staff-cell-grant' as const, signer: { fingerprint, publicKey }, signedAt: REPLICA_SIGNED_AT, payload };
    return { bytes: payloadSigningInput(unsigned), accept(signature) {
      const page = { ...unsigned, sig: signature };
      if (!readGrant(page).ok || (!child && unsigned.payload.pages !== undefined && !readGrantPages(page, children).ok)) return false;
      if (child) children.push(page);
      else {
        const derived = finishRekey(draft.context, draft.grant, page);
        if (derived === undefined) return false;
        rekey = derived;
      }
      return true;
    } };
  }

  function signerFor(role: FinishRole, index: number): AsyncPayloadSigner {
    return { fingerprint, publicKey, async sign(input) {
      if (inFlight) return refusal();
      const step = next(role, index);
      if (step === undefined || !step.bytes.equals(input)) return refusal();
      inFlight = true;
      try {
        if (!await current()) return refusal();
        const result = await sign.call(signer, Buffer.from(step.bytes), { action });
        if (typeof result !== 'string') return result;
        return await current() && step.accept(result) ? result : refusal();
      } finally {
        inFlight = false;
      }
    } };
  }

  return {
    approved,
    permitDrafts: () => rekey?.permits.map((permit) => ({ ...permit })),
    verifiedRekey: () => rekey === undefined || verified.length !== rekey.permits.length ? undefined :
      { operation: { ...rekey.operation }, revision: rekey.revision, permits: verified.map(({ permit, signature }) => ({ permit: { ...permit }, signature })) },
    signerFor,
    signGrants() {
      if (draft === undefined || plan === undefined || rekey !== undefined) return Promise.resolve(refusal());
      return buildGrantPagesAsync({ fingerprint, publicKey, sign(bytes: Buffer) {
        return (children.length < plan.others.length ? signerFor('child', children.length) : signerFor('founding', 0)).sign(bytes);
      } }, draft.grant);
    },
    async signEntry(input: Omit<BuildEntryInput, 'signer'>, accessRoot: string, currentSnapshot: () => Promise<boolean>) {
      if (draft === undefined || rekey === undefined || verified.length !== rekey.permits.length || entrySigned || inFlight) return refusal();
      const { project, predecessor } = draft.context;
      const expected = { ...rekey.operation, accessRevision: rekey.revision, accessRoot, rosterPrev: predecessor };
      if (input.stream !== project || input.body.roster !== predecessor || input.body.kind !== 'cell.rekey' || input.body.actor.kind !== 'person' ||
          !HASH_PATTERN.test(accessRoot) || !canonicalBytes(input.body.data).equals(canonicalBytes(expected))) return refusal();
      inFlight = true;
      const currentEntry = async () => approved() && await currentSnapshot() && approved();
      try {
        if (!await currentEntry()) return refusal();
        const prepared = prepareEntrySigning({ ...input, signer: { fingerprint, publicKey } });
        const result = await sign.call(signer, prepared.signingBytes(), { action });
        if (typeof result !== 'string') return result;
        if (!await currentEntry()) return refusal();
        const built = prepared.finish(result);
        if (built === undefined) return refusal();
        entrySigned = true;
        return { built, matches: prepared.matches };
      } finally {
        inFlight = false;
      }
    }
  };
}

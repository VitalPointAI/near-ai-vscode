import { MAX_GRANT_WRAPS, grantHash, grantProblem, readGrant } from '../../domain/replica/cellKeys';
import type { CellGrant, RekeyReason } from '../../domain/replica/cellKeys';
import { wrapFormatOf } from '../../domain/replica/cellWrapV2';
import { HASH_PATTERN, REPLICA_SIGNED_AT, STREAM_ID_PATTERN, sha256Hex, writerIdOf } from '../../domain/replica/entry';
import { grantPagePlan, readGrantPages } from '../../domain/replica/grantPages';
import type { WrapDevice } from '../../domain/replica/grantPages';
import { CELL_REKEY_REASONS } from '../../domain/replica/kindSchemas/roster';
import type { SessionCertificate } from '../../domain/replica/sessionKeys';
import { canonicalBytes, fingerprintOf, isStrictBase64url } from '../../domain/team/canonical';
import { payloadSigningInput } from '../../domain/team/signedPayload';
import type { AsyncPayloadSigner, SignedPayload, SignRefused } from '../../domain/team/signedPayload';

export interface FinishContext {
  readonly project: string;
  readonly writer: string;
  readonly predecessor: string;
  readonly accessEntry: string;
  readonly accessRoot: string;
  readonly oldEpoch: number;
  readonly reason: RekeyReason;
  readonly evidence: string;
  readonly policy: string | null;
  readonly routing?: string;
  readonly label?: string;
  readonly recipients: readonly (WrapDevice & { format: 1 | 2 })[];
  readonly continuity: readonly { cell: string; devices: readonly string[]; sessions: readonly SessionCertificate[] }[];
}

interface FinishIntent {
  actionBytes(): Buffer;
  unsignedGrant(): CellGrant;
}

interface GrantIntent {
  writer: string;
  action: Buffer;
  grant: CellGrant;
}

const intents = new WeakMap<FinishIntent, GrantIntent>();
const refusal = (): SignRefused => ({ refused: 'This key change needs a current confirmation for the exact part and signing step.' });

/** A private, immutable copy of the exact unsigned rekey and its selected authorization. */
export function createFinishIntent(context: FinishContext, grant: CellGrant): FinishIntent | undefined {
  if (!STREAM_ID_PATTERN.test(context.project) || !STREAM_ID_PATTERN.test(grant.cell) ||
      ![context.writer, context.predecessor, context.accessEntry, context.accessRoot, context.evidence].every((value) => HASH_PATTERN.test(value)) ||
      (context.policy !== null && !HASH_PATTERN.test(context.policy)) || !CELL_REKEY_REASONS.includes(context.reason) ||
      !Number.isSafeInteger(context.oldEpoch) || context.oldEpoch < 1 || !Number.isSafeInteger(grant.epoch) ||
      grant.epoch !== context.oldEpoch + 1 || grant.roster !== context.predecessor || grant.pages !== undefined ||
      grant.wraps.length === 0 || grant.wraps.length > MAX_GRANT_WRAPS || grant.wraps.length !== context.recipients.length) return undefined;
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
    predecessor: context.predecessor, accessEntry: context.accessEntry, accessRoot: context.accessRoot, oldEpoch: context.oldEpoch,
    reason: context.reason, evidence: context.evidence, policy: context.policy, routing: context.routing ?? null, label: context.label ?? null, recipients, continuity: context.continuity,
    cell: draft.cell, epoch: draft.epoch, grant: sha256Hex(canonicalBytes(draft)) });
  const intent: FinishIntent = { actionBytes: () => Buffer.from(action), unsignedGrant: () => ({ ...draft, wraps: draft.wraps.map((wrap) => ({ ...wrap })) }) };
  intents.set(intent, { writer: context.writer, action, grant: draft });
  return Object.freeze(intent);
}

type GrantRole = 'child' | 'founding';

/** Signing adapters cannot choose the next bytes. They must match the draft and verified child signatures. */
export function createFinishGrantScope(intent: FinishIntent, signer: AsyncPayloadSigner, action: string, stillCurrent: () => Promise<boolean>) {
  const draft = intents.get(intent);
  const plan = draft === undefined ? undefined : grantPagePlan(draft.grant);
  const { fingerprint, publicKey, sign } = signer;
  const children: SignedPayload<CellGrant>[] = [];
  let complete = false;
  let inFlight = false;
  const approved = (): boolean => draft !== undefined && isStrictBase64url(publicKey, 32) && fingerprintOf(Buffer.from(publicKey, 'base64url')) === fingerprint && signer.sign === sign && signer.publicKey === publicKey && signer.fingerprint === fingerprint &&
    writerIdOf(publicKey) === draft.writer && signer.canSignAction?.(action, Buffer.from(draft.action)) === true;
  const current = async (): Promise<boolean> => approved() && await stillCurrent() && approved();

  return {
    signerFor(role: GrantRole, index: number): AsyncPayloadSigner {
      return { fingerprint, publicKey, async sign(input) {
        if (plan === undefined || complete || inFlight) return refusal();
        const child = children.length < plan.others.length;
        if (child ? role !== 'child' || index !== children.length : role !== 'founding' || index !== 0) return refusal();
        const payload = child ? plan.others[index] : plan.single ?? plan.founding(children.map(grantHash));
        const unsigned = { v: 1 as const, purpose: 'staff-cell-grant' as const, signer: { fingerprint, publicKey }, signedAt: REPLICA_SIGNED_AT, payload };
        const expected = payloadSigningInput(unsigned);
        if (!expected.equals(input)) return refusal();
        inFlight = true;
        try {
          if (!await current()) return refusal();
          const result = await sign.call(signer, Buffer.from(expected), { action });
          if (typeof result !== 'string') return result;
          if (!await current()) return refusal();
          const page = { ...unsigned, sig: result };
          if (!readGrant(page).ok || (!child && unsigned.payload.pages !== undefined && !readGrantPages(page, children).ok)) return refusal();
          if (child) children.push(page);
          else complete = true;
          return result;
        } finally {
          inFlight = false;
        }
      } };
    }
  };
}

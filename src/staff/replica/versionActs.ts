import { MAX_DEPS } from '../../domain/replica/entry';
import type { Actor } from '../../domain/replica/entry';
import type { FoldResult } from '../../domain/replica/fold';
import { validateVersionsData } from '../../domain/replica/kindSchemas/versions';
import { VERSION_REFUSALS } from '../../domain/replica/versions';
import type { ProductVersions, VersionRefusalReason } from '../../domain/replica/versions';
import { LOCKED_RELEASE_STATES, RELEASE_REFUSALS, TERMINAL_RELEASE_STATES } from '../../domain/staff/release';
import type { GuardVerdict, TradecraftVerdict } from '../../domain/staff/release';
import { ReplicaProjectError } from './replicaProject';
import type { ReplicaProject } from './replicaProject';

export const VERSION_ACT_WORDS = {
  ...RELEASE_REFUSALS,
  ...VERSION_REFUSALS,
  'unsupported-kind': 'This step is unavailable in this version.',
  'hash-mismatch': 'The contents do not match this version.',
  'text-not-in-document': 'The proposed text was never part of this product at the selected point.',
  'pin-above-cell': 'A source product’s label is outside the access allowed for this product.',
  'product-unavailable': 'This product is unavailable for this step.',
  'product-ambiguous': 'More than one shared product has this name. Ask your staff lead to resolve it.',
  'too-many-dependencies': 'This version has too many earlier actions to save this step safely.',
  'cannot-write': 'This step could not be saved. Nothing was written.'
} as const;

type VersionTarget = { product: string; hash: string };
type SubmitInput = VersionTarget & { decisionFor: string };
type VerdictInput = VersionTarget & { reasons: readonly string[] } &
  ({ gate: 'guard'; verdict: GuardVerdict } | { gate: 'tradecraft'; verdict: TradecraftVerdict });

type Refused = { ok: false; reason: keyof typeof VERSION_ACT_WORDS; message: string };
type Written = { ok: true; hash: string; stream: string };

function refuse(reason: Refused['reason']): Refused {
  return { ok: false, reason, message: VERSION_ACT_WORDS[reason] };
}

const products = (fold: FoldResult): ProductVersions[] => (fold.families.versions as ProductVersions[] | undefined) ?? [];

function checkWrite(fold: FoldResult, stream: string, product: string, entry: string): Refused | undefined {
  const output = products(fold).find((item) => item.stream === stream && item.product === product);
  if (output === undefined) return refuse('cannot-write');
  const problem = output.refusals.find((item) => item.entry === entry);
  if (problem !== undefined) return refuse(problem.reason);
  const reduced = fold.refused.find((item) => item.family === 'versions' && item.hash === entry)?.reason;
  if (reduced !== undefined && Object.hasOwn(VERSION_REFUSALS, reduced)) return refuse(reduced as VersionRefusalReason);
  return fold.applied.includes(entry) ? undefined : refuse('cannot-write');
}

/** Signed actions on the shared version record. The same fold judges local and received writes. */
export class VersionActs {
  public constructor(private readonly project: ReplicaProject, private readonly actor: Actor) {}

  public async verdict(input: VerdictInput): Promise<Written | Refused> {
    const data = { product: input.product, hash: input.hash, gate: input.gate, verdict: input.verdict, reasons: input.reasons };
    if (validateVersionsData('version.verdict', data, 'verdict') !== undefined) return refuse('bad-input');
    return this.write('version.verdict', { ...data, reasons: [...data.reasons] });
  }

  public async submit(input: SubmitInput): Promise<Written | Refused> {
    const data = { product: input.product, hash: input.hash, decisionFor: input.decisionFor };
    if (validateVersionsData('version.submit', data, 'submit') !== undefined) return refuse('bad-input');
    return this.write('version.submit', data);
  }

  private async write(kind: 'version.verdict' | 'version.submit', data: VersionTarget & Record<string, unknown>): Promise<Written | Refused> {
    const actor = { ...this.actor };
    const observed = kind === 'version.submit' ? ['version.verdict', 'version.submit'] : ['version.verdict'];
    try {
      const written = await this.project.appendChecked<Refused>(({ fold }) => {
        const candidates = products(fold).filter((item) => item.product === data.product && item.stream !== this.project.projectId);
        if (candidates.length === 0) return refuse('product-unavailable');
        if (candidates.length > 1) return refuse('product-ambiguous');
        const [product] = candidates;
        const version = product.records.find((item) => item.hash === data.hash);
        if (version === undefined) return refuse('stale-version');
        if (kind === 'version.submit' && version.release.state !== 'guard-checked') {
          const { state } = version.release;
          // A fresh local submission must not replace the routing of a decision someone can already make or has made.
          if (TERMINAL_RELEASE_STATES.includes(state)) return refuse('terminal');
          return refuse(LOCKED_RELEASE_STATES.includes(state) ? 'locked' : 'wrong-state');
        }
        const refused = new Set(product.refusals.map((item) => item.entry));
        // Observe the prior actions this step depends on. This writer's stream head already cites its own actions.
        const prior = version.acts.filter((act) => observed.includes(act.kind) && !refused.has(act.entry) && act.writer !== this.project.deviceWriter);
        const deps = [version.entry, ...prior.map((act) => act.entry)];
        if (deps.length > MAX_DEPS) return refuse('too-many-dependencies');
        return {
          kind, data, options: { stream: product.stream, actor, deps },
          check: (preview, hash) => checkWrite(preview, product.stream, product.product, hash)
        };
      });
      if ('refused' in written) return refuse('cannot-write');
      if (!written.ok) return written;
      return { ok: true, hash: written.hash, stream: written.built.entry.header.stream };
    } catch (error) {
      if (error instanceof ReplicaProjectError) return refuse('cannot-write');
      throw error;
    }
  }
}

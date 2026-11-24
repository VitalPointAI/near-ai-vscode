import { recordedDecisionOutcome } from '../../domain/replica/decisions';
import type { DecisionOutcome } from '../../domain/replica/decisions';
import { MAX_DECISIONS_SEEN } from '../../domain/replica/kindSchemas/versions';
import type { ProductVersions, VersionView } from '../../domain/replica/versions';

interface VersionReference {
  product: string;
  hash: string;
  number: number;
}

interface ContestedDecision {
  name: string;
  outcome: DecisionOutcome;
  reasons: string[];
}

export interface ContestedCard extends VersionReference {
  text: string;
  decisions: ContestedDecision[];
  actions: { outcome: 'approve' | 'reject'; label: string }[];
}

export interface ChangesSinceRow extends VersionReference {
  text: string;
  changesSince: number;
  ownerPromptDue: boolean;
}

type DecisionNames = (member: string, roster: string) => string | undefined;

const decisionVerb = {
  approve: 'approved', reject: 'rejected', release: 'released', withdraw: 'withdrew', supersede: 'superseded', decline: 'declined'
} satisfies Record<DecisionOutcome, string>;

const people = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function reference(product: ProductVersions, { hash, number }: VersionView): VersionReference {
  return { product: product.product, hash, number };
}

/** Describe the current conflicting decisions using the names as recorded when each person decided. */
export function contestedCards(products: readonly ProductVersions[], names: DecisionNames): ContestedCard[] {
  return products.flatMap((product) => {
    const records = new Map(product.records.map((record) => [record.hash, record]));
    return product.versions.flatMap((version): ContestedCard[] => {
      const { decision } = version;
      const record = records.get(version.hash);
      if (decision.status !== 'contested' || record === undefined) return [];

      const acts = new Map(record.acts.map((act) => [act.entry, act]));
      const decisions = decision.contested.flatMap((id): ContestedDecision[] => {
        const act = acts.get(id);
        if (act === undefined) return [];
        const outcome = recordedDecisionOutcome(act.kind, act.data.outcome);
        if (outcome === undefined) return [];
        const reasons = act.data.reasons;
        const name = act.actor.kind === 'person' ? (names(act.member, act.roster) ?? 'A decision maker') : 'An agent';
        return [{
          name,
          outcome,
          reasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string')
            : typeof act.data.reason === 'string' ? [act.data.reason] : []
        }];
      });
      // Never present an incomplete conflict or invite a decision on an incomplete record.
      if (decisions.length < 2 || decisions.length !== decision.contested.length) return [];

      const name = `v${version.number}`;
      const description = people.format(decisions.map(({ name: by, outcome }, index) =>
        `${by} ${decisionVerb[outcome]} ${index === 0 ? name : 'it'}`));
      const status = decision.finalBeforeDispute
        ? "A decision previously confirmed by your organization's server is now disputed."
        : decisions.length === 2 ? 'Neither applies.' : 'None applies.';
      const canSettle = version.state === 'awaiting-decision' && decision.pending.length === 0 && decision.held.length === 0
        && decisions.length <= MAX_DECISIONS_SEEN;
      return [{
        ...reference(product, version),
        text: decision.finalBeforeDispute
          ? `Contested: ${description}. ${status} A new decision is needed.`
          : `Contested: ${description} at the same time. ${status} A new decision is needed.`,
        decisions,
        actions: canSettle ? [{ outcome: 'approve', label: `Approve ${name}` }, { outcome: 'reject', label: `Reject ${name}` }] : []
      }];
    });
  });
}

/** A decision without server confirmation can already be effective locally. */
export function pendingConfirmation(products: readonly ProductVersions[]): (VersionReference & { decisions: string[] })[] {
  return products.flatMap((product) => product.versions.flatMap((version) => version.decisionsSinceCheckpoint.length === 0 ? [] : [{
    ...reference(product, version), decisions: [...version.decisionsSinceCheckpoint]
  }]));
}

export function changesSinceRows(products: readonly ProductVersions[]): ChangesSinceRow[] {
  return products.flatMap((product) => product.versions.map((version) => {
    const { changesSince } = version;
    const state = version.state === 'awaiting-decision' ? 'awaiting decision' : version.state;
    return {
      ...reference(product, version),
      text: `v${version.number} ${state}, ${changesSince} ${changesSince === 1 ? 'change' : 'changes'} since`,
      changesSince,
      ownerPromptDue: version.ownerPromptDue && version.state !== 'withdrawn' && version.state !== 'superseded'
    };
  }));
}

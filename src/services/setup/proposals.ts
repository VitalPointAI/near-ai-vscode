import { clearanceKey } from '../../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, parseClearance, type Label } from '../../domain/gate/labels';
import { parsePeopleSection } from '../../domain/org/peopleSection';
import type { ServerKind } from '../../domain/setup/servers';
import type { SetupAuditLog } from '../../gate/setupAuditLog';
import type { PolicyChange, ProposalOutcome } from '../policyEditor';
import type { PolicyEditorPort } from '../policyEditorWiring';
import type { ApplyStep } from './apply';

export type PendingProposal =
  | { readonly id: string; readonly kind: 'clearance'; readonly change: PolicyChange }
  | {
    readonly id: string;
    readonly kind: 'endpoint-approval';
    readonly change: PolicyChange;
    readonly detail: { readonly endpointId: string; readonly serverKind: ServerKind; readonly pin: string };
  };

const PROPOSAL_TEXT: Readonly<Record<ProposalOutcome, string>> = {
  applied: 'You applied this change on the rules page.',
  exported: "You saved this proposal for your organization. It still needs approval.",
  discarded: 'You closed this proposal without applying it.',
  replaced: 'Another proposal replaced this one before it was applied.'
};
const AUDIT_FAILED = 'The rules page finished the proposal, but its decision could not be recorded.';

export function clearanceProposalFor(label: Label, organization: boolean): PolicyChange | undefined {
  if (organization) return undefined;
  const { scale, level } = label;
  return {
    from: 'Get Started',
    target: 'personal',
    reason: `Get Started can raise this project's label only when your clearance covers it. ${CLEARANCE_SELF_ASSERTED_TEXT}`,
    next(current) {
      const parsed = parseClearance({ scale, level, compartments: [], releasability: [] }, current.labels.scales);
      if (!parsed.ok) throw new Error('Your rules do not have this clearance level.');
      const previous = current.people?.clearances ?? [];
      const key = clearanceKey(parsed.value);
      if (previous.some((existing) => clearanceKey(existing) === key)) return current;
      const clearances = [...previous, parsed.value].sort((left, right) => {
        const a = clearanceKey(left);
        const b = clearanceKey(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const people = parsePeopleSection({ ...current.people, v: 1, clearances }, current.labels.scales);
      if (!people.ok) throw new Error('Your rules could not include this clearance. Review the existing clearances first.');
      return { ...current, people: people.value };
    }
  };
}

export function proposalStep(input: {
  readonly port: Pick<PolicyEditorPort, 'propose'>;
  readonly proposal: PendingProposal;
  readonly audit: Pick<SetupAuditLog, 'append'>;
}): ApplyStep {
  const { port, proposal, audit } = input;
  const id = `your-rules:${proposal.id}`;
  return {
    changeId: id,
    alreadyDone: async () => false,
    async run() {
      // The editor owns the proposal while it waits for the person's choice.
      const proposalOutcome = await port.propose(proposal.change);
      if (proposal.kind === 'endpoint-approval') {
        const { endpointId, serverKind, pin } = proposal.detail;
        try {
          const result = await audit.append('setup.discovery.approved-proposal', {
            endpointId, serverKind, pin, proposalId: proposal.id, outcome: proposalOutcome
          });
          if (!result.ok) return { id, outcome: 'failed', proposalOutcome, message: AUDIT_FAILED };
        } catch {
          return { id, outcome: 'failed', proposalOutcome, message: AUDIT_FAILED };
        }
      }
      return { id, outcome: 'proposal-opened', proposalOutcome, message: PROPOSAL_TEXT[proposalOutcome] };
    }
  };
}

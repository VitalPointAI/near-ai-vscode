// Stand-ins for the policy editor port (41-14, D-44), so the gate's commands can be driven without a webview. registerGate takes one through
// RegisterGateOptions.policyEditor. The recording one keeps every call and answers each proposal as told ('discarded' by default); the auto-apply one does
// what a person pressing "Apply to my rules" does: it applies the proposal through the host's own deps and answers 'applied' when the host took it.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import type { PolicyEditorPort } from '../../services/gateCommands';
import type { PolicyChange, PolicyEditorDeps, ProposalOutcome } from '../../services/policyEditor';

export interface FakePolicyEditor extends PolicyEditorPort {
  /** Every deps object register received, in order. */
  readonly registered: PolicyEditorDeps[];
  /** The section each open asked for (undefined for the whole page). */
  readonly opened: Array<string | undefined>;
  readonly proposed: PolicyChange[];
  /** The host's refusal text for each proposal the auto-apply editor could not apply. */
  readonly refusals: string[];
  /** How many registrations were disposed. */
  disposed: number;
  /** The latest deps registered; throws when nothing registered. */
  deps(): PolicyEditorDeps;
}

function fakeEditor(answer: (change: PolicyChange, deps: PolicyEditorDeps, fake: FakePolicyEditor) => Promise<ProposalOutcome>): FakePolicyEditor {
  const fake: FakePolicyEditor = {
    registered: [],
    opened: [],
    proposed: [],
    refusals: [],
    disposed: 0,
    deps(): PolicyEditorDeps {
      const latest = fake.registered.at(-1);
      if (latest === undefined) throw new Error('nothing registered the policy editor');
      return latest;
    },
    register(deps: PolicyEditorDeps) {
      fake.registered.push(deps);
      return { dispose: (): void => { fake.disposed += 1; } };
    },
    open(at?: string): void {
      fake.opened.push(at);
    },
    async propose(change: PolicyChange): Promise<ProposalOutcome> {
      fake.proposed.push(change);
      return answer(change, fake.deps(), fake);
    }
  };
  return fake;
}

/** Records every call and answers each proposal with `outcome` without applying anything. */
export function recordingPolicyEditor(outcome: ProposalOutcome = 'discarded'): FakePolicyEditor {
  return fakeEditor(async () => outcome);
}

/** Applies each proposal to the personal layer through deps.applyPersonal at the shown base, as the page's Apply does. */
export function autoApplyPolicyEditor(): FakePolicyEditor {
  return fakeEditor(async (change, deps, fake) => {
    const state = deps.state();
    if (state === undefined) return 'discarded';
    const answer = await deps.applyPersonal(change.next(state.personal), state.personalHash, change.requiresPersonalAuthority);
    if (answer.ok) return 'applied';
    fake.refusals.push(answer.text);
    return 'discarded';
  });
}

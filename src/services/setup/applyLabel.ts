import { dominates } from '../../domain/gate/dominance';
import { setProjectLabel } from '../../domain/gate/labelMap';
import { raiseOnly, type LabelProposal } from '../../domain/setup/map';
import type { GateHost } from '../../gate/host';
import type { ApplyStep } from './apply';
import { WAITS_SHARED_TEXT } from './projectLayerSink';
import { isSharedProject } from './projectStore';

export const SIGN_LABEL_FILE_TEXT = 'Sign the label file again with Set Label first, then run Get Started again.';
const WAITS_RULES_TEXT = 'Waits for a rules change that covers this label.';
export type LabelHost = Pick<GateHost, 'changeLabels' | 'recordLabelEvent' | 'labelPolicy' | 'labelsFor'>;

export function labelStep(input: {
  readonly host: LabelHost;
  readonly root: string;
  readonly proposal: LabelProposal;
  readonly clock?: () => number;
}): ApplyStep {
  const { host, root, proposal } = input;
  const compare = (current: Parameters<typeof raiseOnly>[0]) => raiseOnly(
    current, { proposed: proposal.proposed, column: 'org', notSure: false, allowedWhileStopped: [] }, host.labelPolicy().scales
  );
  const mayRaise = (label: LabelProposal['proposed']): boolean => {
    const policy = host.labelPolicy();
    return policy.valid && policy.clearances.some((clearance) => dominates(clearance, label, {
      scales: policy.scales, mappings: policy.mappings, now: (input.clock ?? Date.now)()
    }));
  };
  const alreadyKept = Symbol();
  const needsClearance = Symbol();

  return {
    changeId: 'label',
    async alreadyDone() {
      if (await isSharedProject(root)) return false;
      const policy = host.labelPolicy();
      const view = await host.labelsFor(root).view(policy.scales);
      if (!policy.valid || view.state !== 'verified') return false;
      const resolved = view.resolve('', policy.defaultLabel);
      return resolved.origin === 'project' && compare(resolved.mark[0]).outcome !== 'raise';
    },
    async run() {
      if (await isSharedProject(root)) return { id: 'label', outcome: 'waiting', message: WAITS_SHARED_TEXT };
      try {
        const written = await host.changeLabels(root, (map) => {
          const next = compare(map.project);
          // Check against the signed map read under the writer's lock.
          if (next.outcome !== 'raise') throw alreadyKept;
          if (!mayRaise(next.proposed)) throw needsClearance;
          return setProjectLabel(map, next.proposed);
        });
        host.recordLabelEvent(root, {
          event: 'label.set', path: '', label: written.payload.project,
          ...(written.before.project === undefined ? {} : { from: [written.before.project] })
        });
        return { id: 'label', outcome: 'done' };
      } catch (failure) {
        if (failure === alreadyKept) return { id: 'label', outcome: 'already-done' };
        if (failure === needsClearance) return { id: 'label', outcome: 'waiting', message: WAITS_RULES_TEXT };
        return { id: 'label', outcome: 'failed', message: SIGN_LABEL_FILE_TEXT };
      }
    }
  };
}

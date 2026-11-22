// Pure: no I/O, no clock, no vscode, no package.
import { labelKeyRank, labelKeyShownWithMarkings } from '../gate/labelAlgebra';
import { labelKey, scaleOf, type Label, type ScaleTable } from '../gate/labels';
import type { UseTier } from '../gate/models';
import { ROUTING_TIERS, tierForLabel, type RoutingTable } from '../gate/routing';
import { agentWorkDefault, fillSlots, type DataAnswer, type GuideAnswers } from './answers';
import type { LabelProposal as RecordedLabelProposal, StopReason } from './records';
import { KEPT_HIGHER_TEXT } from './words';

export interface LabelInput {
  readonly scales: ScaleTable;
  readonly routing: RoutingTable;
  readonly defaultScale?: string;
}

export interface LabelOutcome {
  readonly proposed: Label;
  readonly stop?: StopReason;
  readonly notSure: boolean;
  readonly column: 'ca' | 'org';
  readonly allowedWhileStopped: readonly Label[];
}

function label(scale: string, level: string): Label {
  return { scale, level, compartments: [], releasability: [], handling: [] };
}

function classifiedLabel(scales: ScaleTable): Label {
  // The committed answer contract groups classified levels. Use the highest known
  // level on an enabled classified scale until the person confirms the marking.
  const ca = ['Top Secret', 'Secret', 'Confidential'].find((level) => labelKeyRank(`ca-classified/${level}`, scales) >= 0);
  if (ca !== undefined) return label('ca-classified', ca);
  const nato = ['Cosmic Top Secret', 'NATO Secret', 'NATO Confidential', 'NATO Restricted'].find((level) => labelKeyRank(`nato/${level}`, scales) >= 0);
  return nato === undefined ? label('ca-classified', 'Top Secret') : label('nato', nato);
}

function lowOrganizationLabel(label: Label): boolean {
  return label.scale === 'org' && (label.level === 'Public' || label.level === 'Internal');
}

function stricterLabel(left: Label, right: Label, input: LabelInput): Label {
  const difference = ROUTING_TIERS.indexOf(tierForLabel(left, input.routing)) - ROUTING_TIERS.indexOf(tierForLabel(right, input.routing));
  if (difference !== 0) return difference > 0 ? left : right;
  // These two scales start at different baselines. An equal routing tier must
  // not turn a Protected marking into ordinary internal work.
  if (left.scale === 'ca-protected' && lowOrganizationLabel(right)) return left;
  if (right.scale === 'ca-protected' && lowOrganizationLabel(left)) return right;
  return labelKeyRank(labelKey(left), input.scales) >= labelKeyRank(labelKey(right), input.scales) ? left : right;
}

export function proposeLabel(answers: GuideAnswers, input: LabelInput): LabelOutcome {
  const hasProtected = scaleOf(input.scales, 'ca-protected') !== undefined;
  const column = hasProtected && (input.defaultScale ?? 'ca-protected') === 'ca-protected' ? 'ca' : 'org';
  const publicLabel = label('org', 'Public');
  const internal = label('org', 'Internal');
  const sensitive = label('org', 'Confidential');
  const restricted = label('org', 'Restricted');
  const protectedA = label('ca-protected', 'Protected A');
  const protectedB = label('ca-protected', 'Protected B');
  const protectedC = label('ca-protected', 'Protected C');
  const classified = classifiedLabel(input.scales);
  const higherPersonal = column === 'ca' ? protectedB : restricted;
  const personal = answers.personalSensitive === 'no' ? (column === 'ca' ? protectedA : sensitive) : higherPersonal;
  const contract = answers.contractLevel === 'classified' ? classified
    : answers.contractLevel === 'protected-a' ? (hasProtected ? protectedA : sensitive)
      : (hasProtected ? protectedB : restricted);
  const labels: Readonly<Record<DataAnswer, Label>> = {
    public: publicLabel, internal, personal, 'protected-a': protectedA, 'protected-b': protectedB,
    'protected-c': protectedC, classified, contract, 'not-sure': higherPersonal,
  };
  const contractSelected = answers.data.includes('contract');
  const notSure = answers.data.length === 0 || answers.data.includes('not-sure');
  const candidates = answers.data.map((answer) => labels[answer]);
  const proposed = candidates.reduce((best: Label | undefined, candidate) =>
    best === undefined ? candidate : stricterLabel(best, candidate, input), undefined) ?? higherPersonal;
  if (answers.data.includes('classified') || (contractSelected && answers.contractLevel === 'classified')) {
    return { proposed: classified, stop: 'classified', column, notSure, allowedWhileStopped: [] };
  }
  if (answers.data.includes('protected-c')) {
    return { proposed: protectedC, stop: 'protected-c', column, notSure, allowedWhileStopped: [] };
  }
  if (contractSelected && answers.contractApproval !== 'yes') {
    return { proposed, stop: 'contract-unapproved', column, notSure, allowedWhileStopped: [publicLabel, internal] };
  }
  return { proposed, column, notSure, allowedWhileStopped: [] };
}

export interface LabelProposal extends RecordedLabelProposal {
  readonly proposed: Label;
  readonly outcome: 'raise' | 'keep-higher' | 'same';
}

export function raiseOnly(existing: Label | undefined, { proposed }: LabelOutcome, scales: ScaleTable): LabelProposal {
  const key = labelKey(proposed);
  if (existing === undefined) return { proposed, label: [key], outcome: 'raise', reason: '' };
  const existingKey = labelKey(existing);
  if (key === existingKey) return { proposed: existing, label: [existingKey], outcome: 'same', reason: '' };
  const oldRank = labelKeyRank(existingKey, scales);
  const newRank = labelKeyRank(key, scales);
  // The guide can move its low organization labels to a standard protected or
  // classified scale. Other cross-scale replacements need a separate decision.
  const toProtectedScale = proposed.scale === 'ca-protected' || proposed.scale === 'ca-classified' || proposed.scale === 'nato';
  if (oldRank >= 0 && newRank >= 0 && (existing.scale === proposed.scale ? newRank > oldRank : lowOrganizationLabel(existing) && toProtectedScale)) {
    return { proposed: { ...existing, scale: proposed.scale, level: proposed.level }, label: [key], outcome: 'raise', reason: '' };
  }
  return {
    proposed: existing, label: [existingKey], outcome: 'keep-higher',
    reason: fillSlots(KEPT_HIGHER_TEXT, { label: labelKeyShownWithMarkings(existing, scales) }),
  };
}

export function useFor(answers: GuideAnswers): UseTier {
  const work = answers.agentWork ?? agentWorkDefault(answers.kindOfWork ?? 'something-else');
  return work === 'answers-only' ? 'T1' : 'T2';
}

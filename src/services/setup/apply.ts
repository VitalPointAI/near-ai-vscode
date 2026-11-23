import { sameGuideAnswers, type ApplyReport, type ApplyStepReport, type ChangeItem, type LabelProposal } from '../../domain/setup/changes';
import { buildGuideRecord, type GuideRecordInput } from '../../domain/setup/guideRecord';
import { parseSetupGuideEntry } from '../../domain/setup/answers';
import type { SetupAuditLog } from '../../gate/setupAuditLog';
import { labelStep, type LabelHost } from './applyLabel';
import { answersStep, projectStep } from './applyProject';
import type { ProjectLayerChange, ProjectLayerSink } from './projectLayerSink';
import { isSharedProject, updateProjectJson } from './projectStore';

export const APPLY_TEXT = Object.freeze({
  checkAgain: 'Nothing was changed. Check which AI services are available and allowed, then try again.',
  failed: 'This change could not be completed. Review your setup and try again.',
  partlyApplied: 'Some changes still need your attention.',
  auditFailed: 'The setup changes could not be recorded in the audit log.',
  referenceFailed: 'The project could not save the setup audit reference.'
});

export interface ApplyStep {
  readonly changeId: string;
  readonly additionalIds?: readonly string[];
  alreadyDone(): Promise<boolean>;
  run(): Promise<ApplyStepReport>;
}

export interface ApplyRunDeps {
  readonly root: string;
  readonly sink: ProjectLayerSink;
  readonly audit: Pick<SetupAuditLog, 'append'>;
  readonly record: Omit<GuideRecordInput, 'changes' | 'nothingChanged'>;
  /** The host checks the selected services with fresh route facts before any mutation. */
  preflight(): Promise<boolean>;
  clock?(): number;
}

export interface ApplyDeps extends ApplyRunDeps {
  readonly labelHost: LabelHost;
  /** A supplied step uses the existing connection flow. */
  readonly connection?: ApplyStep;
  rememberKind?(kind: GuideRecordInput['answers']['kindOfWork'], otherKind?: string): Promise<void>;
}

export interface ApplyContext {
  readonly label: LabelProposal;
  readonly project: ProjectLayerChange;
}

function fixedStep(item: ChangeItem, outcome: ApplyStepReport['outcome']): ApplyStep {
  return {
    changeId: item.id,
    alreadyDone: async () => outcome === 'already-done',
    run: async () => ({ id: item.id, outcome, message: item.text })
  };
}

const AREAS: readonly ChangeItem['area'][] = ['label', 'connection', 'project-rules', 'mode', 'exercise', 'your-rules', 'answers'];
const PROJECT_AREAS = new Set<ChangeItem['area']>(['project-rules', 'mode', 'exercise']);

export function planApply(items: readonly ChangeItem[], context: ApplyContext, deps: ApplyDeps): readonly ApplyStep[] {
  const ordered = [...items].sort((left, right) => AREAS.indexOf(left.area) - AREAS.indexOf(right.area));
  const projectParts = {
    'project-rules': context.project.residency !== undefined || context.project.lock !== undefined,
    mode: context.project.mode !== undefined,
    exercise: context.project.exercise !== undefined
  };
  const project = ordered.filter(({ area, effect }) => effect === 'apply' && Object.hasOwn(projectParts, area) &&
    projectParts[area as keyof typeof projectParts]);
  const connections = ordered.filter((item) => item.effect === 'apply' && item.area === 'connection');
  const steps: ApplyStep[] = [];
  for (const item of ordered) {
    if (item.id === 'answers' && (item.effect === 'apply' || item.effect === 'already')) {
      steps.push(answersStep({
        root: deps.root,
        sink: deps.sink,
        entry: { v: 1, answers: deps.record.answers, chosen: deps.record.choice, pending: [] },
        rememberKind: deps.rememberKind
      }));
    } else if (item.effect === 'kept' || item.effect === 'already') {
      steps.push(fixedStep(item, 'already-done'));
    } else if (item.effect === 'waits') {
      steps.push(fixedStep(item, 'waiting'));
    } else if (item.area === 'label' && item.effect === 'apply') {
      steps.push(labelStep({ host: deps.labelHost, root: deps.root, proposal: context.label, clock: deps.clock }));
    } else if (item.area === 'connection' && item.effect === 'apply') {
      if (!deps.connection) steps.push(fixedStep(item, 'waiting'));
      else if (item === connections[0]) steps.push({ ...deps.connection, changeId: item.id, additionalIds: connections.slice(1).map(({ id }) => id) });
    } else if (PROJECT_AREAS.has(item.area) && item.effect === 'apply') {
      if (!project.includes(item)) { steps.push(fixedStep(item, 'waiting')); continue; }
      if (item === project[0]) {
        const areas = new Set(project.map(({ area }) => area));
        const { mode, exercise, residency, lock } = context.project;
        const change: ProjectLayerChange = {
          ...(areas.has('mode') && mode !== undefined ? { mode } : {}),
          ...(areas.has('exercise') && exercise !== undefined ? { exercise } : {}),
          ...(areas.has('project-rules') && residency !== undefined ? { residency } : {}),
          ...(areas.has('project-rules') && lock !== undefined ? { lock } : {})
        };
        const target = projectStep({ root: deps.root, sink: deps.sink, change, scales: () => deps.labelHost.labelPolicy().scales });
        steps.push({ ...target, changeId: item.id, additionalIds: project.slice(1).map(({ id }) => id) });
      }
    } else {
      steps.push(fixedStep(item, 'waiting'));
    }
  }
  return steps;
}

export interface ApplyResult extends ApplyReport {
  readonly message?: string;
  readonly recordId?: string;
}

async function recordReference(deps: ApplyRunDeps, reports: readonly ApplyStepReport[], recordId: string): Promise<boolean> {
  if (deps.sink.kind === 'shared' || await isSharedProject(deps.root)) return true;
  if (reports.some(({ id, outcome }) => id === 'answers' && (outcome === 'failed' || outcome === 'waiting'))) return true;
  const processed = new Set(reports.map(({ id }) => id));
  const pending = reports.filter(({ outcome }) => outcome === 'failed' || outcome === 'waiting').map(({ id }) => id);
  const result = await updateProjectJson(deps.root, (current) => {
    const guide = parseSetupGuideEntry(current.setupGuide);
    if (!guide || !sameGuideAnswers(guide.answers, deps.record.answers) ||
        guide.chosen.length !== deps.record.choice.length || guide.chosen.some((choice, index) => choice !== deps.record.choice[index])) return current;
    return {
      ...current,
      setupGuide: {
        ...guide, recordId, appliedAt: new Date((deps.clock ?? Date.now)()).toISOString(),
        pending: [...new Set([...guide.pending.filter((id) => !processed.has(id)), ...pending])]
      }
    };
  });
  return result.ok;
}

export async function runApply(steps: readonly ApplyStep[], deps: ApplyRunDeps): Promise<ApplyResult> {
  let ready = false;
  try { ready = await deps.preflight(); } catch { /* A failed check must leave the project untouched. */ }
  if (!ready) return { state: 'partly-applied', steps: [], message: APPLY_TEXT.checkAgain };

  const reports: ApplyStepReport[] = [];
  for (const step of steps) {
    let result: ApplyStepReport;
    try {
      result = await step.alreadyDone()
        ? { id: step.changeId, outcome: 'already-done' }
        : await step.run();
    } catch {
      result = { id: step.changeId, outcome: 'failed', message: APPLY_TEXT.failed };
    }
    for (const id of [step.changeId, ...(step.additionalIds ?? [])]) reports.push({ ...result, id });
  }

  let recordId: string | undefined;
  try {
    const saved = await deps.audit.append('setup.guide.applied', buildGuideRecord({
      ...deps.record,
      changes: reports.map(({ id, outcome }) => ({ id, outcome })),
      nothingChanged: reports.every(({ outcome }) => outcome === 'already-done')
    }));
    if (saved.ok) recordId = saved.id;
  } catch { /* Disk and audit errors are reported without exposing their contents. */ }
  if (!recordId) return { state: 'partly-applied', steps: reports, message: APPLY_TEXT.auditFailed };

  try {
    if (!await recordReference(deps, reports, recordId)) return { state: 'partly-applied', steps: reports, recordId, message: APPLY_TEXT.referenceFailed };
  } catch {
    return { state: 'partly-applied', steps: reports, recordId, message: APPLY_TEXT.referenceFailed };
  }
  return reports.some(({ outcome }) => outcome === 'failed' || outcome === 'waiting')
    ? { state: 'partly-applied', steps: reports, recordId, message: APPLY_TEXT.partlyApplied }
    : { state: 'applied', steps: reports, recordId };
}

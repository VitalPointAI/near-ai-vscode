import { isDeepStrictEqual } from 'node:util';
import type { ScaleTable } from '../../domain/gate/labels';
import { sameGuideAnswers } from '../../domain/setup/changes';
import type { SetupGuideEntry } from '../../domain/setup/answers';
import type { ApplyStepReport } from '../../domain/setup/changes';
import type { ApplyStep } from './apply';
import { WAITS_SHARED_TEXT, type ProjectLayerChange, type ProjectLayerSink, type SinkResult } from './projectLayerSink';
import { isSharedProject, readProjectLayer, readSetupGuide } from './projectStore';

function result(id: string, outcome: SinkResult): ApplyStepReport {
  if (outcome.state === 'written') return { id, outcome: 'done' };
  if (outcome.state === 'waits') return { id, outcome: 'waiting', message: WAITS_SHARED_TEXT };
  return { id, outcome: 'failed', message: outcome.text };
}

export function projectStep(input: {
  readonly root: string;
  readonly sink: ProjectLayerSink;
  readonly change: ProjectLayerChange;
  readonly scales: () => ScaleTable;
}): ApplyStep {
  const { root, sink, change } = input;
  return {
    changeId: 'project-rules',
    async alreadyDone() {
      if (sink.kind === 'shared' || await isSharedProject(root)) return false;
      const current = readProjectLayer(root, input.scales());
      if (current.state !== 'valid') return false;
      const { layer } = current;
      return (change.mode === undefined || layer.mode === change.mode)
        && (change.exercise === undefined || (change.exercise === null ? layer.exercise === undefined : layer.exercise?.reason === change.exercise.reason))
        && (change.residency === undefined || isDeepStrictEqual(change.residency, layer.residency))
        && (change.lock === undefined || change.lock.every((answer) => layer.locked?.[answer] === true));
    },
    async run() { return result('project-rules', await sink.write(change)); }
  };
}

export function answersStep(input: {
  readonly root: string;
  readonly sink: ProjectLayerSink;
  readonly entry: SetupGuideEntry;
  readonly rememberKind?: (kind: SetupGuideEntry['answers']['kindOfWork'], otherKind?: string) => Promise<void>;
}): ApplyStep {
  const { root, sink, entry } = input;
  return {
    changeId: 'answers',
    async alreadyDone() {
      if (sink.kind === 'shared' || await isSharedProject(root)) return false;
      const current = readSetupGuide(root);
      return current !== undefined && sameGuideAnswers(current.answers, entry.answers) && isDeepStrictEqual(current.chosen, entry.chosen);
    },
    async run() {
      if (sink.kind === 'shared' || await isSharedProject(root)) return { id: 'answers', outcome: 'waiting', message: WAITS_SHARED_TEXT };
      // Remembering an answer is idempotent and runs before the durable guide write so a failure remains retryable.
      await input.rememberKind?.(entry.answers.kindOfWork, entry.answers.otherKind);
      const previous = readSetupGuide(root);
      return result('answers', await sink.write({ setupGuide: { ...entry, pending: previous?.pending ?? [] } }));
    }
  };
}

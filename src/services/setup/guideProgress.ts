import { checkKeys, isRecord } from '../../domain/gate/shape';
import { cleanFreeText, MAX_CHOICE_REASON_CHARS, parseGuideAnswers, type GuideAnswers } from '../../domain/setup/answers';
import { QUESTION_SCREENS, type QuestionScreen } from '../../domain/setup/guideMessages';
import { parseOptionId } from '../../domain/setup/ids';
import { questionAnswered, questionOrder, startSession, type GuideSession, type StartSessionInput } from '../../domain/setup/session';

const resumableScreens = [...QUESTION_SCREENS, 'checking', 'options', 'stopped', 'check-answers'] as const;

interface GuideProgress {
  readonly v: 1;
  readonly answers: GuideAnswers;
  readonly screen: (typeof resumableScreens)[number];
  readonly chosen?: string;
  readonly choiceReason?: string;
}

export interface GuideProgressStore {
  read(): unknown;
  write(progress: GuideProgress | undefined): PromiseLike<void>;
}

function parseProgress(value: unknown): GuideProgress | undefined {
  if (!isRecord(value) || checkKeys(value, '', ['v', 'answers', 'screen'], ['chosen', 'choiceReason']) || value.v !== 1) return undefined;
  const screen = resumableScreens.find((candidate) => candidate === value.screen);
  const answers = parseGuideAnswers(value.answers);
  if (!screen || !answers) return undefined;
  const chosen = typeof value.chosen === 'string' && parseOptionId(value.chosen) ? value.chosen : undefined;
  const choiceReason = chosen && typeof value.choiceReason === 'string'
    ? cleanFreeText(value.choiceReason, MAX_CHOICE_REASON_CHARS) : undefined;
  return { v: 1, answers, screen, chosen, choiceReason };
}

export function progressOf({ answers, screen, chosen, choiceReason }: GuideSession): GuideProgress | undefined {
  return parseProgress({ v: 1, answers, screen, chosen, choiceReason });
}

export function restoreProgress(value: unknown, input: StartSessionInput): GuideSession | undefined {
  const progress = parseProgress(value);
  if (!progress) return undefined;
  const session = startSession({ ...input, prefill: progress.answers });
  const questions = questionOrder(session.answers, session.fixed, session.locked)
    .filter((screen): screen is QuestionScreen => screen !== 'checking');
  const requested = questions.findIndex((screen) => screen === progress.screen);
  const incomplete = questions.findIndex((screen) => !questionAnswered(session.answers, screen));
  const next = requested < 0 || (incomplete >= 0 && incomplete < requested) ? incomplete : requested;
  if (next >= 0) return Object.freeze({ ...session, state: 'answering', screen: questions[next] });
  // Only the selection is a hint. The resumed check rebuilds the route and review from current facts.
  return Object.freeze({ ...session, state: 'paused', screen: 'checking', resumeState: 'checking',
    chosen: progress.chosen, choiceReason: progress.choiceReason });
}

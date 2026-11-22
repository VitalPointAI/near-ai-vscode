import {
  agentWorkDefault, cleanFreeText, MAX_CHOICE_REASON_CHARS,
  type GuideAnswers, type GuidePrefill, type SetupGuideEntry,
} from './answers';
import { choiceNeedsReason } from './cards';
import { remainingAfter, rerunDiff, sameGuideAnswers, type ApplyReport, type ChangeItem } from './changes';
import type { GuideAnswerEvent, GuideInbound, QuestionScreen } from './guideMessages';
import type { GuideScreenId } from './ids';
import type { Recommendation } from './recommend';
import { CHECKING_CEILING_MS, isChoosable, nextViability, type ViabilityResult } from './viability';

export const GUIDE_SESSION_STATES = Object.freeze([
  'not-started', 'answering', 'checking', 'choosing', 'reviewing', 'applying',
  'applied', 'partly-applied', 'paused', 'abandoned',
] as const);
export type GuideSessionState = (typeof GUIDE_SESSION_STATES)[number];
export type FixedAnswerKey = 'kind-of-work' | 'data' | 'data-personal' | 'data-contract' | 'canada' | 'agent-work';

export interface GuideSession {
  readonly state: GuideSessionState;
  readonly screen: GuideScreenId;
  readonly answers: GuideAnswers;
  readonly fixed: readonly FixedAnswerKey[];
  readonly locked: Readonly<{ canada?: boolean }>;
  readonly results: readonly ViabilityResult[];
  readonly stillChecking: readonly string[];
  readonly recommendation?: Recommendation;
  readonly chosen?: string;
  readonly choiceReason?: string;
  readonly changes: readonly ChangeItem[];
  readonly report?: ApplyReport;
  readonly previous?: SetupGuideEntry;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly checkingStartedAt?: number;
  readonly changesRequested?: boolean;
  readonly ceilingReached?: boolean;
  readonly recommendationRequested?: boolean;
  readonly checkId?: number;
  readonly resumeState?: GuideSessionState;
  readonly retryIds?: readonly string[];
  readonly nothingChanged?: boolean;
}

type PageEvent = Extract<GuideInbound, { type:
  'answer' | 'next' | 'back' | 'continue-without-slow' | 'choose' | 'reason' |
  'review' | 'change' | 'apply' | 'pause' | 'abandon'
}>;

export type GuideEvent = PageEvent
  | { readonly type: 'start' | 'resume' | 'restart' }
  | { readonly type: 'ceiling'; readonly checkId?: number }
  | { readonly type: 'viability-progress'; readonly result: ViabilityResult; readonly checkId?: number }
  | { readonly type: 'viability-done'; readonly results: readonly ViabilityResult[]; readonly checkId?: number }
  | { readonly type: 'recommendation'; readonly recommendation: Recommendation; readonly checkId?: number }
  | { readonly type: 'changes-ready'; readonly changes: readonly ChangeItem[] }
  | { readonly type: 'apply-done'; readonly report: ApplyReport; readonly previous?: SetupGuideEntry };

export type GuideEffect =
  | { readonly type: 'compute-changes' | 'apply' | 'save-progress' | 'land' }
  | { readonly type: 'run-viability' | 'compute-recommendation'; readonly checkId: number }
  | { readonly type: 'start-ceiling'; readonly ms: number; readonly checkId: number }
  | { readonly type: 'record-abandoned'; readonly screen: GuideScreenId };

export interface StartSessionInput {
  readonly now: number;
  readonly answers?: Partial<GuideAnswers>;
  readonly prefill?: Omit<GuidePrefill, 'fixed'> & Partial<GuideAnswers> & { readonly fixed?: readonly FixedAnswerKey[] };
  readonly fixed?: readonly FixedAnswerKey[];
  readonly previous?: SetupGuideEntry;
  readonly locked?: GuideSession['locked'];
  readonly started?: boolean;
}

export function questionOrder(
  answers: GuideAnswers, fixed: readonly FixedAnswerKey[] = [], locked: GuideSession['locked'] = {},
): readonly (QuestionScreen | 'checking')[] {
  const questions: QuestionScreen[] = ['kind-of-work', 'data'];
  if (answers.data.includes('personal')) questions.push('data-personal');
  if (answers.data.includes('contract')) questions.push('data-contract');
  if (!locked.canada) questions.push('canada');
  return [...questions.filter((screen) => !fixed.includes(screen)), 'checking'];
}

function frozenAnswers(answers: GuideAnswers): GuideAnswers {
  return Object.freeze({ ...answers, data: Object.freeze([...answers.data]) });
}

export function startSession(input: StartSessionInput): GuideSession {
  const { prefill, previous, now } = input;
  const {
    kindOfWork, otherKind, staffSection, data, personalSensitive, contractLevel,
    contractApproval, canada, agentWork,
  } = { data: [], ...input.answers, ...previous?.answers, ...prefill };
  const fixed = Object.freeze([...(input.fixed ?? prefill?.fixed ?? [])]);
  const locked = Object.freeze({ ...input.locked });
  const answers = frozenAnswers({
    kindOfWork, otherKind, staffSection: prefill?.section ?? staffSection, data, personalSensitive, contractLevel,
    contractApproval, canada: locked.canada ? 'yes' : canada,
    agentWork: agentWork ?? (kindOfWork && agentWorkDefault(kindOfWork)),
  });
  const screen = questionOrder(answers, fixed, locked)[0];
  return Object.freeze({
    state: input.started === false || screen === 'checking' ? 'not-started' : 'answering',
    screen, answers, fixed, locked, results: Object.freeze([]), stillChecking: Object.freeze([]),
    changes: Object.freeze([]), previous, startedAt: now, updatedAt: now,
  });
}

export function stepCount(session: GuideSession): { readonly step: number; readonly total: number } {
  const order = questionOrder(session.answers, session.fixed, session.locked);
  const total = order.length - 1;
  const index = order.indexOf(session.screen as QuestionScreen);
  return { step: index < 0 ? total : Math.min(index + 1, total), total };
}

const ANSWER_SCREEN: Readonly<Record<GuideAnswerEvent['key'], QuestionScreen | 'check-answers'>> = {
  kindOfWork: 'kind-of-work', otherKind: 'kind-of-work', staffSection: 'kind-of-work',
  data: 'data', personalSensitive: 'data-personal', contractLevel: 'data-contract',
  contractApproval: 'data-contract', canada: 'canada', agentWork: 'check-answers',
};

export function questionAnswered(answers: GuideAnswers, screen: QuestionScreen): boolean {
  switch (screen) {
    case 'kind-of-work': return answers.kindOfWork !== undefined;
    case 'data': return answers.data.length > 0;
    case 'data-personal': return answers.personalSensitive !== undefined;
    case 'data-contract': return answers.contractLevel !== undefined && answers.contractApproval !== undefined;
    case 'canada': return answers.canada !== undefined;
  }
}

function setAnswer(answers: GuideAnswers, event: GuideAnswerEvent): GuideAnswers {
  if (event.key === 'kindOfWork') {
    if (answers.kindOfWork === event.value) return answers;
    return frozenAnswers({
      ...answers, kindOfWork: event.value, agentWork: agentWorkDefault(event.value),
      staffSection: event.value === 'staff' ? answers.staffSection : undefined,
      otherKind: event.value === 'something-else' ? answers.otherKind : undefined,
    });
  }
  if (event.key === 'data') {
    return frozenAnswers({
      ...answers, data: event.value,
      personalSensitive: event.value.includes('personal') ? answers.personalSensitive : undefined,
      contractLevel: event.value.includes('contract') ? answers.contractLevel : undefined,
      contractApproval: event.value.includes('contract') ? answers.contractApproval : undefined,
    });
  }
  return frozenAnswers({ ...answers, [event.key]: event.value });
}

interface Transition {
  readonly session: GuideSession;
  readonly effects: readonly GuideEffect[];
}

const CAN_INTERRUPT: readonly GuideSessionState[] = ['not-started', 'answering', 'checking', 'choosing', 'reviewing'];

function choiceIsCurrent(session: GuideSession, id: string, now: number): boolean {
  if (session.recommendation?.state === 'stopped') return false;
  const option = session.recommendation?.options.find(({ optionId }) => optionId === id);
  const result = session.results.find(({ optionId }) => optionId === id);
  return (option?.outcome === 'available' || option?.outcome === 'recommended') &&
    option.decision?.allowed !== false && result !== undefined && isChoosable(result, now);
}

export function nextSession(session: GuideSession, event: GuideEvent, now: number): Transition {
  const unchanged = { session, effects: [] };
  const update = (patch: Partial<GuideSession>, ...effects: GuideEffect[]): Transition => ({
    session: Object.freeze({ ...session, ...patch, updatedAt: now }), effects,
  });
  const check = (answers = session.answers, retryIds?: readonly string[]): Transition => {
    const checkId = (session.checkId ?? 0) + 1;
    return update({
      state: 'checking', screen: 'checking', answers, checkingStartedAt: now, checkId, results: Object.freeze([]),
      ceilingReached: false, recommendationRequested: false, stillChecking: Object.freeze([]),
      recommendation: undefined, chosen: undefined, choiceReason: undefined,
      changes: Object.freeze([]), changesRequested: false, report: undefined, nothingChanged: false, retryIds, resumeState: undefined,
    }, { type: 'run-viability', checkId }, { type: 'start-ceiling', ms: CHECKING_CEILING_MS, checkId });
  };
  const order = questionOrder(session.answers, session.fixed, session.locked);
  const questions = order.filter((screen): screen is QuestionScreen => screen !== 'checking');
  const lastQuestion = questions.at(-1);
  const showChanges = (changes: readonly ChangeItem[]): Transition => {
    const pending = session.retryIds ? new Set(session.retryIds) : undefined;
    const eligible = pending ? changes.filter(({ id }) => pending.has(id)) : changes;
    const compared = rerunDiff(session.previous, eligible);
    // The reducer has both sets of answers, even when a host supplies only current settings to changeList.
    const answers = eligible.find(({ id }) => id === 'answers');
    const answersDiffer = session.previous && !sameGuideAnswers(session.previous.answers, session.answers);
    const items = answers && answersDiffer && !compared.includes(answers) ? [...compared, answers] : compared;
    return update({
      state: 'reviewing', screen: 'check-answers', changes: Object.freeze([...items]), changesRequested: false,
      nothingChanged: !items.some(({ effect }) => effect === 'apply' || effect === 'proposal' || effect === 'waits'),
    });
  };
  if ('checkId' in event && event.checkId !== undefined && event.checkId !== session.checkId) return unchanged;
  if (event.type === 'pause' && CAN_INTERRUPT.includes(session.state)) {
    return update({ state: 'paused', resumeState: session.state, changesRequested: false }, { type: 'save-progress' });
  }
  if (event.type === 'abandon' && (CAN_INTERRUPT.includes(session.state) || session.state === 'paused')) {
    return update({ state: 'abandoned', resumeState: undefined }, { type: 'record-abandoned', screen: session.screen });
  }
  if (session.state === 'paused' && event.type === 'resume' && session.resumeState) {
    if (session.resumeState === 'checking') return check(session.answers, session.retryIds);
    if (session.resumeState === 'reviewing' && session.retryIds) {
      return update({ state: 'reviewing', resumeState: undefined, changesRequested: true }, { type: 'compute-changes' });
    }
    return update({ state: session.resumeState, resumeState: undefined });
  }
  if (session.state === 'not-started' && event.type === 'start') {
    return order[0] === 'checking' ? check() : update({ state: 'answering', screen: order[0] });
  }
  switch (session.state) {
    case 'answering': {
      const screen = session.screen as QuestionScreen;
      const index = order.indexOf(screen);
      if (index < 0) return unchanged;
      if (event.type === 'answer' && ANSWER_SCREEN[event.key] === screen) {
        if (event.key === 'staffSection' && session.answers.kindOfWork !== 'staff') return unchanged;
        if (event.key === 'otherKind' && session.answers.kindOfWork !== 'something-else') return unchanged;
        return update({ answers: setAnswer(session.answers, event) });
      }
      if (event.type === 'back' && index > 0) return update({ screen: order[index - 1] });
      if (event.type === 'next' && questionAnswered(session.answers, screen)) {
        const next = order[index + 1];
        return next === 'checking' ? check() : update({ screen: next });
      }
      break;
    }
    case 'checking':
      if (event.type === 'back' && lastQuestion) return update({ state: 'answering', screen: lastQuestion });
      if (event.type === 'viability-progress' && !session.ceilingReached && !session.recommendationRequested) {
        const results = session.results.filter(({ optionId }) => optionId !== event.result.optionId);
        return update({ results: Object.freeze([...results, event.result]) });
      }
      if (event.type === 'ceiling' && !session.ceilingReached && !session.recommendationRequested &&
          now - (session.checkingStartedAt ?? session.updatedAt) >= CHECKING_CEILING_MS) {
        const unfinished = session.results.filter(({ state }) => state === 'checking' || state === 'unknown');
        return update({
          ceilingReached: true, stillChecking: Object.freeze(unfinished.map(({ optionId }) => optionId)),
          results: Object.freeze(session.results.map((result) => nextViability(result, { type: 'ceiling', at: now }))),
        });
      }
      if (event.type === 'continue-without-slow' && session.ceilingReached && !session.recommendationRequested) {
        const results = session.results.filter(({ state }) => state !== 'checking' && state !== 'unknown');
        return update({ results: Object.freeze(results), recommendationRequested: true },
          { type: 'compute-recommendation', checkId: session.checkId ?? 0 });
      }
      if (event.type === 'viability-done' && !session.ceilingReached && !session.recommendationRequested) {
        return update({ results: Object.freeze([...event.results]), recommendationRequested: true },
          { type: 'compute-recommendation', checkId: session.checkId ?? 0 });
      }
      if (event.type === 'recommendation' && session.recommendationRequested) {
        return update({ state: 'choosing', screen: event.recommendation.state === 'stopped' ? 'stopped' : 'options',
          recommendation: event.recommendation });
      }
      break;
    case 'choosing':
      if (event.type === 'back') {
        return lastQuestion ? update({ state: 'answering', screen: lastQuestion, changesRequested: false }) : check();
      }
      if (event.type === 'choose' && !session.changesRequested && choiceIsCurrent(session, event.optionId, now)) {
        return session.chosen === event.optionId ? unchanged : update({ chosen: event.optionId, choiceReason: undefined });
      }
      if (event.type === 'reason' && !session.changesRequested && choiceNeedsReason(session.chosen, session.recommendation?.recommendedId)) {
        return update({ choiceReason: cleanFreeText(event.text, MAX_CHOICE_REASON_CHARS).trim() });
      }
      if ((event.type === 'review' || event.type === 'next' && session.screen === 'stopped') && !session.changesRequested &&
        (session.chosen !== undefined || session.recommendation?.state === 'stopped') &&
        (!choiceNeedsReason(session.chosen, session.recommendation?.recommendedId) || session.choiceReason)) {
        if (session.chosen && !choiceIsCurrent(session, session.chosen, now)) return check(session.answers, session.retryIds);
        return update({ changesRequested: true }, { type: 'compute-changes' });
      }
      if (event.type === 'changes-ready' && session.changesRequested) {
        const changes = session.screen === 'stopped'
          ? event.changes.filter((item) => item.area === 'label' || item.id === 'your-rules:clearance')
          : event.changes;
        return showChanges(changes);
      }
      break;
    case 'reviewing':
      if (event.type === 'change' && questions.includes(event.screen)) {
        return update({ state: 'answering', screen: event.screen, changesRequested: false });
      }
      if (event.type === 'answer' && event.key === 'agentWork' && !session.fixed.includes('agent-work') &&
          session.recommendation?.state !== 'stopped' && event.value !== session.answers.agentWork) {
        return check(setAnswer(session.answers, event));
      }
      if (event.type === 'back') {
        return update({ state: 'choosing', screen: session.recommendation?.state === 'stopped' ? 'stopped' : 'options',
          retryIds: undefined, changesRequested: false });
      }
      if (event.type === 'changes-ready' && session.changesRequested && session.retryIds) {
        return showChanges(event.changes);
      }
      if (event.type === 'apply' && !session.changesRequested &&
          (!session.changes.some(({ group, effect }) => group === 'removed' && effect === 'apply') || event.confirmRemoval)) {
        if (session.chosen && !choiceIsCurrent(session, session.chosen, now)) return check(session.answers, session.retryIds);
        return update({ state: 'applying', screen: 'applying' }, { type: 'apply' });
      }
      break;
    case 'applying':
      if (event.type === 'apply-done') {
        const { report } = event;
        const previous = event.previous ?? (report.state === 'applied'
          ? { ...session.previous, v: 1 as const, answers: session.answers, chosen: session.chosen ? [session.chosen] : [], pending: [] }
          : session.previous);
        return report.state === 'applied'
          ? update({ state: 'applied', screen: 'done', report, previous }, { type: 'land' })
          : update({ state: 'partly-applied', screen: 'done', report, previous });
      }
      break;
    case 'partly-applied':
      if (event.type === 'restart' && session.report) {
        const changes = remainingAfter(session.report, session.changes);
        return update({
          state: 'reviewing', screen: 'check-answers', changes: Object.freeze(changes),
          retryIds: Object.freeze(changes.map(({ id }) => id)), changesRequested: true,
          nothingChanged: changes.length === 0,
        }, { type: 'compute-changes' });
      }
      break;
    case 'applied':
      if (event.type === 'restart') {
        if (order[0] === 'checking') return check(session.previous?.answers);
        const next = startSession({ now, previous: session.previous, answers: session.answers, fixed: session.fixed, locked: session.locked });
        return { session: Object.freeze({ ...next, checkId: session.checkId }), effects: [] };
      }
      break;
  }
  return unchanged;
}

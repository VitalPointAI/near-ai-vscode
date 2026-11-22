import type { PolicyContact } from '../gate/sections';
import { fillSlots, KIND_OF_WORK_ANSWERS, MAX_OTHER_KIND_CHARS, type KindOfWorkAnswer } from './answers';
import { choiceNeedsReason, type OptionCard } from './cards';
import { CHANGE_TEXT, type ApplyStepReport, type ChangeItem } from './changes';
import type { GuideAnswerEvent, QuestionScreen } from './guideMessages';
import type { Landing } from './landing';
import { MODE_SET_BY_ORGANIZATION_TEXT, SET_BY_PROJECT_TEXT, type ModeRow } from './modes';
import { GENERIC_CONTACT_TEXT, type GuidePolicy } from './policy';
import type { ServerKind } from './servers';
import { questionAnswered, questionOrder, stepCount, type GuideSession } from './session';
import { APPROVED_DEVICE_NOTE_TEXT, OPTION_NAME_TEXT, QUESTION_TEXT, STARTING_RULES_TEXT } from './words';
import { parseOptionId } from './ids';
import { STILL_CHECKING_TEXT } from './viability';

export interface FoundServerRow {
  readonly id: string;
  readonly name: string;
  readonly kind?: ServerKind;
  readonly version?: string;
  readonly host: string;
  readonly port: number;
  readonly state: 'found' | 'no-tls' | 'unknown-server' | 'proposed';
  readonly action: 'approve' | 'ask' | 'none';
}

export interface ScanOffer {
  readonly offered: boolean;
  readonly reasonOff?: string;
  readonly confirmText?: string;
  readonly ranges: readonly string[];
  readonly running: boolean;
  readonly done?: number;
  readonly total?: number;
}

export interface GuideDiscoveryPort {
  rows(): readonly FoundServerRow[];
  scanOffer(): ScanOffer;
  refresh(signal: AbortSignal): Promise<void>;
  startScan(ranges: readonly string[]): Promise<void>;
  stopScan(): void;
  approve(rowId: string): Promise<'opened' | 'not-allowed' | 'failed'>;
  onDidChange(listener: () => void): { dispose(): void };
}

export const GET_STARTED_PAGE = {
  viewType: 'nearAiGetStarted',
  title: 'Get Started',
  folder: 'getStarted',
  script: 'getStarted.js',
  scripts: ['getStartedScreens.js'],
  style: 'getStarted.css',
  probe: 'get-started',
} as const;

export const GET_STARTED_BODY = `<main id="guide">
  <ol id="stepper"></ol>
  <h1 id="heading" tabindex="-1"></h1>
  <div id="content"></div>
  <p id="who-to-ask"></p>
  <div id="live" aria-live="polite" class="visually-hidden"></div>
  <footer id="actions"></footer>
</main>`;

export interface ScreenInputs {
  readonly cards: readonly OptionCard[];
  readonly candidates: readonly FoundServerRow[];
  readonly scan: ScanOffer;
  readonly checkedOn: string;
  readonly contacts: readonly PolicyContact[];
  readonly startingRules: boolean;
  readonly modeRow?: ModeRow;
  readonly landing?: Landing;
  readonly approvedDevice?: string;
  readonly policy?: GuidePolicy;
  readonly kindsOfWork?: readonly KindOfWorkAnswer[];
  readonly fixedKindSource?: string;
}

export const SCREEN_TEXT = Object.freeze({
  step: 'Step {n} of {m}: {question}',
  questions: {
    'kind-of-work': 'Kind of work', data: 'Information', 'data-personal': 'Personal information',
    'data-contract': 'Contract requirements', canada: 'Work in Canada',
  },
  checkedOn: 'Checked on: {machine}',
  whoToAsk: 'Who to ask: {contact}',
  completed: 'Completed:',
  next: 'Continue',
  back: 'Back',
  pause: 'Save and finish later',
  apply: 'Apply these settings',
  options: 'Recommended for this project',
  why: 'Why?',
  notAvailable: 'Not available here',
  checking: 'Checking what works here',
  checked: 'Checked {n} of {m}',
  check: 'Check your answers and what will change',
  groups: { added: 'Added', changed: 'Changed', removed: 'Removed' },
  change: 'Change',
  changeAnswer: 'Change the answer to: {question}',
  otherKind: 'Describe your kind of work',
  staffSection: 'Choose your section',
  continueWithoutSlow: 'Continue without them',
  review: 'Check your answers',
  reasonPrompt: 'Why did you choose this option?',
  cardLabels: {
    where: 'Where your text goes', who: 'Who could see it', proven: 'What is proven',
    notProven: 'What is not proven', cost: 'Cost', speed: 'Speed',
  },
  foundHeading: 'Found on your network, not approved',
  askApproval: 'Ask {contact} to approve it.',
  foundStates: { found: 'Found', 'no-tls': 'This server needs a secure connection.',
    'unknown-server': 'The server did not identify itself.', proposed: 'Approval requested' },
  approve: 'Approve',
  scan: 'Check the network for servers',
  scanNow: 'Scan now',
  scanStop: 'Stop',
  scanProgress: 'Checked {n} of {m} addresses',
  nothingChanged: 'No settings will change. You can still save a record of this check.',
  confirmRemoval: 'Confirm the connections listed under Removed can stop working.',
  lowerLabel: 'Lower Label',
  stopped: 'Check with your organization',
  applying: 'Applying your settings',
  done: 'Setup complete',
  partial: 'Some settings still need attention',
  finished: 'Done',
  unfinished: 'Still to do',
  retry: 'Try the remaining changes',
  changeAnswers: 'Change setup answers',
  paused: 'Setup paused',
  abandoned: 'Setup ended',
  fix: 'Check your organization’s rules',
});

interface Step {
  readonly screen: QuestionScreen;
  readonly text: string;
  readonly state: 'completed' | 'current' | 'upcoming';
}

interface ScreenBase {
  readonly heading: string;
  readonly whoToAsk: string;
  readonly steps: readonly Step[];
  readonly completedText: string;
  readonly backText?: string;
  readonly pauseText?: string;
  readonly startingRules?: string;
}

interface Choice { readonly value: string; readonly text: string }

interface QuestionField {
  readonly key: GuideAnswerEvent['key'];
  readonly heading?: string;
  readonly kind: 'radio' | 'checkbox' | 'text';
  readonly choices: readonly Choice[];
  readonly selected: readonly string[];
  readonly maxLength?: number;
}

interface OptionsModel {
  readonly kind: 'options';
  readonly recommended: readonly OptionCard[];
  readonly available: readonly OptionCard[];
  readonly ruledOut: readonly OptionCard[];
  readonly notAvailable: readonly OptionCard[];
  readonly notAvailableText: string;
  readonly reason?: string;
  readonly whyText: string;
  readonly chosen?: string;
  readonly choiceReason?: string;
  readonly needsReason: boolean;
  readonly checkedOn: string;
  readonly candidates: readonly (FoundServerRow & { readonly actionText?: string; readonly stateText: string })[];
  readonly candidatesHeading: string;
  readonly scan: ScanOffer & { readonly label: string; readonly confirmLabel: string; readonly stopLabel: string; readonly progress?: string };
  readonly cardLabels: typeof SCREEN_TEXT.cardLabels;
  readonly reviewText: string;
  readonly canReview: boolean;
  readonly reasonPrompt?: string;
}

interface AnswerRow {
  readonly key: GuideAnswerEvent['key'];
  readonly label: string;
  readonly value: readonly string[];
  readonly screen?: QuestionScreen;
  readonly source?: string;
  readonly changeText?: string;
  readonly changeLabel?: string;
}

interface CheckModel {
  readonly kind: 'check';
  readonly modeRow?: ModeRow;
  readonly changes: readonly ChangeItem[];
  readonly groups: readonly { readonly title: string; readonly items: readonly ChangeItem[] }[];
  readonly applyText: string;
  readonly answers: readonly AnswerRow[];
  readonly agentWork?: QuestionField;
  readonly nothingChangedText?: string;
  readonly lowerLabelText?: string;
  readonly confirmRemovalText?: string;
  readonly clearanceText?: string;
  readonly canApply: boolean;
}

interface DoneRow { readonly id: string; readonly text: string; readonly message?: string }

export type GuideScreenModel = ScreenBase & (
  | { readonly kind: 'question'; readonly screen: QuestionScreen; readonly fields: readonly QuestionField[];
      readonly choices: readonly Choice[]; readonly nextText: string; readonly canContinue: boolean }
  | { readonly kind: 'checking'; readonly checkedOn: string; readonly progress: string;
      readonly slow: readonly string[]; readonly continueText?: string }
  | OptionsModel
  | CheckModel
  | { readonly kind: 'stopped'; readonly sentence: string; readonly approvedDevice?: string; readonly nextText: string }
  | { readonly kind: 'applying' }
  | { readonly kind: 'done'; readonly landing?: Landing; readonly done: readonly DoneRow[]; readonly notDone: readonly DoneRow[];
      readonly doneHeading: string; readonly notDoneHeading: string; readonly restartText?: string }
  | { readonly kind: 'fix'; readonly sentence: string }
);

function field(key: GuideAnswerEvent['key'], labels: Readonly<Record<string, string>>, answer?: string | readonly string[],
  kind: QuestionField['kind'] = 'radio', heading?: string): QuestionField {
  return {
    key, heading, kind, choices: Object.entries(labels).map(([value, text]) => ({ value, text })),
    selected: typeof answer === 'string' ? [answer] : answer ?? [],
  };
}

function questionFields(screen: QuestionScreen, session: GuideSession, inputs: ScreenInputs): {
  heading: string; fields: readonly QuestionField[];
} {
  const { answers } = session;
  switch (screen) {
    case 'kind-of-work': {
      const kinds = inputs.kindsOfWork ?? (inputs.policy?.state === 'ready' ? inputs.policy.kindsOfWork : KIND_OF_WORK_ANSWERS);
      const choices = Object.fromEntries([...new Set([...kinds, 'something-else' as const])].map((kind) => [kind, QUESTION_TEXT.q1.choices[kind]]));
      const fields = [field('kindOfWork', choices, answers.kindOfWork)];
      if (answers.kindOfWork === 'staff') fields.push(field('staffSection', QUESTION_TEXT.q1.staffSections, answers.staffSection, 'radio', SCREEN_TEXT.staffSection));
      if (answers.kindOfWork === 'something-else') fields.push({
        ...field('otherKind', {}, answers.otherKind, 'text', SCREEN_TEXT.otherKind), maxLength: MAX_OTHER_KIND_CHARS,
      });
      return { heading: QUESTION_TEXT.q1.heading, fields };
    }
    case 'data':
      return { heading: QUESTION_TEXT.q2.heading, fields: [field('data', QUESTION_TEXT.q2.choices, answers.data, 'checkbox')] };
    case 'data-personal':
      return { heading: QUESTION_TEXT.q2a.heading, fields: [field('personalSensitive', QUESTION_TEXT.q2a.choices, answers.personalSensitive)] };
    case 'data-contract':
      return { heading: QUESTION_TEXT.q2b.heading, fields: [
        field('contractLevel', QUESTION_TEXT.q2b.choices, answers.contractLevel),
        field('contractApproval', QUESTION_TEXT.q2b.approvalChoices, answers.contractApproval, 'radio', QUESTION_TEXT.q2b.approvalHeading),
      ] };
    case 'canada':
      return { heading: QUESTION_TEXT.q3.heading, fields: [field('canada', QUESTION_TEXT.q3.choices, answers.canada)] };
  }
}

function answerRows(session: GuideSession, inputs: ScreenInputs, agentWork: QuestionField): readonly AnswerRow[] {
  const screens: QuestionScreen[] = ['kind-of-work', 'data'];
  if (session.answers.data.includes('personal')) screens.push('data-personal');
  if (session.answers.data.includes('contract')) screens.push('data-contract');
  screens.push('canada');
  const rows = screens.flatMap((screen) => {
    const { heading, fields } = questionFields(screen, session, inputs);
    const fixed = session.fixed.includes(screen);
    const locked = screen === 'canada' && session.locked.canada;
    const source = locked ? MODE_SET_BY_ORGANIZATION_TEXT
      : fixed ? (screen === 'kind-of-work' ? inputs.fixedKindSource : undefined) ?? SET_BY_PROJECT_TEXT : undefined;
    return fields.map((question): AnswerRow => {
      const label = question.heading ?? heading;
      const value = selectedText(question);
      return {
        key: question.key, label, value, source,
        ...(!source ? { screen, changeText: SCREEN_TEXT.change, changeLabel: fillSlots(SCREEN_TEXT.changeAnswer, { question: label }) } : {}),
      };
    });
  });
  rows.push({ key: 'agentWork', label: QUESTION_TEXT.q4.heading, value: selectedText(agentWork),
    source: session.fixed.includes('agent-work') ? SET_BY_PROJECT_TEXT : undefined });
  return rows;
}

function selectedText(field: QuestionField): readonly string[] {
  if (field.kind === 'text') return field.selected;
  return field.choices.filter(({ value }) => field.selected.includes(value)).map(({ text }) => text);
}

function reportRows(session: GuideSession, matches: (outcome: ApplyStepReport['outcome']) => boolean): readonly DoneRow[] {
  const textById = new Map(session.changes.map(({ id, text }) => [id, text]));
  return session.report?.steps.filter(({ outcome }) => matches(outcome)).flatMap(({ id, message }) => {
    const text = textById.get(id) ?? message;
    return text === undefined ? [] : [{ id, text, message: text === message ? undefined : message }];
  }) ?? [];
}

function contactText(contacts: readonly PolicyContact[]): string {
  return contacts.length ? contacts.map(({ name, how }) => [name, how].join(' · ')).join(' · ') : GENERIC_CONTACT_TEXT;
}

export function screenFor(session: GuideSession, inputs: ScreenInputs): GuideScreenModel {
  const { policy } = inputs;
  const contacts = policy?.contacts ?? inputs.contacts;
  const contact = contacts.find(({ topic }) => topic === 'security') ?? contacts[0];
  const whoToAsk = fillSlots(SCREEN_TEXT.whoToAsk, { contact: contactText(contacts) });
  if (policy?.state === 'failed-closed') {
    return { kind: 'fix', heading: SCREEN_TEXT.fix, whoToAsk, sentence: policy.sentence, steps: [], completedText: SCREEN_TEXT.completed };
  }
  const { step, total } = stepCount(session);
  const order = questionOrder(session.answers, session.fixed, session.locked);
  const isQuestion = session.state === 'answering' || (session.state === 'not-started' && session.screen !== 'checking');
  const base: Omit<ScreenBase, 'heading'> = {
    whoToAsk, completedText: SCREEN_TEXT.completed,
    steps: order.flatMap((screen, index) => screen === 'checking' ? [] : [{
      screen, text: SCREEN_TEXT.questions[screen],
      state: isQuestion && screen === session.screen ? 'current' : !isQuestion || index < step - 1 ? 'completed' : 'upcoming',
    }]),
    pauseText: SCREEN_TEXT.pause,
    backText: (isQuestion && step <= 1) || total === 0 ? undefined : SCREEN_TEXT.back,
    startingRules: (policy?.startingRules ?? inputs.startingRules) ? STARTING_RULES_TEXT : undefined,
  };
  const checkedOn = fillSlots(SCREEN_TEXT.checkedOn, { machine: inputs.checkedOn });
  if (isQuestion) {
    const screen = session.screen as QuestionScreen;
    const { heading, fields } = questionFields(screen, session, inputs);
    return {
      ...base, kind: 'question', screen, heading: fillSlots(SCREEN_TEXT.step, { n: String(step), m: String(total), question: heading }),
      choices: fields[0].choices, fields, nextText: SCREEN_TEXT.next, canContinue: questionAnswered(session.answers, screen),
    };
  }
  if (session.state === 'choosing' && session.screen === 'stopped') {
    return {
      ...base, kind: 'stopped', heading: SCREEN_TEXT.stopped, nextText: SCREEN_TEXT.next,
      sentence: fillSlots(session.recommendation?.reason ?? '', { contact: contact?.name ?? GENERIC_CONTACT_TEXT }),
      approvedDevice: inputs.approvedDevice ? fillSlots(APPROVED_DEVICE_NOTE_TEXT, { name: inputs.approvedDevice }) : undefined,
    };
  }
  if (session.state === 'reviewing') {
    const agent = field('agentWork', QUESTION_TEXT.q4.choices, session.answers.agentWork, 'radio', QUESTION_TEXT.q4.heading);
    const stopped = session.recommendation?.state === 'stopped';
    return {
      ...base, kind: 'check', heading: SCREEN_TEXT.check, applyText: SCREEN_TEXT.apply, modeRow: inputs.modeRow,
      canApply: !session.changesRequested,
      answers: answerRows(session, inputs, agent),
      agentWork: !session.fixed.includes('agent-work') && !stopped ? agent : undefined,
      nothingChangedText: (session.nothingChanged ?? session.changes.length === 0) ? SCREEN_TEXT.nothingChanged : undefined,
      lowerLabelText: session.changes.some(({ waitsFor }) => waitsFor === 'lower-label-flow') ? SCREEN_TEXT.lowerLabel : undefined,
      confirmRemovalText: session.changes.some(({ group, effect }) => group === 'removed' && effect === 'apply') ? SCREEN_TEXT.confirmRemoval : undefined,
      clearanceText: session.changes.some(({ id }) => id === 'your-rules:clearance') ? CHANGE_TEXT.clearanceExplanation : undefined,
      changes: session.changes,
      groups: Object.entries(SCREEN_TEXT.groups).flatMap(([group, title]) => {
        const items = session.changes.filter((item) => item.group === group);
        return items.length ? [{ title, items }] : [];
      }),
    };
  }
  if (session.state === 'choosing') {
    const cards = (state: OptionCard['outcome']) => inputs.cards.filter((card) => card.outcome === state);
    const needsReason = choiceNeedsReason(session.chosen, session.recommendation?.recommendedId);
    const { scan } = inputs;
    return {
      ...base, kind: 'options', heading: SCREEN_TEXT.options, recommended: cards('recommended'),
      available: cards('available'), ruledOut: cards('ruled-out'), notAvailable: cards('not-available'),
      notAvailableText: SCREEN_TEXT.notAvailable, reason: session.recommendation?.reason, whyText: SCREEN_TEXT.why,
      chosen: session.chosen, choiceReason: session.choiceReason, checkedOn,
      needsReason, reasonPrompt: needsReason ? SCREEN_TEXT.reasonPrompt : undefined,
      canReview: session.chosen !== undefined && !session.changesRequested && (!needsReason || Boolean(session.choiceReason)),
      reviewText: SCREEN_TEXT.review, cardLabels: SCREEN_TEXT.cardLabels,
      candidatesHeading: SCREEN_TEXT.foundHeading,
      candidates: inputs.candidates.map((row) => ({
        ...row, stateText: SCREEN_TEXT.foundStates[row.state],
        actionText: row.action === 'approve' ? SCREEN_TEXT.approve : row.action === 'ask'
          ? fillSlots(SCREEN_TEXT.askApproval, { contact: contact?.name ?? GENERIC_CONTACT_TEXT }) : undefined,
      })),
      scan: {
        ...scan, label: SCREEN_TEXT.scan, confirmLabel: SCREEN_TEXT.scanNow, stopLabel: SCREEN_TEXT.scanStop,
        progress: scan.running && scan.done !== undefined && scan.total !== undefined
          ? fillSlots(SCREEN_TEXT.scanProgress, { n: String(scan.done), m: String(scan.total) }) : undefined,
      },
    };
  }
  if (session.state === 'applying') {
    return { ...base, kind: 'applying', heading: SCREEN_TEXT.applying, pauseText: undefined, backText: undefined };
  }
  if (session.state === 'applied' || session.state === 'partly-applied' || session.state === 'paused' || session.state === 'abandoned') {
    const partial = session.state === 'partly-applied';
    const completed = session.state === 'applied';
    return {
      ...base, kind: 'done', pauseText: undefined, backText: undefined,
      heading: partial ? SCREEN_TEXT.partial : completed ? SCREEN_TEXT.done
        : session.state === 'paused' ? SCREEN_TEXT.paused : SCREEN_TEXT.abandoned,
      landing: completed || partial ? inputs.landing : undefined,
      done: reportRows(session, (outcome) => outcome === 'done' || outcome === 'already-done'),
      notDone: reportRows(session, (outcome) => outcome === 'failed' || outcome === 'waiting'),
      doneHeading: SCREEN_TEXT.finished, notDoneHeading: SCREEN_TEXT.unfinished,
      restartText: partial ? SCREEN_TEXT.retry : completed ? SCREEN_TEXT.changeAnswers : undefined,
    };
  }
  const finished = session.results.filter(({ state }) => state !== 'checking' && state !== 'unknown').length;
  return { ...base, kind: 'checking', heading: SCREEN_TEXT.checking, checkedOn,
    progress: fillSlots(SCREEN_TEXT.checked, { n: String(finished), m: String(session.results.length) }),
    slow: session.stillChecking.flatMap((id) => {
      const option = parseOptionId(id);
      return option ? [fillSlots(STILL_CHECKING_TEXT, { option: OPTION_NAME_TEXT[option.kind] })] : [];
    }),
    continueText: (session.ceilingReached || session.stillChecking.length > 0) && !session.recommendationRequested
      ? SCREEN_TEXT.continueWithoutSlow : undefined,
  };
}

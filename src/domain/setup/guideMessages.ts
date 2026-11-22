import { ENDPOINT_ID_PATTERN } from '../gate/endpoints';
import { checkKeys, isRecord, ownValue } from '../gate/shape';
import {
  AGENT_WORK_ANSWERS, cleanFreeText, CONTRACT_LEVELS, DATA_ANSWERS, KIND_OF_WORK_ANSWERS,
  MAX_CHOICE_REASON_CHARS, MAX_OTHER_KIND_CHARS, STAFF_SECTION_ANSWERS, YES_NO_UNSURE,
  type GuideAnswers,
} from './answers';
import { isAuditScanRange } from './guideRecord';
import { optionIdOf, parseOptionId } from './ids';
import type { GuideScreenModel } from './screens';
import { VIABILITY_FIX_ACTIONS, type ViabilityFix } from './viability';

export const MAX_INBOUND_TEXT = MAX_CHOICE_REASON_CHARS;
export const QUESTION_SCREENS = ['kind-of-work', 'data', 'data-personal', 'data-contract', 'canada'] as const;
export type QuestionScreen = (typeof QUESTION_SCREENS)[number];

export type GuideAnswerEvent = {
  [Key in keyof Required<GuideAnswers>]: {
    readonly type: 'answer';
    readonly key: Key;
    readonly value: Required<GuideAnswers>[Key];
  };
}[keyof GuideAnswers];

const NO_FIELDS = [
  'ready', 'next', 'back', 'continue-without-slow', 'review', 'pause', 'abandon',
  'scan-stop', 'change-answers', 'close',
] as const;
type SimpleMessage = { [Type in (typeof NO_FIELDS)[number]]: { readonly type: Type } }[(typeof NO_FIELDS)[number]];

export type GuideInbound =
  | SimpleMessage
  | GuideAnswerEvent
  | { readonly type: 'choose'; readonly optionId: string }
  | { readonly type: 'reason'; readonly text: string }
  | { readonly type: 'change'; readonly screen: QuestionScreen }
  | { readonly type: 'apply'; readonly confirmRemoval?: true }
  | { readonly type: 'fix'; readonly optionId: string; readonly action: ViabilityFix['action'] }
  | { readonly type: 'scan-confirm'; readonly ranges: readonly string[] }
  | { readonly type: 'approve-candidate'; readonly candidateId: string };

export type GuideOutbound =
  | { readonly type: 'screen'; readonly screen: GuideScreenModel }
  | { readonly type: 'progress'; readonly text: string }
  | { readonly type: 'announce'; readonly text: string };

const ANSWER_CHOICES = {
  kindOfWork: KIND_OF_WORK_ANSWERS, staffSection: STAFF_SECTION_ANSWERS,
  personalSensitive: YES_NO_UNSURE, contractLevel: CONTRACT_LEVELS, contractApproval: YES_NO_UNSURE,
  canada: YES_NO_UNSURE, agentWork: AGENT_WORK_ANSWERS,
};

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function optionId(value: unknown): value is string {
  const parsed = typeof value === 'string' && value.length <= MAX_INBOUND_TEXT ? parseOptionId(value) : undefined;
  return parsed !== undefined && optionIdOf(parsed.kind, parsed.endpointId) === value;
}

function parseAnswer(key: unknown, value: unknown): GuideAnswerEvent | undefined {
  if (key === 'data') {
    if (!Array.isArray(value) || value.length > DATA_ANSWERS.length) return undefined;
    const data = [...value];
    if (data.every((entry) => oneOf(entry, DATA_ANSWERS)) && new Set(data).size === data.length) {
      return { type: 'answer', key, value: data };
    }
    return undefined;
  }
  if (key === 'otherKind') {
    return typeof value === 'string' && value.length <= MAX_OTHER_KIND_CHARS
      ? { type: 'answer', key, value: cleanFreeText(value, MAX_OTHER_KIND_CHARS) }
      : undefined;
  }
  if (typeof key !== 'string' || !Object.hasOwn(ANSWER_CHOICES, key)) return undefined;
  const choice = key as keyof typeof ANSWER_CHOICES;
  return oneOf(value, ANSWER_CHOICES[choice]) ? { type: 'answer', key: choice, value } as GuideAnswerEvent : undefined;
}

export function parseGuideInbound(value: unknown): GuideInbound | undefined {
  if (!isRecord(value)) return undefined;
  const type = ownValue(value, 'type');
  const exact = (...keys: string[]) => !checkKeys(value, '', ['type', ...keys]);
  if (oneOf(type, NO_FIELDS)) return exact() ? { type } : undefined;
  switch (type) {
    case 'answer':
      return exact('key', 'value') ? parseAnswer(ownValue(value, 'key'), ownValue(value, 'value')) : undefined;
    case 'choose': {
      const id = ownValue(value, 'optionId');
      return exact('optionId') && optionId(id) ? { type, optionId: id } : undefined;
    }
    case 'reason': {
      const reason = ownValue(value, 'text');
      return exact('text') && typeof reason === 'string' && reason.length <= MAX_INBOUND_TEXT
        ? { type, text: cleanFreeText(reason, MAX_INBOUND_TEXT) } : undefined;
    }
    case 'change': {
      const screen = ownValue(value, 'screen');
      return exact('screen') && oneOf(screen, QUESTION_SCREENS) ? { type, screen } : undefined;
    }
    case 'apply':
      if (exact()) return { type };
      return exact('confirmRemoval') && ownValue(value, 'confirmRemoval') === true ? { type, confirmRemoval: true } : undefined;
    case 'fix': {
      const id = ownValue(value, 'optionId');
      const action = ownValue(value, 'action');
      return exact('optionId', 'action') && optionId(id) && oneOf(action, VIABILITY_FIX_ACTIONS)
        ? { type, optionId: id, action } : undefined;
    }
    case 'approve-candidate': {
      const candidateId = ownValue(value, 'candidateId');
      return exact('candidateId') && typeof candidateId === 'string' && ENDPOINT_ID_PATTERN.test(candidateId)
        ? { type, candidateId } : undefined;
    }
    case 'scan-confirm': {
      const ranges = ownValue(value, 'ranges');
      if (!exact('ranges') || !Array.isArray(ranges) || ranges.length === 0 || ranges.length > 32) return undefined;
      const copy = [...ranges];
      return copy.every(isAuditScanRange) && new Set(copy).size === copy.length ? { type, ranges: copy } : undefined;
    }
    default:
      return undefined;
  }
}

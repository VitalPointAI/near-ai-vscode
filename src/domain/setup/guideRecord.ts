// Pure: project and probe details are reduced to the values the audit allows.
import { labelKey, type Label } from '../gate/labels';
import type { UseTier } from '../gate/models';
import { cleanFreeText, MAX_CHOICE_REASON_CHARS, MAX_OTHER_KIND_CHARS, type GuideAnswers } from './answers';
import type { HostKind } from './device';
import type { GuideScreenId } from './ids';
import type { ViabilitySnapshotEntry } from './records';
import type { ServerKind } from './servers';
import type { ViabilityReasonCode, ViabilityResult } from './viability';

const SHA256 = /^[a-f0-9]{64}$/i;
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
// Same IPv4 range and prefix limits as the onboarding policy parser.
const SCAN_CIDR = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}/(?:1[6-9]|2[0-9]|3[0-2])$`);
const LOCATION_TEXT = /\S*[\\/]\S*|\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\b|\[[0-9a-f]*:[0-9a-f:]+\](?::\d+)?/gi;

function cap(text: string, max: number): string {
  return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

function cleanAuditText(text: string, max: number): string {
  // Redact before clipping so a secret or location crossing the cap is removed in full.
  return cap(cleanFreeText(text, Number.MAX_SAFE_INTEGER).replace(LOCATION_TEXT, '[REDACTED]'), max);
}

export interface GuideRecordInput {
  readonly answers: GuideAnswers;
  readonly proposedLabel: Pick<Label, 'scale' | 'level'> | null;
  readonly use: UseTier;
  readonly residency: { readonly narrowed: boolean };
  readonly viability: readonly ViabilityResult[];
  readonly policy: Readonly<Record<string, string | undefined>>;
  readonly options: readonly { readonly optionId: string; readonly outcome: string }[];
  readonly recommendation: { readonly optionId?: string; readonly reasonId: string };
  readonly choice: readonly string[];
  readonly choiceReason?: string;
  readonly changes: readonly { readonly id: string; readonly outcome: string }[];
  readonly hostKind: HostKind;
  readonly proposals?: readonly string[];
  readonly authorizations?: readonly string[];
  readonly deviceKeyId?: string;
  readonly earlierLocality?: 'local' | 'cloud' | 'hybrid';
  readonly nothingChanged?: boolean;
}

function answerIds(answers: GuideAnswers): Omit<GuideAnswers, 'otherKind'> {
  const { kindOfWork, staffSection, data, personalSensitive, contractLevel, contractApproval, canada, agentWork } = answers;
  return {
    data: [...data],
    ...(kindOfWork === undefined ? {} : { kindOfWork }),
    ...(staffSection === undefined ? {} : { staffSection }),
    ...(personalSensitive === undefined ? {} : { personalSensitive }),
    ...(contractLevel === undefined ? {} : { contractLevel }),
    ...(contractApproval === undefined ? {} : { contractApproval }),
    ...(canada === undefined ? {} : { canada }),
    ...(agentWork === undefined ? {} : { agentWork }),
  };
}

// Mirrors the last-part rule in the gate's session mark without importing the engine layer.
function modelName(id: string): string {
  const text = id.trim();
  if (text === '') return 'unknown-model';
  const url = text.indexOf('://');
  const looksLikePlace = url >= 0 || text.includes('\\') || /^(?:\/|~|\.\.?\/|[a-z]:)/i.test(text);
  let name = text;
  if (looksLikePlace) {
    const location = url < 0 ? text : text.slice(url + 3).split(/[?#]/, 1)[0].split('/').slice(1).join('/');
    const last = location.split(/[\\/]/).filter(Boolean).at(-1);
    name = !last || last.includes(':') ? 'unknown-model' : last;
  }
  return cap(cleanFreeText(name, Number.MAX_SAFE_INTEGER), 128) || 'unknown-model';
}

interface GuideViabilitySnapshotEntry extends ViabilitySnapshotEntry {
  readonly reasonCode?: ViabilityReasonCode;
  readonly serverKind?: ServerKind;
  readonly serverVersion?: string;
  readonly models: readonly { readonly id: string; readonly sha256?: string }[];
  readonly checkedAt?: string;
}

export function snapshotOf(results: readonly ViabilityResult[]): readonly GuideViabilitySnapshotEntry[] {
  return results.map(({ optionId, state, reasonCode, server, models, checkedAt }) => {
    const timestamp = checkedAt === undefined ? undefined : new Date(checkedAt);
    return {
      optionId, state,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      ...(server === undefined ? {} : { serverKind: server.kind }),
      ...(server?.version === undefined ? {} : { serverVersion: cleanAuditText(server.version, 40) }),
      models: models.map(({ id, sha256 }) => ({ id: modelName(id), ...(sha256 && SHA256.test(sha256) ? { sha256 } : {}) })),
      ...(timestamp && Number.isFinite(timestamp.getTime()) ? { checkedAt: timestamp.toISOString() } : {}),
    };
  });
}

export function buildGuideRecord(input: GuideRecordInput) {
  const { answers, proposedLabel, residency, recommendation, choiceReason, proposals, authorizations, deviceKeyId, earlierLocality, nothingChanged } = input;
  return {
    answers: answerIds(answers),
    proposedLabel: proposedLabel === null ? null : labelKey(proposedLabel),
    use: input.use,
    residency: { answer: answers.canada ?? null, narrowed: residency.narrowed },
    viability: snapshotOf(input.viability),
    policy: Object.fromEntries(Object.entries(input.policy).filter(([layer, hash]) => /^[a-z][a-zA-Z0-9-]*$/.test(layer) && hash !== undefined && SHA256.test(hash))),
    options: input.options.map(({ optionId, outcome }) => ({ optionId, outcome })),
    recommendation: { optionId: recommendation.optionId ?? null, reasonId: recommendation.reasonId },
    choice: [...input.choice],
    changes: nothingChanged ? [] : input.changes.map(({ id, outcome }) => ({ id, outcome })),
    hostKind: input.hostKind,
    ...(answers.kindOfWork === 'something-else' && answers.otherKind !== undefined ? { kindOfWorkText: cleanAuditText(answers.otherKind, MAX_OTHER_KIND_CHARS) } : {}),
    ...(choiceReason === undefined ? {} : { choiceReason: cleanAuditText(choiceReason, MAX_CHOICE_REASON_CHARS) }),
    ...(proposals === undefined ? {} : { proposals: [...proposals] }),
    ...(authorizations === undefined ? {} : { authorizations: [...authorizations] }),
    ...(deviceKeyId === undefined ? {} : { deviceKeyId }),
    ...(earlierLocality === undefined ? {} : { earlierLocality }),
    ...(nothingChanged === undefined ? {} : { nothingChanged }),
  };
}

export function buildAbandonedRecord(input: { readonly answers: GuideAnswers; readonly screen: GuideScreenId; readonly hostKind: HostKind }) {
  return { answers: answerIds(input.answers), screen: input.screen, hostKind: input.hostKind };
}

export function isAuditScanRange(value: unknown): value is string {
  return typeof value === 'string' && SCAN_CIDR.test(value);
}

export function buildScanRecord(input: {
  readonly phase: 'start' | 'end';
  readonly ranges: readonly string[];
  readonly ports: readonly number[];
  readonly found: number;
  readonly hostKind: HostKind;
}) {
  const { phase, ranges, ports, found, hostKind } = input;
  return { phase, ranges: ranges.filter(isAuditScanRange), ports: [...ports], found, hostKind };
}

// GUIDE-05. Pure: no I/O, no clock, no vscode, no package.
import type { ScaleTable } from '../gate/labels';
import type { UseTier } from '../gate/models';
import type { RouteDecision, RouteFacts } from '../gate/routing';
import { TRUST_LINE_TEXT, trustFactsFor, trustLine, type TrustContext, type TrustVerificationLevel } from '../gate/trust';
import { USE_TIER_WORDS } from '../gate/useTier';
import { fillSlots } from './answers';
import type { OptionKind } from './ids';
import type { ViabilityFix, ViabilityResult } from './viability';

export const CARD_LINE_KEYS = Object.freeze(['where', 'who', 'proven', 'notProven', 'cost', 'speed'] as const);
type CardLines = Readonly<Record<(typeof CARD_LINE_KEYS)[number], string>>;

export interface CardOutcome {
  readonly optionId: string;
  readonly kind: OptionKind;
  readonly outcome: 'recommended' | 'available' | 'ruled-out' | 'not-available';
  readonly decision?: RouteDecision;
  readonly refusal?: string;
  readonly note?: string;
}

export interface CardInput {
  readonly outcome: CardOutcome;
  readonly viability: ViabilityResult;
  readonly facts?: RouteFacts;
  readonly context: TrustContext;
  readonly scales: ScaleTable;
  readonly verification?: TrustVerificationLevel;
  readonly approval?: { readonly name: string; readonly use: UseTier };
  readonly provider?: string;
  readonly speed?: string;
}

export interface OptionCard {
  readonly optionId: string;
  readonly kind: OptionKind;
  readonly title: string;
  readonly outcome: CardOutcome['outcome'];
  readonly lines: CardLines;
  readonly trustLine?: string;
  readonly reason?: string;
  readonly fix?: ViabilityFix;
  readonly approvalNote: string;
  readonly describedById: string;
  readonly outcomeText?: string;
}

export const RULED_OUT_WORDS_TEXT = 'Not for this work';
export const NO_APPROVAL_TEXT = 'No approval on record for this model yet';
export const REPORT_ONLY_NOTE_TEXT = NO_APPROVAL_TEXT;
export const APPROVAL_NOTE_TEXT = '{name} is approved for {use}.';

export const NEAR_PRIVATE_PLACE_TEXT = 'NEAR AI private hardware (checked each time it is used)';
export const CARD_FALLBACK_TEXT = Object.freeze({
  provider: 'This service',
  region: 'location not stated',
  speed: 'Speed has not been measured yet.'
});

export const CARD_TEXT = {
  'this-computer': {
    title: 'This computer',
    lines: {
      where: 'Your text stays on this computer.',
      who: 'People with access to this computer could see your text.',
      proven: 'Nothing leaves this computer.',
      notProven: 'How well the local model does this work.',
      cost: 'No charge per use. Uses this computer.',
      speed: '{speed}'
    }
  },
  'near-private': {
    title: NEAR_PRIVATE_PLACE_TEXT,
    lines: {
      where: `Your text goes to ${NEAR_PRIVATE_PLACE_TEXT}.`,
      who: 'The model on this hardware processes your text. The hardware check cannot tell you who could see it.',
      proven: 'Each answer is checked to come from this hardware.',
      notProven: 'Where the data centre is.',
      cost: 'Priced per token.',
      speed: '{speed}'
    }
  },
  'org-server': {
    title: "Your organization's server",
    lines: {
      where: "Your text goes to your organization's server.",
      who: 'People with access to the server could see your text.',
      proven: 'The connection is checked against the certificate in your rules.',
      notProven: "Where the server is and who runs it beyond what your organization's rules say.",
      cost: 'Any charge depends on how your organization runs the server.',
      speed: '{speed}'
    }
  },
  'org-tee': {
    title: '{provider} ({region})',
    lines: {
      where: 'Your text would go to {provider} ({region}).',
      who: 'This version cannot check who could see your text on this server.',
      proven: 'This version cannot check the connection to this server.',
      notProven: 'Which hardware would run the model and where it is.',
      cost: 'Any charge depends on how your organization runs the server.',
      speed: '{speed}'
    }
  },
  'near-all': {
    title: 'NEAR AI Cloud, all models',
    lines: {
      where: 'Your text goes through NEAR AI Cloud to the service running the model.',
      who: 'The service running the model could see your text.',
      proven: 'Your request goes through NEAR AI Cloud.',
      notProven: 'Some models run outside the hardware NEAR AI checks for each answer.',
      cost: 'Priced per token.',
      speed: '{speed}'
    }
  },
  'vendor-tee': {
    title: '{provider} ({region})',
    lines: {
      where: 'Your text would go to {provider} ({region}).',
      who: 'This version cannot check who could see your text on this service.',
      proven: 'This version cannot check the connection to this service.',
      notProven: 'Which hardware would run the model and where it is.',
      cost: 'Any charge depends on your agreement with the service.',
      speed: '{speed}'
    }
  },
  'vendor-region': {
    title: '{provider} ({region})',
    lines: {
      where: 'Your text would go to {provider} ({region}).',
      who: 'People with access to the service could see your text.',
      proven: 'This version cannot check the connection to this service.',
      notProven: 'Whether the service processes your text in the location it names.',
      cost: 'Any charge depends on your agreement with the service.',
      speed: '{speed}'
    }
  }
} as const satisfies Record<OptionKind, { readonly title: string; readonly lines: CardLines }>;

export function choiceNeedsReason(chosenId?: string, recommendedId?: string): boolean {
  return Boolean(chosenId && recommendedId && chosenId !== recommendedId);
}

export function cardFor(input: CardInput): OptionCard {
  const { outcome, viability, facts, context, scales } = input;
  const template = CARD_TEXT[outcome.kind];
  const endpoint = outcome.decision?.endpoint;
  const region = endpoint?.region ?? viability.endpoint?.region;
  const slots = {
    provider: endpoint?.provider ?? input.provider ?? CARD_FALLBACK_TEXT.provider,
    region: region === undefined || region === 'unstated' ? CARD_FALLBACK_TEXT.region : TRUST_LINE_TEXT.regions[region],
    speed: input.speed ?? CARD_FALLBACK_TEXT.speed
  };
  const approvalNote = input.approval === undefined
    ? NO_APPROVAL_TEXT
    : fillSlots(APPROVAL_NOTE_TEXT, { name: input.approval.name, use: USE_TIER_WORDS[input.approval.use] });
  const card: OptionCard = {
    optionId: outcome.optionId,
    kind: outcome.kind,
    title: fillSlots(template.title, slots),
    outcome: outcome.outcome,
    lines: {
      where: fillSlots(template.lines.where, slots),
      who: fillSlots(template.lines.who, slots),
      proven: fillSlots(template.lines.proven, slots),
      notProven: fillSlots(template.lines.notProven, slots),
      cost: fillSlots(template.lines.cost, slots),
      speed: fillSlots(template.lines.speed, slots)
    },
    approvalNote,
    describedById: `reason-${outcome.optionId.replace(/[^a-z0-9-]/g, '-')}`
  };
  if (outcome.outcome === 'ruled-out') {
    return { ...card, reason: outcome.refusal, outcomeText: RULED_OUT_WORDS_TEXT };
  }
  if (outcome.outcome === 'not-available') {
    return { ...card, reason: viability.sentence, fix: viability.fix };
  }
  if (outcome.decision?.allowed && facts !== undefined) {
    return { ...card, trustLine: trustLine(trustFactsFor(outcome.decision, facts, context, {
      verification: input.verification ?? 'not-checked', provider: input.provider
    }), scales).text };
  }
  return card;
}

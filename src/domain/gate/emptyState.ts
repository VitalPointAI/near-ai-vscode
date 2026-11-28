// The empty-state card (74.1 D-22, design 8.5, 74.1-UI-SPEC S8): when a request is refused by route.passport and no model would pass, the chat shows what
// this chat is, that no allowed model is available here, the ways forward that are real for this request, and who to ask last. Pure: the caller passes
// the facts and the gate's own `allows`, so the card never offers a model the gate would refuse (UI security rule 4). It names no tier, approval id or rule.
import type { UseTier } from './models';
import { ROW_USE_WORDS } from './modelRow';

/** Every sentence of the card (74.1-UI-SPEC S8). Placeholders in braces are filled by code. */
export const EMPTY_STATE_TEXT = Object.freeze({
  cardTitle: 'No approved model can do this',
  cardFacts: 'This chat is {use} at {label}. No model your organization\'s rules allow for that is available on {place}.',
  cardFactsOwn: 'This chat is {use} at {label}. No model your rules allow for that is available on {place}.',
  waysTitle: 'Ways forward',
  service: 'Run an approved model on your organization\'s own server, on this computer, or through a Cohere vault. Command A+ can run through a Cohere vault or on your organization\'s own hardware.',
  serviceNoVault: 'Run an approved model on your organization\'s own server or on this computer. Command A+ can run on your organization\'s own hardware.',
  serviceButton: 'Add an AI service',
  closed: 'Use {model} from an outside provider ({provider}). This is allowed only because this chat\'s label, {label}, may go to any cloud. Your text leaves private hardware.',
  closedButton: 'Use {model} for this chat',
  near: 'Wait for NEAR AI to host Western models in its private hardware.',
  nearButton: 'What NEAR AI has been asked',
  nearDetail: 'NEAR AI has been asked to host Nemotron 3, Command A+ and gpt-oss, and Western embedding and reranking models, in its private hardware. When it does, they appear in the models list.',
  research: 'To study an adversary model, use the research workspace. It has no project data and no tools.',
  researchButton: 'Open Research Workspace',
  afterUse: 'This chat now uses {model}. Your message is back in the box; send it again to use {model}.'
});

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);

/** A catalogue model the closed option may name: a model an outside provider serves, with the approval that decided it. */
export interface ClosedCandidate {
  readonly id: string;
  /** The outside provider's name in words. */
  readonly provider: string;
  /** True when its approval is for the closed-api class and covers this chat's use. */
  readonly closedApprovalCovers: boolean;
}

export interface EmptyStateInput {
  readonly use: UseTier;
  /** The chat's label in words. */
  readonly label: string;
  /** Where this chat's label may go: only `any-cloud` offers the closed option. */
  readonly routingTier: string;
  /** Where the request would run, in the Runs on words. */
  readonly place: string;
  readonly catalog: readonly ClosedCandidate[];
  /** The gate's own answer for a model at this chat's use and label (decideRoute through the host). */
  readonly allows: (model: string) => boolean;
  /** The built "Who to ask: ..." sentence (74.1-04). */
  readonly whoToAsk: string;
  readonly organization: boolean;
  /** The guide's AI services option exists on this build (Phase 32.1); otherwise the row is not shown (P17). */
  readonly hasOrgHostingOption: boolean;
  /** A Cohere vault connection exists (Phases 36, 37); otherwise the service row names only your organization's own hardware (P17). */
  readonly hasVault: boolean;
}

export type EmptyStateOption =
  | { readonly kind: 'service'; readonly text: string; readonly button: string }
  | { readonly kind: 'closed'; readonly text: string; readonly button: string; readonly model: string }
  | { readonly kind: 'near'; readonly text: string; readonly button: string; readonly detail: string }
  | { readonly kind: 'research'; readonly text: string; readonly button: string };

export interface EmptyStateCard {
  readonly title: string;
  readonly facts: string;
  readonly waysTitle: string;
  readonly options: readonly EmptyStateOption[];
  readonly who: string;
}

/** The card for one refusal: only the ways forward whose condition holds, in the contract's order, and who to ask last. */
export function emptyStateCard(input: EmptyStateInput): EmptyStateCard {
  const options: EmptyStateOption[] = [];
  if (input.hasOrgHostingOption) options.push({ kind: 'service', text: input.hasVault ? EMPTY_STATE_TEXT.service : EMPTY_STATE_TEXT.serviceNoVault, button: EMPTY_STATE_TEXT.serviceButton });
  // The closed Western option only where the label may go to any cloud, a closed-model approval covers the use, and the gate itself would allow it.
  if (input.routingTier === 'any-cloud') {
    const closed = input.catalog.find((candidate) => candidate.closedApprovalCovers && input.allows(candidate.id));
    if (closed !== undefined) {
      options.push({
        kind: 'closed', model: closed.id,
        text: fill(EMPTY_STATE_TEXT.closed, { model: closed.id, provider: closed.provider, label: input.label }),
        button: fill(EMPTY_STATE_TEXT.closedButton, { model: closed.id })
      });
    }
  }
  options.push({ kind: 'near', text: EMPTY_STATE_TEXT.near, button: EMPTY_STATE_TEXT.nearButton, detail: EMPTY_STATE_TEXT.nearDetail });
  options.push({ kind: 'research', text: EMPTY_STATE_TEXT.research, button: EMPTY_STATE_TEXT.researchButton });
  return Object.freeze({
    title: EMPTY_STATE_TEXT.cardTitle,
    facts: fill(input.organization ? EMPTY_STATE_TEXT.cardFacts : EMPTY_STATE_TEXT.cardFactsOwn, { use: ROW_USE_WORDS[input.use], label: input.label, place: input.place }),
    waysTitle: EMPTY_STATE_TEXT.waysTitle,
    options: Object.freeze(options),
    who: input.whoToAsk
  });
}

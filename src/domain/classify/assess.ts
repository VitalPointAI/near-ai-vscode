// One call from content to a classification decision (Phase 70.1, D-05, D-09, D-13, D-18, D-19; research 3.3, 3.5, 3.6). Pure: no I/O, no clock, no
// vscode, no package, no state: the caller stores the session's fact set it returns. Phase 74.3's runner and Phase 93's ingest call this.
// Order: markings and code words over the visible text and every hidden part; the hidden-instruction detector over the hidden parts; guide and compilation
// rules over the item's facts; compilation rules over the session's set with the item's facts added; then decide(). With no judgement (no model, an edge
// offline) every floor still applies, so rules keep working without a model (owner decision D9 default). A judgement for other content is stale and
// returns at once: assess never mixes two revisions' facts or floors.
import type { ClassificationSection, ShadowMode } from '../gate/classificationSection';
import type { Mark } from '../gate/dominance';
import type { Label, ScaleMapping, ScaleTable } from '../gate/labels';
import { decide } from './decide';
import type { DecideRefusal, Decision, Judgement, LabelEventDescriptor } from './decide';
import { addFacts } from './facts';
import type { SessionFact } from './facts';
import { hiddenInstructionFacts } from './hidden';
import { markingFloors } from './markings';
import type { Floor } from './markings';
import { PROPOSAL_RECORD_VERSION } from './record';
import type { ExceptionKind, Fact, ItemRef, NoModelCause, PromptRef, ProposalRecord } from './record';
import { evaluateRules } from './rules';
import type { AuditResult } from './thresholds';

/** The basis ref of the floor a hidden instruction gives (a detector, D-19). */
export const HIDDEN_INSTRUCTION_DETECTOR = 'hidden-instruction';

export interface AssessInput {
  readonly start: Mark;
  readonly current: ItemRef;
  /** What a reader sees. */
  readonly visible: string;
  /** What a reader does not see: comments, zero-width text, alt text, metadata (the caller extracts them). */
  readonly hidden?: readonly string[];
  /** Facts the caller's own scanners found in this item (types and opaque subjects). */
  readonly facts?: readonly Fact[];
  /** The session's running fact set before this item. */
  readonly sessionFacts?: readonly SessionFact[];
  readonly section: ClassificationSection;
  readonly scales: ScaleTable;
  readonly mappings?: readonly ScaleMapping[];
  readonly modes?: Readonly<Record<string, ShadowMode>>;
  readonly history?: Readonly<Record<string, readonly AuditResult[]>>;
  readonly judgement?: Judgement;
  /** The policy bundle the rules came from, for the record. */
  readonly bundleHash: string;
  /** With a judgement: the prompt template and decoding settings, each as SHA-256. */
  readonly prompt?: { readonly templateHash: string; readonly decodingHash: string };
  /** With a judgement: the model's short reason, labelled at the item's label. It stays in the record with the item, never in the log copy. */
  readonly rationale?: { readonly label: Label; readonly text: string };
  /** With a judgement: the agent's did:key. */
  readonly agent?: string;
  /** With no judgement: why (the 74.3 runner's cause), `rules-only` by default. */
  readonly noModel?: NoModelCause;
}

export type AssessResult =
  | { readonly ok: false; readonly refusal: DecideRefusal | 'bad-fact' | 'judgement-without-context'; readonly message: string }
  | {
    readonly ok: true;
    readonly decision: Decision;
    readonly record: ProposalRecord;
    readonly events: readonly LabelEventDescriptor[];
    /** The session's new running set; unchanged on a stale result or at the cap. */
    readonly sessionFacts: readonly SessionFact[];
  };

const ASSESS_REFUSALS = Object.freeze({
  'bad-fact': 'A fact has a key or a value a fact may not hold. A fact names a type and an opaque subject only.',
  'judgement-without-context': 'A model judgement needs its prompt hashes, its rationale and the agent that asked for it.'
} as const);

/** The hidden instruction's floor: every label of the start gains `no-agent-tools` (D-19). */
function hiddenFloors(start: Mark): readonly Floor[] {
  return start.map((label) => Object.freeze({
    label: Object.freeze({ scale: label.scale, level: label.level, compartments: Object.freeze([]), releasability: Object.freeze([]), handling: Object.freeze(['no-agent-tools']) }),
    basis: Object.freeze({ kind: 'detector' as const, ref: HIDDEN_INSTRUCTION_DETECTOR })
  }));
}

function recordFacts(facts: readonly Fact[]): readonly Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const fact of facts) {
    const key = `${fact.type} ${fact.subject ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze(fact.subject === undefined ? { type: fact.type } : { type: fact.type, subject: fact.subject }));
  }
  return Object.freeze(out);
}

function withExceptions(decision: Decision, kinds: readonly ExceptionKind[]): Decision {
  const missing = kinds.filter((kind) => !decision.exceptions.some((entry) => entry.kind === kind));
  if (missing.length === 0) return decision;
  const events = [...decision.events, ...missing.map((kind) => Object.freeze({ event: 'label.exception-queued' as const, from: decision.start, to: decision.applied, bases: decision.bases, exception: kind }))];
  return {
    ...decision,
    exceptions: Object.freeze([...decision.exceptions, ...missing.map((kind) => Object.freeze({ kind }))]),
    events: Object.freeze(events)
  };
}

function recordOf(decision: Decision, facts: readonly Fact[], input: AssessInput): ProposalRecord {
  const judgement = input.judgement;
  const prompt: PromptRef = judgement === undefined || input.prompt === undefined
    ? Object.freeze({ bundleHash: input.bundleHash })
    : Object.freeze({ bundleHash: input.bundleHash, templateHash: input.prompt.templateHash, decodingHash: input.prompt.decodingHash });
  return Object.freeze({
    v: PROPOSAL_RECORD_VERSION,
    item: input.current.item,
    contentHash: input.current.contentHash,
    revision: input.current.revision,
    start: decision.start,
    proposal: decision.proposal,
    bases: decision.bases,
    facts,
    confidence: decision.confidence,
    model: judgement === undefined ? Object.freeze({ none: input.noModel ?? 'rules-only' }) : judgement.model,
    prompt,
    rationale: judgement === undefined || input.rationale === undefined ? null : Object.freeze({ label: input.rationale.label, text: input.rationale.text }),
    outcome: decision.outcome,
    applied: decision.applied,
    suggestions: decision.suggestions,
    exceptions: decision.exceptions,
    actor: judgement === undefined ? 'rules' : (input.agent as string)
  });
}

/** Assesses one item: every floor, the hidden-instruction detector, the guide and compilation rules, then decide(); see the file header for the order. */
export function assess(input: AssessInput): AssessResult {
  const judgement = input.judgement;
  if (judgement !== undefined && (input.prompt === undefined || input.rationale === undefined || input.agent === undefined)) {
    return { ok: false, refusal: 'judgement-without-context', message: ASSESS_REFUSALS['judgement-without-context'] };
  }
  const session = input.sessionFacts ?? [];
  if (judgement !== undefined && judgement.contentHash !== input.current.contentHash) {
    const stale = decide({ start: input.start, current: input.current, floors: [], judgement, section: input.section, scales: input.scales });
    if (!stale.ok) return stale;
    return { ok: true, decision: stale, record: recordOf(stale, [], input), events: stale.events, sessionFacts: session };
  }
  const hidden = input.hidden ?? [];
  const markings = [input.visible, ...hidden].flatMap((text) => markingFloors(text, input.section));
  const hiddenFacts = hiddenInstructionFacts(hidden);
  const itemFacts = [...(input.facts ?? []), ...(judgement?.facts ?? []), ...hiddenFacts];
  const added = addFacts(session, itemFacts, input.current.item);
  if (!added.ok) return { ok: false, refusal: 'bad-fact', message: ASSESS_REFUSALS['bad-fact'] };
  const itemRules = evaluateRules(itemFacts, input.section, 'item');
  const sessionRules = evaluateRules(added.value.facts, input.section, 'session');
  const floors = [...markings, ...(hiddenFacts.length > 0 ? hiddenFloors(input.start) : []), ...itemRules, ...sessionRules];
  const decided = decide({
    start: input.start, current: input.current, floors, section: input.section, scales: input.scales,
    ...(judgement === undefined ? {} : { judgement }),
    ...(input.mappings === undefined ? {} : { mappings: input.mappings }),
    ...(input.modes === undefined ? {} : { modes: input.modes }),
    ...(input.history === undefined ? {} : { history: input.history })
  });
  if (!decided.ok) return decided;
  const kinds: ExceptionKind[] = [];
  if (hiddenFacts.length > 0) kinds.push('hidden-instruction');
  if (added.value.exception !== undefined) kinds.push(added.value.exception);
  const decision = withExceptions(decided, kinds);
  return { ok: true, decision, record: recordOf(decision, recordFacts(itemFacts), input), events: decision.events, sessionFacts: added.value.facts };
}

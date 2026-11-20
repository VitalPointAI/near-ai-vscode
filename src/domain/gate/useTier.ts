// The use tier of a model request (model provenance design 6.1, Phase 41 D-42). Pure: no I/O, no clock, no vscode, no package.
// Every input is a local fact the extension already holds at request time. The tier is the highest of the rows that apply and only ever rises; the
// research lane, a cyber engagement and a comparison on synthetic tasks are T0 whatever else is set, because the lane forbids anything higher.
// Label and project rows read the shipped tables first and then the policy's own `tierByLevel` and `tierByProject`, which can only raise them.
// Report mode only in Phase 41: 41-10's passport step records the result; nothing here refuses a request.
import type { GateContextName } from './bundle';
import { USE_TIERS } from './models';
import type { ModelsSection, UseTier } from './models';
import { SHIPPED_TIER_BY_LEVEL, SHIPPED_TIER_BY_PROJECT } from './shippedPassports';

export interface UseInput {
  /** The request comes from the research lane (provenance 7). */
  readonly lane?: 'research';
  /** A cyber engagement: the research lane only (decision 4). */
  readonly cyber?: boolean;
  /** The request carries any tool definition (read, write, edit, run, web, MCP, sub-agent). */
  readonly tools?: boolean;
  /** The gate context, or a sub-agent; anything but interactive is agent work. */
  readonly context?: GateContextName | 'sub-agent';
  /** Apply, insert or edit actions on the answer, commit message writing, Team Studio AI. */
  readonly writesFiles?: boolean;
  /** A reviewer, release guard, tradecraft reviewer, red team, editor, plan checker or safety classifier: its verdict gates an action. */
  readonly checkingJob?: boolean;
  /** The chat's mark: every label it carries. */
  readonly mark?: readonly { readonly scale: string; readonly level: string }[];
  /** The project's kind and its signed exercise attribute (a staff project at T2 instead of T3). */
  readonly project?: { readonly kind: string; readonly exercise?: boolean };
  /** The tier of the chat or feature that sent the attachment or reads the result (vision, transcription, embedding, reranking). */
  readonly inherited?: UseTier;
  /** Embedding and reranking are at least T1. */
  readonly feature?: 'embedding' | 'rerank';
  /** Compare Models: on synthetic tasks a T0 activity, on project tasks agent work. */
  readonly compare?: 'synthetic' | 'project';
}

/** The use words of the glossary (provenance 6.3); people never see the tier names. */
export const USE_TIER_WORDS: Readonly<Record<UseTier, string>> = Object.freeze({
  T0: 'research only (in the research workspace)',
  T1: 'chat you review',
  T2: 'agent work',
  T3: 'operational work'
});

/** The higher of two tiers: a tier only rises. */
export function raiseUseTier(a: UseTier, b: UseTier): UseTier {
  return USE_TIERS.indexOf(a) >= USE_TIERS.indexOf(b) ? a : b;
}

/** A tier from a table by own property only, so a key such as `__proto__` or `constructor` reads as nothing. */
function tableTier(table: Readonly<Record<string, UseTier>> | undefined, key: string): UseTier | undefined {
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const tier: unknown = table[key];
  return USE_TIERS.find((candidate) => candidate === tier);
}

function raiseBy(tier: UseTier, found: UseTier | undefined): UseTier {
  return found === undefined ? tier : raiseUseTier(tier, found);
}

/** The use tier of a request (provenance 6.1). `models` is the effective policy's models section, whose tables only raise the shipped ones. */
export function useTierFor(input: UseInput, models?: Pick<ModelsSection, 'tierByLevel' | 'tierByProject'>): UseTier {
  if (input.lane === 'research' || input.cyber === true || input.compare === 'synthetic') return 'T0';
  let tier: UseTier = 'T1';
  const agentWork = input.tools === true || (input.context !== undefined && input.context !== 'interactive') || input.writesFiles === true
    || input.checkingJob === true || input.compare === 'project';
  if (agentWork) tier = raiseUseTier(tier, 'T2');
  for (const label of input.mark ?? []) {
    const key = `${label.scale}/${label.level}`;
    tier = raiseBy(raiseBy(tier, tableTier(SHIPPED_TIER_BY_LEVEL, key)), tableTier(models?.tierByLevel, key));
  }
  if (input.project !== undefined) {
    const key = input.project.exercise === true ? `${input.project.kind}-exercise` : input.project.kind;
    tier = raiseBy(raiseBy(tier, tableTier(SHIPPED_TIER_BY_PROJECT, key)), tableTier(models?.tierByProject, key));
  }
  if (input.feature !== undefined) tier = raiseUseTier(tier, 'T1');
  if (input.inherited !== undefined) tier = raiseBy(tier, USE_TIERS.find((candidate) => candidate === input.inherited));
  return tier;
}

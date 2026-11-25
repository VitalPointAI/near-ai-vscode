// The classification proposal record v1 (Phase 70.1, D-03, D-06, D-21; research 3.4, 3.9). Pure: no I/O, no clock, no vscode, no package.
// A record says what one proposal for one revision of one item did, and why. It holds data attributes only (labels, bases, typed facts about the
// content, confidence): never a key for a person attribute (owner decision D1). Once a release ships these keys they never change in place; a change is a
// v2 beside v1 (Phase 70 D-22).
import type { Label } from '../gate/labels';
import type { Mark } from '../gate/dominance';

export const PROPOSAL_RECORD_VERSION = 1;

/**
 * Why a label or a part of it was proposed (D-06), the same six kinds as Phase 33.1 D-40's `basis`, in the same order. Every basis here has a `ref`: the
 * source item id, the marking pattern id, the guide rule id, the detector id, the compilation rule id, or for `judgement` the SHA-256 of the labelled
 * rationale. Never the matched text.
 */
export const BASIS_KINDS = Object.freeze(['source', 'marking', 'guide', 'detector', 'compilation', 'judgement'] as const);
export type BasisKind = (typeof BASIS_KINDS)[number];

export interface Basis {
  readonly kind: BasisKind;
  /** 1 to 128 characters, no line break. */
  readonly ref: string;
}

/** What a proposal did, recorded as the record's outcome (D-21). `affirmed`, `reverted-by-request` and `lowered` are later events about a record, never edits. */
export const PROPOSAL_OUTCOMES = Object.freeze(['auto-raised', 'suggested', 'kept', 'none', 'stale', 'possible-spill'] as const);
export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];

export type ItemRef = { readonly item: string; readonly contentHash: string; readonly revision: number };

/** A label's start and its proposed label on one scale, each field with its direction (D-04). */
export type LevelDirection = 'up' | 'same' | 'down';
export type SetDirection = 'added' | 'removed' | 'both' | 'same';
export type ReleaseDirection = 'narrowed' | 'widened' | 'both' | 'same';

export interface ProposalPart {
  readonly label: Label;
  readonly level: LevelDirection;
  readonly compartments: SetDirection;
  readonly releasability: ReleaseDirection;
  readonly handling: SetDirection;
}

export interface ProposalRecordCore extends ItemRef {
  readonly v: 1;
  readonly start: Mark;
  readonly proposal: readonly ProposalPart[];
  readonly bases: readonly Basis[];
  readonly outcome: ProposalOutcome;
  readonly applied: Mark;
}

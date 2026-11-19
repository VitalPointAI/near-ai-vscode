// The reducer contract for the fold (DESIGN 4.4 step 3). Not hub-side: this file knows the text reducer, and so Yjs.
//
// A reducer owns one kind family:
// - apply mutates the family's working state in fold order and says whether the entry was applied, refused (permanent) or held (a piece is missing).
// - finish derives the family's output from the whole state, so per-version results can be computed from sets, independent of order.
// - canonical gives the digest input for one stream: arrays and plain objects only, since canonical JSON refuses Maps.
// - clone lets plan 30-09 keep a copy of the state at a checkpoint prefix for refolds.
import type { CausalGraph } from './causal';
import type { KindFamily } from './kinds';
import type { ReplicaContext } from './rosterView';
import { textReducer } from './textFold';
import type { VerifiedEntry } from './verify';

export type ReduceOutcome = { status: 'applied' } | { status: 'refused'; reason: string } | { status: 'held'; reason: string };

export interface FoldView {
  ctx: ReplicaContext;
  graph: CausalGraph;
  // Index of an admitted entry in the total order.
  position(hash: string): number | undefined;
  entry(hash: string): VerifiedEntry | undefined;
  // The working state of another family, as far as the fold has got.
  state(family: KindFamily): unknown;
  // Is the entry's place in the order final? Answers false until plan 30-09 adds checkpoints.
  isFinal(hash: string): boolean;
}

export interface FamilyReducer<S, O> {
  family: KindFamily;
  init(): S;
  apply(state: S, entry: VerifiedEntry, view: FoldView): ReduceOutcome;
  finish(state: S, view: FoldView): O;
  canonical(output: O, stream: string): unknown;
  clone(state: S): S;
}

// A list of reducers of different state types: the state and output are private to each reducer, so the list holds them as any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReducer = FamilyReducer<any, any>;

// Plan 30-12 registers the other families.
export const DEFAULT_REDUCERS: readonly AnyReducer[] = [textReducer];

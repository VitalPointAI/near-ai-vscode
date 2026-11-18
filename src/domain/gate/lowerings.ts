// The registry of the judge every thread merge uses for a signed lowering of a chat's label (CLAS-04, D-58), and of where the merge reports what it judged.
// A module-level registration, like the key history warning sink (keyHistoryWarnings.ts), so no merge site changes: the gate host registers both at
// activation. With no judge registered every lowering from another copy is rejected (fail closed). Pure: no I/O, no vscode.
import type { Mark } from './dominance';

/** What the judge of a signed lowering is told about the copy it would lower (D-58). */
export interface LoweringContext {
  readonly chatId: string;
  /** The other copy's mark, which the lowering's from-mark must cover. */
  readonly otherMark: Mark;
  /** When the other copy was last used; it must not be after the lowering. */
  readonly otherLastUsedAt: string;
}

/**
 * The judge's answer: apply the lowering, with the verified signed target it lowers to (the only source of the result, PR #87 review round 2), or the
 * plain cause it was not applied.
 */
export type LoweringVerdict = { readonly apply: true; readonly to: Mark; readonly signedAt: string } | { readonly apply: false; readonly cause: string };

/** Judges a signed lowering one copy of a chat holds and the other does not (registered by the gate host, src/gate/chatLabel.ts). */
export type LabelLoweringJudge = (lowering: unknown, context: LoweringContext) => LoweringVerdict;

let loweringJudge: LabelLoweringJudge | undefined;

/** Registers (or, with undefined, clears) the judge every merge uses; returns a function that clears it while it is still this one. */
export function registerLabelLoweringJudge(judge: LabelLoweringJudge | undefined): () => void {
  loweringJudge = judge;
  return () => { if (loweringJudge === judge) loweringJudge = undefined; };
}

/** Told each lowering a merge applied or rejected, with its cause (the gate host records them once per signature per window). */
export type LoweringOutcomeListener = (outcome: { readonly chatId: string; readonly lowering: unknown; readonly applied: boolean; readonly cause?: string; readonly result?: Mark; readonly from?: Mark }) => void;
let loweringOutcomes: LoweringOutcomeListener | undefined;

/** Registers where the merge reports each lowering it judged; returns a function that clears it while it is still this one. */
export function registerLoweringOutcomes(listener: LoweringOutcomeListener | undefined): () => void {
  loweringOutcomes = listener;
  return () => { if (loweringOutcomes === listener) loweringOutcomes = undefined; };
}

/** Tells the registered listener what a merge did with one lowering. Never throws. */
export function reportLowering(chatId: string, lowering: unknown, verdict: LoweringVerdict, result?: Mark, from?: Mark): void {
  try { loweringOutcomes?.({ chatId, lowering, applied: verdict.apply, ...(verdict.apply ? {} : { cause: verdict.cause }), ...(result === undefined ? {} : { result }), ...(from === undefined ? {} : { from }) }); } catch { /* a report never changes a merge */ }
}

/** Judges one lowering with the registered judge; with none, or one that throws, it is rejected (fail closed). */
export function judgeLowering(lowering: unknown, context: LoweringContext): LoweringVerdict {
  try {
    return loweringJudge?.(lowering, context) ?? { apply: false, cause: 'no-judge' };
  } catch {
    return { apply: false, cause: 'does-not-verify' };
  }
}

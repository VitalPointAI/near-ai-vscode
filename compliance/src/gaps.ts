// Derived gap states (44-04, D-20 and D-38). Gap state is never stored in the register:
// evidence rows, POA&M milestones, verified risk acceptances and the clock are its only inputs.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadJson } from './validate.ts';
import type { State, VerifiedRiskAcceptance } from './model.ts';

export const GAP_STATES = Object.freeze(['open', 'planned', 'in-progress', 'closed', 'risk-accepted'] as const);
export type GapState = typeof GAP_STATES[number];

export interface Gap {
  readonly id: string;
  readonly controls: readonly string[];
  readonly remediation: string;
  readonly ownerRole: string;
  readonly closesInPhase?: string;
  readonly poam?: string;
}

export interface PoamMilestone { readonly phase?: string; readonly targetDate?: string; readonly title: string }
export interface Poam { readonly id: string; readonly gap: string; readonly controls: readonly string[]; readonly milestones: readonly PoamMilestone[] }
export interface GapRow { readonly level: string; readonly control: string; readonly state: State }
export interface GapStateRow {
  readonly id: string;
  readonly state: GapState;
  readonly acceptedUntil?: string;
  readonly overdue: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Reads the register; Task 3 adds the strict cross-file validation before it is used for release output. */
export function loadGaps(file: string): Gap[] {
  const root = record(loadJson(file));
  if (!root || !Array.isArray(root.gaps)) throw new Error(`${file}: gaps must be an array`);
  return root.gaps.map((entry, index) => {
    const gap = record(entry);
    if (!gap || typeof gap.id !== 'string' || !Array.isArray(gap.controls) || !gap.controls.every((control) => typeof control === 'string') || typeof gap.remediation !== 'string' || typeof gap.ownerRole !== 'string') {
      throw new Error(`${file}: gaps[${index}] is incomplete`);
    }
    return {
      id: gap.id, controls: gap.controls, remediation: gap.remediation, ownerRole: gap.ownerRole,
      ...(typeof gap.closesInPhase === 'string' ? { closesInPhase: gap.closesInPhase } : {}),
      ...(typeof gap.poam === 'string' ? { poam: gap.poam } : {})
    };
  });
}

/** Reads every POA&M item directly in a folder, in file-name order. */
export function loadPoam(dir: string): Poam[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json') && statSync(path.join(dir, name)).isFile()).sort().map((name) => {
    const file = path.join(dir, name);
    const item = record(loadJson(file));
    if (!item || typeof item.id !== 'string' || typeof item.gap !== 'string' || !Array.isArray(item.controls) || !item.controls.every((control) => typeof control === 'string') || !Array.isArray(item.milestones)) throw new Error(`${file}: POA&M item is incomplete`);
    const milestones = item.milestones.map((milestone, index) => {
      const parsed = record(milestone);
      if (!parsed || typeof parsed.title !== 'string') throw new Error(`${file}: milestones[${index}] is incomplete`);
      return { title: parsed.title, ...(typeof parsed.phase === 'string' ? { phase: parsed.phase } : {}), ...(typeof parsed.targetDate === 'string' ? { targetDate: parsed.targetDate } : {}) };
    });
    return { id: item.id, gap: item.gap, controls: item.controls, milestones };
  });
}

const acceptanceFor = (gap: Gap, acceptances: readonly VerifiedRiskAcceptance[], now: Date): VerifiedRiskAcceptance | undefined => acceptances.find((acceptance) => (
  acceptance.gap === gap.id
  && Date.parse(acceptance.expiresAt) > now.getTime()
  && gap.controls.every((control) => acceptance.controls.includes(control))
));

/**
 * Computes the Task 1 tracer states. Task 3 completes the evidence-derived closed and in-progress
 * branches and validates the source register strictly; accepted risk deliberately wins only while it
 * is current and covers every control in the gap.
 */
export function gapStates(input: { readonly gaps: readonly Gap[]; readonly poam: readonly Poam[]; readonly rows: readonly GapRow[]; readonly acceptances: readonly VerifiedRiskAcceptance[]; readonly now: Date }): GapStateRow[] {
  return input.gaps.map((gap) => {
    const acceptance = acceptanceFor(gap, input.acceptances, input.now);
    if (acceptance) return { id: gap.id, state: 'risk-accepted', acceptedUntil: acceptance.expiresAt, overdue: false };
    const poam = gap.poam === undefined ? undefined : input.poam.find((item) => item.id === gap.poam && item.gap === gap.id);
    const overdue = poam?.milestones.some((milestone) => milestone.targetDate !== undefined && Date.parse(`${milestone.targetDate}T00:00:00.000Z`) < input.now.getTime()) ?? false;
    return { id: gap.id, state: poam || gap.closesInPhase ? 'planned' : 'open', overdue };
  });
}

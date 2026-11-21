// Derived gap states (44-04, D-20 and D-38). State is never persisted in the source register.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadJson, validateOurs } from './validate.ts';
import type { State, VerifiedRiskAcceptance } from './model.ts';

export const GAP_STATES = Object.freeze(['open', 'planned', 'in-progress', 'closed', 'risk-accepted'] as const);
export type GapState = typeof GAP_STATES[number];
export interface Gap { readonly id: string; readonly controls: readonly string[]; readonly remediation: string; readonly ownerRole: string; readonly closesInPhase?: string; readonly poam?: string }
export interface PoamMilestone { readonly phase?: string; readonly targetDate?: string; readonly title: string }
export interface Poam { readonly id: string; readonly gap: string; readonly controls: readonly string[]; readonly milestones: readonly PoamMilestone[] }
export interface GapRow { readonly level: string; readonly control: string; readonly state: State }
export interface GapStateRow { readonly id: string; readonly state: GapState; readonly acceptedUntil?: string; readonly phase?: string; readonly overdue: boolean }

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Loads the strict register. A state-like field cannot appear in its schema. */
export function loadGaps(file: string): Gap[] {
  const doc = loadJson(file);
  const valid = validateOurs(doc, 'gaps');
  if (!valid.ok) throw new Error(`${file}: invalid gaps register: ${valid.errors.join('; ')}`);
  const entries = (doc as { gaps: Record<string, unknown>[] }).gaps;
  const ids = new Set<string>();
  return entries.map((entry) => {
    const id = entry.id as string;
    if (ids.has(id)) throw new Error(`${file}: duplicate gap ${id}`);
    ids.add(id);
    return { id, controls: entry.controls as string[], remediation: entry.remediation as string, ownerRole: entry.ownerRole as string, ...(typeof entry.closesInPhase === 'string' ? { closesInPhase: entry.closesInPhase } : {}), ...(typeof entry.poam === 'string' ? { poam: entry.poam } : {}) };
  });
}

/** Loads strict POA&M items in deterministic order. */
export function loadPoam(dir: string): Poam[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const ids = new Set<string>();
  return readdirSync(dir).filter((name) => name.endsWith('.json') && statSync(path.join(dir, name)).isFile()).sort().map((name) => {
    const file = path.join(dir, name);
    const doc = loadJson(file);
    const valid = validateOurs(doc, 'poam-item');
    if (!valid.ok) throw new Error(`${file}: invalid POA&M item: ${valid.errors.join('; ')}`);
    const item = doc as { id: string; gap: string; controls: string[]; milestones: PoamMilestone[] };
    if (ids.has(item.id)) throw new Error(`${file}: duplicate POA&M id ${item.id}`);
    ids.add(item.id);
    return { id: item.id, gap: item.gap, controls: item.controls, milestones: item.milestones };
  });
}

function acceptanceFor(gap: Gap, acceptances: readonly VerifiedRiskAcceptance[], now: Date): VerifiedRiskAcceptance | undefined {
  return acceptances.find((acceptance) => acceptance.gap === gap.id && Date.parse(acceptance.expiresAt) > now.getTime() && gap.controls.every((control) => acceptance.controls.includes(control)));
}

function evidenceProgress(gap: Gap, rows: readonly GapRow[]): 'closed' | 'in-progress' | 'none' {
  let anyCovered = false;
  for (const control of gap.controls) {
    const controlRows = rows.filter((row) => row.control === control);
    if (controlRows.length === 0) return anyCovered ? 'in-progress' : 'none';
    const covered = controlRows.every((row) => row.state === 'met' || row.state === 'not-applicable');
    if (!covered) {
      if (controlRows.some((row) => row.state === 'met' || row.state === 'not-applicable')) anyCovered = true;
      return anyCovered ? 'in-progress' : 'none';
    }
    anyCovered = true;
  }
  return 'closed';
}

/** Computes states only from rows, registered milestones, verified acceptances and the clock. */
export function gapStates(input: { readonly gaps: readonly Gap[]; readonly poam: readonly Poam[]; readonly rows: readonly GapRow[]; readonly acceptances: readonly VerifiedRiskAcceptance[]; readonly now: Date }): GapStateRow[] {
  const poamById = new Map(input.poam.map((item) => [item.id, item]));
  for (const gap of input.gaps) {
    if (gap.poam !== undefined && poamById.get(gap.poam)?.gap !== gap.id) throw new Error(`gap ${gap.id}: POA&M ${gap.poam} does not point back to the gap`);
  }
  for (const item of input.poam) if (!input.gaps.some((gap) => gap.poam === item.id && gap.id === item.gap)) throw new Error(`POA&M ${item.id} is orphaned`);
  return input.gaps.map((gap) => {
    const accepted = acceptanceFor(gap, input.acceptances, input.now);
    if (accepted) return { id: gap.id, state: 'risk-accepted', acceptedUntil: accepted.expiresAt, overdue: false };
    const progress = evidenceProgress(gap, input.rows);
    if (progress === 'closed') return { id: gap.id, state: 'closed', overdue: false };
    if (progress === 'in-progress') return { id: gap.id, state: 'in-progress', overdue: false };
    const poam = gap.poam === undefined ? undefined : poamById.get(gap.poam);
    const milestone = poam?.milestones[0];
    const overdue = poam?.milestones.some((entry) => entry.targetDate !== undefined && Date.parse(`${entry.targetDate}T00:00:00.000Z`) < input.now.getTime()) ?? false;
    if (gap.closesInPhase !== undefined || poam !== undefined) return { id: gap.id, state: 'planned', ...(gap.closesInPhase !== undefined ? { phase: gap.closesInPhase } : milestone?.phase ? { phase: milestone.phase } : {}), overdue };
    return { id: gap.id, state: 'open', overdue: false };
  });
}

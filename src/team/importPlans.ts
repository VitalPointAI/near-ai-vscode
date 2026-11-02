// Stub for the RED commit: the importer is not written yet.
import type { GsdGraph, GsdMilestone } from '../domain/team/gsdImport';
import type { ItemImportedBody, TeamState } from '../domain/team/types';
import type { EventIntent, TeamLog } from './eventLog';
import type { GitRunner } from './runGit';

export const IMPORT_NOOP = 'import: nothing to change';
export const NOT_IN_ROADMAP = 'no longer in the roadmap';
export const WITHHELD_TEXT = '(withheld: text that looks like a secret)';
export const IMPORT_STATE_FILE = 'import.json';
export interface ImportSource { projectRoot: string; ref?: string; remote?: string; branch?: string }
export type ImportResult =
  | { ok: true; written: number; upToDate: boolean; milestone: string; withheld: number; reopenNeeded: number; warnings: string[]; skipped?: 'unchanged-tree' | 'stale-source' }
  | { ok: false; message: string; written: number };

const notWritten = (): never => { throw new Error('not implemented'); };
export function graphToItems(_graph: GsdGraph, _options: { sourceCommit: string }): { bodies: ItemImportedBody[]; withheld: number; warnings: string[] } { return notWritten(); }
export function fitItemBody(_body: ItemImportedBody): { body: ItemImportedBody; warning?: string } { return notWritten(); }
export function diffImport(_state: Pick<TeamState, 'items'>, _bodies: readonly ItemImportedBody[], _options: { milestoneId: string; current: boolean; sourceCommit: string }): EventIntent[] { return notWritten(); }
export async function importPlans(_input: { log: TeamLog; source: ImportSource; storageDir: string; milestone?: string; mode: 'auto' | 'command'; git?: GitRunner }): Promise<ImportResult> { return notWritten(); }
export function importResultText(_result: ImportResult): string { return notWritten(); }
export async function listImportableMilestones(_source: ImportSource, _git?: GitRunner): Promise<GsdMilestone[]> { return notWritten(); }

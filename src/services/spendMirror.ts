// RED stub: replaced in the next commit.
import type { ProjectStateHome } from './stateHome';

export interface SpendMirrorOptions { ledgerRoot: string; projectScopeId: string; home: ProjectStateHome; recentMonths?: number }
export interface ProjectSpendMonth { month: string; requests: number; confirmedUsd: number; estimatedUsd: number; byModel: Array<{ model: string; requests: number; usd: number }> }

export async function mirrorProjectSpend(_options: SpendMirrorOptions): Promise<number> { return 0; }
export async function readProjectSpend(_home: ProjectStateHome): Promise<ProjectSpendMonth[]> { return []; }
export function formatProjectSpend(_months: readonly ProjectSpendMonth[]): string { return ''; }

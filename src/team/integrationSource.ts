// Reads the project's GSD files from the team's integration branch as committed on the remote (D-01). Not implemented yet.
import type { GitRunner } from './runGit';

export const INTEGRATION_REF_PREFIX = 'refs/near-ai/integration/';
export const MAX_PLANNING_FILE_BYTES = 256 * 1024;

export type FetchOutcome = { ok: true; ref: string; commit: string } | { ok: false; kind: 'missing' | 'offline'; reason: string };

export interface PlanningSnapshot {
  commit: string;
  treeHash: string | undefined;
  paths: string[];
  files: Map<string, string>;
  oversize: string[];
  truncated: boolean;
}

export function integrationRef(_branch: string): string {
  throw new Error('not implemented');
}

export async function fetchIntegrationBranch(_projectRoot: string, _remote: string, _branch: string, _git?: GitRunner): Promise<FetchOutcome> {
  throw new Error('not implemented');
}

export async function readPlanningSnapshot(_projectRoot: string, _ref: string, _wanted: (path: string) => boolean, _git?: GitRunner): Promise<PlanningSnapshot> {
  throw new Error('not implemented');
}

export const TEAM_PREVIEW_PATH = '/services/near-team-preview';
export const TeamPreviewService = Symbol('TeamPreviewService');

export interface TeamPreviewProject {
  readonly id: string;
  readonly title: string;
}

export interface TeamPreviewMember {
  readonly name: string;
  readonly role?: string;
  readonly reportsTo?: string;
  readonly instructions: string;
}

export interface TeamPreviewTeam {
  readonly name: string;
  readonly description: string;
  readonly members: readonly TeamPreviewMember[];
}

export type TeamPreviewResult =
  | { readonly kind: 'ready'; readonly team: TeamPreviewTeam }
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

export interface TeamPreviewService {
  listProjects(): Promise<readonly TeamPreviewProject[]>;
  readProject(id: string): Promise<TeamPreviewResult>;
}

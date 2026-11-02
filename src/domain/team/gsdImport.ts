// Pure GSD parser (D-06 to D-09): turns the texts of ROADMAP.md, STATE.md and the *-PLAN.md files into a graph of one milestone, its phases, plans and tasks.
// No I/O, no clock, no vscode: the caller passes texts and paths in.
export interface GsdTask { index: number; title: string; type: string; files: string[] }
export interface GsdPlan {
  phase: string; plan: string; path: string; title: string; wave?: number; dependsOn: string[]; filesModified: string[]; requirements: string[];
  truths: string[]; estimateTokens?: number; confidence?: 'low' | 'medium' | 'high'; gapClosure: boolean; hasSummary: boolean; tasks: GsdTask[];
}
export interface GsdPhase { number: string; title: string; dependsOn: string[]; requirements: string[] }
export interface GsdMilestone { key: string; title: string; current: boolean }
export interface GsdGraph { milestone: GsdMilestone; phases: GsdPhase[]; plans: GsdPlan[]; milestones: GsdMilestone[]; warnings: string[] }
export interface GsdSource { paths: readonly string[]; files: ReadonlyMap<string, string> }
export interface PlanFrontmatter {
  phase?: string; plan?: string; wave?: number; dependsOn: string[]; filesModified: string[]; requirements: string[]; truths: string[];
  autonomous?: boolean; gapClosure: boolean; estimateTokens?: number; estimateTasks?: number; confidence?: 'low' | 'medium' | 'high';
}
export interface RoadmapMilestone { key: string; title: string; shipped: boolean; paused: boolean; current: boolean; marked: boolean; first?: string; last?: string }
export interface RoadmapPlanEntry { phase: string; plan: string; title: string; checked: boolean; wave?: number; requirements: string[] }
export interface RoadmapPhase { number: string; title: string; dependsOn: string[]; requirements: string[]; plans: RoadmapPlanEntry[] }
export interface RoadmapSection { key: string; title: string; phases: RoadmapPhase[] }
export interface Roadmap { milestones: RoadmapMilestone[]; sections: RoadmapSection[]; problems: string[] }

const NOT_IMPLEMENTED = 'not implemented';

export function planIdentity(_path: string): { phase: string; plan: string; kind: 'plan' | 'summary' } | undefined {
  throw new Error(NOT_IMPLEMENTED);
}
export function normalisePhase(_raw: string): string {
  throw new Error(NOT_IMPLEMENTED);
}
export function parseFrontmatter(_text: string): { fields: PlanFrontmatter | undefined; problems: string[] } {
  throw new Error(NOT_IMPLEMENTED);
}
export function parsePlanTasks(_text: string): GsdTask[] {
  throw new Error(NOT_IMPLEMENTED);
}
export function parseRoadmap(_text: string): Roadmap {
  throw new Error(NOT_IMPLEMENTED);
}
export function currentMilestoneKey(_roadmap: Roadmap, _stateText: string | undefined): string | undefined {
  throw new Error(NOT_IMPLEMENTED);
}
export function buildGsdGraph(_source: GsdSource, _options?: { milestone?: string }): GsdGraph | { error: string } {
  throw new Error(NOT_IMPLEMENTED);
}

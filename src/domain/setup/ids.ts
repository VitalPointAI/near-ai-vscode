// GUIDE-03, GUIDE-06, GUIDE-07. Pure: no I/O, no clock, no vscode, no package.
import type { EndpointClass } from '../gate/endpoints';
import { ENDPOINT_ID_PATTERN } from '../gate/endpoints';

export const GUIDE_SCREEN_IDS = Object.freeze(['kind-of-work', 'data', 'data-personal', 'data-contract', 'canada', 'checking', 'options', 'check-answers', 'stopped', 'applying', 'done'] as const);
export type GuideScreenId = (typeof GUIDE_SCREEN_IDS)[number];
export const SETUP_STEP_IDS = Object.freeze(['connection', 'software-team', 'staff-team', 'local-models', 'spending-limit', 'web-search', 'research-verifiers', 'mcp', 'my-computers', 'share-with-people', 'policy', 'secure-workflow', 'data-connections', 'change-answers'] as const);
export type KnownSetupStepId = (typeof SETUP_STEP_IDS)[number];
export const SETUP_STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export type GetStartedTarget = GuideScreenId | KnownSetupStepId | 'checklist' | 'join';
export function isGetStartedTarget(value: unknown): value is GetStartedTarget { return typeof value === 'string' && ([...GUIDE_SCREEN_IDS, ...SETUP_STEP_IDS, 'checklist', 'join'] as string[]).includes(value); }

export const OPTION_KINDS = Object.freeze(['this-computer', 'org-server', 'org-tee', 'near-private', 'near-all', 'vendor-tee', 'vendor-region'] as const);
export type OptionKind = (typeof OPTION_KINDS)[number];
export const OPTION_KIND_CLASS: Readonly<Record<OptionKind, EndpointClass>> = Object.freeze({ 'this-computer': 'local', 'org-server': 'org-plain', 'org-tee': 'org-tee', 'near-private': 'nearai-tee', 'near-all': 'forwarded', 'vendor-tee': 'vendor-tee', 'vendor-region': 'vendor-region' });
export const OPTIONS_WITHOUT_ADAPTER = Object.freeze(['org-tee', 'vendor-tee', 'vendor-region'] as const);
export function optionIdOf(kind: OptionKind, endpointId?: string): string { return endpointId && ['org-server', 'org-tee', 'near-private', 'near-all', 'vendor-tee', 'vendor-region'].includes(kind) ? `${kind}:${endpointId}` : kind; }
export function parseOptionId(text: unknown): { kind: OptionKind; endpointId?: string } | undefined {
  if (typeof text !== 'string') return undefined;
  const [kindText, endpointId, ...rest] = text.split(':');
  if (rest.length || !OPTION_KINDS.includes(kindText as OptionKind) || (endpointId !== undefined && !ENDPOINT_ID_PATTERN.test(endpointId))) return undefined;
  return endpointId === undefined ? { kind: kindText as OptionKind } : { kind: kindText as OptionKind, endpointId };
}
export const STEP_DONE_CONTEXT_PREFIX = 'nearAi.setup.done.';
export const STEP_SHOWN_CONTEXT_PREFIX = 'nearAi.setup.show.';
export const stepDoneContextKey = (id: string): string => `${STEP_DONE_CONTEXT_PREFIX}${id}`;
export const stepShownContextKey = (id: string): string => `${STEP_SHOWN_CONTEXT_PREFIX}${id}`;
export const KIND_OF_WORK_STATE_KEY = 'nearAi.setup.kindOfWork';
export const GET_STARTED_COMMAND = 'nearAi.setup';
export const CHANGE_ANSWERS_COMMAND = 'nearAi.setup.changeAnswers';

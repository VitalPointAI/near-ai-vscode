import { redactSecrets } from './redaction';

export type PromptAnswerKind = 'choice' | 'free-form';
export type PromptState = 'active' | 'waiting' | 'cancelled' | 'answered' | 'resumed';
export type ProgressCardState = 'started' | 'running' | 'waiting' | 'approval' | 'retry' | 'completed' | 'cancelled' | 'failed';

export interface PromptChoice {
  id: string;
  label: string;
  description?: string;
}

export interface StructuredPrompt {
  sessionId: string;
  promptId: string;
  question: string;
  choices: PromptChoice[];
  freeForm?: { enabled: true; label?: string; placeholder?: string; minLength?: number; maxLength?: number };
  state: PromptState;
  phase?: string;
  plans: string[];
}

export type PromptResponse =
  | { type: 'prompt-choice'; sessionId: string; promptId: string; choiceId: string }
  | { type: 'prompt-answer'; sessionId: string; promptId: string; text: string }
  | { type: 'prompt-cancel'; sessionId: string; promptId: string }
  | { type: 'prompt-resume'; sessionId: string; promptId: string };

export interface ProgressCard {
  type: 'progress-card';
  id: string;
  sessionId?: string;
  state: ProgressCardState;
  project?: string;
  phase?: string;
  action: string;
  tool?: string;
  model?: string;
  agent?: string;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  approvalRequired?: boolean;
  summary: string;
  recovery?: string;
  live: 'polite' | 'assertive' | 'off';
  reducedMotionSafe: true;
}

const SESSION_ID = /^session-[a-z0-9-]{8,80}$/;
const PROMPT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function isPromptId(value: unknown): value is string { return typeof value === 'string' && PROMPT_ID.test(value); }
export function isSessionId(value: unknown): value is string { return typeof value === 'string' && SESSION_ID.test(value); }

export function normalizePrompt(value: unknown): StructuredPrompt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!isSessionId(input.sessionId) || !isPromptId(input.promptId) || typeof input.question !== 'string') return undefined;
  if (input.question.length === 0 || input.question.length > 600 || /(?:api[-_ ]?key|bearer\s|authorization\s*[:=]|private prompt)/i.test(input.question)) return undefined;
  if (!Array.isArray(input.choices) || input.choices.length > 12) return undefined;
  const choices: PromptChoice[] = [];
  for (const value of input.choices) {
    if (!value || typeof value !== 'object') return undefined;
    const choice = value as Record<string, unknown>;
    if (typeof choice.id !== 'string' || !SAFE_ID.test(choice.id) || typeof choice.label !== 'string' || !choice.label || choice.label.length > 160) return undefined;
    if (choice.description !== undefined && (typeof choice.description !== 'string' || choice.description.length > 300)) return undefined;
    choices.push({ id: choice.id, label: choice.label, description: choice.description as string | undefined });
  }
  const freeForm = input.freeForm;
  let rules: StructuredPrompt['freeForm'];
  if (freeForm !== undefined) {
    if (!freeForm || typeof freeForm !== 'object' || (freeForm as Record<string, unknown>).enabled !== true) return undefined;
    const item = freeForm as Record<string, unknown>;
    if (item.minLength !== undefined && (!Number.isInteger(item.minLength) || (item.minLength as number) < 0 || (item.minLength as number) > 4000)) return undefined;
    if (item.maxLength !== undefined && (!Number.isInteger(item.maxLength) || (item.maxLength as number) < 1 || (item.maxLength as number) > 4000)) return undefined;
    if (typeof item.minLength === 'number' && typeof item.maxLength === 'number' && item.minLength > item.maxLength) return undefined;
    rules = { enabled: true, label: typeof item.label === 'string' ? item.label.slice(0, 120) : undefined, placeholder: typeof item.placeholder === 'string' ? item.placeholder.slice(0, 160) : undefined, minLength: item.minLength as number | undefined, maxLength: item.maxLength as number | undefined };
  }
  return { sessionId: input.sessionId, promptId: input.promptId, question: input.question.trim(), choices, freeForm: rules, state: input.state === 'waiting' ? 'waiting' : 'active', phase: typeof input.phase === 'string' ? input.phase.slice(0, 120) : undefined, plans: Array.isArray(input.plans) ? input.plans.filter((item): item is string => typeof item === 'string').slice(0, 20) : [] };
}

export function validatePromptResponse(response: PromptResponse, prompt: StructuredPrompt | undefined): boolean {
  if (!prompt || response.sessionId !== prompt.sessionId || response.promptId !== prompt.promptId || (prompt.state !== 'active' && prompt.state !== 'waiting')) return false;
  if (response.type === 'prompt-choice') return prompt.choices.some((choice) => choice.id === response.choiceId);
  if (response.type === 'prompt-answer') return Boolean(prompt.freeForm?.enabled) && response.text.length <= (prompt.freeForm?.maxLength ?? 4000) && response.text.trim().length >= (prompt.freeForm?.minLength ?? 1) && !/(?:api[-_ ]?key|bearer\s|authorization\s*[:=])/i.test(response.text);
  return true;
}

export function safeProgressText(value: string | undefined): string {
  if (!value) return '';
  return redactSecrets(value).replace(/(?:private prompt|chain[- ]of[- ]thought|environment values?|raw command output)[^.;]*/gi, '[REDACTED CONTEXT]').replace(/(?:^|\s)(?:\/home|\/Users|[A-Z]:\\)[^\s]*/g, '[REDACTED PATH]').slice(0, 240);
}

export interface LifecycleInput { state: string; command?: string; text?: string; sessionId?: string; phase?: string; action?: string; tool?: string; model?: string; agent?: string; agentCount?: number; attempt?: number; retry?: boolean; approvalRequired?: boolean; }

export function progressCardFromEvent(event: LifecycleInput, index = 0): ProgressCard {
  const state: ProgressCardState = event.approvalRequired ? 'approval' : event.state === 'output' ? 'running' : event.state === 'waiting' ? 'waiting' : event.state === 'retry' ? 'retry' : ['started', 'running', 'completed', 'cancelled', 'failed'].includes(event.state) ? event.state as ProgressCardState : 'running';
  const summary = safeProgressText(event.text) || `${event.command ? `Open-GSD /${event.command}` : 'NEAR AI work'} ${state}.`;
  const action = event.action || event.tool || event.command || 'assistant work';
  return { type: 'progress-card', id: `${event.sessionId ?? 'live'}-${index}`, sessionId: isSessionId(event.sessionId) ? event.sessionId : undefined, state, phase: event.phase?.slice(0, 120), action, tool: event.tool, model: event.model, agent: event.agent, agentCount: typeof event.agentCount === 'number' && event.agentCount >= 0 ? Math.floor(event.agentCount) : undefined, attempt: typeof event.attempt === 'number' && event.attempt > 0 ? Math.floor(event.attempt) : undefined, retry: event.retry === true, approvalRequired: event.approvalRequired === true, summary, recovery: state === 'failed' ? 'Review the failure and retry the action or continue from the saved session.' : state === 'cancelled' ? 'Resume this session when you are ready.' : state === 'approval' || state === 'waiting' ? 'Review the request and choose a safe next step.' : state === 'completed' ? 'Continue from the completed session or start another action.' : undefined, live: state === 'failed' ? 'assertive' : state === 'completed' || state === 'cancelled' ? 'polite' : 'polite', reducedMotionSafe: true };
}

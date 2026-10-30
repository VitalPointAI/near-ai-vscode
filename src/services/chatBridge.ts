import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ModelInfo, NearAiError, SpendLimitError } from './nearAiClient';
import { redactSecrets } from '../domain/redaction';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { ActivitySessionSummary, AttributionSnapshot } from '../domain/activity';
import { normalizePrompt, PromptResponse, StructuredPrompt, isPromptId, isSessionId, progressCardFromEvent, ProgressCard, safeProgressText } from '../domain/chatProgress';
import { parseGsdPlanningState } from '../domain/gsdStatus';
import type { OrganizationProfile } from '../domain/auth';
import type { ActionPolicyMode } from '../domain/policy';
import { isPolicyMode } from './approvalPolicy';

/** The longest message the composer may send to a running agent. */
export const MAX_MESSAGE_CHARS = 100_000;

/**
 * Messages about one conversation may name it (`conversationId`): the view sends the one on
 * screen, so a reply never reaches a conversation the user has switched away from. Without it
 * (host requests, older callers) the message is for the conversation on screen.
 */
export type ChatWebviewMessage =
  | { type: 'load-models' }
  | { type: 'open-setup' }
  | { type: 'refresh-status' }
  | { type: 'chat-ready' }
  | { type: 'open-command'; command: string; args?: string; model?: string; conversationId?: string }
  | { type: 'questions-reply'; id: string; answers: string[]; conversationId?: string }
  | { type: 'agent-control'; agentId: string; action: 'pause' | 'resume' | 'stop' }
  /** Opens a saved conversation as a tab, or shows it if it is already open. */
  | { type: 'resume-conversation'; id: string }
  | { type: 'open-artifact'; path: string; kind: GsdArtifactKind }
  | { type: 'send'; text: string; model?: string; overrideToken?: string; attachmentIds?: string[]; conversationId?: string }
  /** A message typed while a run is going: queued for the running agent, or sent as a new turn if it has ended. */
  | { type: 'steer'; id: string; text: string; conversationId?: string }
  | { type: 'attach-files' }
  | { type: 'attachment-remove'; id: string }
  /** Stops one conversation's run (the emergency stop stops them all). */
  | { type: 'stop'; conversationId?: string }
  /** The user's choice in the composer's approval-policy picker. */
  | { type: 'set-action-policy'; mode: ActionPolicyMode }
  /** Starts a new conversation alongside the open ones (or clears the one on screen if it is still empty). */
  | { type: 'new-chat' }
  | { type: 'switch-conversation'; id: string }
  /** Closes a conversation's tab; a running one is stopped first, once the user confirms. Its transcript stays in history. */
  | { type: 'close-conversation'; id: string }
  | { type: 'open-tools' }
  /** The spend line's token link: the host decides what it runs (set the token, or turn NEAR's total back on). */
  | { type: 'reporting-token' }
  | { type: 'open-activity'; agentId?: string }
  | { type: 'select-profile' }
  | { type: 'approval-reply'; callId: string; decision: 'allow' | 'allow-run' | 'allow-always' | 'deny'; feedback?: string; conversationId?: string }
  | { type: 'revert-run'; runId: string; conversationId?: string }
  | { type: 'verify-response'; runId: string; conversationId?: string }
  | { type: 'insert-code'; text: string }
  | { type: 'prompt-choice'; sessionId: string; promptId: string; choiceId: string }
  | { type: 'prompt-answer'; sessionId: string; promptId: string; text: string }
  | { type: 'prompt-cancel'; sessionId: string; promptId: string }
  | { type: 'prompt-resume'; sessionId: string; promptId: string };

export interface ProfileStatusView {
  projectScope: string;
  activeProfileId?: string;
  profiles: Array<Pick<OrganizationProfile, 'profileId' | 'displayName' | 'organization' | 'provider' | 'baseUrl' | 'authMode' | 'validation'>>;
  configured: boolean;
}
  
export function profileStatusMessage(profiles: OrganizationProfile[], projectScope: string, activeProfileId: string | undefined, configured: boolean): ProfileStatusView {
  return {
    projectScope,
    activeProfileId,
    configured,
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      displayName: profile.displayName,
      organization: profile.organization,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      authMode: profile.authMode,
      validation: { ...profile.validation }
    }))
  };
}

export type ChatPromptMessage = PromptResponse;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatModelOption {
  id: string;
  label: string;
  /** "tee" when NEAR runs the model in an attested TEE; "forwarded" when NEAR sends it to another provider. */
  privacy: 'tee' | 'local' | 'forwarded' | 'unknown';
  forwardedTo?: string;
}

/** Short, user-facing privacy wording for a model, shared by every chat surface. */
export function modelPrivacyLabel(model?: Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'>): string {
  if (model?.privacyBoundary === 'tee') return 'Private · runs in NEAR TEE';
  if (model?.privacyBoundary === 'local') return 'Local · runs on this machine';
  if (model?.privacyBoundary === 'cloud') return model.forwardedTo ? `Not private · forwarded to ${model.forwardedTo}` : 'Not private · forwarded';
  return 'Privacy unknown';
}

export interface GsdArtifactLink {
  label: string;
  path: string;
  kind: GsdArtifactKind;
}

export type GsdArtifactKind = 'file' | 'directory';

export interface ChatSessionSummary {
  sessionId: string;
  project: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  plans: string[];
  agents: ActivitySessionSummary['agents'];
  models: string[];
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  approvals: ActivitySessionSummary['approvals'];
  startedAt: string;
  updatedAt: string;
  outcome: ActivitySessionSummary['outcome'];
  continuationAvailable: boolean;
  context: ActivitySessionSummary['context'];
}

export function sessionSummaryMessage(session: ActivitySessionSummary): ChatSessionSummary {
  return {
    sessionId: session.sessionId,
    project: session.project,
    attribution: session.attribution ? { ...session.attribution } : undefined,
    phase: session.phase,
    plans: [...session.plans],
    agents: { ...session.agents },
    models: [...session.models],
    estimatedCostUsd: session.estimatedCostUsd,
    actualCostUsd: session.actualCostUsd,
    approvals: { ...session.approvals },
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    outcome: session.outcome,
    continuationAvailable: session.continuationAvailable,
    context: { ...session.context }
  };
}

const artifactNames = /^(STATE|ROADMAP|.*-(?:PLAN|SUMMARY|VERIFICATION))\.md$/;

export function isSafeArtifactPath(root: string, relativePath: string): boolean {
  const planningRoot = path.resolve(root, '.planning');
  const candidate = path.resolve(root, relativePath);
  return (candidate === planningRoot || candidate.startsWith(`${planningRoot}${path.sep}`)) && !relativePath.split(/[\\/]/).includes('..');
}

export async function discoverGsdArtifacts(root: string): Promise<GsdArtifactLink[]> {
  const planningRoot = path.join(root, '.planning');
  const found: GsdArtifactLink[] = [];
  let planningState = '';
  try { planningState = await fs.readFile(path.join(planningRoot, 'STATE.md'), 'utf8'); } catch { return []; }
  const currentPhase = parseGsdPlanningState(planningState).currentPhase;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && artifactNames.test(entry.name)) {
        const artifactPath = path.relative(root, absolute).split(path.sep).join('/');
        found.push({ label: artifactPath, path: artifactPath, kind: 'file' });
      }
    }
  };
  await visit(planningRoot);
  if (currentPhase !== null) {
    try {
      const phaseEntries = await fs.readdir(path.join(planningRoot, 'phases'), { withFileTypes: true });
      const matches = phaseEntries.filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name) && Number(entry.name.split('-', 1)[0]) === currentPhase);
      if (matches.length === 1) {
        const artifactPath = path.relative(root, path.join(planningRoot, 'phases', matches[0].name)).split(path.sep).join('/');
        found.push({ label: `${artifactPath}/`, path: artifactPath, kind: 'directory' });
      }
    } catch { /* Missing or inaccessible phase state is a safe empty result. */ }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export interface GsdCommandProgressMessage {
  type: 'command-progress';
  state: 'started' | 'running' | 'output' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  command: string;
  text?: string;
  exitCode?: number | null;
  phase?: string;
  action?: string;
  tool?: string;
  model?: string;
  agent?: string;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  approvalRequired?: boolean;
}

export function promptMessage(prompt: unknown): StructuredPrompt | undefined { return normalizePrompt(prompt); }

export function progressCardMessage(event: Parameters<typeof progressCardFromEvent>[0], index = 0): ProgressCard {
  return progressCardFromEvent(event, index);
}

export function promptResponseMessage(value: unknown): ChatPromptMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  if (!['prompt-choice', 'prompt-answer', 'prompt-cancel', 'prompt-resume'].includes(String(message.type)) || !isSessionId(message.sessionId) || !isPromptId(message.promptId)) return undefined;
  const allowed = message.type === 'prompt-choice' ? ['type', 'sessionId', 'promptId', 'choiceId'] : message.type === 'prompt-answer' ? ['type', 'sessionId', 'promptId', 'text'] : ['type', 'sessionId', 'promptId'];
  if (Object.keys(message).some((key) => !allowed.includes(key))) return undefined;
  if (message.type === 'prompt-choice' && typeof message.choiceId === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(message.choiceId)) return { type: 'prompt-choice', sessionId: message.sessionId, promptId: message.promptId, choiceId: message.choiceId };
  if (message.type === 'prompt-answer' && typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 4000 && !/(?:api[-_ ]?key|bearer\s|authorization\s*[:=])/i.test(message.text)) return { type: 'prompt-answer', sessionId: message.sessionId, promptId: message.promptId, text: message.text.trim() };
  if (message.type === 'prompt-cancel' || message.type === 'prompt-resume') return { type: message.type, sessionId: message.sessionId, promptId: message.promptId };
  return undefined;
}

const CONVERSATION_ID = /^conv-[a-z0-9-]{6,60}$/;

/** The optional `conversationId`: absent, or a well-formed one; anything else rejects the message. */
function conversationOf(message: Record<string, unknown>): { ok: boolean; field: { conversationId?: string } } {
  if (message.conversationId === undefined) return { ok: true, field: {} };
  return typeof message.conversationId === 'string' && CONVERSATION_ID.test(message.conversationId) ? { ok: true, field: { conversationId: message.conversationId } } : { ok: false, field: {} };
}

export function parseChatWebviewMessage(value: unknown): ChatWebviewMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  const conversation = conversationOf(message);
  if (!conversation.ok) return undefined;
  const scoped = conversation.field;
  if (message.type === 'set-action-policy') {
    if (Object.keys(message).length !== 2 || !isPolicyMode(message.mode)) return undefined;
    return { type: 'set-action-policy', mode: message.mode };
  }
  if (message.type === 'approval-reply') {
    if (Object.keys(message).some((key) => !['type', 'callId', 'decision', 'feedback', 'conversationId'].includes(key))) return undefined;
    if (typeof message.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(message.callId)) return undefined;
    if (message.decision !== 'allow' && message.decision !== 'allow-run' && message.decision !== 'allow-always' && message.decision !== 'deny') return undefined;
    if (message.feedback !== undefined && (typeof message.feedback !== 'string' || message.feedback.length > 2000)) return undefined;
    return { type: 'approval-reply', callId: message.callId, decision: message.decision, ...(message.feedback ? { feedback: message.feedback as string } : {}), ...scoped };
  }
  if ((message.type === 'revert-run' || message.type === 'verify-response') && typeof message.runId === 'string' && /^run-\d+-[a-f0-9]{6}$/.test(message.runId) && Object.keys(message).every((key) => key === 'type' || key === 'runId' || key === 'conversationId')) return { type: message.type, runId: message.runId, ...scoped };
  if ((message.type === 'switch-conversation' || message.type === 'close-conversation') && typeof message.id === 'string' && CONVERSATION_ID.test(message.id) && Object.keys(message).length === 2) return { type: message.type, id: message.id };
  if (message.type === 'insert-code' && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 100_000) {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'text')) return undefined;
    return { type: 'insert-code', text: message.text };
  }
  if (message.type === 'stop') {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'conversationId')) return undefined;
    return { type: 'stop', ...scoped };
  }
  if (message.type === 'load-models' || message.type === 'open-setup' || message.type === 'refresh-status' || message.type === 'new-chat' || message.type === 'open-tools' || message.type === 'reporting-token' || message.type === 'select-profile' || message.type === 'chat-ready') {
    if (Object.keys(message).some((key) => key !== 'type')) return undefined;
    return { type: message.type };
  }
  const promptResponse = promptResponseMessage(value);
  if (promptResponse) return promptResponse;
  if (message.type === 'open-artifact' && typeof message.path === 'string' && message.path.length > 0 && message.path.length < 300 && !message.path.startsWith('/') && !message.path.split(/[\\/]/).includes('..') && (message.kind === 'file' || message.kind === 'directory')) {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'path' && key !== 'kind')) return undefined;
    return { type: 'open-artifact', path: message.path, kind: message.kind };
  }
  // Slash commands name an installed Open-GSD skill; the host checks it exists in the installed version.
  if (message.type === 'open-command' && typeof message.command === 'string' && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(message.command)) {
    if (Object.keys(message).some((key) => !['type', 'command', 'args', 'model', 'conversationId'].includes(key))) return undefined;
    if (message.args !== undefined && (typeof message.args !== 'string' || message.args.length > 4000)) return undefined;
    if (message.model !== undefined && (typeof message.model !== 'string' || message.model.length > 200)) return undefined;
    return { type: 'open-command', command: message.command, ...(message.args ? { args: (message.args as string).trim() } : {}), ...(message.model ? { model: (message.model as string).trim() } : {}), ...scoped };
  }
  if (message.type === 'attach-files' && Object.keys(message).length === 1) return { type: 'attach-files' };
  if (message.type === 'attachment-remove' && typeof message.id === 'string' && /^att-[a-f0-9]{12}$/.test(message.id) && Object.keys(message).length === 2) return { type: 'attachment-remove', id: message.id };
  if (message.type === 'open-activity') {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'agentId')) return undefined;
    if (message.agentId === undefined) return { type: 'open-activity' };
    return typeof message.agentId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i.test(message.agentId) ? { type: 'open-activity', agentId: message.agentId } : undefined;
  }
  if (message.type === 'agent-control' && typeof message.agentId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i.test(message.agentId) && (message.action === 'pause' || message.action === 'resume' || message.action === 'stop') && Object.keys(message).length === 3) {
    return { type: 'agent-control', agentId: message.agentId, action: message.action };
  }
  if (message.type === 'resume-conversation' && typeof message.id === 'string' && /^conv-[a-z0-9-]{6,60}$/.test(message.id) && Object.keys(message).length === 2) return { type: 'resume-conversation', id: message.id };
  if (message.type === 'questions-reply' && typeof message.id === 'string' && /^q-[a-f0-9]{12}$/.test(message.id) && Array.isArray(message.answers)) {
    if (Object.keys(message).some((key) => !['type', 'id', 'answers', 'conversationId'].includes(key))) return undefined;
    if (message.answers.length > 4 || message.answers.some((answer) => typeof answer !== 'string' || answer.length > 4000)) return undefined;
    return { type: 'questions-reply', id: message.id, answers: message.answers as string[], ...scoped };
  }
  if (message.type === 'steer') {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'id' && key !== 'text' && key !== 'conversationId')) return undefined;
    if (typeof message.id !== 'string' || !/^steer-[a-f0-9]{12}$/.test(message.id)) return undefined;
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_MESSAGE_CHARS) return undefined;
    return { type: 'steer', id: message.id, text: message.text.trim(), ...scoped };
  }
  if (message.type !== 'send' || typeof message.text !== 'string' || !message.text.trim()) return undefined;
  if (Object.keys(message).some((key) => key !== 'type' && key !== 'text' && key !== 'model' && key !== 'overrideToken' && key !== 'attachmentIds' && key !== 'conversationId')) return undefined;
  if (message.attachmentIds !== undefined && (!Array.isArray(message.attachmentIds) || message.attachmentIds.length > 10 || message.attachmentIds.some((id) => typeof id !== 'string' || !/^att-[a-f0-9]{12}$/.test(id)))) return undefined;
  if (message.overrideToken !== undefined && (typeof message.overrideToken !== 'string' || !/^privacy-[0-9a-f-]{36}$/.test(message.overrideToken))) return undefined;
  return {
    type: 'send',
    text: message.text.trim(),
    model: typeof message.model === 'string' ? message.model.trim() || undefined : undefined,
    ...(message.overrideToken ? { overrideToken: message.overrideToken as string } : {}),
    ...(Array.isArray(message.attachmentIds) && message.attachmentIds.length ? { attachmentIds: message.attachmentIds as string[] } : {}),
    ...scoped
  };
}

export function promptResponseMatches(response: PromptResponse, prompt: StructuredPrompt | undefined): boolean {
  if (!prompt || response.sessionId !== prompt.sessionId || response.promptId !== prompt.promptId) return false;
  if (response.type === 'prompt-choice') return prompt.choices.some((choice) => choice.id === response.choiceId);
  if (response.type === 'prompt-answer') return Boolean(prompt.freeForm?.enabled) && response.text.length <= (prompt.freeForm?.maxLength ?? 4000) && response.text.trim().length >= (prompt.freeForm?.minLength ?? 1);
  return true;
}

export function progressActivitySummary(card: ProgressCard): string {
  const state = card.state === 'approval' ? 'Approval required' : card.state[0].toUpperCase() + card.state.slice(1);
  return safeProgressText(`${state}: ${card.action}${card.tool ? ` · tool ${card.tool}` : ''}${card.phase ? ` · ${card.phase}` : ''}${card.model ? ` · model ${card.model}` : ''}${card.agent ? ` · agent ${card.agent}` : ''}${card.agentCount !== undefined ? ` · ${card.agentCount} agents` : ''}${card.attempt ? ` · attempt ${card.attempt}` : ''}${card.retry ? ' · retry' : ''}${card.approvalRequired ? ' · approval required' : ''}`);
}

/**
 * Models a run may hand work to (sub-agents, tiers, image generation) without the user picking
 * them: on the same route as the chosen model (local or cloud) and at least as private. A run on a
 * TEE model never reaches a forwarded one; a local run stays on this machine.
 */
export function modelsAsPrivateAs(models: ModelInfo[], chosen: ModelInfo | undefined): ModelInfo[] {
  const boundary = chosen?.privacyBoundary;
  if (boundary === 'local') return models.filter((model) => model.privacyBoundary === 'local');
  const cloud = models.filter((model) => model.privacyBoundary !== 'local');
  return boundary === 'tee' ? cloud.filter((model) => model.privacyBoundary === 'tee') : cloud;
}

/**
 * The auto mode's safety model: the wanted model when it runs privately (in NEAR's TEE, or on a
 * local runtime) on the same route as the chat, otherwise none, so unclear commands ask instead
 * of going to a forwarded model.
 */
export function privateSafetyModel(models: ModelInfo[], chosen: ModelInfo | undefined, wanted: string): string | undefined {
  const candidate = modelsAsPrivateAs(models, chosen).find((model) => model.id === wanted.trim());
  return candidate && (candidate.privacyBoundary === 'tee' || candidate.privacyBoundary === 'local') ? candidate.id : undefined;
}

/** Embedding, reranking, and speech models cannot hold a conversation. */
export function isChatModel(model: Pick<ModelInfo, 'id'>): boolean {
  return model.id.trim().length > 0 && !/(?:embed|rerank|whisper|tts|speech|moderation)/i.test(model.id);
}

/** The configured default when the provider offers it, otherwise the first private chat model, otherwise the first chat model. */
export function defaultChatModel(models: ModelInfo[], configured?: string): string | undefined {
  const chat = models.filter(isChatModel);
  return chat.find((model) => model.id === configured?.trim())?.id ?? chat.find((model) => model.privacyBoundary === 'tee')?.id ?? chat[0]?.id;
}

export function modelOptions(models: ModelInfo[], configured?: string): ChatModelOption[] {
  const preferred = defaultChatModel(models, configured);
  const rank = (model: ModelInfo) => (model.id === preferred ? 0 : model.privacyBoundary === 'tee' || model.privacyBoundary === 'local' ? 1 : 2);
  return models
    .filter(isChatModel)
    .sort((a, b) => rank(a) - rank(b))
    .map((model) => ({
      id: model.id,
      label: [model.id, modelPrivacyLabel(model), model.inputPricePerMillion === undefined ? undefined : `$${model.inputPricePerMillion}/$${model.outputPricePerMillion ?? 0} per 1M`].filter(Boolean).join(' · '),
      privacy: model.privacyBoundary === 'tee' ? 'tee' : model.privacyBoundary === 'local' ? 'local' : model.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown',
      ...(model.forwardedTo ? { forwardedTo: model.forwardedTo } : {})
    }));
}

export function appendUserTurn(history: ConversationTurn[], text: string): ConversationTurn[] {
  return [...history, { role: 'user', content: text.trim() }];
}

export function appendAssistantTurn(history: ConversationTurn[], text: string): ConversationTurn[] {
  if (!text) return history;
  return [...history, { role: 'assistant', content: text }];
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof NearAiError) {
    const request = error.requestId ? ` Request ID: ${error.requestId}.` : '';
    if (error.status === 401 || error.status === 403) return `NEAR AI rejected the request. Check your API key in Setup.${request}`;
    if (error.status === 402) return `NEAR spend limit reached: NEAR AI Cloud refused the request because your organization's credits or this API key's spend limit are used up${error.detail ? ` (NEAR says: ${error.detail})` : ''}. Add credits or raise the key's limit in the NEAR AI Cloud console.${request}`;
    if (error.status === 429) return `NEAR AI is rate limiting requests${error.model ? ` to ${error.model}` : ''}${error.detail ? ` (NEAR says: ${error.detail})` : ''}. Wait a moment and try again, or switch to another model.${request}`;
    return `${error.message}${request}`;
  }
  // The daily limit (nearAi.dailySpendLimitUsd) stopped the request before it was sent.
  if (error instanceof SpendLimitError) return error.message;
  // The agent loop gave up after NEAR kept refusing a model, or after the model kept going quiet
  // mid-reply; its message already says what happened and what to do.
  if (error instanceof Error && (error.name === 'ModelUnavailableError' || error.name === 'ModelStalledError')) return redactSecrets(error.message);
  return 'The NEAR AI request could not be completed. Check your connection and try again.';
}

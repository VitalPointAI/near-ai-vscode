import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../domain/redaction';
import { ActivityApprovalSummary, ActivityEvent, ActivityLedger, ActivitySessionSummary, ActivityStatus, AttributionSnapshot, emptyAgentCounts, normalizeAttribution, sessionOutcome, summarizeAgentCounts } from '../domain/activity';
import type { UsageMetadata } from './nearAiClient';

export interface ActivityFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
}
const defaultFileSystem: ActivityFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: (file, encoding) => fs.readFile(file, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding)
};
const STORE_VERSION = 1 as const;
const SESSION_ID = /^session-[a-z0-9-]{8,80}$/;
export interface ActivityStoreOptions { clock?: () => string; fileSystem?: ActivityFileSystem; maxSessions?: number; maxEventsPerSession?: number; }
export interface StartSessionInput { sessionId?: string; project: string; phase?: string; plans?: string[]; model?: string; summary?: string; attribution?: AttributionSnapshot; }
export interface ActivityUpdate {
  status: ActivityStatus;
  kind?: ActivityEvent['kind'];
  summary: string;
  phase?: string;
  plan?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  tool?: string;
  action?: string;
  route?: string;
  requestId?: string;
  cacheHit?: boolean;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  approvalRequired?: boolean;
  errorCode?: string;
}

export class ActivityStore {
  private readonly fileSystem: ActivityFileSystem;
  private readonly clock: () => string;
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private ledger: ActivityLedger = { version: STORE_VERSION, sessions: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  public constructor(private readonly workspaceRoot: string, options: ActivityStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.maxSessions = Math.max(1, Math.min(100, options.maxSessions ?? 30));
    this.maxEventsPerSession = Math.max(1, Math.min(500, options.maxEventsPerSession ?? 100));
  }
  public get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'activity.json'); }
  public async list(): Promise<ActivitySessionSummary[]> { await this.load(); return this.ledger.sessions.map(cloneSession); }
  public async get(sessionId: string): Promise<ActivitySessionSummary | undefined> {
    if (!SESSION_ID.test(sessionId)) return undefined;
    await this.load();
    const session = this.ledger.sessions.find((candidate) => candidate.sessionId === sessionId);
    return session ? cloneSession(session) : undefined;
  }
  public async start(input: StartSessionInput): Promise<ActivitySessionSummary> {
    await this.load();
    const now = this.clock();
    const sessionId = input.sessionId ?? `session-${randomUUID()}`;
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid activity session identifier.');
    const project = safeText(input.project, 160) ?? 'Unknown project';
    const attribution = normalizeAttribution(input.attribution, project);
    const session: ActivitySessionSummary = { version: STORE_VERSION, sessionId, project, attribution, phase: safeText(input.phase, 120), plans: uniqueSafeText(input.plans ?? [], 120), agents: emptyAgentCounts(), models: input.model ? uniqueSafeText([input.model], 160) : [], approvals: emptyApprovals(), startedAt: now, updatedAt: now, outcome: 'running', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: [] };
    this.ledger.sessions = [session, ...this.ledger.sessions.filter((candidate) => candidate.sessionId !== sessionId)].slice(0, this.maxSessions);
    await this.persist();
    return input.summary ? this.append(sessionId, { status: 'running', summary: input.summary, kind: 'session' }) : cloneSession(session);
  }
  public async append(sessionId: string, update: ActivityUpdate): Promise<ActivitySessionSummary> {
    await this.load();
    const session = this.ledger.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error('Activity session was not found.');
    const kind = update.kind ?? 'session';
    const event: ActivityEvent = { id: `${sessionId}-${session.events.length + 1}`, sessionId, timestamp: this.clock(), attribution: clone(session.attribution), kind, status: update.status, summary: operationalSummary(kind, update.summary), phase: safeText(update.phase ?? session.phase, 120), agentId: safeText(update.agentId, 120), agentRole: safeText(update.agentRole, 120), model: safeText(update.model, 160), tool: safeText(update.tool, 120), action: safeText(update.action, 120), route: safeText(update.route, 160), requestId: safeText(update.requestId, 160), cacheHit: update.cacheHit === true, agentCount: safeInteger(update.agentCount), attempt: safeInteger(update.attempt), retry: update.retry === true, estimatedCostUsd: safeNumber(update.estimatedCostUsd), actualCostUsd: safeNumber(update.actualCostUsd), inputTokens: safeInteger(update.inputTokens), outputTokens: safeInteger(update.outputTokens), durationMs: safeInteger(update.durationMs), approvalRequired: update.approvalRequired === true, errorCode: safeText(update.errorCode, 80) };
    session.events = [...session.events, event].slice(-this.maxEventsPerSession); session.updatedAt = event.timestamp;
    if (event.phase) session.phase = event.phase; if (update.plan) session.plans = uniqueSafeText([...session.plans, update.plan], 120); if (event.model) session.models = uniqueSafeText([...session.models, event.model], 160);
    if (event.estimatedCostUsd !== undefined) session.estimatedCostUsd = event.estimatedCostUsd; if (event.actualCostUsd !== undefined) session.actualCostUsd = event.actualCostUsd;
    if (event.kind === 'agent') session.agents = summarizeAgentCounts(session.events);
    if (event.kind === 'approval') { session.approvals.required += event.approvalRequired ? 1 : 0; if (event.status === 'completed') session.approvals.approved += 1; session.approvals.pending = Math.max(0, session.approvals.required - session.approvals.approved); }
    if (event.kind === 'message') { if (event.summary.toLocaleLowerCase().includes('user message')) session.context.userTurns += 1; if (event.summary.toLocaleLowerCase().includes('assistant response')) session.context.assistantTurns += 1; }
    session.context.lastEvent = event.summary; session.outcome = sessionOutcome(update.status); session.continuationAvailable = session.outcome !== 'running';
    await this.persist(); return cloneSession(session);
  }
  /** Append provider-reported values without replacing or inventing the estimate. */
  public async reconcile(sessionId: string, usage: Pick<UsageMetadata, 'requestId' | 'inputTokens' | 'outputTokens' | 'actualCostUsd' | 'latencyMs'>): Promise<ActivitySessionSummary> {
    if (!usage.requestId) throw new Error('A provider request ID is required for reconciliation.');
    return this.append(sessionId, { status: 'completed', kind: 'model', summary: 'Provider usage reconciled.', requestId: usage.requestId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actualCostUsd: usage.actualCostUsd, durationMs: usage.latencyMs });
  }
  private async load(): Promise<void> {
    if (this.loaded) return; this.loaded = true;
    try { const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<ActivityLedger>; if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.sessions)) throw new Error('Unsupported activity ledger.'); this.ledger = { version: STORE_VERSION, sessions: parsed.sessions.map(normalizeSession).filter((value): value is ActivitySessionSummary => Boolean(value)).slice(0, this.maxSessions) }; } catch { this.ledger = { version: STORE_VERSION, sessions: [] }; }
  }
  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.ledger)}\n`; const directory = path.dirname(this.filePath); const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.writeQueue = this.writeQueue.then(async () => { await this.fileSystem.mkdir(directory, { recursive: true }); await this.fileSystem.writeFile(temporary, payload, 'utf8'); await this.fileSystem.rename(temporary, this.filePath); }); await this.writeQueue;
  }
}
function emptyApprovals(): ActivityApprovalSummary { return { required: 0, approved: 0, pending: 0 }; }
function safeText(value: string | undefined, max: number): string | undefined { if (!value) return undefined; const text = value.replace(/[\r\n\t]+/g, ' ').trim(); return text ? text.slice(0, max) : undefined; }
function operationalSummary(kind: ActivityEvent['kind'], value: string): string {
  if (kind === 'message') {
    const lower = value.toLocaleLowerCase();
    if (lower.includes('user message')) return 'User message received.';
    if (lower.includes('assistant response')) return 'Assistant response completed.';
    return 'Conversation message recorded without content.';
  }
  return safeText(redactMedia(redactSecrets(value).replace(/(?:raw )?private prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/(?:generation|user) prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/raw command output[^.;]*/gi, '[REDACTED CONTEXT]').replace(/command\s*[:=]\s*[^\s,;]+/gi, 'command=[REDACTED]')), 240) ?? 'Activity update';
}
function redactMedia(value: string): string { return value.replace(/data:[^\s,;]+/gi, '[REDACTED MEDIA]').replace(/raw media[^.;]*/gi, '[REDACTED MEDIA]').replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[REDACTED MEDIA]'); }
function uniqueSafeText(values: string[], max: number): string[] { return [...new Set(values.map((value) => safeText(value, max)).filter((value): value is string => Boolean(value)))].slice(0, 20); }
function safeNumber(value: number | undefined): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function safeInteger(value: number | undefined): number | undefined { return safeNumber(value) === undefined ? undefined : Math.floor(value as number); }
function cloneSession(session: ActivitySessionSummary): ActivitySessionSummary { return JSON.parse(JSON.stringify(session)) as ActivitySessionSummary; }
function normalizeSession(value: unknown): ActivitySessionSummary | undefined {
  if (!value || typeof value !== 'object') return undefined; const session = value as Partial<ActivitySessionSummary>; if (typeof session.sessionId !== 'string' || !SESSION_ID.test(session.sessionId)) return undefined;
  const project = safeText(session.project, 160) ?? 'Unknown project';
  const attribution = normalizeAttribution(session.attribution, project);
  const sessionId = session.sessionId;
  const events = Array.isArray(session.events) ? session.events.filter((event): event is ActivityEvent => Boolean(event && typeof event === 'object')).slice(-100).map((event) => normalizeEvent(event, sessionId, attribution)) : [];
  return { version: STORE_VERSION, sessionId, project, attribution, phase: safeText(session.phase, 120), plans: uniqueSafeText(Array.isArray(session.plans) ? session.plans.filter((item): item is string => typeof item === 'string') : [], 120), agents: { ...emptyAgentCounts(), ...(session.agents ?? {}) }, models: uniqueSafeText(Array.isArray(session.models) ? session.models.filter((item): item is string => typeof item === 'string') : [], 160), estimatedCostUsd: safeNumber(session.estimatedCostUsd), actualCostUsd: safeNumber(session.actualCostUsd), approvals: { ...emptyApprovals(), ...(session.approvals ?? {}) }, startedAt: typeof session.startedAt === 'string' ? session.startedAt : new Date(0).toISOString(), updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date(0).toISOString(), outcome: session.outcome === 'completed' || session.outcome === 'failed' || session.outcome === 'cancelled' || session.outcome === 'setup-blocked' ? session.outcome : 'running', continuationAvailable: session.continuationAvailable !== false, context: { userTurns: session.context?.userTurns ?? 0, assistantTurns: session.context?.assistantTurns ?? 0, lastEvent: safeText(session.context?.lastEvent, 240) }, events };
}

function normalizeEvent(value: ActivityEvent, sessionId: string, attribution: AttributionSnapshot): ActivityEvent {
  return { ...value, id: safeText(value.id, 120) ?? `${sessionId}-legacy`, sessionId, timestamp: typeof value.timestamp === 'string' ? value.timestamp.slice(0, 40) : new Date(0).toISOString(), attribution: clone(attribution), summary: operationalSummary(value.kind, value.summary), requestId: safeText(value.requestId, 160), cacheHit: value.cacheHit === true, phase: safeText(value.phase, 120), agentId: safeText(value.agentId, 120), agentRole: safeText(value.agentRole, 120), model: safeText(value.model, 160), route: safeText(value.route, 160), action: safeText(value.action, 120), tool: safeText(value.tool, 120), agentCount: safeInteger(value.agentCount), attempt: safeInteger(value.attempt), retry: value.retry === true, estimatedCostUsd: safeNumber(value.estimatedCostUsd), actualCostUsd: safeNumber(value.actualCostUsd), inputTokens: safeInteger(value.inputTokens), outputTokens: safeInteger(value.outputTokens), durationMs: safeInteger(value.durationMs), approvalRequired: value.approvalRequired === true, errorCode: safeText(value.errorCode, 80) };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

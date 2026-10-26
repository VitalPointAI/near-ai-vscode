import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditEvent, AuditFilter } from '../domain/approval';
import { normalizeAttribution } from '../domain/activity';
import type { StakeHistoryEntry } from '../domain/staking';

const MAX_EVENTS = 500;
const MAX_TEXT = 240;

export class AuditStore {
  private events: AuditEvent[] = [];
  private loaded = false;
  private loading?: Promise<void>;
  public constructor(private readonly workspaceRoot?: string, private readonly now: () => number = Date.now) {}

  public async append(event: AuditEvent): Promise<void> {
    if (!isAuditEventType(event.type)) return;
    await this.rehydrate();
    this.events.push(redactEvent(event));
    this.events = this.events.slice(-MAX_EVENTS);
    await this.persist();
  }
  public async appendType(type: AuditEvent['type'], values: Omit<AuditEvent, 'version' | 'id' | 'timestamp' | 'type'> = {}): Promise<AuditEvent> {
    const event = redactEvent({ version: 1, id: `audit-${randomUUID().replaceAll('-', '').slice(0, 16)}`, timestamp: new Date(this.now()).toISOString(), type, ...values });
    await this.append(event);
    return structuredClone(event);
  }
  public async list(filter: AuditFilter = {}): Promise<AuditEvent[]> { await this.rehydrate(); return this.events.filter((event) => matches(event, filter)).map(clone); }
  public async export(filter: AuditFilter = {}): Promise<string> { return JSON.stringify({ version: 1, events: await this.list(filter) }); }
  public async clear(): Promise<void> { this.events = []; await this.persist(); }
  public get size(): number { return this.events.length; }
  public async rehydrate(): Promise<void> {
    if (this.loaded) return this.loading;
    this.loaded = true;
    this.loading = (async () => {
      if (!this.workspaceRoot) return;
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { version?: number; events?: unknown[] };
        if (parsed.version !== 1 || !Array.isArray(parsed.events)) return;
        this.events = parsed.events.slice(-MAX_EVENTS).map(normalizeEvent).filter((event): event is AuditEvent => Boolean(event));
      } catch { this.events = []; }
    })();
    return this.loading;
  }
  private get filePath(): string { return path.join(this.workspaceRoot ?? '', '.planning', '.near-ai', 'audit.json'); }
  private async persist(): Promise<void> {
    if (!this.workspaceRoot) return;
    const file = this.filePath; const temporary = `${file}.${process.pid}.tmp`;
    try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temporary, `${JSON.stringify({ version: 1, events: this.events.slice(-MAX_EVENTS) })}\n`, 'utf8'); await fs.rename(temporary, file); } catch { try { await fs.rm(temporary, { force: true }); } catch { /* best effort */ } }
  }
}

function redactEvent(event: AuditEvent): AuditEvent {
  const safe: AuditEvent = {
    version: 1,
    id: safeText(event.id, 80) ?? `audit-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    timestamp: safeText(event.timestamp, 40) ?? new Date(0).toISOString(),
    type: event.type,
    attribution: normalizeAttribution(event.attribution, event.projectId),
    sessionId: safeText(event.sessionId, 100),
    projectId: safeText(event.projectId, 100),
    phase: safeText(event.phase, 120),
    agentId: safeText(event.agentId, 120),
    agentRole: safeText(event.agentRole, 80),
    model: safeText(event.model, 160),
    provider: safeText(event.provider, 120),
    capability: event.capability,
    requestId: safeText(event.requestId, 160),
    previewId: safeText(event.previewId, 160),
    outcome: safeText(event.outcome, 120),
    reason: event.reason ? redactText(event.reason) : undefined,
    estimatedCostUsd: safeNumber(event.estimatedCostUsd),
    actualCostUsd: safeNumber(event.actualCostUsd),
    estimatedTokens: safeInteger(event.estimatedTokens),
    actualTokens: safeInteger(event.actualTokens),
    budgetStatus: event.budgetStatus,
    dataClasses: event.dataClasses ? [...new Set(event.dataClasses)] : undefined,
    scopeSummary: event.scopeSummary ? redactText(event.scopeSummary) : undefined,
    wallet: event.wallet ? redactWallet(event.wallet) : undefined,
    metadata: event.metadata ? Object.fromEntries(Object.entries(event.metadata).filter(([key]) => !/(secret|token|key|password|prompt|command|context|output|path)/i.test(key)).map(([key, value]) => [safeText(key, 40), typeof value === 'string' ? redactText(value) : value])) : undefined
  };
  return safe;
}
function redactText(value: string): string { return value.replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').replace(/((?:api[-_ ]?key|token|secret|password)\s*[:=])\s*[^\s,;]+/gi, '$1 [REDACTED]').replace(/-----BEGIN [\s\S]*?-----END [\s\S]*?-----/gi, '[PRIVATE KEY REDACTED]').replace(/private prompt|raw context|tool output|command\s*[:=].*/gi, '[SENSITIVE CONTENT REDACTED]').slice(0, MAX_TEXT); }
function matches(event: AuditEvent, filter: AuditFilter): boolean { return (!filter.sessionId || event.sessionId === filter.sessionId) && (!filter.projectId || event.projectId === filter.projectId || event.attribution?.projectId === filter.projectId) && (!filter.organizationProfileId || event.attribution?.organizationProfileId === filter.organizationProfileId) && (!filter.phase || event.phase === filter.phase) && (!filter.agentId || event.agentId === filter.agentId) && (!filter.agentRole || event.agentRole === filter.agentRole) && (!filter.model || event.model === filter.model) && (!filter.type || event.type === filter.type) && (!filter.from || event.timestamp >= filter.from) && (!filter.to || event.timestamp <= filter.to); }
function normalizeEvent(value: unknown): AuditEvent | undefined { if (!value || typeof value !== 'object') return undefined; const event = value as Partial<AuditEvent>; if (event.version !== 1 || typeof event.id !== 'string' || typeof event.timestamp !== 'string' || typeof event.type !== 'string' || !isAuditEventType(event.type)) return undefined; return redactEvent({ ...event, version: 1, id: event.id.slice(0, 80), timestamp: event.timestamp.slice(0, 40), type: event.type }); }
function isAuditEventType(value: unknown): value is AuditEvent['type'] { return typeof value === 'string' && ['preflight', 'route', 'preview', 'approval', 'dispatch', 'denial', 'retry', 'pause', 'resume', 'cancellation', 'budget', 'emergency-stop', 'completed', 'failed', 'setup-blocked', 'near-wallet'].includes(value); }
function safeText(value: unknown, max: number): string | undefined { return typeof value === 'string' && !/[\r\n\t]/.test(value) && value.trim() ? redactText(value.trim()).slice(0, max) : undefined; }
function safeNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function safeInteger(value: unknown): number | undefined { const result = safeNumber(value); return result === undefined ? undefined : Math.floor(result); }
function redactWallet(value: StakeHistoryEntry): StakeHistoryEntry | undefined {
  if (!value || value.version !== 1 || !safeWalletAccount(value.accountId) || !safeWalletLabel(value.networkId) || !safeWalletAccount(value.validatorAccount) || !['stake', 'unstake', 'withdraw', 'credit', 'balance'].includes(value.operation) || !safeText(value.timestamp, 40) || !['submitted', 'pending', 'confirmed', 'failed', 'cancelled', 'observed', 'unavailable'].includes(value.status)) return undefined;
  return { version: 1, accountId: value.accountId, networkId: value.networkId, validatorAccount: value.validatorAccount, operation: value.operation, amountYocto: typeof value.amountYocto === 'string' && /^(?:0|[1-9][0-9]{0,47})$/.test(value.amountYocto) ? value.amountYocto : undefined, transactionId: typeof value.transactionId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value.transactionId) ? value.transactionId : undefined, timestamp: value.timestamp, status: value.status, outcome: redactText(value.outcome).slice(0, MAX_TEXT) };
}
function safeWalletAccount(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function safeWalletLabel(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

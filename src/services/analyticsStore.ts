import type { ActivityEvent, AgentCounts, AttributionSnapshot } from '../domain/activity';
import { emptyAgentCounts, normalizeAttribution } from '../domain/activity';
import type { AnalyticsActivitySource, AnalyticsAuditSource, AnalyticsCostGroup, AnalyticsCostSummary, AnalyticsExport, AnalyticsFilter, AnalyticsResult, AgentFleetSnapshot, AgentSnapshot, AnalyticsReputationSource, AnalyticsTimelineEvent, ReputationEvidenceSummary, AnalyticsMemorySource } from '../domain/analytics';
import type { AuditEvent, AuditFilter } from '../domain/approval';
import type { ReputationEvidence } from '../domain/routing';
import { redactSecrets } from '../domain/redaction';

const MAX_EVENTS = 500;
const MAX_LIMIT = 100;
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value) ? redactMedia(redactSecrets(value.trim().replace(/(?:raw )?private prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/(?:generation|user) prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=[REDACTED]')).slice(0, max)) : undefined;
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class AnalyticsStore {
  public constructor(private readonly activity: AnalyticsActivitySource, private readonly audit?: AnalyticsAuditSource, private readonly reputation?: AnalyticsReputationSource, private readonly clock: () => string = () => new Date().toISOString(), private readonly memory?: AnalyticsMemorySource) {}

  public async query(filter: AnalyticsFilter = {}): Promise<AnalyticsResult> {
    const safe = normalizeFilter(filter);
    const sessions = this.activity.sessions.filter((s) => {
      const attribution = normalizeAttribution(s.attribution, s.project);
      return (!safe.sessionId || s.sessionId === safe.sessionId) && (!safe.projectId || attribution.projectId === safe.projectId) && (!safe.organizationProfileId || attribution.organizationProfileId === safe.organizationProfileId) && (!safe.phase || s.phase === safe.phase);
    });
    const activityEvents = sessions.flatMap((session) => {
      const attribution = normalizeAttribution(session.attribution, session.project);
      return session.events.map((event) => ({ ...event, attribution: normalizeAttribution(event.attribution ?? attribution, attribution.projectLabel) }));
    });
    const events = activityEvents.filter((event) => matches(event, safe)).slice(-MAX_EVENTS);
    const auditFilter: AuditFilter = { sessionId: safe.sessionId, projectId: safe.projectId, organizationProfileId: safe.organizationProfileId, phase: safe.phase, model: safe.model, agentId: safe.agentId, from: safe.from, to: safe.to };
    const audits = this.audit ? await this.audit.list(auditFilter) : [];
    const agents = snapshots(events);
    const evidence = this.reputation ? await this.reputation.list() : [];
    const filteredEvidence = evidence.filter((row) => !safe.role || row.role === safe.role);
    const memoryAudits = this.memory ? await this.memory.getAudit() : [];
    const timeline = [...events.map(toActivityTimeline), ...audits.map(toAuditTimeline), ...filteredEvidence.map(toReputationTimeline), ...memoryAudits.map(toMemoryTimeline)].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-MAX_EVENTS);
    const reputation = await this.reputationSummaries(filteredEvidence);
    const cost = summarizeCost(events, audits);
    const latency = summarizeLatency(events);
    const models: Record<string, number> = {};
    for (const event of events) if (event.model) models[event.model] = (models[event.model] ?? 0) + 1;
    const offset = safe.offset ?? 0; const limit = safe.limit ?? 50;
    const fleet: AgentFleetSnapshot = { counts: counts(agents), agents: agents.slice(offset, offset + limit), timeline: timeline.slice(offset, offset + limit), cost, latency, models, reputation };
    return clone({ filter: safe, fleet, timeline: fleet.timeline, agents: fleet.agents, cost, latency, models, reputation, totalEvents: timeline.length });
  }

  public async export(filter: AnalyticsFilter = {}): Promise<string> { const result = await this.query(filter); const payload: AnalyticsExport = { version: 1, exportedAt: this.clock(), result }; return JSON.stringify(payload); }

  private async reputationSummaries(rows: ReputationEvidence[]): Promise<ReputationEvidenceSummary[]> {
    const grouped = new Map<string, ReputationEvidence[]>();
    for (const row of rows) grouped.set(`${row.profileId}:${row.role}`, [...(grouped.get(`${row.profileId}:${row.role}`) ?? []), row]);
    return Promise.all([...grouped.entries()].map(async ([, evidence]) => { const score = this.reputation ? await this.reputation.getScore(evidence[0].profileId, evidence[0].role) : undefined; return { profileId: evidence[0].profileId, role: evidence[0].role, score: score?.score, evidenceCount: evidence.length, components: score?.components, evidence: evidence.slice(0, 20).map(({ evidenceId, kind, value, recordedAt, source, outcome }) => ({ evidenceId, kind, value, recordedAt, source, outcome })) }; }));
  }
}

function normalizeFilter(filter: AnalyticsFilter): AnalyticsFilter { return { sessionId: text(filter.sessionId, 100), projectId: text(filter.projectId), organizationProfileId: text(filter.organizationProfileId, 80), phase: text(filter.phase, 120), model: text(filter.model), role: text(filter.role, 40), agentId: text(filter.agentId, 120), from: text(filter.from, 40), to: text(filter.to, 40), offset: Math.max(0, Math.min(1000, Math.floor(number(filter.offset)))), limit: Math.max(1, Math.min(MAX_LIMIT, Math.floor(number(filter.limit)) || 50)) }; }
function matches(event: ActivityEvent & { attribution: AttributionSnapshot }, filter: AnalyticsFilter): boolean { return (!filter.projectId || event.attribution.projectId === filter.projectId) && (!filter.organizationProfileId || event.attribution.organizationProfileId === filter.organizationProfileId) && (!filter.model || event.model === filter.model) && (!filter.role || event.agentRole === filter.role) && (!filter.agentId || event.agentId === filter.agentId) && (!filter.from || event.timestamp >= filter.from) && (!filter.to || event.timestamp <= filter.to); }
function safeSummary(value: string): string { return (text(redactSecrets(value).replace(/(?:raw )?private prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/(?:generation|user) prompt[^.;]*/gi, '[REDACTED CONTEXT]').replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=[REDACTED]'), 240) ?? 'Activity recorded'); }
function redactMedia(value: string): string { return value.replace(/data:[^\s,;]+/gi, '[REDACTED MEDIA]').replace(/raw media[^.;]*/gi, '[REDACTED MEDIA]').replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[REDACTED MEDIA]'); }
function toActivityTimeline(event: ActivityEvent & { attribution: AttributionSnapshot }): AnalyticsTimelineEvent { return { id: event.id, timestamp: event.timestamp, source: 'activity', kind: event.kind, summary: safeSummary(event.summary), sessionId: event.sessionId, projectId: event.attribution.projectId, projectLabel: event.attribution.projectLabel, organizationProfileId: event.attribution.organizationProfileId, organizationDisplayName: event.attribution.organizationDisplayName, attributionStatus: event.attribution.status, phase: event.phase, agentId: event.agentId, role: event.agentRole, model: event.model, route: event.route, status: event.status, requestId: event.requestId }; }
function toAuditTimeline(event: AuditEvent): AnalyticsTimelineEvent { const attribution = normalizeAttribution(event.attribution, event.projectId); return { id: event.id, timestamp: event.timestamp, source: 'audit', kind: event.type, summary: text(event.reason ?? event.outcome ?? event.type, 240) ?? event.type, sessionId: event.sessionId, projectId: attribution.projectId, projectLabel: attribution.projectLabel, organizationProfileId: attribution.organizationProfileId, organizationDisplayName: attribution.organizationDisplayName, attributionStatus: attribution.status, phase: event.phase, agentId: event.agentId, model: event.model, requestId: event.requestId }; }
function toReputationTimeline(event: ReputationEvidence): AnalyticsTimelineEvent { return { id: event.evidenceId, timestamp: event.recordedAt, source: 'reputation', kind: event.kind, summary: `Reputation evidence ${event.kind} recorded.`, agentId: event.profileId, role: event.role, evidenceId: event.evidenceId, status: event.outcome }; }
function toMemoryTimeline(event: import('../domain/contextGraph').MemoryAuditMetadata): AnalyticsTimelineEvent { return { id: `memory-${event.operation}-${event.graphVersion}-${event.scope.kind}-${event.scope.id}`, timestamp: event.timestamp, source: 'memory', kind: `memory-${event.operation}`, summary: `Bounded memory ${event.operation} ${event.outcome} for ${event.scope.kind}.`, scope: `${event.scope.kind}:${event.scope.id}`, nodeIds: event.nodeIds.slice(0, 20), edgeIds: event.edgeIds.slice(0, 20), status: event.outcome }; }
function snapshots(events: Array<ActivityEvent & { attribution: AttributionSnapshot }>): AgentSnapshot[] { const latest = new Map<string, AgentSnapshot>(); for (const event of events) { if (event.kind !== 'agent' || !event.agentId) continue; latest.set(`${event.attribution.projectId}:${event.agentId}`, { agentId: event.agentId, role: event.agentRole, task: safeSummary(event.action ?? event.summary), model: event.model, route: event.route, status: event.status, tokens: optionalSum(event.inputTokens, event.outputTokens), estimatedCostUsd: event.estimatedCostUsd, actualCostUsd: event.actualCostUsd, durationMs: event.durationMs, approvalRequired: event.approvalRequired === true, errorCode: event.errorCode, outcome: event.status === 'completed' ? 'success' : event.status === 'failed' ? 'failure' : undefined, updatedAt: event.timestamp, attribution: event.attribution }); } return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function counts(agents: AgentSnapshot[]): AgentCounts { const result = emptyAgentCounts(); result.deployed = agents.length; for (const agent of agents) { if (agent.status === 'running') result.active++; if (agent.status === 'waiting') result.waiting++; if (agent.status === 'completed') result.completed++; if (agent.status === 'failed') result.failed++; if (agent.status === 'cancelled') result.cancelled++; } return result; }
function summarizeCost(events: Array<ActivityEvent & { attribution: AttributionSnapshot }>, audits: AuditEvent[]): AnalyticsCostSummary {
  type Contribution = { attribution: AttributionSnapshot; request: boolean; input?: number; output?: number; estimate?: number; actual?: number; cache: boolean };
  const contributions = new Map<string, Contribution>();
  const observe = (key: string, attribution: AttributionSnapshot, source: Omit<Contribution, 'attribution'>): void => {
    const current = contributions.get(key);
    if (!current) { contributions.set(key, { attribution, ...source }); return; }
    current.request ||= source.request;
    current.input = maxKnown(current.input, source.input);
    current.output = maxKnown(current.output, source.output);
    current.estimate = maxKnown(current.estimate, source.estimate);
    current.actual = maxKnown(current.actual, source.actual);
    current.cache ||= source.cache;
  };
  for (const event of events) {
    const key = event.requestId ? `activity:${event.requestId}` : `event:${event.id}`;
    observe(key, event.attribution, { request: event.kind === 'session' || event.kind === 'agent' || event.kind === 'model', input: event.inputTokens, output: event.outputTokens, estimate: event.estimatedCostUsd, actual: event.actualCostUsd, cache: event.cacheHit === true });
  }
  for (const event of audits) {
    const key = event.requestId ? `activity:${event.requestId}` : `audit:${event.id}`;
    observe(key, normalizeAttribution(event.attribution, event.projectId), { request: Boolean(event.requestId), input: event.estimatedTokens, output: event.actualTokens, estimate: event.estimatedCostUsd, actual: event.actualCostUsd, cache: false });
  }
  const groups = new Map<string, AnalyticsCostGroup>();
  for (const contribution of contributions.values()) {
    const key = attributionKey(contribution.attribution);
    const group = groups.get(key) ?? { attribution: contribution.attribution, requests: 0, cacheHits: 0 };
    if (contribution.request) group.requests += 1;
    group.inputTokens = addKnown(group.inputTokens, contribution.input);
    group.outputTokens = addKnown(group.outputTokens, contribution.output);
    group.estimatedUsd = addKnown(group.estimatedUsd, contribution.estimate);
    group.actualUsd = addKnown(group.actualUsd, contribution.actual);
    if (contribution.cache) group.cacheHits += 1;
    groups.set(key, group);
  }
  const list = [...groups.values()].sort((a, b) => attributionKey(a.attribution).localeCompare(attributionKey(b.attribution)));
  return { requests: list.reduce((sum, group) => sum + group.requests, 0), inputTokens: optionalTotal(list.map((group) => group.inputTokens)), outputTokens: optionalTotal(list.map((group) => group.outputTokens)), estimatedUsd: optionalTotal(list.map((group) => group.estimatedUsd)), actualUsd: optionalTotal(list.map((group) => group.actualUsd)), cacheHits: list.reduce((sum, group) => sum + group.cacheHits, 0), groups: list };
}
function summarizeLatency(events: ActivityEvent[]) { const values = events.map((event) => event.durationMs).filter((value): value is number => typeof value === 'number' && value >= 0).sort((a, b) => a - b); return { count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), averageMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined, p95Ms: values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)] : undefined }; }
function attributionKey(value: AttributionSnapshot): string { return `${value.organizationProfileId}:${value.projectId}`; }
function optionalSum(...values: Array<number | undefined>): number | undefined { const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0); return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined; }
function optionalTotal(values: Array<number | undefined>): number | undefined { return optionalSum(...values); }
function maxKnown(current: number | undefined, next: number | undefined): number | undefined { return current === undefined ? next : next === undefined ? current : Math.max(current, next); }
function addKnown(current: number | undefined, next: number | undefined): number | undefined { return current === undefined ? next : next === undefined ? current : current + next; }

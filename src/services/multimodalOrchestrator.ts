import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActivityStatus } from '../domain/activity';
import type { AuditEvent } from '../domain/approval';
import type { DataClass, ProviderRequest } from '../domain/privacy';
import type { AttributionSnapshot } from '../domain/activity';
import type { ActionCapability } from '../domain/policy';
import type { CapabilityModality, CapabilityReasonCode, CapabilityRequirement } from '../domain/capabilities';
import { CapabilityRouter } from './capabilityRouter';
import type { ModelInfo } from './nearAiClient';
import { cloneMultimodal, MAX_DERIVED_ARTIFACTS, MAX_LINEAGE_SOURCES, type AttachmentPrivacyState, type AttachmentProvenance, type AttachmentRecord, type ArtifactKind, type DerivedArtifact, type LineageEdge, type MultimodalApprovalPreview, type MultimodalLedger, type MultimodalOperation, type MultimodalOperationRecord, type MultimodalReasonCode, type MultimodalRoute, type OperationLifecycle, MULTIMODAL_VERSION } from '../domain/multimodal';
import { ActivityStore } from './activityStore';
import { MultimodalIntake } from './multimodalIntake';
import { PolicyGate } from './policyGate';
import { PrivacyPreflight } from './privacyPreflight';

export interface MultimodalPrepareInput {
  operation: MultimodalOperation;
  sourceArtifactIds: string[];
  route: MultimodalRoute;
  sessionId?: string;
  projectId?: string;
  attribution?: AttributionSnapshot;
  estimatedCostUsd?: number;
  rawContentRequested?: boolean;
  privacyOverrideToken?: string;
}

export interface MultimodalExecutionInput {
  operation: MultimodalOperation;
  sourceArtifactIds: string[];
  route: MultimodalRoute;
  rawHandles: Array<{ artifactId: string; managedPath: string; contentHash: string }>;
  signal?: AbortSignal;
}

export interface MultimodalExecutionOutput {
  kind: ArtifactKind;
  label: string;
  contentHash?: string;
  managedReference?: string;
  safePreview?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  publicationEligible?: boolean;
}

export interface MultimodalOrchestratorOptions {
  privacy?: PrivacyPreflight;
  policyGate?: PolicyGate;
  intake: MultimodalIntake;
  activity?: ActivityStore;
  audit?: { append(event: AuditEvent): Promise<void> | void };
  clock?: () => number;
  approvalTtlMs?: number;
  budgetLimitUsd?: number;
  /** Host policy owns the stop switch; the orchestrator only observes it. */
  emergencyStop?: () => boolean;
  execute?: (input: MultimodalExecutionInput) => Promise<MultimodalExecutionOutput>;
}

/**
 * Resolve a multimodal route from the current host catalog. The caller must
 * provide the model chosen by host settings; no webview route facts are used.
 */
export async function selectMultimodalRoute(
  router: CapabilityRouter,
  provider: string,
  model: string,
  operation: MultimodalOperation,
  sourceModalities: readonly CapabilityModality[]
): Promise<MultimodalRoute> {
  if (operation === 'publish') throw new MultimodalOperationError('operation-not-supported', 'Publication uses its separate managed-artifact approval flow.');
  const snapshot = await router.describe(provider, model);
  if (!snapshot) throw new MultimodalOperationError('unknown-capability', 'The selected provider/model has no current declared capability metadata.');
  const requirement: CapabilityRequirement = {
    requirementId: `multimodal:${operation}`,
    inputModality: sourceModalities[0],
    skill: operation === 'transcribe' ? 'transcribe' : 'analyze',
    providerOperation: operation === 'transcribe' ? 'audio-transcription' : undefined,
    privacyBoundary: snapshot.privacyBoundary,
    requiresCostEstimate: true,
    requiresCancellation: true
  };
  const evaluation = await router.evaluate({
    provider: snapshot.provider,
    model: snapshot.modelId,
    locality: snapshot.locality === 'unknown' ? 'cloud' : snapshot.locality,
    privacyBoundary: snapshot.privacyBoundary
  }, requirement);
  if (!evaluation.compatible || !evaluation.snapshot) throw new MultimodalOperationError(multimodalCapabilityReason(evaluation.reasons), 'The provider/model does not expose a current compatible multimodal route.');
  const providerBoundary = evaluation.snapshot.privacyBoundary === 'local' || evaluation.snapshot.locality === 'local'
    ? 'local'
    : evaluation.snapshot.privacyBoundary === 'tee' ? 'tee' : 'cloud';
  return {
    provider: evaluation.snapshot.provider,
    model: evaluation.snapshot.modelId,
    providerBoundary,
    privacyBoundary: evaluation.snapshot.privacyBoundary,
    capabilitySnapshotId: evaluation.snapshot.snapshotId,
    freshness: evaluation.snapshot.freshness,
    supportedOperations: [operation],
    cancellationSupported: evaluation.snapshot.generation?.cancellationSupported === true
  };
}

export function multimodalCatalogRouter(models: ModelInfo[]): CapabilityRouter {
  return new CapabilityRouter({ catalog: models });
}

export class MultimodalOrchestrator {
  private readonly privacy: PrivacyPreflight;
  private readonly policyGate?: PolicyGate;
  private readonly activity?: ActivityStore;
  private readonly audit?: MultimodalOrchestratorOptions['audit'];
  private readonly now: () => number;
  private readonly approvalTtlMs: number;
  private readonly budgetLimitUsd: number;
  private readonly executeOutput?: MultimodalOrchestratorOptions['execute'];
  private readonly operations = new Map<string, MultimodalOperationRecord>();
  private readonly derived = new Map<string, DerivedArtifact>();
  private readonly lineage: LineageEdge[] = [];
  private readonly privacyTokens = new Map<string, string>();
  private loaded = false;
  private loading: Promise<void> | undefined;

  public constructor(private readonly workspaceRoot: string, private readonly options: MultimodalOrchestratorOptions) {
    this.privacy = options.privacy ?? new PrivacyPreflight();
    this.policyGate = options.policyGate;
    this.activity = options.activity;
    this.audit = options.audit;
    this.now = options.clock ?? Date.now;
    this.approvalTtlMs = Math.max(1_000, options.approvalTtlMs ?? 5 * 60_000);
    this.budgetLimitUsd = Math.max(0, options.budgetLimitUsd ?? 25);
    this.executeOutput = options.execute;
  }

  public async prepare(input: MultimodalPrepareInput): Promise<MultimodalOperationRecord> {
    await this.rehydrate();
    if (this.options.emergencyStop?.()) throw new MultimodalOperationError('emergency-stop', 'Emergency stop is active; new multimodal work is blocked.');
    const sourceIds = uniqueIds(input.sourceArtifactIds);
    if (!sourceIds.length || sourceIds.length > MAX_LINEAGE_SOURCES || sourceIds.length !== new Set(input.sourceArtifactIds).size) throw new MultimodalOperationError('invalid-reference', 'A bounded source artifact set is required.');
    if (sourceIds.some((id, index) => id !== input.sourceArtifactIds[index])) throw new MultimodalOperationError('scope-escalation', 'Unknown or forged source artifact IDs are not accepted.');
    const sources = sourceIds.map((id) => this.options.intake.get(id));
    if (sources.some((source) => !source || source.lifecycle !== 'staged')) throw new MultimodalOperationError('invalid-reference', 'Every source artifact must be staged and active.');
    const sourceRecords = sources.filter((source): source is AttachmentRecord => Boolean(source));
    for (const source of sourceRecords) if (!(await this.options.intake.verify(source.artifactId))) throw new MultimodalOperationError('provenance-mismatch', 'A staged artifact failed its immutable content verification.');
    validateRoute(input.operation, input.route, sourceRecords);
    const request = this.providerRequest(input, sourceRecords);
    const privacyEvaluation = this.privacy.preflight(request, input.privacyOverrideToken);
    const cloud = input.route.providerBoundary !== 'local';
    const localOnlyBlock = privacyEvaluation.decision.reason.includes('local-only');
    if (privacyEvaluation.decision.outcome === 'block' && !(cloud && localOnlyBlock)) throw new MultimodalOperationError('privacy-blocked', 'Privacy preflight blocked this modality operation.');
    const operationId = `multimodal-op-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const createdAt = new Date(this.now()).toISOString();
    const approvalRequired = cloud || input.rawContentRequested === true || input.operation === 'publish';
    const approval = approvalRequired ? this.createApproval(operationId, input, sourceIds, createdAt) : undefined;
    if (cloud && localOnlyBlock && !input.privacyOverrideToken) this.privacyTokens.set(operationId, this.privacy.issueOverride(request, this.approvalTtlMs).token);
    const status: OperationLifecycle = approvalRequired ? 'awaiting-approval' : 'prepared';
    const record: MultimodalOperationRecord = { version: MULTIMODAL_VERSION, operationId, operation: input.operation, sourceArtifactIds: sourceIds, route: cloneMultimodal(input.route), sessionId: input.sessionId, projectId: input.projectId, status, approval, attribution: input.attribution ? cloneMultimodal(input.attribution) : undefined, estimatedCostUsd: nonNegative(input.estimatedCostUsd), derivedArtifactIds: [], createdAt, updatedAt: createdAt };
    this.operations.set(operationId, record);
    await this.persist();
    await this.recordActivity(record, 'waiting', 'Multimodal operation prepared; awaiting exact approval.');
    return cloneMultimodal(record);
  }

  public async approve(operationId: string, approvalFingerprint: string): Promise<MultimodalOperationRecord> {
    await this.rehydrate();
    const operation = this.requireOperation(operationId);
    if (!operation.approval || operation.approval.expiresAt <= new Date(this.now()).toISOString()) throw new MultimodalOperationError('approval-expired', 'The modality approval has expired and must be recreated.');
    if (operation.approval.approvalFingerprint !== approvalFingerprint) throw new MultimodalOperationError('approval-fingerprint-mismatch', 'Approval does not match the exact source, route, and operation scope.');
    operation.approvalFingerprint = approvalFingerprint;
    operation.status = 'prepared';
    operation.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    return cloneMultimodal(operation);
  }

  public async run(operationId: string, approvalFingerprint?: string, signal?: AbortSignal): Promise<MultimodalOperationRecord> {
    await this.rehydrate();
    const operation = this.requireOperation(operationId);
    if (operation.status === 'paused') throw new MultimodalOperationError('restart-requires-approval', 'Recovered operations require fresh policy and approval.');
    if (operation.status === 'cancelled' || operation.status === 'failed' || operation.status === 'completed') return cloneMultimodal(operation);
    if (operation.approval) {
      if (operation.approval.expiresAt <= new Date(this.now()).toISOString()) return this.fail(operation, 'approval-expired', 'The exact modality approval expired before dispatch.');
      if (!approvalFingerprint || operation.approval.approvalFingerprint !== approvalFingerprint || operation.approvalFingerprint !== approvalFingerprint) return this.fail(operation, 'approval-fingerprint-mismatch', 'A fresh exact approval is required before modality dispatch.');
    }
    if (signal?.aborted) return this.fail(operation, 'cancelled', 'The modality operation was cancelled before dispatch.');
    const sources = operation.sourceArtifactIds.map((id) => this.options.intake.get(id));
    if (sources.some((source) => !source || source.lifecycle !== 'staged')) return this.fail(operation, 'provenance-mismatch', 'A source artifact is no longer available.');
    const sourceRecords = sources.filter((source): source is AttachmentRecord => Boolean(source));
    for (const source of sourceRecords) if (!(await this.options.intake.verify(source.artifactId))) return this.fail(operation, 'provenance-mismatch', 'A source artifact failed integrity verification.');
    const request = this.providerRequest({ operation: operation.operation, route: operation.route, rawContentRequested: operation.approval?.rawContentRequested }, sourceRecords);
    const privacyToken = this.privacyTokens.get(operation.operationId);
    const privacyEvaluation = this.privacy.preflight(request, privacyToken);
    if (privacyEvaluation.decision.outcome !== 'allow') return this.fail(operation, 'privacy-blocked', privacyEvaluation.decision.reason);
    const action: ActionCapability = operation.route.providerBoundary === 'local' && !operation.approval?.rawContentRequested ? 'read' : 'network';
    const policy = this.policyGate?.decideAction(action, request, privacyToken);
    if (policy && !policy.allowed) {
      if (this.options.emergencyStop?.() || policy.reason.includes('emergency stop')) return this.fail(operation, 'emergency-stop', 'Emergency stop is active; multimodal dispatch is blocked.');
      if (!operation.approvalFingerprint) return this.fail(operation, 'cloud-transfer-not-approved', policy.reason);
    }
    if (this.options.emergencyStop?.()) return this.fail(operation, 'emergency-stop', 'Emergency stop is active; multimodal dispatch is blocked.');
    if ((operation.estimatedCostUsd ?? 0) > this.budgetLimitUsd) return this.fail(operation, 'budget-blocked', 'The multimodal operation exceeds the bounded project budget.');
    operation.status = 'running'; operation.updatedAt = new Date(this.now()).toISOString(); await this.persist();
    const rawHandles = operation.approval?.rawContentRequested ? sourceRecords.map((source) => this.options.intake.authorizeRawContent(source.artifactId, source.contentHash)).filter((handle): handle is NonNullable<typeof handle> => Boolean(handle)).map(({ artifactId, managedPath, contentHash }) => ({ artifactId, managedPath, contentHash })) : [];
    try {
      const output = this.executeOutput
        ? await this.executeOutput({ operation: operation.operation, sourceArtifactIds: operation.sourceArtifactIds, route: cloneMultimodal(operation.route), rawHandles, signal })
        : operation.route.providerBoundary === 'local'
          ? defaultOutput(operation.operation, sourceRecords[0])
          : (() => { throw new MultimodalOperationError('operation-not-supported', 'No documented provider adapter is available for this boundary; execution will not fall back locally.'); })();
      if (signal?.aborted) return this.fail(operation, 'cancelled', 'The modality operation was cancelled before completion.');
      const artifact = this.createDerived(operation, sourceRecords, output);
      operation.derivedArtifactIds = [artifact.artifactId]; operation.actualCostUsd = nonNegative(output.actualCostUsd); operation.inputTokens = nonNegativeInteger(output.inputTokens); operation.outputTokens = nonNegativeInteger(output.outputTokens); operation.status = 'completed'; operation.reason = undefined; operation.updatedAt = new Date(this.now()).toISOString();
      await this.persist(); await this.recordActivity(operation, 'completed', 'Multimodal operation completed with source lineage.');
      return cloneMultimodal(operation);
    } catch (error) {
      if (error instanceof MultimodalOperationError) return this.fail(operation, error.code, 'The multimodal provider boundary rejected the operation.');
      return this.fail(operation, 'provider-failed', error instanceof Error ? error.message : 'The modality operation failed.');
    }
  }

  public async cancel(operationId: string): Promise<MultimodalOperationRecord> { await this.rehydrate(); const operation = this.requireOperation(operationId); if (!['completed', 'failed', 'cancelled'].includes(operation.status)) { operation.status = 'cancelled'; operation.reason = 'cancelled'; operation.updatedAt = new Date(this.now()).toISOString(); await this.persist(); await this.recordActivity(operation, 'cancelled', 'Multimodal operation cancelled safely.'); } return cloneMultimodal(operation); }

  public async recover(operationId: string): Promise<MultimodalOperationRecord> {
    await this.rehydrate(); const operation = this.requireOperation(operationId); if (operation.status !== 'paused') return cloneMultimodal(operation);
    const createdAt = new Date(this.now()).toISOString(); const approvalFingerprint = fingerprint({ operation: operation.operation, sourceArtifactIds: operation.sourceArtifactIds, route: operation.route, createdAt });
    operation.approval = { operationId, approvalFingerprint, operation: operation.operation, sourceArtifactIds: [...operation.sourceArtifactIds], provider: operation.route.provider, model: operation.route.model, providerBoundary: operation.route.providerBoundary, rawContentRequested: false, expiresAt: new Date(this.now() + this.approvalTtlMs).toISOString(), reason: 'Restart recovery requires fresh policy and approval.' }; operation.status = 'awaiting-approval'; operation.approvalFingerprint = undefined; operation.updatedAt = createdAt; await this.persist(); return cloneMultimodal(operation);
  }

  public async rehydrate(): Promise<void> {
    if (this.loaded) return; if (this.loading) return this.loading; this.loading = (async () => { this.loaded = true; try { const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<MultimodalLedger>; if (parsed.version !== MULTIMODAL_VERSION) return; for (const row of (parsed.operations ?? []).slice(-50)) { const operation = normalizeOperation(row); if (!operation) continue; if (operation.status === 'running' || operation.status === 'prepared' || operation.status === 'awaiting-approval') { operation.status = 'paused'; operation.reason = 'restart-requires-approval'; } this.operations.set(operation.operationId, operation); } for (const row of (parsed.derivedArtifacts ?? []).slice(-MAX_DERIVED_ARTIFACTS)) { const artifact = normalizeArtifact(row); if (artifact) this.derived.set(artifact.artifactId, artifact); } this.lineage.push(...(parsed.lineage ?? []).slice(-MAX_DERIVED_ARTIFACTS * MAX_LINEAGE_SOURCES).filter((edge): edge is LineageEdge => Boolean(edge && typeof edge.sourceArtifactId === 'string' && typeof edge.derivedArtifactId === 'string'))); } catch { /* Missing or corrupt multimodal state is a safe empty/recovery state. */ } })(); await this.loading; }
  public list(): MultimodalOperationRecord[] { return [...this.operations.values()].map(cloneMultimodal); }
  public getDerived(artifactId: string): DerivedArtifact | undefined { const artifact = this.derived.get(artifactId); return artifact ? cloneMultimodal(artifact) : undefined; }
  public getLineage(): LineageEdge[] { return cloneMultimodal(this.lineage); }
  public get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'multimodal.json'); }

  private requireOperation(id: string): MultimodalOperationRecord { const operation = this.operations.get(id); if (!operation) throw new MultimodalOperationError('invalid-reference', 'Unknown multimodal operation.'); return operation; }
  private providerRequest(input: Pick<MultimodalPrepareInput, 'operation' | 'route' | 'rawContentRequested'>, sources: AttachmentRecord[]): ProviderRequest { return { provider: input.route.provider, providerBoundary: input.route.providerBoundary, capability: input.route.providerBoundary === 'local' && !input.rawContentRequested ? 'read' : 'network', paths: sources.map((source) => source.sourcePath), scope: `multimodal:${input.operation}`, context: `approved multimodal metadata operation ${input.operation}`, attachmentIds: sources.map((source) => source.artifactId), rawContentAuthorized: input.rawContentRequested === true }; }
  private createApproval(operationId: string, input: MultimodalPrepareInput, sourceIds: string[], createdAt: string): MultimodalApprovalPreview { const approvalFingerprint = fingerprint({ operation: input.operation, sourceArtifactIds: sourceIds, route: input.route, rawContentRequested: input.rawContentRequested === true }); return { operationId, approvalFingerprint, operation: input.operation, sourceArtifactIds: [...sourceIds], provider: input.route.provider, model: input.route.model, providerBoundary: input.route.providerBoundary, rawContentRequested: input.rawContentRequested === true, expiresAt: new Date(this.now() + this.approvalTtlMs).toISOString(), reason: input.route.providerBoundary === 'local' ? 'Raw content or publication requires explicit approval.' : 'Cloud transfer requires explicit approval for this exact source and route.' }; }
  private createDerived(operation: MultimodalOperationRecord, sources: AttachmentRecord[], output: MultimodalExecutionOutput): DerivedArtifact { if (this.derived.size >= MAX_DERIVED_ARTIFACTS) throw new MultimodalOperationError('budget-blocked', 'Derived artifact capacity is full.'); const source = sources[0]; const artifactId = `derived-${randomUUID().replaceAll('-', '').slice(0, 20)}`; const artifact: DerivedArtifact = { version: MULTIMODAL_VERSION, artifactId, operationId: operation.operationId, kind: output.kind, label: safeLabel(output.label), sourceArtifactIds: [...operation.sourceArtifactIds], inputFingerprint: fingerprint({ sourceArtifactIds: operation.sourceArtifactIds, hashes: sources.map((item) => item.contentHash), operation: operation.operation, transformationVersion: 'multimodal-v1' }), contentHash: safeHash(output.contentHash), managedReference: safeReference(output.managedReference), safePreview: safePreview(output.safePreview), privacy: cloneMultimodal(source.privacy), provenance: cloneMultimodal(source.provenance), transformationVersion: 'multimodal-v1', route: { provider: operation.route.provider, model: operation.route.model, providerBoundary: operation.route.providerBoundary, privacyBoundary: operation.route.privacyBoundary, capabilitySnapshotId: operation.route.capabilitySnapshotId }, attribution: operation.attribution ? cloneMultimodal(operation.attribution) : undefined, estimatedCostUsd: operation.estimatedCostUsd, actualCostUsd: nonNegative(output.actualCostUsd), inputTokens: nonNegativeInteger(output.inputTokens), outputTokens: nonNegativeInteger(output.outputTokens), publicationEligible: output.publicationEligible === true && operation.operation === 'publish', createdAt: new Date(this.now()).toISOString() }; this.derived.set(artifactId, artifact); for (const sourceArtifactId of operation.sourceArtifactIds) this.lineage.push({ sourceArtifactId, derivedArtifactId: artifactId, operationId: operation.operationId, operation: operation.operation, transformationVersion: 'multimodal-v1', createdAt: artifact.createdAt }); return artifact; }
  private async fail(operation: MultimodalOperationRecord, reason: MultimodalReasonCode, message: string): Promise<MultimodalOperationRecord> { operation.status = reason === 'budget-blocked' ? 'budget-blocked' : reason === 'cancelled' ? 'cancelled' : 'failed'; operation.reason = reason; operation.updatedAt = new Date(this.now()).toISOString(); await this.persist(); await this.recordActivity(operation, operation.status === 'cancelled' ? 'cancelled' : 'failed', `Multimodal operation ended: ${reason}.`); return cloneMultimodal(operation); }
  private async recordActivity(operation: MultimodalOperationRecord, status: ActivityStatus, summary: string): Promise<void> { if (this.activity && operation.sessionId) await this.activity.append(operation.sessionId, { status, kind: 'model', requestId: operation.operationId, action: `multimodal:${operation.operation}`, model: operation.route.model, route: `${operation.route.providerBoundary}:${operation.route.provider}`, estimatedCostUsd: operation.estimatedCostUsd, actualCostUsd: operation.actualCostUsd, summary }); if (this.audit) await this.audit.append({ version: 1, id: `audit-${randomUUID().replaceAll('-', '').slice(0, 16)}`, timestamp: new Date(this.now()).toISOString(), type: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancellation' : status === 'failed' ? 'failed' : 'preflight', requestId: operation.operationId, capability: operation.route.providerBoundary === 'local' ? 'read' : 'network', provider: operation.route.provider, outcome: status, reason: summary, estimatedCostUsd: operation.estimatedCostUsd, actualCostUsd: operation.actualCostUsd }); }
  private async persist(): Promise<void> { const ledger: MultimodalLedger = { version: MULTIMODAL_VERSION, attachments: [], operations: [...this.operations.values()].slice(-50), derivedArtifacts: [...this.derived.values()].slice(-MAX_DERIVED_ARTIFACTS), lineage: this.lineage.slice(-MAX_DERIVED_ARTIFACTS * MAX_LINEAGE_SOURCES) }; const file = this.filePath; const temporary = `${file}.tmp-${process.pid}`; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temporary, `${JSON.stringify(ledger)}\n`, 'utf8'); await fs.rename(temporary, file); }
}

export class MultimodalOperationError extends Error { public constructor(public readonly code: MultimodalReasonCode, message: string) { super(message); this.name = 'MultimodalOperationError'; } }

function validateRoute(operation: MultimodalOperation, route: MultimodalRoute, sources: AttachmentRecord[]): void { if (!route.provider || !route.model || !route.capabilitySnapshotId || route.freshness !== 'current' || route.privacyBoundary === 'unknown' || !route.supportedOperations.includes(operation)) throw new MultimodalOperationError(route.freshness !== 'current' ? 'stale-capability' : !route.supportedOperations.includes(operation) ? 'operation-not-supported' : 'unknown-capability', 'The provider route does not prove a current compatible multimodal capability.'); if (operation === 'transcribe' && !sources.some((source) => source.modality === 'audio' || source.modality === 'video')) throw new MultimodalOperationError('operation-not-supported', 'Transcription requires an audio or video source.'); if (operation === 'extract' && !sources.some((source) => source.modality === 'document' || source.modality === 'structured')) throw new MultimodalOperationError('operation-not-supported', 'Extraction requires a document or structured source.'); }
function multimodalCapabilityReason(reasons: CapabilityReasonCode[]): MultimodalReasonCode {
  const reason = reasons[0];
  if (reason === 'unknown-model' || reason === 'metadata-unknown') return 'unknown-capability';
  if (reason === 'stale-metadata') return 'stale-capability';
  if (reason === 'unavailable-pricing') return 'unavailable-pricing';
  if (reason === 'privacy-mismatch') return 'privacy-blocked';
  if (reason === 'cancellation-unsupported' || reason === 'unsupported-input-modality' || reason === 'unsupported-skill' || reason === 'unsupported-provider-operation') return 'operation-not-supported';
  return 'unknown-capability';
}
function defaultOutput(operation: MultimodalOperation, source: AttachmentRecord): MultimodalExecutionOutput { const kind: ArtifactKind = operation === 'transcribe' ? 'transcript' : operation === 'extract' ? source.modality === 'structured' ? 'structured-projection' : 'extracted-text' : operation === 'inspect' ? 'thumbnail' : operation === 'summarize' ? 'summary' : 'transformed'; return { kind, label: `${kind} for ${source.label}`, safePreview: `${kind} derived from ${source.artifactId}` }; }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function uniqueIds(values: string[]): string[] { return [...new Set(values)].filter((value) => /^attachment-[a-z0-9]{20}$/.test(value)).slice(0, MAX_LINEAGE_SOURCES); }
function nonNegative(value: number | undefined): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function nonNegativeInteger(value: number | undefined): number | undefined { const result = nonNegative(value); return result === undefined ? undefined : Math.floor(result); }
function safeLabel(value: string): string { return value.replace(/[\r\n\t]/g, ' ').replace(/(?:api[_ -]?key|token|secret|password|private prompt|raw media|command)\s*[:=]?\s*[^\s,;]*/gi, '[REDACTED]').slice(0, 120) || 'derived artifact'; }
function safePreview(value: string | undefined): string | undefined { if (!value) return undefined; return safeLabel(value).slice(0, 240); }
function safeHash(value: string | undefined): string | undefined { return value && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined; }
function safeReference(value: string | undefined): string | undefined { return value && /^multimodal:\/\/[a-z0-9-]{1,100}$/i.test(value) ? value : undefined; }
function normalizeOperation(value: unknown): MultimodalOperationRecord | undefined { if (!value || typeof value !== 'object') return undefined; const row = value as Partial<MultimodalOperationRecord>; const operations: MultimodalOperation[] = ['inspect', 'transcribe', 'extract', 'summarize', 'transform', 'publish']; const statuses: OperationLifecycle[] = ['prepared', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled', 'paused', 'budget-blocked']; if (row.version !== MULTIMODAL_VERSION || typeof row.operationId !== 'string' || !/^multimodal-op-[a-z0-9]{20}$/.test(row.operationId) || !operations.includes(row.operation as MultimodalOperation) || !statuses.includes(row.status as OperationLifecycle) || !Array.isArray(row.sourceArtifactIds) || !row.route) return undefined; return { ...cloneMultimodal(row as MultimodalOperationRecord), sourceArtifactIds: uniqueIds(row.sourceArtifactIds.filter((id): id is string => typeof id === 'string')), derivedArtifactIds: Array.isArray(row.derivedArtifactIds) ? row.derivedArtifactIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_DERIVED_ARTIFACTS) : [], status: row.status as OperationLifecycle, operation: row.operation as MultimodalOperation }; }
function normalizeArtifact(value: unknown): DerivedArtifact | undefined { if (!value || typeof value !== 'object') return undefined; const row = value as Partial<DerivedArtifact>; if (row.version !== MULTIMODAL_VERSION || typeof row.artifactId !== 'string' || typeof row.operationId !== 'string' || !Array.isArray(row.sourceArtifactIds) || !row.provenance || !row.privacy || !row.route) return undefined; return cloneMultimodal(row as DerivedArtifact); }

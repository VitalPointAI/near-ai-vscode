import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActivityStore } from './activityStore';
import type { ApprovalService } from './approvalService';
import type { CapabilityRouter } from './capabilityRouter';
import type { CapabilityEvaluation, ModelCapabilitySnapshot } from '../domain/capabilities';
import type {
  GeneratedArtifact, GenerationApproval, GenerationCostEstimate, GenerationOperation, GenerationOperationRecord,
  GenerationPreview, GenerationProviderAdapter, GenerationProviderInput, GenerationReasonCode, GenerationRequest,
  GenerationRouteSnapshot, GenerationUsage, PublicationPreview, PublicationRequest, ProviderGenerationResult
} from '../domain/generation';
import { cloneGeneration, GENERATION_VERSION, MAX_GENERATION_PROMPT, MAX_GENERATION_SOURCES, MAX_VIDEO_POLLS } from '../domain/generation';
import { MultimodalIntake } from './multimodalIntake';
import type { NearAiClient } from './nearAiClient';
import { PrivacyPreflight } from './privacyPreflight';

export interface GenerationServiceOptions {
  router: CapabilityRouter;
  adapters: readonly GenerationProviderAdapter[];
  approval: ApprovalService;
  activity?: ActivityStore;
  intake?: MultimodalIntake;
  privacy?: PrivacyPreflight;
  clock?: () => number;
  pollDelayMs?: number;
  maxVideoPolls?: number;
}

export class GenerationError extends Error {
  public constructor(public readonly code: GenerationReasonCode, message: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

/**
 * Host-owned generation boundary. It never selects an adapter from a model
 * name, accepts provider URLs, persists prompts/media, or falls back to chat.
 */
export class GenerationService {
  private readonly now: () => number;
  private readonly pollDelayMs: number;
  private readonly maxVideoPolls: number;
  private readonly operations = new Map<string, GenerationOperationRecord>();
  private readonly artifacts = new Map<string, GeneratedArtifact>();
  private readonly prompts = new Map<string, string>();
  private readonly publicationPreviews = new Map<string, PublicationPreview>();
  private readonly privacy: PrivacyPreflight;
  private loaded = false;
  private loading: Promise<void> | undefined;

  public constructor(private readonly workspaceRoot: string, private readonly options: GenerationServiceOptions) {
    this.now = options.clock ?? Date.now;
    this.pollDelayMs = Math.max(0, Math.min(5_000, options.pollDelayMs ?? 50));
    this.maxVideoPolls = Math.max(1, Math.min(MAX_VIDEO_POLLS, options.maxVideoPolls ?? MAX_VIDEO_POLLS));
    this.privacy = options.privacy ?? new PrivacyPreflight();
  }

  public async prepare(request: GenerationRequest): Promise<GenerationOperationRecord> {
    await this.rehydrate();
    validateRequest(request);
    const capability = await this.evaluateCapability(request);
    if (!capability.compatible || !capability.snapshot) throw unavailable(capability);
    const adapter = this.adapterFor(request.provider, request.operation);
    if (!adapter) throw new GenerationError('unsupported-provider-endpoint', 'The selected provider has no documented adapter for this generation operation.');
    validateAdapter(adapter, request.operation);
    validateSnapshotOperations(capability.snapshot, request.operation);
    const estimate = estimateCost(capability.snapshot, request);
    if (!estimate) throw new GenerationError('unavailable-pricing', 'The provider did not declare a usable generation price for this request.');
    const privacy = this.privacy.preflight({ provider: request.provider, providerBoundary: request.providerBoundary, capability: 'mediaGeneration', scope: `generation:${request.skill}`, context: 'Generation prompt withheld; only bounded capability metadata is evaluated.' });
    if (privacy.decision.outcome === 'block') throw new GenerationError('privacy-mismatch', 'Privacy policy blocks this generation provider boundary.');
    const operationId = `generation-op-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const createdAt = new Date(this.now()).toISOString();
    const route = routeSnapshot(capability.snapshot, request, createdAt);
    const promptFingerprint = fingerprint(request.prompt);
    const sourceArtifactIds = [...(request.sourceArtifactIds ?? [])];
    const approvalFingerprint = fingerprint({ operationId, operation: request.operation, skill: request.skill, model: request.model, provider: request.provider, promptFingerprint, sourceArtifactIds, parameters: request.parameters ?? {}, route: route.capabilitySnapshotId, estimated: estimate });
    const approvalPreview = await this.options.approval.preview({
      requestId: operationId,
      sessionId: request.sessionId,
      projectId: request.projectId,
      attribution: request.attribution,
      capability: 'mediaGeneration',
      action: `generation:${request.operation}`,
      targetScope: `model:${request.provider}/${request.model}`,
      provider: request.provider,
      providerBoundary: request.providerBoundary,
      context: 'Approved generation metadata and redacted prompt fingerprint only.',
      scope: `generation:${request.skill}`,
      estimated: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: estimate.amountUsd, currency: 'USD' },
      reversible: false
    });
    const approval: GenerationApproval = { previewId: approvalPreview.previewId, approvalFingerprint, expiresAt: approvalPreview.expiresAt, action: 'generation' };
    const created: GenerationOperationRecord = {
      version: GENERATION_VERSION,
      operationId,
      skill: request.skill,
      operation: request.operation,
      provider: request.provider,
      model: request.model,
      promptFingerprint,
      sourceArtifactIds,
      parameters: normalizeParameters(request.parameters),
      route,
      status: 'awaiting-approval',
      approval,
      estimatedCost: estimate,
      publication: 'unpublished',
      attribution: cloneGeneration(request.attribution),
      sessionId: request.sessionId,
      projectId: request.projectId,
      createdAt,
      updatedAt: createdAt
    };
    this.operations.set(operationId, created);
    this.prompts.set(operationId, request.prompt);
    await this.persist();
    await this.activityEvent(created, 'queued', 'Generation preview created; exact approval is required.');
    return cloneGeneration(created);
  }

  public preview(operationId: string): GenerationPreview {
    const operation = this.require(operationId);
    if (!operation.approval || !operation.estimatedCost) throw new GenerationError('approval-required', 'Generation approval is unavailable.');
    return {
      operationId: operation.operationId,
      skill: operation.skill,
      operation: operation.operation,
      provider: operation.provider,
      model: operation.model,
      capabilitySnapshotId: operation.route.capabilitySnapshotId,
      capabilityFreshness: operation.route.capabilityMetadata.freshness,
      providerBoundary: operation.route.providerBoundary,
      privacyBoundary: operation.route.privacyBoundary,
      estimatedCost: cloneGeneration(operation.estimatedCost),
      approval: cloneGeneration(operation.approval),
      attribution: cloneGeneration(operation.attribution),
      sourceArtifactIds: [...operation.sourceArtifactIds],
      publication: operation.publication
    };
  }

  public async approve(operationId: string, approvalFingerprint: string): Promise<GenerationOperationRecord> {
    await this.rehydrate();
    const operation = this.require(operationId);
    if (!operation.approval || operation.approval.expiresAt <= new Date(this.now()).toISOString()) throw new GenerationError('approval-expired', 'The generation approval expired and must be recreated.');
    if (!/^[a-f0-9]{64}$/.test(approvalFingerprint) || operation.approval.approvalFingerprint !== approvalFingerprint) throw new GenerationError('approval-mismatch', 'Approval does not match the exact generation scope.');
    const decision = await this.options.approval.decide(operation.approval.previewId, 'approved', 'User approved the exact generation scope.');
    if (decision.decision !== 'approved') throw new GenerationError('approval-mismatch', 'The generation approval was not accepted.');
    operation.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    return cloneGeneration(operation);
  }

  public async run(operationId: string, approvalFingerprint?: string, signal?: AbortSignal): Promise<GenerationOperationRecord> {
    await this.rehydrate();
    const operation = this.require(operationId);
    if (isTerminal(operation.status)) return cloneGeneration(operation);
    if (!operation.approval || !approvalFingerprint || operation.approval.approvalFingerprint !== approvalFingerprint) return this.fail(operation, 'approval-required', 'A fresh exact generation approval is required.');
    if (signal?.aborted) return this.cancel(operation.operationId, signal);
    const dispatched = await this.options.approval.dispatch(operation.approval.previewId);
    if (!dispatched.allowed) return this.fail(operation, dispatched.reason.includes('Budget') ? 'budget-blocked' : dispatched.reason.includes('stop') ? 'emergency-stop' : 'approval-required', 'Generation was blocked by approval, budget, or emergency-stop policy.');
    const adapter = this.adapterFor(operation.provider, operation.operation);
    if (!adapter) return this.fail(operation, 'unsupported-provider-endpoint', 'No exact provider adapter is available.');
    operation.status = operation.operation === 'video-generation' ? 'queued' : 'in-progress';
    operation.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    await this.activityEvent(operation, operation.status, 'Generation dispatched through the approved provider adapter.');
    try {
      const input = await this.providerInput(operation, signal);
      const result = operation.operation === 'image-generation' ? await adapter.createImage(input) : operation.operation === 'image-edit' ? await adapter.editImage(input) : await this.runVideo(adapter, input, operation, signal);
      if (signal?.aborted) return this.cancel(operation.operationId, signal);
      if (result.status !== 'completed' || !result.bytes) return this.fail(operation, 'provider-failed', 'The provider did not return a completed managed output.');
      const artifact = await this.storeOutput(operation, result.bytes, result.usage, result.requestId, result.providerJobId);
      operation.status = 'completed';
      operation.usage = normalizeUsage(result.usage, result.requestId, result.providerJobId);
      operation.artifactId = artifact.artifactId;
      operation.updatedAt = new Date(this.now()).toISOString();
      await this.options.approval.recordLifecycle(operation.approval.previewId, 'completed', { outcome: 'completed', reason: 'Managed output stored; publication remains separate.', actualCostUsd: operation.usage?.actualCostUsd, actualTokens: totalTokens(operation.usage) });
      await this.persist();
      await this.activityEvent(operation, 'completed', 'Generation completed; managed artifact is unpublished by default.');
      return cloneGeneration(operation);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return this.cancel(operation.operationId, signal);
      if (error instanceof GenerationError) return this.fail(operation, error.code, 'Generation stopped at a safe provider lifecycle boundary.');
      return this.fail(operation, 'provider-failed', 'The provider generation request failed.');
    }
  }

  public async cancel(operationId: string, signal?: AbortSignal): Promise<GenerationOperationRecord> {
    await this.rehydrate();
    const operation = this.require(operationId);
    if (isTerminal(operation.status)) return cloneGeneration(operation);
    const adapter = this.adapterFor(operation.provider, operation.operation);
    if (operation.providerJobId && adapter?.cancelVideo && operation.route.capabilityMetadata.providerOperations.includes('video-cancel')) {
      await adapter.cancelVideo(operation.providerJobId, new AbortController().signal).catch(() => undefined);
    }
    operation.status = 'cancelled';
    operation.reason = 'cancelled';
    operation.updatedAt = new Date(this.now()).toISOString();
    await this.options.approval.recordLifecycle(operation.approval?.previewId ?? operation.operationId, 'cancellation', { outcome: 'cancelled', reason: 'Generation cancellation requested.' }).catch(() => undefined);
    await this.persist();
    await this.activityEvent(operation, 'cancelled', 'Generation cancelled; no publication occurred.');
    return cloneGeneration(operation);
  }

  public async preparePublication(request: PublicationRequest): Promise<PublicationPreview> {
    await this.rehydrate();
    const operation = this.require(request.operationId);
    if (operation.status !== 'completed' || !operation.artifactId) throw new GenerationError('publication-not-eligible', 'Only a completed managed artifact can be published.');
    const artifact = this.artifacts.get(operation.artifactId);
    if (!artifact || !safeDestination(request.destination)) throw new GenerationError('publication-destination-invalid', 'Publication destination must be a workspace-relative non-symlink path.');
    const destination = normalizeDestination(request.destination);
    const approvalFingerprint = fingerprint({ operationId: operation.operationId, artifactId: artifact.artifactId, destination, route: operation.route.capabilitySnapshotId, attribution: request.attribution });
    const approvalPreview = await this.options.approval.preview({
      requestId: `publication-${operation.operationId}`,
      sessionId: operation.sessionId,
      projectId: operation.projectId,
      attribution: request.attribution,
      capability: 'mediaPublication',
      action: 'generation:publication',
      targetScope: `workspace:${destination}`,
      provider: operation.provider,
      providerBoundary: operation.route.providerBoundary,
      context: 'Managed generated artifact publication; source prompt and media are withheld.',
      paths: [destination],
      scope: 'generated-artifact-publication',
      estimated: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, currency: 'USD' },
      reversible: true
    });
    operation.publication = 'awaiting-approval';
    operation.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    const preview = { operationId: operation.operationId, artifactId: artifact.artifactId, destination, approval: { previewId: approvalPreview.previewId, approvalFingerprint, expiresAt: approvalPreview.expiresAt, action: 'publication' as const }, attribution: cloneGeneration(request.attribution), provenance: artifact.provenance };
    this.publicationPreviews.set(operation.operationId, cloneGeneration(preview));
    return preview;
  }

  public async publish(preview: PublicationPreview, fingerprintValue: string): Promise<GenerationOperationRecord> {
    await this.rehydrate();
    const operation = this.require(preview.operationId);
    const expected = this.publicationPreviews.get(preview.operationId);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(preview)) throw new GenerationError('approval-mismatch', 'Publication approval is not bound to the exact managed artifact and destination.');
    if (preview.approval.approvalFingerprint !== fingerprintValue) throw new GenerationError('approval-mismatch', 'Publication approval does not match the exact artifact and destination.');
    if (!safeDestination(preview.destination)) throw new GenerationError('publication-destination-invalid', 'Publication destination is outside the managed workspace boundary.');
    const decision = await this.options.approval.decide(preview.approval.previewId, 'approved', 'User approved the exact publication destination.');
    if (decision.decision !== 'approved') throw new GenerationError('publication-approval-required', 'A separate publication approval is required.');
    const artifact = operation.artifactId ? this.artifacts.get(operation.artifactId) : undefined;
    if (!artifact) throw new GenerationError('publication-not-eligible', 'The managed generated artifact is unavailable.');
    const source = this.managedPath(artifact.artifactId);
    const destination = path.resolve(this.workspaceRoot, normalizeDestination(preview.destination));
    try {
      const root = await fs.realpath(this.workspaceRoot);
      const parent = await fs.realpath(path.dirname(destination));
      if (!within(root, parent) || await isSymlink(destination)) throw new Error('destination containment');
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    } catch {
      operation.publication = 'failed';
      operation.reason = 'publication-failed';
      operation.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      throw new GenerationError('publication-failed', 'The managed artifact could not be published to that destination.');
    }
    operation.publication = 'published';
    operation.updatedAt = new Date(this.now()).toISOString();
    artifact.publication = 'published';
    await this.persist();
    await this.activityEvent(operation, 'completed', 'Generated artifact published after separate approval.');
    return cloneGeneration(operation);
  }

  public get(operationId: string): GenerationOperationRecord | undefined { const value = this.operations.get(operationId); return value ? cloneGeneration(value) : undefined; }
  public list(): GenerationOperationRecord[] { return [...this.operations.values()].map(cloneGeneration); }
  public getArtifact(artifactId: string): GeneratedArtifact | undefined { const value = this.artifacts.get(artifactId); return value ? cloneGeneration(value) : undefined; }
  public getPublicationPreview(operationId: string): PublicationPreview | undefined { const value = this.publicationPreviews.get(operationId); return value ? cloneGeneration(value) : undefined; }
  public async publishOperation(operationId: string, fingerprintValue: string): Promise<GenerationOperationRecord> { const preview = this.publicationPreviews.get(operationId); if (!preview) throw new GenerationError('publication-approval-required', 'A fresh publication preview is required.'); return this.publish(preview, fingerprintValue); }
  public emergencyStop(projectId: string): void { this.options.approval.emergencyStop(projectId); }
  public clearEmergencyStop(projectId: string): void { this.options.approval.clearEmergencyStop(projectId); }

  private async evaluateCapability(request: GenerationRequest): Promise<CapabilityEvaluation> {
    return this.options.router.evaluate({ provider: request.provider, model: request.model, locality: request.providerBoundary === 'local' ? 'local' : 'cloud', privacyBoundary: request.privacyBoundary }, {
      requirementId: `generation:${request.operation}`,
      outputModality: request.skill === 'generate_image' ? 'image' : 'video',
      skill: request.skill,
      generationOperation: request.skill === 'generate_image' ? 'image' : 'video',
      providerOperation: request.operation === 'image-edit' ? 'image-edit' : request.skill === 'generate_image' ? 'image-generation' : 'video-generation',
      privacyBoundary: request.privacyBoundary,
      requiresCostEstimate: true,
      requiresCancellation: true
    });
  }

  private adapterFor(provider: string, operation: GenerationOperation): GenerationProviderAdapter | undefined { return this.options.adapters.find((candidate) => candidate.provider === provider && candidate.operations.includes(operation)); }

  private async providerInput(operation: GenerationOperationRecord, signal?: AbortSignal): Promise<GenerationProviderInput> {
    const handles: Array<{ artifactId: string; managedPath: string; contentHash: string }> = [];
    if (operation.sourceArtifactIds.length) {
      if (!this.options.intake || operation.operation !== 'image-edit') throw new GenerationError('raw-content-not-approved', 'Image editing requires host-managed approved source content.');
      for (const artifactId of operation.sourceArtifactIds) {
        const source = this.options.intake.get(artifactId);
        const handle = source ? this.options.intake.authorizeRawContent(artifactId, source.contentHash) : undefined;
        if (!handle) throw new GenerationError('raw-content-not-approved', 'The source media handle is not available for this approved operation.');
        handles.push({ artifactId: handle.artifactId, managedPath: handle.managedPath, contentHash: handle.contentHash });
      }
    }
    const prompt = this.prompts.get(operation.operationId);
    if (!prompt) throw new GenerationError('invalid-request', 'The prompt is not retained across restart; recreate the generation approval.');
    return { operationId: operation.operationId, provider: operation.provider, model: operation.model, prompt, parameters: cloneGeneration(operation.parameters), sourceArtifactIds: [...operation.sourceArtifactIds], rawContentHandles: handles, signal: signal ?? new AbortController().signal };
  }

  private async runVideo(adapter: GenerationProviderAdapter, input: GenerationProviderInput, operation: GenerationOperationRecord, signal?: AbortSignal): Promise<ProviderGenerationResult> {
    if (!adapter.createVideo || !adapter.pollVideo || !adapter.cancelVideo) throw new GenerationError('unsupported-provider-endpoint', 'Video requires create, status, content, and documented cancellation operations.');
    const created = await adapter.createVideo(input);
    operation.providerJobId = created.providerJobId;
    operation.usage = normalizeUsage(created.usage, created.requestId, created.providerJobId);
    if (created.status === 'completed') return created;
    if (!created.providerJobId) throw new GenerationError('provider-failed', 'The video provider did not return a job identity.');
    for (let attempt = 0; attempt < this.maxVideoPolls; attempt += 1) {
      if (signal?.aborted) { await adapter.cancelVideo(created.providerJobId, signal).catch(() => undefined); throw new DOMException('The operation was aborted.', 'AbortError'); }
      await delay(this.pollDelayMs, signal);
      const status = await adapter.pollVideo(created.providerJobId, signal ?? new AbortController().signal);
      operation.providerJobId = status.providerJobId;
      if (status.status === 'completed') return { status: 'completed', providerJobId: status.providerJobId, requestId: status.requestId ?? created.requestId, bytes: status.bytes, usage: status.usage ?? created.usage };
      if (status.status === 'failed') throw new GenerationError('provider-failed', 'The video provider reported a failed job.');
      if (status.status === 'cancelled') throw new DOMException('The operation was aborted.', 'AbortError');
      if (status.status === 'unknown') throw new GenerationError('unknown-provider-state', 'The video provider returned an unknown lifecycle state.');
      operation.status = status.status === 'queued' ? 'queued' : 'in-progress';
    }
    throw new GenerationError('unknown-provider-state', 'The video provider did not reach a known terminal state within the bounded polling window.');
  }

  private async storeOutput(operation: GenerationOperationRecord, bytes: Uint8Array, usage?: GenerationUsage, requestId?: string, providerJobId?: string): Promise<GeneratedArtifact> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 100 * 1024 * 1024) throw new GenerationError('output-storage-failed', 'Generated output exceeded the managed storage boundary.');
    const artifactId = `generated-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const file = this.managedPath(artifactId);
    try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' }); } catch { throw new GenerationError('output-storage-failed', 'Generated output could not be stored in the managed workspace boundary.'); }
    const artifact: GeneratedArtifact = { version: GENERATION_VERSION, artifactId, operationId: operation.operationId, sourceArtifactIds: [...operation.sourceArtifactIds], promptFingerprint: operation.promptFingerprint, route: cloneGeneration(operation.route), managedReference: `generated://${artifactId}`, storageBoundary: 'workspace-managed', provenance: operation.operation === 'image-edit' ? 'provider-edited' : 'provider-generated', privacyBoundary: operation.route.privacyBoundary, attribution: cloneGeneration(operation.attribution), estimatedCostUsd: operation.estimatedCost?.amountUsd, usage: normalizeUsage(usage, requestId, providerJobId), publication: 'unpublished', createdAt: new Date(this.now()).toISOString() };
    this.artifacts.set(artifactId, artifact);
    return artifact;
  }

  private async fail(operation: GenerationOperationRecord, reason: GenerationReasonCode, _message: string): Promise<GenerationOperationRecord> { operation.status = reason === 'budget-blocked' ? 'budget-blocked' : 'failed'; operation.reason = reason; operation.updatedAt = new Date(this.now()).toISOString(); await this.options.approval.recordLifecycle(operation.approval?.previewId ?? operation.operationId, reason === 'budget-blocked' ? 'budget' : 'failed', { outcome: reason, reason: `Generation ended: ${reason}.` }).catch(() => undefined); await this.persist(); await this.activityEvent(operation, operation.status, `Generation ended: ${reason}.`); return cloneGeneration(operation); }
  private require(operationId: string): GenerationOperationRecord { const value = this.operations.get(operationId); if (!value) throw new GenerationError('invalid-request', 'The generation operation is not available.'); return value; }
  private managedPath(artifactId: string): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'generated', `${artifactId}.bin`); }
  private async activityEvent(operation: GenerationOperationRecord, status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'budget-blocked', summary: string): Promise<void> { if (!this.options.activity) return; try { const activityStatus = status === 'in-progress' ? 'running' : status === 'queued' ? 'queued' : status === 'budget-blocked' ? 'failed' : status; await this.options.activity.append(operation.sessionId, { status: activityStatus, kind: 'model', requestId: operation.operationId, model: operation.model, route: `${operation.route.providerBoundary}:${operation.provider}`, action: `generation:${operation.operation}`, summary, estimatedCostUsd: operation.estimatedCost?.amountUsd, actualCostUsd: operation.usage?.actualCostUsd, inputTokens: operation.usage?.inputTokens, outputTokens: operation.usage?.outputTokens, approvalRequired: true, errorCode: operation.reason }); } catch { /* Activity is best-effort; generation state remains authoritative. */ } }
  private async rehydrate(): Promise<void> { if (this.loaded) return this.loading; if (this.loading) return this.loading; this.loaded = true; this.loading = (async () => { try { const parsed = JSON.parse(await fs.readFile(this.ledgerPath, 'utf8')) as { version?: number; operations?: GenerationOperationRecord[]; artifacts?: GeneratedArtifact[] }; if (parsed.version !== GENERATION_VERSION) return; for (const row of (parsed.operations ?? []).slice(-50)) { if (isRecord(row)) { const value = cloneGeneration(row); if (value.status === 'queued' || value.status === 'in-progress') { value.status = 'unknown'; value.reason = 'unknown-provider-state'; } this.operations.set(value.operationId, value); } } for (const artifact of (parsed.artifacts ?? []).slice(-50)) if (isArtifact(artifact)) this.artifacts.set(artifact.artifactId, cloneGeneration(artifact)); } catch { /* Missing or corrupt state is safe empty state. */ } })(); return this.loading; }
  private get ledgerPath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'generation.json'); }
  private async persist(): Promise<void> { await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true }); const temporary = `${this.ledgerPath}.tmp-${process.pid}`; await fs.writeFile(temporary, `${JSON.stringify({ version: GENERATION_VERSION, operations: [...this.operations.values()].slice(-50), artifacts: [...this.artifacts.values()].slice(-50) })}\n`, 'utf8'); await fs.rename(temporary, this.ledgerPath); }
}

/** NEAR adapter intentionally implements images only; NEAR video is not guessed. */
export class NearAiGenerationAdapter implements GenerationProviderAdapter {
  public readonly provider = 'near-ai';
  public readonly operations = ['image-generation', 'image-edit'] as const;
  public readonly providerOperations = ['image-generation', 'image-edit'] as const;
  public constructor(private readonly client: NearAiClient) {}

  public async createImage(input: GenerationProviderInput): Promise<ProviderGenerationResult> {
    const result = await this.client.generateImage(input.model, input.prompt, { count: input.parameters.count, size: input.parameters.size, quality: input.parameters.quality }, input.signal);
    return { status: result.bytes ? 'completed' : 'failed', requestId: result.requestId, bytes: result.bytes, usage: usageFromProvider(result.usage, result.requestId), errorCode: result.remoteUrlPresent && !result.bytes ? 'remote-url-not-stored' : undefined };
  }

  public async editImage(input: GenerationProviderInput): Promise<ProviderGenerationResult> {
    if (input.rawContentHandles.length !== 1) throw new GenerationError('raw-content-not-approved', 'Image edit requires exactly one host-managed source image.');
    const bytes = await fs.readFile(input.rawContentHandles[0].managedPath);
    const result = await this.client.editImage(input.model, input.prompt, bytes, { size: input.parameters.size, quality: input.parameters.quality }, input.signal);
    return { status: result.bytes ? 'completed' : 'failed', requestId: result.requestId, bytes: result.bytes, usage: usageFromProvider(result.usage, result.requestId), errorCode: result.remoteUrlPresent && !result.bytes ? 'remote-url-not-stored' : undefined };
  }
}

function validateRequest(request: GenerationRequest): void { if (!request || (request.skill !== 'generate_image' && request.skill !== 'generate_video') || !request.provider || !request.model || !request.sessionId || !request.projectId || !request.attribution || !request.prompt || request.prompt.length > MAX_GENERATION_PROMPT) throw new GenerationError('invalid-request', 'Generation requires bounded host-owned request metadata and a non-empty prompt.'); if ((request.sourceArtifactIds?.length ?? 0) > MAX_GENERATION_SOURCES || new Set(request.sourceArtifactIds ?? []).size !== (request.sourceArtifactIds ?? []).length || (request.sourceArtifactIds ?? []).some((id) => !/^attachment-[a-z0-9]{20}$/.test(id))) throw new GenerationError('invalid-request', 'Generation source references must be bounded opaque attachment IDs.'); if (request.operation === 'image-edit' && (request.skill !== 'generate_image' || request.rawContentRequested !== true || !request.sourceArtifactIds?.length)) throw new GenerationError('raw-content-not-approved', 'Image editing requires explicit raw-content authorization and a staged source.'); if (request.operation === 'video-generation' && request.skill !== 'generate_video') throw new GenerationError('invalid-request', 'Video generation requires the video generation skill.'); if (request.operation === 'image-generation' && request.sourceArtifactIds?.length) throw new GenerationError('invalid-request', 'Image generation does not accept unbound source media; use image edit.'); }
function validateAdapter(adapter: GenerationProviderAdapter, operation: GenerationOperation): void { const required = operation === 'image-generation' ? ['image-generation'] : operation === 'image-edit' ? ['image-edit'] : ['video-generation', 'video-status', 'video-content', 'video-cancel']; if (!required.every((value) => adapter.providerOperations.includes(value))) throw new GenerationError('unsupported-provider-endpoint', 'The provider adapter did not advertise every required documented operation.'); }
function validateSnapshotOperations(snapshot: ModelCapabilitySnapshot, operation: GenerationOperation): void { const required = operation === 'image-generation' ? ['image-generation'] : operation === 'image-edit' ? ['image-edit'] : ['video-generation', 'video-status', 'video-content', 'video-cancel']; if (!required.every((value) => snapshot.providerOperations.includes(value as never))) throw new GenerationError('unsupported-provider-operation', 'The model snapshot does not advertise every required provider operation.'); }
function routeSnapshot(snapshot: ModelCapabilitySnapshot, request: GenerationRequest, capturedAt: string): GenerationRouteSnapshot { return { provider: request.provider, model: request.model, operation: request.operation, capabilitySnapshotId: snapshot.snapshotId, capabilityMetadata: { version: snapshot.version, snapshotId: snapshot.snapshotId, provider: snapshot.provider, modelId: snapshot.modelId, inputModalities: [...snapshot.inputModalities], outputModalities: [...snapshot.outputModalities], supportedFeatures: [...snapshot.supportedFeatures], providerOperations: [...snapshot.providerOperations], readiness: snapshot.readiness, pricing: { ...snapshot.pricing }, privacyBoundary: snapshot.privacyBoundary, locality: snapshot.locality, verificationStatus: snapshot.verificationStatus, metadataStatus: snapshot.metadataStatus, freshness: snapshot.freshness, source: snapshot.source }, providerBoundary: request.providerBoundary, privacyBoundary: request.privacyBoundary, capturedAt }; }
function estimateCost(snapshot: ModelCapabilitySnapshot, request: GenerationRequest): GenerationCostEstimate | undefined { const quantity = request.operation === 'video-generation' ? Math.max(1, Math.floor(request.parameters?.durationSeconds ?? 1)) : Math.max(1, Math.min(4, Math.floor(request.parameters?.count ?? 1))); const unit = request.operation === 'video-generation' ? snapshot.pricing.videoPricePerUnit ?? snapshot.pricing.requestPricePerUnit : snapshot.pricing.imagePricePerUnit ?? snapshot.pricing.requestPricePerUnit; if (unit === undefined || !Number.isFinite(unit) || unit < 0) return undefined; return { amountUsd: unit * quantity, currency: 'USD', basis: request.operation === 'video-generation' ? snapshot.pricing.videoPricePerUnit !== undefined ? 'video-unit' : 'request-unit' : snapshot.pricing.imagePricePerUnit !== undefined ? 'image-unit' : 'request-unit', quantity }; }
function normalizeParameters(value: GenerationRequest['parameters']): NonNullable<GenerationOperationRecord['parameters']> { return { count: boundedInt(value?.count, 1, 4), size: safeParameter(value?.size, 32), quality: safeParameter(value?.quality, 32), durationSeconds: boundedInt(value?.durationSeconds, 1, 120) }; }
function safeParameter(value: string | undefined, max: number): string | undefined { return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) ? value.slice(0, max) : undefined; }
function boundedInt(value: number | undefined, min: number, max: number): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined; }
function normalizeUsage(value: GenerationUsage | undefined, requestId?: string, providerJobId?: string): GenerationUsage | undefined { if (!value && !requestId && !providerJobId) return undefined; return { requestId: safeId(requestId), providerJobId: safeId(providerJobId), inputTokens: safeNumber(value?.inputTokens), outputTokens: safeNumber(value?.outputTokens), units: safeNumber(value?.units), actualCostUsd: safeNumber(value?.actualCostUsd), verificationStatus: value?.verificationStatus }; }
function totalTokens(value: GenerationUsage | undefined): number | undefined { const total = (value?.inputTokens ?? 0) + (value?.outputTokens ?? 0); return total > 0 ? total : undefined; }
function safeNumber(value: number | undefined): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function safeId(value: string | undefined): string | undefined { return value && /^[A-Za-z0-9._:/-]{1,160}$/.test(value) ? value : undefined; }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function unavailable(evaluation: CapabilityEvaluation): GenerationError { const reason = evaluation.reasons[0]; const code: GenerationReasonCode = reason === 'unknown-model' ? 'unknown-model' : reason === 'metadata-unknown' ? 'metadata-unknown' : reason === 'stale-metadata' ? 'stale-metadata' : reason === 'metadata-contradictory' ? 'metadata-contradictory' : reason === 'model-not-ready' ? 'model-not-ready' : reason === 'unsupported-skill' ? 'unsupported-skill' : reason === 'unsupported-provider-operation' ? 'unsupported-provider-operation' : reason === 'cancellation-unsupported' ? 'unsupported-cancellation' : reason === 'privacy-mismatch' ? 'privacy-mismatch' : reason === 'unavailable-pricing' ? 'unavailable-pricing' : 'unsupported-operation'; return new GenerationError(code, 'The selected provider/model does not advertise a current compatible generation capability.'); }
function isTerminal(status: GenerationOperationRecord['status']): boolean { return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'budget-blocked' || status === 'unknown'; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function delay(ms: number, signal?: AbortSignal): Promise<void> { if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError')); return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('The operation was aborted.', 'AbortError')); }, { once: true }); }); }
function safeDestination(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 240 && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.startsWith('.') && !value.includes('\0'); }
function normalizeDestination(value: string): string { return value.split('/').filter(Boolean).join('/'); }
function within(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
async function isSymlink(value: string): Promise<boolean> { try { return (await fs.lstat(value)).isSymbolicLink(); } catch { return false; } }
function isRecord(value: unknown): value is GenerationOperationRecord { return Boolean(value && typeof value === 'object' && (value as GenerationOperationRecord).version === GENERATION_VERSION && typeof (value as GenerationOperationRecord).operationId === 'string'); }
function isArtifact(value: unknown): value is GeneratedArtifact { return Boolean(value && typeof value === 'object' && (value as GeneratedArtifact).version === GENERATION_VERSION && typeof (value as GeneratedArtifact).artifactId === 'string' && typeof (value as GeneratedArtifact).managedReference === 'string'); }
function usageFromProvider(value: { requestId?: string; inputTokens?: number; outputTokens?: number; actualCostUsd?: number; verificationStatus?: 'verified' | 'unverified' | 'unknown' } | undefined, requestId?: string): GenerationUsage | undefined { if (!value && !requestId) return undefined; return { requestId: value?.requestId ?? requestId, inputTokens: value?.inputTokens, outputTokens: value?.outputTokens, actualCostUsd: value?.actualCostUsd, verificationStatus: value?.verificationStatus }; }

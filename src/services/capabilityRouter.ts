import { createHash } from 'node:crypto';
import type { CapabilityEvaluation, CapabilityReasonCode, CapabilityRequirement, CapabilityRouteInput, CapabilityRouteResult, CapabilityPrivacyBoundary, ModelCapabilitySnapshot, ProviderOperation, SkillCapability } from '../domain/capabilities';
import { CAPABILITY_SNAPSHOT_VERSION, cloneCapability } from '../domain/capabilities';
import type { AgentLocality } from '../domain/agents';
import type { ModelInfo } from './nearAiClient';

export interface CapabilityCatalog {
  listModels(): Promise<ModelInfo[]>;
}

export interface CapabilityRouterOptions {
  catalog?: CapabilityCatalog | ModelInfo[] | (() => ModelInfo[] | Promise<ModelInfo[]>);
  clock?: () => string;
  freshnessMs?: number;
}

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * CapabilityRouter is deliberately metadata-only. It never creates a provider
 * client, reads credentials, or infers support from a model name.
 */
export class CapabilityRouter {
  private readonly clock: () => string;
  private readonly freshnessMs: number;
  private readonly catalog?: CapabilityRouterOptions['catalog'];

  public constructor(options: CapabilityRouterOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.freshnessMs = Math.max(1, options.freshnessMs ?? DEFAULT_FRESHNESS_MS);
    this.catalog = options.catalog;
  }

  public async snapshot(provider: string, model: string | undefined): Promise<ModelCapabilitySnapshot | undefined> {
    if (!model || !this.catalog) return undefined;
    const models = await this.models();
    const match = models.find((candidate) => candidate.provider === provider && candidate.id === model)
      ?? models.find((candidate) => (candidate.provider ?? 'near-ai') === provider && candidate.id === model);
    return match ? snapshotFromModel(match, this.clock(), this.freshnessMs) : undefined;
  }

  public async evaluate(candidate: CapabilityRouteInput, requirement: CapabilityRequirement): Promise<CapabilityEvaluation> {
    const reasons: CapabilityReasonCode[] = [];
    if (requirement.skill && candidate.memberSkills && !candidate.memberSkills.includes(requirement.skill)) reasons.push('missing-member-skill');
    const snapshot = await this.snapshot(candidate.provider, candidate.model);
    if (!snapshot) {
      reasons.push('unknown-model');
      return this.result(requirement, reasons, undefined);
    }
    if (snapshot.metadataStatus === 'unknown') reasons.push('metadata-unknown');
    if (snapshot.metadataStatus === 'contradictory') reasons.push('metadata-contradictory');
    if (snapshot.freshness === 'stale') reasons.push('stale-metadata');
    if (snapshot.freshness === 'unknown') reasons.push('metadata-unknown');
    if (snapshot.readiness !== 'ready') reasons.push('model-not-ready');
    const inputModality = requirement.inputModality ?? (requirement.modality && requirement.skill !== 'generate_image' && requirement.skill !== 'generate_video' ? requirement.modality : undefined);
    const outputModality = requirement.outputModality ?? (requirement.generationOperation ? requirement.generationOperation : requirement.skill === 'generate_image' ? 'image' : requirement.skill === 'generate_video' ? 'video' : undefined);
    if (inputModality && !snapshot.inputModalities.includes(inputModality)) reasons.push('unsupported-input-modality');
    if (outputModality && !snapshot.outputModalities.includes(outputModality)) reasons.push('unsupported-output-modality');
    if (requirement.skill && !snapshot.supportedFeatures.includes(requirement.skill)) reasons.push('unsupported-skill');
    if (requirement.generationOperation && !(snapshot.generation?.operations.includes(requirement.generationOperation) || snapshot.supportedFeatures.includes(generationSkill(requirement.generationOperation)))) reasons.push('unsupported-generation');
    if (requirement.providerOperation && !snapshot.providerOperations.includes(requirement.providerOperation)) reasons.push('unsupported-provider-operation');
    if (candidate.locality === 'local' && snapshot.locality !== 'local') reasons.push('locality-mismatch');
    if (candidate.locality === 'cloud' && snapshot.locality === 'local') reasons.push('locality-mismatch');
    if (candidate.privacyBoundary === 'local' && snapshot.privacyBoundary !== 'local') reasons.push('privacy-mismatch');
    if (candidate.privacyBoundary === 'cloud' && snapshot.privacyBoundary !== 'cloud' && snapshot.privacyBoundary !== 'tee') reasons.push('privacy-mismatch');
    if (requirement.locality && !localitySatisfies(snapshot.locality, requirement.locality, candidate.locality)) reasons.push('locality-mismatch');
    if (requirement.privacyBoundary && !privacySatisfies(snapshot.privacyBoundary, requirement.privacyBoundary, candidate.privacyBoundary)) reasons.push('privacy-mismatch');
    if (requirement.privacyBoundary === 'tee' && snapshot.verificationStatus !== 'verified') reasons.push('privacy-mismatch');
    if (requirement.requiresCancellation && snapshot.generation?.cancellationSupported !== true) reasons.push('cancellation-unsupported');
    if (requirement.requiresPublication && snapshot.generation?.publicationSupported !== true) reasons.push('publication-unsupported');
    const costAvailable = costAvailableFor(snapshot, requirement);
    if ((requirement.requiresCostEstimate !== false) && !costAvailable) reasons.push('unavailable-pricing');
    if (requirement.maxCostUsd !== undefined && (candidate.estimatedCostUsd === undefined || candidate.estimatedCostUsd > requirement.maxCostUsd)) reasons.push('unavailable-pricing');
    return this.result(requirement, unique(reasons), snapshot, costAvailable);
  }

  public check(candidate: CapabilityRouteInput, requirement: CapabilityRequirement): Promise<CapabilityEvaluation> {
    return this.evaluate(candidate, requirement);
  }

  public async route(candidates: CapabilityRouteInput[], requirement: CapabilityRequirement): Promise<CapabilityRouteResult> {
    const evaluated = await Promise.all(candidates.map(async (candidate) => ({ candidate, evaluation: await this.evaluate(candidate, requirement) })));
    const compatibleCandidates = evaluated.filter((row) => row.evaluation.compatible);
    const excludedCandidates = evaluated.filter((row) => !row.evaluation.compatible);
    return {
      requirement: cloneCapability(requirement),
      compatibleCandidates: compatibleCandidates.map(cloneCapability),
      excludedCandidates: excludedCandidates.map(cloneCapability),
      reason: compatibleCandidates.length > 0 ? 'Only candidates with current, declared capability metadata remain eligible.' : 'No candidate has a current, declared capability route for this request.'
    };
  }

  public async describe(provider: string, model: string | undefined): Promise<ModelCapabilitySnapshot | undefined> {
    return this.snapshot(provider, model);
  }

  private async models(): Promise<ModelInfo[]> {
    if (!this.catalog) return [];
    if (Array.isArray(this.catalog)) return this.catalog.map(cloneCapability);
    if (typeof this.catalog === 'function') return cloneCapability(await this.catalog());
    return cloneCapability(await this.catalog.listModels());
  }

  private result(requirement: CapabilityRequirement, reasons: CapabilityReasonCode[], snapshot?: ModelCapabilitySnapshot, costAvailable = snapshot ? costAvailableFor(snapshot, requirement) : false): CapabilityEvaluation {
    const uniqueReasons = unique(reasons);
    const compatible = uniqueReasons.length === 0 && Boolean(snapshot);
    const status = compatible ? 'compatible' : requirement.privacyBoundary || requirement.requiresCancellation || requirement.requiresPublication ? 'denied' : 'unavailable';
    return { requirementId: requirement.requirementId, status, compatible, reasons: uniqueReasons, explanation: compatible ? 'Current provider metadata satisfies the requested capability and route constraints.' : reasonText(uniqueReasons), snapshot: snapshot ? cloneCapability(snapshot) : undefined, costAvailable };
  }
}

export function snapshotFromModel(model: ModelInfo, now = new Date().toISOString(), freshnessMs = DEFAULT_FRESHNESS_MS): ModelCapabilitySnapshot {
  const fetchedAt = model.fetchedAt;
  const age = fetchedAt ? Date.parse(now) - Date.parse(fetchedAt) : Number.NaN;
  const freshness = model.capabilityMetadataStatus === 'unknown' || !fetchedAt || Number.isNaN(age) ? 'unknown' : age >= 0 && age <= freshnessMs ? 'current' : 'stale';
  const metadataStatus = model.capabilityMetadataStatus ?? (model.inputModalities && model.outputModalities && model.supportedFeatures ? 'current' : 'unknown');
  const generationOperations = [
    ...(model.supportedFeatures?.includes('generate_image') ? ['image' as const] : []),
    ...(model.supportedFeatures?.includes('generate_video') ? ['video' as const] : [])
  ];
  const providerOperations = model.providerOperations ?? [];
  const generation = generationOperations.length > 0 || model.cancellationSupported !== undefined || model.publicationSupported !== undefined
    ? { operations: generationOperations, cancellationSupported: model.cancellationSupported, publicationSupported: model.publicationSupported }
    : undefined;
  const snapshotBase = { provider: model.provider ?? 'near-ai', modelId: model.id, fetchedAt, source: model.capabilitySource ?? 'provider-catalog', metadataStatus, inputModalities: model.inputModalities ?? [], outputModalities: model.outputModalities ?? [], supportedFeatures: model.supportedFeatures ?? [], providerOperations, readiness: model.readiness ?? 'unknown', pricing: { inputPricePerMillion: model.inputPricePerMillion, outputPricePerMillion: model.outputPricePerMillion, cachePricePerMillion: model.cachePricePerMillion, imagePricePerUnit: model.imagePricePerUnit, videoPricePerUnit: model.videoPricePerUnit, requestPricePerUnit: model.requestPricePerUnit } };
  const snapshotId = `cap-${createHash('sha256').update(JSON.stringify(snapshotBase)).digest('hex').slice(0, 20)}`;
  const snapshot: ModelCapabilitySnapshot = {
    version: CAPABILITY_SNAPSHOT_VERSION,
    snapshotId,
    provider: snapshotBase.provider,
    modelId: model.id,
    displayName: model.name,
    inputModalities: [...snapshotBase.inputModalities],
    outputModalities: [...snapshotBase.outputModalities],
    supportedFeatures: [...snapshotBase.supportedFeatures],
    providerOperations: [...providerOperations],
    generation,
    readiness: snapshotBase.readiness,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    pricing: { ...snapshotBase.pricing },
    privacyBoundary: model.privacyBoundary ?? 'unknown',
    locality: model.locality ?? 'unknown',
    verificationStatus: model.verificationStatus ?? 'unknown',
    attestationStatus: model.attestationStatus,
    metadataStatus,
    freshness,
    fetchedAt,
    source: snapshotBase.source,
    availability: 'unavailable',
    unavailableReasons: metadataStatus === 'contradictory' ? ['metadata-contradictory'] : metadataStatus === 'unknown' ? ['metadata-unknown'] : freshness === 'stale' ? ['stale-metadata'] : []
  };
  snapshot.availability = snapshot.unavailableReasons.length === 0 && snapshot.readiness === 'ready' ? 'compatible' : 'unavailable';
  return snapshot;
}

function costAvailableFor(snapshot: ModelCapabilitySnapshot, requirement: CapabilityRequirement): boolean {
  if (requirement.requiresCostEstimate === false) return true;
  if (requirement.generationOperation === 'video') return snapshot.pricing.videoPricePerUnit !== undefined || snapshot.pricing.requestPricePerUnit !== undefined;
  if (requirement.generationOperation === 'image') return snapshot.pricing.imagePricePerUnit !== undefined || snapshot.pricing.requestPricePerUnit !== undefined;
  if (requirement.modality === 'image' || requirement.inputModality === 'image') return snapshot.pricing.imagePricePerUnit !== undefined || snapshot.pricing.inputPricePerMillion !== undefined;
  return snapshot.pricing.inputPricePerMillion !== undefined && snapshot.pricing.outputPricePerMillion !== undefined;
}

function generationSkill(operation: 'image' | 'video'): SkillCapability { return operation === 'image' ? 'generate_image' : 'generate_video'; }
function localitySatisfies(snapshot: AgentLocality | 'unknown', required: AgentLocality, candidate: AgentLocality): boolean { return snapshot === 'unknown' ? false : snapshot === required || snapshot === 'hybrid' || candidate === 'hybrid'; }
function privacySatisfies(snapshot: CapabilityPrivacyBoundary, required: CapabilityPrivacyBoundary, candidate?: CapabilityPrivacyBoundary): boolean { if (candidate === 'hybrid' || required === 'hybrid') return snapshot !== 'unknown'; return snapshot === required; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function reasonText(reasons: CapabilityReasonCode[]): string { return reasons.length ? `Capability route unavailable: ${reasons.join(', ')}.` : 'Capability route unavailable.'; }

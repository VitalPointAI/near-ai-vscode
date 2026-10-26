import { isSecureEndpoint } from '../domain/config';
import { redactSecrets } from '../domain/redaction';
import type { CapabilityMetadataStatus, CapabilityModality, CapabilityPrivacyBoundary, SkillCapability, ProviderOperation } from '../domain/capabilities';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachePricePerMillion?: number;
  imagePricePerUnit?: number;
  videoPricePerUnit?: number;
  requestPricePerUnit?: number;
  supportsReasoning?: boolean;
  inputModalities?: CapabilityModality[];
  outputModalities?: CapabilityModality[];
  architectureInputModalities?: CapabilityModality[];
  architectureOutputModalities?: CapabilityModality[];
  supportedFeatures?: SkillCapability[];
  providerOperations?: ProviderOperation[];
  readiness?: 'ready' | 'not-ready' | 'unknown';
  privacyBoundary?: CapabilityPrivacyBoundary;
  locality?: 'cloud' | 'local' | 'hybrid' | 'unknown';
  verificationStatus?: VerificationStatus;
  attestationStatus?: string;
  cancellationSupported?: boolean;
  publicationSupported?: boolean;
  capabilityMetadataStatus?: CapabilityMetadataStatus;
  fetchedAt?: string;
  capabilitySource?: string;
}

export type VerificationStatus = 'verified' | 'unverified' | 'unknown';

export interface UsageMetadata {
  requestId?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  verificationStatus: VerificationStatus;
  latencyMs: number;
}

export interface ImageGenerationOptions {
  count?: number;
  size?: string;
  quality?: string;
}

export interface ImageGenerationResult {
  requestId?: string;
  bytes?: Uint8Array;
  usage?: UsageMetadata;
  remoteUrlPresent: boolean;
}

export interface ChatDelta {
  text: string;
  done: boolean;
  usage?: UsageMetadata;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string; metadata?: UsageMetadata }
  | { type: 'status'; status: 'started' | 'completed' | 'cancelled'; metadata: UsageMetadata }
  | { type: 'done'; metadata: UsageMetadata };

export interface NearAiClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** How long to wait for response headers; a stream that has started is never cut off. */
  responseTimeoutMs?: number;
  clock?: () => string;
}

export const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;

export function createNearAiClient(options: NearAiClientOptions): NearAiClient {
  return new NearAiClient(options);
}

export class NearAiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId?: string
  ) {
    super(redactSecrets(message));
    this.name = 'NearAiError';
  }
}

export function classifyRetryableFailure(status: number, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function estimateCostUsd(model: ModelInfo, inputTokens = 0, outputTokens = 0): number | undefined {
  if (model.inputPricePerMillion === undefined || model.outputPricePerMillion === undefined) return undefined;
  return (inputTokens * model.inputPricePerMillion + outputTokens * model.outputPricePerMillion) / 1_000_000;
}

export class NearAiClient {
  private readonly fetchFn: typeof fetch;
  private readonly models = new Map<string, ModelInfo>();

  public constructor(private readonly options: NearAiClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request('/models', { method: 'GET', signal });
    return this.rememberModels(normalizeModelRows(await jsonRows(response), (this.options.clock ?? (() => new Date().toISOString()))(), '/models'));
  }

  public async listModelsWithPricing(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request('/models/pricing', { method: 'GET', signal });
    return this.rememberModels(normalizeModelRows(await jsonRows(response), (this.options.clock ?? (() => new Date().toISOString()))(), '/models/pricing'));
  }

  /** Official NEAR image-generation contract. No video endpoint is assumed here. */
  public async generateImage(model: string, prompt: string, options: ImageGenerationOptions = {}, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const started = Date.now();
    const body: Record<string, unknown> = { model, prompt };
    if (options.count !== undefined) body.n = options.count;
    if (options.size !== undefined) body.size = options.size;
    if (options.quality !== undefined) body.quality = options.quality;
    const response = await this.request('/images/generations', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return imageResult(await response.json(), metadataFromHeaders(response.headers, started));
  }

  /** Official NEAR image-edit contract. The staged image bytes never enter durable telemetry. */
  public async editImage(model: string, prompt: string, image: Uint8Array, options: ImageGenerationOptions = {}, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const started = Date.now();
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('image', new Blob([Buffer.from(image)], { type: 'application/octet-stream' }), 'source.bin');
    if (options.size !== undefined) form.set('size', options.size);
    if (options.quality !== undefined) form.set('quality', options.quality);
    const response = await this.request('/images/edits', { method: 'POST', signal, body: form });
    return imageResult(await response.json(), metadataFromHeaders(response.headers, started));
  }

  /** Reconcile a completed request with provider-reported usage and actual cost. */
  public async reconcileUsage(requestId: string, signal?: AbortSignal): Promise<UsageMetadata> {
    const response = await this.request(`/usage/${encodeURIComponent(requestId)}`, { method: 'GET', signal });
    const body = await response.json() as Record<string, unknown>;
    const payload = objectValue(body.data ?? body);
    const metadata = usageFromPayload(payload, metadataFromHeaders(response.headers, Date.now()), requestId);
    return { ...metadata, estimatedCostUsd: undefined };
  }

  public async *streamChat(model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatDelta> {
    const started = Date.now();
    const response = await this.request('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
    const metadata = metadataFromHeaders(response.headers, started);
    if (!response.body) throw new NearAiError(response.status, 'NEAR AI returned no streaming body.', false, metadata.requestId);

    let completed = false;
    try {
      for await (const event of this.readEvents(response.body, metadata, signal, this.models.get(model))) {
        if (event.type === 'text') yield { text: event.text, done: false, usage: event.metadata };
        if (event.type === 'done') {
          completed = true;
          yield { text: '', done: true, usage: event.metadata };
        }
      }
      if (!signal?.aborted && !completed) yield { text: '', done: true, usage: { ...metadata, latencyMs: Date.now() - started } };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      throw error;
    }
  }

  public async *streamChatEvents(model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const started = Date.now();
    const response = await this.request('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
    const metadata = metadataFromHeaders(response.headers, started);
    if (!response.body) throw new NearAiError(response.status, 'NEAR AI returned no streaming body.', false, metadata.requestId);

    yield { type: 'status', status: 'started', metadata };
    try {
      for await (const event of this.readEvents(response.body, metadata, signal, this.models.get(model))) yield event;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        yield { type: 'status', status: 'cancelled', metadata: { ...metadata, latencyMs: Date.now() - started } };
        return;
      }
      throw error;
    }
    const completed = { ...metadata, latencyMs: Date.now() - started };
    yield { type: 'status', status: 'completed', metadata: completed };
    yield { type: 'done', metadata: completed };
  }

  private async *readEvents(body: ReadableStream<Uint8Array>, initial: UsageMetadata, signal?: AbortSignal, model?: ModelInfo): AsyncGenerator<ChatStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let metadata = initial;
    let finished = false;
    try {
      while (!finished) {
        const next = await reader.read();
        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (next.done) {
          buffer += decoder.decode();
          finished = true;
        } else {
          buffer += decoder.decode(next.value, { stream: true });
        }
        const lines = buffer.split(/\r?\n/);
        buffer = finished ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          const event = parseSseLine(line, metadata, model);
          if (!event) continue;
          if (event.type === 'done') return;
          if (event.type === 'text' && event.metadata) metadata = event.metadata;
          yield event;
        }
      }
    } finally {
      if (signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private rememberModels(models: ModelInfo[]): ModelInfo[] {
    for (const model of models) this.models.set(model.id, model);
    return models;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    const maxRetries = Math.max(0, Math.min(3, this.options.maxRetries ?? 2));
    const retryBaseDelayMs = Math.max(0, this.options.retryBaseDelayMs ?? 100);
    const responseTimeoutMs = Math.max(1, this.options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
    if (!isSecureEndpoint(url)) throw new NearAiError(0, 'NEAR AI endpoint must use HTTPS; plain HTTP is only allowed for localhost.', false);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const attemptAbort = new AbortController();
      const forwardAbort = () => attemptAbort.abort(init.signal?.reason);
      if (init.signal?.aborted) forwardAbort(); else init.signal?.addEventListener('abort', forwardAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; attemptAbort.abort(); }, responseTimeoutMs);
      try {
        response = await this.fetchFn(url, {
          ...init,
          signal: attemptAbort.signal,
          headers: { authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) }
        });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        if (timedOut) {
          if (attempt < maxRetries) { await waitForRetry(retryBaseDelayMs, attempt, init.signal ?? undefined); continue; }
          throw new NearAiError(408, `NEAR AI did not respond within ${Math.round(responseTimeoutMs / 1000)} seconds.`, true);
        }
        if (isAbortError(error)) throw error;
        if (attempt < maxRetries) {
          await waitForRetry(retryBaseDelayMs, attempt, init.signal ?? undefined);
          continue;
        }
        throw new NearAiError(0, `NEAR AI request failed: ${error instanceof Error ? error.message : 'network error'}.`, true);
      } finally {
        clearTimeout(timer);
      }
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      if (response.ok) return response;
      const requestId = metadataFromHeaders(response.headers, Date.now()).requestId;
      const retryable = classifyRetryableFailure(response.status, init.signal ?? undefined);
      if (retryable && attempt < maxRetries) {
        await waitForRetry(retryBaseDelayMs, attempt, init.signal ?? undefined);
        continue;
      }
      throw new NearAiError(response.status, `NEAR AI request failed with HTTP ${response.status}.`, retryable, requestId);
    }
  }
}

async function jsonRows(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.json() as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  return Array.isArray(body) ? body : (body.data ?? []);
}

export function normalizeModelRows(rows: Array<Record<string, unknown>>, fetchedAt = new Date().toISOString(), source = '/models'): ModelInfo[] {
  return rows.map((model) => normalizeModelInfo(model, fetchedAt, source)).filter((model) => model.id.length > 0);
}

export function normalizeModelInfo(model: Record<string, unknown>, fetchedAt = new Date().toISOString(), source = '/models'): ModelInfo {
  const pricing = objectValue(model.pricing);
  const architecture = objectValue(model.architecture);
  const input = enumList(model.input_modalities ?? model.inputModalities, ['text', 'image', 'video', 'audio', 'document', 'structured'] as const);
  const output = enumList(model.output_modalities ?? model.outputModalities, ['text', 'image', 'video', 'audio', 'document', 'structured'] as const);
  const architectureInput = enumList(architecture.input_modalities ?? architecture.inputModalities, ['text', 'image', 'video', 'audio', 'document', 'structured'] as const);
  const architectureOutput = enumList(architecture.output_modalities ?? architecture.outputModalities, ['text', 'image', 'video', 'audio', 'document', 'structured'] as const);
  const feature = featureList(model.supported_features ?? model.supportedFeatures);
  const operations = operationList(model.provider_operations ?? model.providerOperations ?? model.operations);
  const malformed = input.malformed || output.malformed || architectureInput.malformed || architectureOutput.malformed || feature.malformed || operations.malformed;
  const contradictory = (input.values.length > 0 && architectureInput.values.length > 0 && !sameValues(input.values, architectureInput.values)) || (output.values.length > 0 && architectureOutput.values.length > 0 && !sameValues(output.values, architectureOutput.values));
  const inputModalities = input.values.length > 0 ? input.values : architectureInput.values;
  const outputModalities = output.values.length > 0 ? output.values : architectureOutput.values;
  const hasCapabilityMetadata = ['provider', 'input_modalities', 'inputModalities', 'output_modalities', 'outputModalities', 'architecture', 'supported_features', 'supportedFeatures', 'provider_operations', 'providerOperations', 'operations', 'readiness', 'status', 'privacy_boundary', 'privacyBoundary', 'locality', 'verification_status', 'verificationStatus', 'tee_status', 'teeStatus', 'attestation_status', 'attestationStatus', 'cancellation_supported', 'cancellationSupported', 'publication_supported', 'publicationSupported'].some((key) => key in model);
  const normalized: ModelInfo = {
    id: stringValue(model.id ?? model.model) ?? '',
    supportsReasoning: model.supports_reasoning === true || model.supportsReasoning === true
  };
  if (hasCapabilityMetadata) Object.assign(normalized, { provider: stringValue(model.provider) ?? 'near-ai', inputModalities, outputModalities, architectureInputModalities: architectureInput.values, architectureOutputModalities: architectureOutput.values, supportedFeatures: feature.values, providerOperations: operations.values, readiness: readinessValue(model.readiness ?? model.status), privacyBoundary: privacyBoundaryValue(model.privacy_boundary ?? model.privacyBoundary), locality: localityValue(model.locality), verificationStatus: verificationValue(model.verification_status ?? model.verificationStatus ?? model.tee_status ?? model.teeStatus), attestationStatus: stringValue(model.attestation_status ?? model.attestationStatus ?? model.tee_status ?? model.teeStatus), cancellationSupported: booleanValue(model.cancellation_supported ?? model.cancellationSupported), publicationSupported: booleanValue(model.publication_supported ?? model.publicationSupported), capabilityMetadataStatus: malformed ? 'unknown' : contradictory ? 'contradictory' : input.values.length > 0 && output.values.length > 0 && feature.values.length > 0 ? 'current' : 'unknown', fetchedAt, capabilitySource: source });
  const name = stringValue(model.name ?? model.display_name);
  const contextLength = numberValue(model.context_length ?? model.contextLength ?? model.max_context_length);
  const inputPrice = numberValue(pricing.input_per_million ?? pricing.inputPricePerMillion ?? pricing.input ?? model.input_price_per_million ?? model.inputPricePerMillion);
  const outputPrice = numberValue(pricing.output_per_million ?? pricing.outputPricePerMillion ?? pricing.output ?? model.output_price_per_million ?? model.outputPricePerMillion);
  const cachePrice = numberValue(pricing.cache_per_million ?? pricing.cachePricePerMillion ?? pricing.cache ?? model.cache_price_per_million ?? model.cachePricePerMillion);
  const imagePrice = numberValue(pricing.image_per_unit ?? pricing.imagePricePerUnit ?? pricing.image ?? model.image_price_per_unit ?? model.imagePricePerUnit);
  const videoPrice = numberValue(pricing.video_per_unit ?? pricing.videoPricePerUnit ?? pricing.video ?? model.video_price_per_unit ?? model.videoPricePerUnit);
  const requestPrice = numberValue(pricing.request_per_unit ?? pricing.requestPricePerUnit ?? pricing.request ?? model.request_price_per_unit ?? model.requestPricePerUnit);
  const maxOutputTokens = numberValue(model.max_output_tokens ?? model.maxOutputTokens ?? model.max_tokens);
  if (name !== undefined) normalized.name = name;
  if (contextLength !== undefined) normalized.contextLength = contextLength;
  if (inputPrice !== undefined) normalized.inputPricePerMillion = inputPrice;
  if (outputPrice !== undefined) normalized.outputPricePerMillion = outputPrice;
  if (cachePrice !== undefined) normalized.cachePricePerMillion = cachePrice;
  if (imagePrice !== undefined) normalized.imagePricePerUnit = imagePrice;
  if (videoPrice !== undefined) normalized.videoPricePerUnit = videoPrice;
  if (requestPrice !== undefined) normalized.requestPricePerUnit = requestPrice;
  if (maxOutputTokens !== undefined) normalized.maxOutputTokens = maxOutputTokens;
  return normalized;
}

function enumList<T extends string>(value: unknown, allowed: readonly T[]): { values: T[]; malformed: boolean } {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  const values = [...new Set(value.filter((item): item is T => allowed.includes(item as T)))];
  return { values, malformed: values.length !== value.length };
}

function featureList(value: unknown): { values: SkillCapability[]; malformed: boolean } {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  const aliases: Record<string, SkillCapability> = { analyze: 'analyze', image_analysis: 'analyze', vision: 'analyze', transcribe: 'transcribe', audio_transcription: 'transcribe', generate_image: 'generate_image', image_generation: 'generate_image', generate_video: 'generate_video', video_generation: 'generate_video' };
  const values: SkillCapability[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !aliases[item]) continue;
    if (!values.includes(aliases[item])) values.push(aliases[item]);
  }
  return { values, malformed: value.some((item) => typeof item !== 'string' || !aliases[item]) };
}

function operationList(value: unknown): { values: ProviderOperation[]; malformed: boolean } {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  const allowed: ProviderOperation[] = ['chat', 'image-analysis', 'audio-transcription', 'image-generation', 'image-edit', 'video-generation', 'video-status', 'video-content', 'video-cancel'];
  const values = [...new Set(value.filter((item): item is ProviderOperation => allowed.includes(item as ProviderOperation)))];
  return { values, malformed: values.length !== value.length };
}

function sameValues(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)); }
function readinessValue(value: unknown): ModelInfo['readiness'] { return value === 'ready' || value === 'available' ? 'ready' : value === 'not-ready' || value === 'unavailable' || value === 'disabled' ? 'not-ready' : 'unknown'; }
function privacyBoundaryValue(value: unknown): CapabilityPrivacyBoundary { return value === 'local' || value === 'cloud' || value === 'tee' ? value : 'unknown'; }
function localityValue(value: unknown): ModelInfo['locality'] { return value === 'local' || value === 'cloud' || value === 'hybrid' ? value : 'unknown'; }
function verificationValue(value: unknown): VerificationStatus { return value === 'verified' || value === 'true' ? 'verified' : value === 'unverified' || value === 'false' ? 'unverified' : 'unknown'; }
function booleanValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }

function parseSseLine(line: string, metadata: UsageMetadata, model?: ModelInfo): ChatStreamEvent | undefined {
  const value = line.trim();
  if (!value.startsWith('data:')) return undefined;
  const payload = value.slice(5).trim();
  if (payload === '[DONE]') return { type: 'done', metadata };
  try {
    const parsed = JSON.parse(payload) as {
      id?: unknown;
      provider?: unknown;
      choices?: Array<{ delta?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
    };
    const nextMetadata = usageFromPayload(parsed.usage ?? {}, metadata, stringValue(parsed.id) ?? metadata.requestId, stringValue(parsed.provider) ?? metadata.provider);
    nextMetadata.estimatedCostUsd = estimateCostUsd(model ?? { id: '' }, nextMetadata.inputTokens, nextMetadata.outputTokens) ?? metadata.estimatedCostUsd;
    const text = stringValue(parsed.choices?.[0]?.delta?.content) ?? '';
    return text || parsed.usage ? { type: 'text', text, metadata: nextMetadata } : undefined;
  } catch {
    throw new NearAiError(0, 'NEAR AI returned malformed streaming data.', false, metadata.requestId);
  }
}

function metadataFromHeaders(headers: Headers, startedAt: number): UsageMetadata {
  const verification = headers.get('x-near-tee-verified') ?? headers.get('x-verification-status') ?? headers.get('x-tee-status');
  const metadata: UsageMetadata = {
    requestId: headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('x-near-request-id') ?? undefined,
    provider: headers.get('x-provider') ?? headers.get('x-near-provider') ?? undefined,
    inputTokens: headerNumber(headers, 'x-input-tokens', 'x-prompt-tokens', 'x-usage-input-tokens'),
    outputTokens: headerNumber(headers, 'x-output-tokens', 'x-completion-tokens', 'x-usage-output-tokens'),
    verificationStatus: verification === 'true' || verification === 'verified' ? 'verified' : verification === 'false' || verification === 'unverified' ? 'unverified' : 'unknown',
    latencyMs: Date.now() - startedAt
  };
  const estimatedCost = headerNumber(headers, 'x-estimated-cost-usd', 'x-estimated-cost');
  const actualCost = headerNumber(headers, 'x-actual-cost-usd', 'x-actual-cost');
  if (estimatedCost !== undefined) metadata.estimatedCostUsd = estimatedCost;
  if (actualCost !== undefined) metadata.actualCostUsd = actualCost;
  return metadata;
}

function usageFromPayload(payload: Record<string, unknown>, base: UsageMetadata, requestId?: string, provider?: string): UsageMetadata {
  const next: UsageMetadata = {
    ...base,
    requestId: requestId ?? stringValue(payload.request_id ?? payload.requestId) ?? base.requestId,
    provider: provider ?? stringValue(payload.provider) ?? base.provider,
    inputTokens: numberValue(payload.input_tokens ?? payload.prompt_tokens ?? payload.inputTokens) ?? base.inputTokens,
    outputTokens: numberValue(payload.output_tokens ?? payload.completion_tokens ?? payload.outputTokens) ?? base.outputTokens
  };
  const verification = stringValue(payload.verification_status ?? payload.verificationStatus ?? payload.tee_status ?? payload.teeStatus);
  if (verification === 'verified' || verification === 'true') next.verificationStatus = 'verified';
  if (verification === 'unverified' || verification === 'false') next.verificationStatus = 'unverified';
  const actualCost = numberValue(payload.actual_cost_usd ?? payload.actualCostUsd ?? payload.cost_usd ?? payload.costUsd);
  if (actualCost !== undefined) next.actualCostUsd = actualCost;
  const estimatedCost = numberValue(payload.estimated_cost_usd ?? payload.estimatedCostUsd);
  if (estimatedCost !== undefined) next.estimatedCostUsd = estimatedCost;
  return next;
}

function imageResult(value: unknown, metadata: UsageMetadata): ImageGenerationResult {
  const body = objectValue(value);
  const rows = Array.isArray(body.data) ? body.data : [];
  const first = objectValue(rows[0]);
  const encoded = stringValue(first.b64_json ?? first.b64Json ?? first.base64);
  const remoteUrlPresent = typeof first.url === 'string' && first.url.length > 0;
  const bytes = encoded ? decodeBase64(encoded) : undefined;
  const usage = usageFromPayload(objectValue(body.usage), metadata, stringValue(body.request_id ?? body.requestId) ?? metadata.requestId, stringValue(body.provider) ?? metadata.provider);
  return { requestId: usage.requestId, bytes, usage, remoteUrlPresent };
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 140_000_000) return undefined;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length ? new Uint8Array(bytes) : undefined;
  } catch { return undefined; }
}

function headerNumber(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = numberValue(Number(headers.get(name)));
    if (value !== undefined) return value;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function waitForRetry(baseDelayMs: number, attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const delayMs = baseDelayMs * (2 ** attempt);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

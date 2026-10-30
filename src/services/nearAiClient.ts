import { createHash } from 'node:crypto';
import { sha256Hex, verifyResponse, type ResponseEvidence, type VerificationResult } from './attestation';
import { isSecureEndpoint } from '../domain/config';
import { redactSecrets } from '../domain/redaction';
import { currentSpendTag, SpendKind, SpendTag, usdToNano } from './spendLedger';
import type { SpendSink } from './spendAccount';
import type { BillingCostsAnswer } from './spendReconciler';
import type { CapabilityMetadataStatus, CapabilityModality, CapabilityPrivacyBoundary, SkillCapability, ProviderOperation } from '../domain/capabilities';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** A tool call as the OpenAI-compatible API returns it; `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Conversation messages for tool-calling runs. */
export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type CompletionEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; message: Extract<AgentMessage, { role: 'assistant' }>; finishReason: string; usage: UsageMetadata };

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
  /** Where NEAR sends the request when it does not run the model in its own TEE (e.g. "anthropic", "openrouter.ai"). */
  forwardedTo?: string;
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
  /** Of inputTokens, how many NEAR served from its prompt cache (billed at the cache-read price). */
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  verificationStatus: VerificationStatus;
  latencyMs: number;
  /** Time from sending the request to the first streamed token (queueing and prompt processing). */
  firstTokenMs?: number;
  /** Of outputTokens, reasoning, when NEAR reports it (completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number;
  /** Characters of reasoning and of answer (text plus tool-call arguments) streamed, to estimate the reasoning share when it is not reported. */
  reasoningChars?: number;
  answerChars?: number;
  /** Hashes for checking NEAR's signature on this completion later. */
  evidence?: ResponseEvidence;
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
  /** Quick retries of one request after a dropped connection, a timeout, or a 500/502/504 (0 or 1; default 1). Never for 429 or 503. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** A model's cooldown after a 429 or 503 that carries no Retry-After; it doubles while the model keeps refusing (default 5 s, at most 60 s). */
  cooldownBaseMs?: number;
  /** Jitter source in [0, 1) for the quick retry (Math.random by default). */
  random?: () => number;
  /** Milliseconds clock for model cooldowns (Date.now by default). */
  now?: () => number;
  /** How long to wait for response headers. */
  responseTimeoutMs?: number;
  /** How long a started stream may go without progress (a delta of reasoning, text, a tool call, or usage; SSE keep-alive comments do not count) before it counts as stalled. */
  streamIdleTimeoutMs?: number;
  /** The most one streamed model turn may take in total, however steadily it streams. */
  streamTurnTimeoutMs?: number;
  clock?: () => string;
  /** Where every billable response is recorded (the key's spend ledger), and the daily limit. */
  spend?: SpendSink;
  /** Tags every recorded response from this client carries (the project). */
  spendTag?: Pick<SpendTag, 'projectId'>;
}

/** Endpoints NEAR bills for; every 2xx answer from one is recorded in the spend ledger. */
const BILLABLE_PATHS = new Set(['/chat/completions', '/images/generations', '/images/edits', '/audio/transcriptions']);

export const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;
/** Output tokens allowed in one agent reply unless nearAi.agent.maxOutputTokens says otherwise. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/**
 * Time without progress, not total time: every delta (reasoning included) restarts it, so a long
 * answer that keeps arriving is never cut off. Keep-alive comments do not restart it, so a server
 * that holds the connection open without generating anything still counts as stalled.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
/** After [DONE], how long the connection may take to close before the reader stops waiting for it. */
const STREAM_END_GRACE_MS = 2_000;
/** The backstop for one streamed turn: a reply still going after an hour is stopped (the output cap normally ends it far sooner). */
export const DEFAULT_STREAM_TURN_TIMEOUT_MS = 60 * 60_000;

export function createNearAiClient(options: NearAiClientOptions): NearAiClient {
  return new NearAiClient(options);
}

/** Longest Retry-After the client honours; a larger value is treated as this. */
export const MAX_RETRY_AFTER_MS = 60_000;
export const DEFAULT_COOLDOWN_BASE_MS = 5_000;
/** How much of an error body is read for NEAR's message; the rest is discarded. */
const MAX_ERROR_BODY_BYTES = 16_384;
const MAX_ERROR_DETAIL_CHARS = 300;

export interface NearAiErrorDetails {
  /** How long NEAR asked the client to wait (Retry-After, capped at MAX_RETRY_AFTER_MS). */
  retryAfterMs?: number;
  /** NEAR's own error message, type, and code from the response body (secrets redacted). */
  detail?: string;
  errorType?: string;
  errorCode?: string;
  /** Raised by this client without sending anything: the model is cooling down after a 429 or 503. */
  cooling?: boolean;
  /** The model the request was for. */
  model?: string;
}

export class NearAiError extends Error {
  public readonly retryAfterMs?: number;
  public readonly detail?: string;
  public readonly errorType?: string;
  public readonly errorCode?: string;
  public readonly cooling?: boolean;
  public readonly model?: string;

  public constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId?: string,
    details: NearAiErrorDetails = {}
  ) {
    super(redactSecrets(message));
    this.name = 'NearAiError';
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.detail) this.detail = redactSecrets(details.detail);
    if (details.errorType) this.errorType = redactSecrets(details.errorType);
    if (details.errorCode) this.errorCode = redactSecrets(details.errorCode);
    if (details.cooling) this.cooling = true;
    if (details.model) this.model = details.model;
  }
}

/**
 * Milliseconds a Retry-After (or retry-after-ms) value asks for: delta-seconds or an HTTP-date,
 * capped at MAX_RETRY_AFTER_MS. Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now(), unit: 's' | 'ms' = 's'): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * (unit === 's' ? 1000 : 1);
  else if (unit === 's' && /[a-z]/i.test(text)) {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowMs;
  } else return undefined;
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(ms)));
}

/** Where rate-limit and error diagnostics go (the NEAR AI output channel in the extension). */
let diagnosticsSink: ((line: string) => void) | undefined;
export function setNearAiDiagnostics(sink: ((line: string) => void) | undefined): void {
  diagnosticsSink = sink;
}
function diagnose(line: string): void {
  try { diagnosticsSink?.(redactSecrets(line)); } catch { /* diagnostics never break a request */ }
}

/**
 * How a started stream failed: no progress for the idle limit (`stalled`), the connection broke
 * (`dropped`), the stream ended before the reply finished (`closed`), NEAR sent an error event
 * mid-response (`error`), or the reply ran past the limit for one turn (`turn-limit`).
 */
export type StreamInterruption = 'stalled' | 'dropped' | 'closed' | 'error' | 'turn-limit';

/** A stream that stopped sending, dropped, or ended early. Worth retrying, except a reply that ran past the turn limit. */
export class StreamInterruptedError extends NearAiError {
  public readonly kind: StreamInterruption;
  /** The idle limit that ran out (stalled). */
  public readonly idleMs?: number;

  public constructor(message: string, public readonly stalled: boolean, requestId?: string, details: { kind?: StreamInterruption; idleMs?: number; model?: string; detail?: string; retryable?: boolean } = {}) {
    super(0, message, details.retryable ?? true, requestId, { ...(details.model ? { model: details.model } : {}), ...(details.detail ? { detail: details.detail } : {}) });
    this.name = 'StreamInterruptedError';
    this.kind = details.kind ?? (stalled ? 'stalled' : 'dropped');
    if (details.idleMs !== undefined) this.idleMs = details.idleMs;
  }
}

/** "0.4", "1.5", "120": seconds for messages, without rounding a short limit down to 0. */
export function formatSeconds(ms: number): string {
  return ms >= 10_000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10);
}

export function classifyRetryableFailure(status: number, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * NEAR's prices: cached input tokens at the cache-read price when NEAR lists one, the rest at the
 * input price, plus the model's per-request price when it has one.
 */
export function estimateCostUsd(model: ModelInfo, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0): number | undefined {
  if (model.inputPricePerMillion === undefined || model.outputPricePerMillion === undefined) return undefined;
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const cachePrice = model.cachePricePerMillion ?? model.inputPricePerMillion;
  return ((inputTokens - cached) * model.inputPricePerMillion + cached * cachePrice + outputTokens * model.outputPricePerMillion) / 1_000_000 + (model.requestPricePerUnit ?? 0);
}

/** An image request's price: per image (NEAR's `pricing.image`) and per request, when NEAR lists them. */
export function estimateImageCostUsd(model: ModelInfo, images = 1): number | undefined {
  if (model.imagePricePerUnit === undefined && model.requestPricePerUnit === undefined) return undefined;
  return (model.imagePricePerUnit ?? 0) * Math.max(1, images) + (model.requestPricePerUnit ?? 0);
}

/** A local daily-limit refusal: nothing was sent. */
export class SpendLimitError extends Error {
  public readonly status = 402;
  public readonly retryable = false;
  public constructor(public readonly spentUsd: number, public readonly limitUsd: number, public readonly source: 'near' | 'local') {
    super(`Today's NEAR AI spend ($${spentUsd.toFixed(2)}${source === 'near' ? ', from NEAR\'s usage summary' : ''}) has reached your daily limit of $${limitUsd.toFixed(2)}. Raise nearAi.dailySpendLimitUsd to continue.`);
    this.name = 'SpendLimitError';
  }
}

export class NearAiClient {
  private readonly fetchFn: typeof fetch;
  private readonly models = new Map<string, ModelInfo>();
  private pricingEndpointAbsent = false;
  /**
   * Models NEAR refused with a 429 or 503, shared by every caller of this client (the main agent,
   * its sub-agents, and the auto mode's safety check): until `until`, nobody sends to the model;
   * after it, one probe goes out while the others wait for its answer.
   */
  private readonly cooling = new Map<string, { until: number; strikes: number; probe?: Promise<void> }>();
  /** The spend ledger entry of each billable response still being read. */
  private readonly charges = new WeakMap<Response, { finish: (result: Parameters<ReturnType<SpendSink['begin']>>[0]) => void; inputTokens: number; model?: string }>();
  /** Each streamed response's connection: `abort` closes it, `release` unhooks the caller's signal once the body is done. */
  private readonly streams = new WeakMap<Response, { abort: () => void; release: () => void }>();

  public constructor(private readonly options: NearAiClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    options.spend?.attach(this);
  }

  /** The key's spend account, when spend tracking is on for this client. */
  public get spend(): SpendSink | undefined { return this.options.spend; }

  /** True while any model is cooling down after a 429 or 503 (billing calls wait). */
  public rateLimited(): boolean {
    const now = this.now();
    for (const state of this.cooling.values()) if (state.until > now) return true;
    return false;
  }

  /** Raw POST /v1/billing/costs: nano-USD per inference-id, and whether NEAR warned that some matched nothing. */
  public async billingCosts(requestIds: string[], signal?: AbortSignal): Promise<BillingCostsAnswer> {
    const response = await this.request('/billing/costs', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestIds }) }, { maxRetries: 0 });
    const body = objectValue(await response.json());
    const rows = Array.isArray(body.requests) ? body.requests.map(objectValue) : [];
    const costs = new Map<string, number>();
    for (const row of rows) {
      const id = stringValue(row.requestId);
      const nano = numberValue(row.costNanoUsd);
      if (id && nano !== undefined && nano >= 0) costs.set(id, nano);
    }
    return { costs, warning: Boolean(body.warning) };
  }

  /** POST /v1/check_api_key with this client's key: the organization and API key IDs (no secrets). */
  public async checkApiKey(signal?: AbortSignal): Promise<{ organizationId: string; apiKeyId: string }> {
    const response = await this.request('/check_api_key', { method: 'POST', signal }, { maxRetries: 0 });
    const body = objectValue(await response.json());
    const organizationId = stringValue(body.organization_id);
    const apiKeyId = stringValue(body.api_key_id);
    if (!organizationId || !apiKeyId) throw new NearAiError(0, 'NEAR AI did not say which organization this API key belongs to.', false);
    return { organizationId, apiKeyId };
  }

  /**
   * NEAR's usage summary for one API key (GET /v1/organizations/{org}/usage/summary) with a usage
   * reporting token, which is sent only on this call. Returns totals.total_cost_nano_usd.
   */
  public async usageSummary(token: string, organizationId: string, query: { apiKeyId: string; startTime: string; endTime: string }, signal?: AbortSignal): Promise<number> {
    const params = new URLSearchParams({ api_key_id: query.apiKeyId, start_time: query.startTime, end_time: query.endTime, source: 'all' });
    const response = await this.request(`/organizations/${encodeURIComponent(organizationId)}/usage/summary?${params.toString()}`, { method: 'GET', signal, headers: { authorization: `Bearer ${token}` } }, { maxRetries: 0, secret: token });
    const totals = objectValue(objectValue(await response.json()).totals);
    const nano = numberValue(totals.total_cost_nano_usd);
    if (nano === undefined || nano < 0) throw new NearAiError(0, 'NEAR AI\'s usage summary had no total.', false);
    return nano;
  }

  public async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request('/models', { method: 'GET', signal });
    const models = normalizeModelRows(await jsonRows(response), (this.options.clock ?? (() => new Date().toISOString()))(), '/models');
    return this.rememberModels(await this.withPrivacy(models, signal));
  }

  private async withPrivacy(models: ModelInfo[], signal?: AbortSignal): Promise<ModelInfo[]> {
    let privacy: Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'>>;
    try {
      privacy = await this.listModelPrivacy(signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return models;
    }
    return models.map((model) => ({ ...model, ...(privacy.get(model.id) ?? {}) }));
  }

  /** Models from a local OpenAI-compatible runtime (`/models`), all marked as running on this machine. */
  public async listLocalModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request('/models', { method: 'GET', signal });
    const models = normalizeModelRows(await jsonRows(response), (this.options.clock ?? (() => new Date().toISOString()))(), '/models');
    return this.rememberModels(models.map((model) => ({ ...model, privacyBoundary: 'local' as const, locality: 'local' as const })));
  }

  /**
   * Which models NEAR runs inside an attested TEE and which it forwards to another provider,
   * from `/model/list` metadata. Only the backend kind and destination host are read.
   */
  public async listModelPrivacy(signal?: AbortSignal): Promise<Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'>>> {
    const response = await this.request('/model/list', { method: 'GET', signal });
    const body = objectValue(await response.json());
    const rows = Array.isArray(body.models) ? body.models.map(objectValue) : [];
    const privacy = new Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'>>();
    for (const row of rows) {
      const id = stringValue(row.modelId);
      if (!id) continue;
      privacy.set(id, modelPrivacy(objectValue(row.metadata)));
    }
    return privacy;
  }

  public async listModelsWithPricing(signal?: AbortSignal): Promise<ModelInfo[]> {
    // NEAR AI's /models already carries pricing; /models/pricing is preferred when it answers with rows.
    // Once it is missing (404/405/410), not implemented (501, or an error typed not_implemented, as
    // NEAR AI Cloud answers today), or answers with no rows, this client stops asking for it.
    if (this.pricingEndpointAbsent) return this.listModels(signal);
    try {
      const response = await this.request('/models/pricing', { method: 'GET', signal });
      const models = normalizeModelRows(await jsonRows(response), (this.options.clock ?? (() => new Date().toISOString()))(), '/models/pricing');
      if (models.length) return this.rememberModels(await this.withPrivacy(models, signal));
      this.pricingEndpointAbsent = true;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (error instanceof NearAiError && ([404, 405, 410, 501].includes(error.status) || [error.errorType, error.errorCode].includes('not_implemented'))) this.pricingEndpointAbsent = true;
    }
    return this.listModels(signal);
  }

  /** Official NEAR image-generation contract. No video endpoint is assumed here. */
  public async generateImage(model: string, prompt: string, options: ImageGenerationOptions = {}, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const started = Date.now();
    const body: Record<string, unknown> = { model, prompt, response_format: 'b64_json' };
    if (options.count !== undefined) body.n = options.count;
    if (options.size !== undefined) body.size = options.size;
    if (options.quality !== undefined) body.quality = options.quality;
    const response = await this.request('/images/generations', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { model });
    return this.readImageResult(response, model, options.count ?? 1, started);
  }

  /** Reads an image answer and records its cost: tokens when NEAR reports them, else its per-image price. */
  private async readImageResult(response: Response, model: string, count: number, started: number): Promise<ImageGenerationResult> {
    let result: ImageGenerationResult;
    try {
      result = imageResult(await response.json(), metadataFromHeaders(response.headers, started));
    } catch (error) {
      this.settleCharge(response, 'partial');
      throw error;
    }
    const info = this.models.get(model) ?? { id: '' };
    const usage = result.usage!;
    const tokenEstimate = usage.inputTokens !== undefined || usage.outputTokens !== undefined ? estimateCostUsd(info, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : undefined;
    const imageEstimate = estimateImageCostUsd(info, count);
    // Token prices (with the per-request price) plus the per-image price; without tokens, the image and request prices.
    const estimate = tokenEstimate !== undefined ? tokenEstimate + (info.imagePricePerUnit ?? 0) * Math.max(1, count) : imageEstimate;
    if (usage.estimatedCostUsd === undefined && estimate !== undefined) usage.estimatedCostUsd = estimate;
    this.settleCharge(response, 'completed', usage, { estimateUsd: usage.estimatedCostUsd });
    return result;
  }

  /** Speech to text through NEAR's `/audio/transcriptions` (multipart: file, model, response_format). */
  public async transcribeAudio(model: string, audio: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal): Promise<{ text: string; usage: UsageMetadata }> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), fileName);
    form.append('model', model);
    form.append('response_format', 'json');
    const response = await this.request('/audio/transcriptions', { method: 'POST', signal, body: form }, { model });
    let body: Record<string, unknown>;
    try { body = objectValue(await response.json()); } catch (error) { this.settleCharge(response, 'partial'); throw error; }
    const usage = usageFromPayload(objectValue(body.usage), metadataFromHeaders(response.headers, started));
    const info = this.models.get(model);
    const estimate = usage.inputTokens !== undefined || usage.outputTokens !== undefined ? estimateCostUsd(info ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : info?.requestPricePerUnit;
    if (usage.estimatedCostUsd === undefined && estimate !== undefined) usage.estimatedCostUsd = estimate;
    this.settleCharge(response, 'completed', usage);
    const text = stringValue(body.text);
    if (text === undefined) throw new NearAiError(0, 'The transcription service returned no text.', false);
    return { text, usage };
  }

  /** Asks a vision model about an image (sent as a data URL) and returns its text answer. */
  public async describeImage(model: string, dataUrl: string, question: string, signal?: AbortSignal): Promise<{ text: string; usage: UsageMetadata }> {
    const started = Date.now();
    const response = await this.request('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: dataUrl } }] }] })
    }, { model, spendKind: 'attachment' });
    let body: Record<string, unknown>;
    try { body = objectValue(await response.json()); } catch (error) { this.settleCharge(response, 'partial'); throw error; }
    const usage = usageFromPayload(objectValue(body.usage), metadataFromHeaders(response.headers, started));
    usage.estimatedCostUsd = estimateCostUsd(this.models.get(model) ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
    this.settleCharge(response, 'completed', usage);
    const choice = objectValue(Array.isArray(body.choices) ? body.choices[0] : undefined);
    const text = stringValue(objectValue(choice.message).content);
    if (!text) throw new NearAiError(0, 'The vision model returned no description.', false);
    return { text, usage };
  }

  /**
   * One short, non-streamed completion, sent exactly once: no retries on a rate limit, timeout, or
   * server error. For quick checks (the auto mode's command safety check) that must fail fast.
   */
  public async completeOnce(model: string, messages: AgentMessage[], options: { maxTokens: number; signal?: AbortSignal; noThinking?: boolean }): Promise<{ text: string; usage: UsageMetadata; reasoning?: string; finishReason?: string }> {
    const started = Date.now();
    // noThinking asks a reasoning model (Qwen, GLM, DeepSeek on vLLM) to answer directly, so a short
    // max_tokens is not spent on thinking before the answer starts.
    const send = (noThinking: boolean) => this.request('/chat/completions', {
      method: 'POST',
      signal: options.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, max_tokens: Math.max(16, Math.floor(options.maxTokens)), temperature: 0, ...(noThinking ? { chat_template_kwargs: { enable_thinking: false, thinking: false } } : {}) })
    }, { maxRetries: 0, model, failFast: true });
    let response: Response;
    try { response = await send(options.noThinking === true); } catch (error) {
      // A server that rejects the option is asked once more without it.
      if (!options.noThinking || (error as { status?: unknown }).status !== 400) throw error;
      response = await send(false);
    }
    let body: Record<string, unknown>;
    try { body = objectValue(await response.json()); } catch (error) { this.settleCharge(response, options.signal?.aborted ? 'aborted' : 'partial'); throw error; }
    const choice = objectValue(Array.isArray(body.choices) ? body.choices[0] : undefined);
    const message = objectValue(choice.message);
    const text = stringValue(message.content) ?? '';
    const reasoning = stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
    const finishReason = stringValue(choice.finish_reason);
    const usage = usageFromPayload(objectValue(body.usage), metadataFromHeaders(response.headers, started));
    usage.estimatedCostUsd = estimateCostUsd(this.models.get(model) ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
    this.settleCharge(response, 'completed', usage);
    return { text, usage, ...(reasoning ? { reasoning } : {}), ...(finishReason ? { finishReason } : {}) };
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
    const response = await this.request('/images/edits', { method: 'POST', signal, body: form }, { model });
    return this.readImageResult(response, model, 1, started);
  }

  /**
   * Actual cost for a completed request from NEAR's billing API. `requestId` must be the
   * `inference-id` response header. NEAR reports 0 with a warning until usage is recorded,
   * so an unrecorded request resolves to undefined rather than a fabricated $0.
   */
  public async actualCostUsd(requestId: string, signal?: AbortSignal): Promise<number | undefined> {
    const response = await this.request('/billing/costs', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestIds: [requestId] }) });
    const body = objectValue(await response.json());
    const rows = Array.isArray(body.requests) ? body.requests.map(objectValue) : [];
    const row = rows.find((candidate) => candidate.requestId === requestId);
    const nanoUsd = numberValue(row?.costNanoUsd);
    if (nanoUsd === undefined || (nanoUsd === 0 && body.warning)) return undefined;
    return nanoUsd / 1e9;
  }

  /** Total actual cost of several completions (an agent run), or undefined until every one is recorded. */
  public async actualCostsUsd(requestIds: string[], signal?: AbortSignal, delaysMs: number[] = [0, 1500, 4000]): Promise<number | undefined> {
    const ids = [...new Set(requestIds.filter(Boolean))];
    if (!ids.length) return undefined;
    for (const delay of delaysMs) {
      if (delay) await waitForRetry(delay, 0, signal);
      const response = await this.request('/billing/costs', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestIds: ids }) });
      const body = objectValue(await response.json());
      const rows = Array.isArray(body.requests) ? body.requests.map(objectValue) : [];
      const costs = ids.map((id) => numberValue(rows.find((row) => row.requestId === id)?.costNanoUsd));
      if (costs.every((cost) => cost !== undefined && (cost > 0 || !body.warning))) return (costs as number[]).reduce((total, cost) => total + cost, 0) / 1e9;
    }
    return undefined;
  }

  /** Polls briefly for the actual cost, since billing records can lag the response by a moment. */
  public async reconcileUsage(requestId: string, signal?: AbortSignal, delaysMs: number[] = [0, 1500, 4000]): Promise<UsageMetadata> {
    for (const delay of delaysMs) {
      if (delay) await waitForRetry(delay, 0, signal);
      const cost = await this.actualCostUsd(requestId, signal);
      if (cost !== undefined) return { requestId, actualCostUsd: cost, verificationStatus: 'unknown', latencyMs: 0 };
    }
    return { requestId, verificationStatus: 'unknown', latencyMs: 0 };
  }

  public async *streamChat(model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatDelta> {
    const started = Date.now();
    const response = await this.request('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } })
    }, { model, stream: true });
    const metadata = metadataFromHeaders(response.headers, started);
    if (!response.body) { this.streams.get(response)?.release(); this.settleCharge(response, 'partial', metadata); throw new NearAiError(response.status, 'NEAR AI returned no streaming body.', false, metadata.requestId); }

    let completed = false;
    let latest = metadata;
    let chars = 0;
    try {
      for await (const event of this.readEvents(response, response.body, metadata, signal, this.models.get(model))) {
        if (event.type === 'text') { if (event.metadata) latest = event.metadata; chars += event.text.length; yield { text: event.text, done: false, usage: event.metadata }; }
        if (event.type === 'done') {
          completed = true;
          this.settleCharge(response, 'completed', event.metadata);
          yield { text: '', done: true, usage: event.metadata };
        }
      }
      if (!signal?.aborted && !completed) { this.settleCharge(response, 'completed', latest); yield { text: '', done: true, usage: { ...latest, latencyMs: Date.now() - started } }; }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      throw error;
    } finally {
      // A caller that stopped reading early leaves no listener on its signal behind.
      this.streams.get(response)?.release();
      this.settleCharge(response, signal?.aborted ? 'aborted' : 'partial', latest, { streamedChars: chars });
    }
  }

  public async *streamChatEvents(model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const started = Date.now();
    const response = await this.request('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } })
    }, { model, stream: true });
    const metadata = metadataFromHeaders(response.headers, started);
    if (!response.body) { this.streams.get(response)?.release(); this.settleCharge(response, 'partial', metadata); throw new NearAiError(response.status, 'NEAR AI returned no streaming body.', false, metadata.requestId); }

    let latest = metadata;
    let chars = 0;
    try {
      yield { type: 'status', status: 'started', metadata };
      try {
        for await (const event of this.readEvents(response, response.body, metadata, signal, this.models.get(model))) {
          if (event.type === 'text') { if (event.metadata) latest = event.metadata; chars += event.text.length; }
          yield event;
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          this.settleCharge(response, 'aborted', latest, { streamedChars: chars });
          yield { type: 'status', status: 'cancelled', metadata: { ...latest, latencyMs: Date.now() - started } };
          return;
        }
        throw error;
      }
      // The completion carries the usage streamed with the response, not just the response headers.
      const completed = { ...latest, latencyMs: Date.now() - started };
      this.settleCharge(response, 'completed', completed);
      yield { type: 'status', status: 'completed', metadata: completed };
      yield { type: 'done', metadata: completed };
    } finally {
      // A caller that stopped reading early leaves no listener on its signal behind.
      this.streams.get(response)?.release();
      this.settleCharge(response, signal?.aborted ? 'aborted' : 'partial', latest, { streamedChars: chars });
    }
  }

  /**
   * One streamed model turn with tools. Text and reasoning stream as they arrive; tool calls are
   * assembled from their indexed fragments and returned whole in the final `done` event.
   */
  public async *streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, options: { idleTimeoutMs?: number; turnTimeoutMs?: number; maxOutputTokens?: number } = {}): AsyncGenerator<CompletionEvent> {
    const started = Date.now();
    // Cap one reply's output (reasoning included), never above the model's own limit: a model that
    // keeps generating inside a single turn is otherwise bounded only by that limit.
    const modelMax = this.models.get(model)?.maxOutputTokens;
    const maxTokens = Math.max(256, Math.min(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, modelMax ?? Number.POSITIVE_INFINITY));
    const requestBody = JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) });
    const response = await this.request('/chat/completions', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: requestBody }, { model, stream: true });
    const connection = this.streams.get(response);
    let usage = metadataFromHeaders(response.headers, started);
    // NEAR signs SHA-256 of the exact request body and raw response; keep both hashes for verification.
    const rawResponse = createHash('sha256');
    let chatId: string | undefined;
    if (!response.body) { connection?.release(); this.settleCharge(response, 'partial', usage); throw new NearAiError(response.status, 'NEAR AI returned no streaming body.', false, usage.requestId); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let text = '';
    let finishReason = 'stop';
    /** A choice said how it finished, and the stream said [DONE]: without either, it was cut off. */
    let finished = false;
    let ended = false;
    let eof = false;
    let buffer = '';
    let firstTokenAt: number | undefined;
    let reasoningChars = 0;
    let answerChars = 0;
    const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? this.idleTimeoutMs);
    const turnTimeoutMs = Math.max(1, options.turnTimeoutMs ?? this.options.streamTurnTimeoutMs ?? DEFAULT_STREAM_TURN_TIMEOUT_MS);
    const watch = new StreamWatch(reader, { idleMs: idleTimeoutMs, turnMs: turnTimeoutMs, signal, requestId: usage.requestId, model, abortRequest: () => connection?.abort() });
    try {
    try {
      for (;;) {
        let next: ReadResult;
        try {
          next = await watch.next();
        } catch (error) {
          // After [DONE] the reply is whole; a connection that then lingers or drops changes nothing.
          if (ended && error instanceof StreamInterruptedError) break;
          throw error;
        }
        if (next.value) rawResponse.update(next.value);
        buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = next.done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          const value = line.trim();
          // SSE comments (": keep-alive"), event names, and blank lines carry nothing: not progress.
          if (!value.startsWith('data:')) continue;
          const payload = value.slice(5).trim();
          if (payload === '[DONE]') { ended = true; watch.progress(); watch.ending(); continue; }
          let chunk: { id?: unknown; error?: unknown; choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ index?: number; id?: unknown; function?: { name?: unknown; arguments?: unknown } }> }; finish_reason?: unknown; error?: unknown }>; usage?: Record<string, unknown> };
          try { chunk = JSON.parse(payload); } catch { throw new NearAiError(0, 'NEAR AI returned malformed streaming data.', false, usage.requestId); }
          if (chunk.error !== undefined && chunk.error !== null) throw streamErrorFrom(chunk.error, usage.requestId, model, this.options.apiKey);
          if (!chatId && typeof chunk.id === 'string' && chunk.id) chatId = chunk.id;
          if (chunk.usage) {
            watch.progress();
            usage = usageFromPayload(chunk.usage, usage, usage.requestId, usage.provider);
            usage.estimatedCostUsd = estimateCostUsd(this.models.get(model) ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) ?? usage.estimatedCostUsd;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason === 'error') throw streamErrorFrom(choice.error ?? {}, usage.requestId, model, this.options.apiKey);
          if (typeof choice.finish_reason === 'string') { finishReason = choice.finish_reason; finished = true; watch.progress(); }
          const delta = choice.delta ?? {};
          const reasoning = stringValue(delta.reasoning_content) ?? stringValue(delta.reasoning);
          const content = stringValue(delta.content);
          if (reasoning || content || delta.tool_calls?.length) {
            // Any delta is progress, reasoning included: a model that is still thinking is not stalled.
            watch.progress();
            if (firstTokenAt === undefined) firstTokenAt = Date.now();
          }
          if (reasoning) { reasoningChars += reasoning.length; yield { type: 'reasoning', text: reasoning }; }
          if (content) { text += content; answerChars += content.length; yield { type: 'text', text: content }; }
          for (const fragment of delta.tool_calls ?? []) {
            if (typeof fragment.function?.arguments === 'string') answerChars += fragment.function.arguments.length;
            const index = typeof fragment.index === 'number' ? fragment.index : calls.length;
            const call = calls[index] ?? (calls[index] = { id: '', name: '', arguments: '' });
            if (typeof fragment.id === 'string' && fragment.id) call.id = fragment.id;
            if (typeof fragment.function?.name === 'string') call.name += fragment.function.name;
            if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments;
          }
        }
        if (next.done) { eof = true; break; }
      }
      // The body ended without the reply finishing (a gateway or proxy cut the stream, often at a
      // fixed timeout): that is not an answer, and must not end the run as if it were one.
      if (!finished && (!ended || (!text && !calls.length))) {
        throw new StreamInterruptedError(ended ? 'NEAR AI ended the response without sending an answer.' : 'NEAR AI closed the stream before the reply finished.', false, usage.requestId, { kind: 'closed', model });
      }
    } catch (error) {
      if (error instanceof StreamInterruptedError) diagnose(`STREAM ${error.kind} POST /chat/completions model=${model}${usage.requestId ? ` request=${usage.requestId}` : ''} after=${formatSeconds(watch.elapsedMs)}s quiet=${formatSeconds(watch.quietMs)}s reasoningChars=${reasoningChars} answerChars=${answerChars}`);
      throw error;
    } finally {
      if (!eof) watch.stop();
      connection?.release();
      try { reader.releaseLock(); } catch { /* a cancelled read may still hold it */ }
    }
    const toolCalls: ToolCall[] = calls.filter((call) => call.name).map((call, index) => ({ id: call.id || `call_${index}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
    this.settleCharge(response, 'completed', usage);
    yield {
      type: 'done',
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finishReason,
      usage: { ...usage, latencyMs: Date.now() - started, ...(firstTokenAt !== undefined ? { firstTokenMs: firstTokenAt - started } : {}), reasoningChars, answerChars, ...(chatId ? { evidence: { chatId, requestHash: sha256Hex(requestBody), responseHash: rawResponse.digest('hex') } } : {}) }
    };
    } finally {
      // Stopped or broken off before the end: recorded with what arrived, and reconciled by its inference-id.
      this.settleCharge(response, signal?.aborted ? 'aborted' : 'partial', usage, { streamedChars: reasoningChars + answerChars });
    }
  }

  /** Checks NEAR's signature and attestation for a completion this client received. */
  public async verifyResponse(model: string, evidence: ResponseEvidence, signal?: AbortSignal, trust: { trustedRoot?: string; now?: Date } = {}): Promise<VerificationResult> {
    return verifyResponse(evidence, model, async (path) => (await this.request(path, { method: 'GET', signal })).json(), trust);
  }

  private async *readEvents(response: Response, body: ReadableStream<Uint8Array>, initial: UsageMetadata, signal?: AbortSignal, model?: ModelInfo): AsyncGenerator<ChatStreamEvent> {
    const connection = this.streams.get(response);
    const reader = body.getReader();
    const watch = new StreamWatch(reader, { idleMs: this.idleTimeoutMs, turnMs: Math.max(1, this.options.streamTurnTimeoutMs ?? DEFAULT_STREAM_TURN_TIMEOUT_MS), signal, requestId: initial.requestId, model: model?.id, abortRequest: () => connection?.abort() });
    const decoder = new TextDecoder();
    let buffer = '';
    let metadata = initial;
    let finished = false;
    try {
      while (!finished) {
        const next = await watch.next();
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
          // Keep-alive comments and empty chunks are not progress.
          if (!event) continue;
          watch.progress();
          if (event.type === 'done') return;
          if (event.type === 'text' && event.metadata) metadata = event.metadata;
          yield event;
        }
      }
    } finally {
      if (!finished) watch.stop();
      connection?.release();
      try { reader.releaseLock(); } catch { /* a cancelled read may still hold it */ }
    }
  }

  private get idleTimeoutMs(): number {
    return Math.max(1, this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  }

  private rememberModels(models: ModelInfo[]): ModelInfo[] {
    for (const model of models) this.models.set(model.id, model);
    return models;
  }

  /** Milliseconds left in `model`'s cooldown after a 429 or 503 (0 when it is not cooling). */
  public cooldownRemainingMs(model: string): number {
    const state = this.cooling.get(model);
    return state ? Math.max(0, state.until - this.now()) : 0;
  }

  /**
   * Waits out `model`'s cooldown. Returns a release function when this caller is the one probe
   * sent after a cooldown, undefined when the model is not cooling. Throws a local 429 (nothing
   * sent) when the cooldown was renewed while this caller waited, so the caller's own backoff
   * decides when to try again; `failFast` throws it at once instead of waiting.
   */
  private async admit(model: string | undefined, signal: AbortSignal | undefined, failFast: boolean): Promise<(() => void) | undefined> {
    if (!model) return undefined;
    let waited = false;
    for (;;) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const state = this.cooling.get(model);
      if (!state) return undefined;
      const remaining = state.until - this.now();
      if ((failFast && (remaining > 0 || state.probe)) || (waited && remaining > 0)) throw coolingError(model, Math.max(0, remaining));
      if (remaining > 0) { await sleepFor(remaining, signal); waited = true; continue; }
      if (state.probe) { await untilSettled(state.probe, signal); waited = true; continue; }
      let settle!: () => void;
      const probe = new Promise<void>((resolve) => { settle = resolve; });
      state.probe = probe;
      return () => { if (state.probe === probe) state.probe = undefined; settle(); };
    }
  }

  /** After a 429 or 503: the model cools for Retry-After, or for a base that doubles while it keeps refusing. */
  private startCooling(model: string, retryAfterMs: number | undefined, wasProbe: boolean): number {
    const existing = this.cooling.get(model);
    const strikes = !existing ? 1 : wasProbe ? existing.strikes + 1 : existing.strikes;
    const base = Math.max(1, this.options.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS);
    const durationMs = retryAfterMs ?? Math.min(MAX_RETRY_AFTER_MS, base * (2 ** (strikes - 1)));
    const until = Math.max(existing?.until ?? 0, this.now() + durationMs);
    if (existing) { existing.until = until; existing.strikes = strikes; } else this.cooling.set(model, { until, strikes });
    return until - this.now();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Records a billable response in the spend ledger, tagged with the caller's spend context: as
   * open (a body still to read; the method that reads it finishes the entry) or already ended.
   */
  private charge(path: string, init: RequestInit, model: string | undefined, kind: SpendKind | undefined, response: Response | undefined, status: 'open' | 'aborted'): void {
    const spend = this.options.spend;
    if (!spend) return;
    const tag = { ...(this.options.spendTag ?? {}), ...currentSpendTag() };
    const info = model ? this.models.get(model) : undefined;
    // Until the response says how many tokens it used, the request body (about 4 characters a token) is the estimate.
    const inputTokens = typeof init.body === 'string' && path === '/chat/completions' ? Math.ceil(init.body.length / 4) : 0;
    const images = path.startsWith('/images/') ? (typeof init.body === 'string' ? Math.max(1, Number(objectValue(safeJson(init.body)).n) || 1) : 1) : 0;
    const estimateUsd = images ? estimateImageCostUsd(info ?? { id: '' }, images) : path === '/audio/transcriptions' ? info?.requestPricePerUnit : estimateCostUsd(info ?? { id: '' }, inputTokens, 0);
    const resolved: SpendKind = kind ?? (path === '/audio/transcriptions' ? 'transcription' : path.startsWith('/images/') ? (tag.kind === 'generation' ? 'generation' : 'image') : tag.kind ?? 'main');
    const finish = spend.begin({ ...tag, kind: resolved, path, model, requestId: response?.headers.get('inference-id') ?? undefined, status, estimateNanoUsd: usdToNano(estimateUsd) });
    if (response && status === 'open') this.charges.set(response, { finish, inputTokens, model });
  }

  /** Ends a response's ledger entry: its final usage, or (broken off) what arrived. Only the first call counts. */
  private settleCharge(response: Response, status: 'completed' | 'partial' | 'aborted', usage?: UsageMetadata, extra: { estimateUsd?: number; streamedChars?: number } = {}): void {
    const charge = this.charges.get(response);
    if (!charge) return;
    this.charges.delete(response);
    const info = charge.model ? this.models.get(charge.model) : undefined;
    let estimateUsd = extra.estimateUsd ?? usage?.estimatedCostUsd;
    // A stream that broke off before its usage chunk: the request plus what streamed (about 4 characters a token).
    if (status !== 'completed' && usage?.outputTokens === undefined) estimateUsd = estimateCostUsd(info ?? { id: '' }, usage?.inputTokens ?? charge.inputTokens, Math.ceil((extra.streamedChars ?? 0) / 4), usage?.cachedInputTokens) ?? estimateUsd;
    charge.finish({ status, ...(usage?.requestId ? { requestId: usage.requestId } : {}), ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}), ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(estimateUsd !== undefined ? { estimateNanoUsd: usdToNano(estimateUsd) } : {}) });
  }

  private async request(path: string, init: RequestInit, overrides: { maxRetries?: number; model?: string; failFast?: boolean; spendKind?: SpendKind; secret?: string; stream?: boolean } = {}): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    // One retry layer: the agent loop backs off between model turns. Here, at most one quick retry,
    // and only for failures that are usually momentary (never for 429 or 503).
    const maxRetries = Math.max(0, Math.min(1, overrides.maxRetries ?? this.options.maxRetries ?? 1));
    const retryBaseDelayMs = Math.max(0, this.options.retryBaseDelayMs ?? 250);
    const random = this.options.random ?? Math.random;
    const responseTimeoutMs = Math.max(1, this.options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
    if (!isSecureEndpoint(url)) throw new NearAiError(0, 'NEAR AI endpoint must use HTTPS; plain HTTP is only allowed for localhost.', false);
    const model = overrides.model;
    const billable = BILLABLE_PATHS.has(path) && (init.method ?? 'GET') === 'POST' && this.options.spend !== undefined;
    if (billable) {
      // The daily limit is checked before every billable request, whoever sends it.
      const reached = this.options.spend!.limitReached();
      if (reached) throw new SpendLimitError(reached.spentUsd, reached.limitUsd, reached.source);
    }
    const release = await this.admit(model, init.signal ?? undefined, overrides.failFast === true);
    const quickRetry = () => waitForRetry(Math.round(retryBaseDelayMs * (0.5 + random())), 0, init.signal ?? undefined);
    try {
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        const attemptAbort = new AbortController();
        const forwardAbort = () => attemptAbort.abort(init.signal?.reason);
        if (init.signal?.aborted) forwardAbort(); else init.signal?.addEventListener('abort', forwardAbort, { once: true });
        const unhook = () => init.signal?.removeEventListener('abort', forwardAbort);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; attemptAbort.abort(); }, responseTimeoutMs);
        try {
          response = await this.fetchFn(url, {
            ...init,
            signal: attemptAbort.signal,
            headers: { ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}), ...(init.headers ?? {}) }
          });
        } catch (error) {
          unhook();
          // Sent but cancelled or timed out before NEAR answered: NEAR may still have done (and billed) the work.
          if (billable && (init.signal?.aborted || timedOut)) this.charge(path, init, model, overrides.spendKind, undefined, 'aborted');
          if (init.signal?.aborted) throw error;
          if (timedOut) {
            if (attempt < maxRetries) { await quickRetry(); continue; }
            throw new NearAiError(408, `NEAR AI did not respond within ${Math.round(responseTimeoutMs / 1000)} seconds.`, true, undefined, { model });
          }
          if (isAbortError(error)) throw error;
          if (attempt < maxRetries) { await quickRetry(); continue; }
          throw new NearAiError(0, `NEAR AI request failed: ${error instanceof Error ? error.message : 'network error'}.`, true, undefined, { model });
        } finally {
          clearTimeout(timer);
        }
        if (init.signal?.aborted) {
          unhook();
          if (billable && response.ok) this.charge(path, init, model, overrides.spendKind, response, 'aborted');
          await response.body?.cancel().catch(() => undefined);
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (response.ok) {
          if (model) this.cooling.delete(model);
          if (billable) this.charge(path, init, model, overrides.spendKind, response, 'open');
          // A stream keeps the caller's stop wired to the connection while its body is read, and its
          // reader can close the connection itself when the stream stalls; the reader releases it.
          if (overrides.stream) this.streams.set(response, { abort: () => attemptAbort.abort(), release: unhook });
          else unhook();
          return response;
        }
        unhook();
        const failure = await this.failureFrom(response, init.method ?? 'GET', path, model, release !== undefined, overrides.secret);
        if (failure.retryable && attempt < maxRetries && [500, 502, 504].includes(response.status) && (failure.retryAfterMs ?? 0) <= 1_000) {
          await quickRetry();
          continue;
        }
        throw failure;
      }
    } finally {
      release?.();
    }
  }

  /** Reads (and so releases) a failed response's body, logs it, and turns it into a NearAiError with NEAR's own message. */
  private async failureFrom(response: Response, method: string, path: string, model: string | undefined, wasProbe: boolean, secret?: string): Promise<NearAiError> {
    const status = response.status;
    const headers = response.headers;
    const requestId = headers.get('inference-id') ?? headers.get('x-request-id') ?? undefined;
    const retryAfterMs = parseRetryAfter(headers.get('retry-after-ms'), this.now(), 'ms') ?? parseRetryAfter(headers.get('retry-after'), this.now());
    let body = errorBodyDetails(await readErrorBody(response), this.options.apiKey);
    if (secret) body = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value.split(secret).join('[REDACTED]') : value]));
    path = path.replace(/\?.*$/, '');
    const retryable = classifyRetryableFailure(status);
    let cooldownMs: number | undefined;
    if (model && (status === 429 || status === 503)) cooldownMs = this.startCooling(model, retryAfterMs, wasProbe);
    const limits: string[] = [];
    headers.forEach((value, name) => { if (/^(x-)?ratelimit|^retry-after/i.test(name)) limits.push(`${name}=${value.slice(0, 80)}`); });
    diagnose(`HTTP ${status} ${method} ${path}${model ? ` model=${model}` : ''}${requestId ? ` request=${requestId}` : ''}${limits.length ? ` ${limits.join(' ')}` : ''}${body.errorType ? ` type=${body.errorType}` : ''}${body.errorCode ? ` code=${body.errorCode}` : ''}${body.detail ? ` message="${body.detail}"` : ''}${cooldownMs !== undefined ? ` cooldown=${Math.round(cooldownMs / 1000)}s` : ''}`);
    const kind = [body.errorType, body.errorCode].filter(Boolean).join(', ');
    // 402: the organization is out of credits or this key's spend limit on NEAR AI Cloud is reached.
    const message = status === 402
      ? `NEAR spend limit reached: NEAR AI Cloud refused the request because the organization's credits or this API key's spend limit are used up${body.detail ? ` (NEAR says: ${body.detail})` : ''}.`
      : `NEAR AI request failed with HTTP ${status}${model ? ` for ${model}` : ''}${body.detail ? `: ${body.detail}` : ''}${kind ? ` (${kind})` : ''}.`;
    return new NearAiError(status, message, retryable, requestId, { ...body, retryAfterMs, model });
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
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
  // NEAR's /v1/models gives input and output per million tokens and input_cache_read per token.
  const cacheReadPerToken = numberValue(pricing.input_cache_read);
  const cachePrice = numberValue(pricing.cache_per_million ?? pricing.cachePricePerMillion ?? pricing.cache ?? model.cache_price_per_million ?? model.cachePricePerMillion) ?? (cacheReadPerToken !== undefined ? Number((cacheReadPerToken * 1_000_000).toPrecision(12)) : undefined);
  const imagePrice = numberValue(pricing.image_per_unit ?? pricing.imagePricePerUnit ?? pricing.image ?? model.image_price_per_unit ?? model.imagePricePerUnit);
  const videoPrice = numberValue(pricing.video_per_unit ?? pricing.videoPricePerUnit ?? pricing.video ?? model.video_price_per_unit ?? model.videoPricePerUnit);
  const requestPrice = numberValue(pricing.request_per_unit ?? pricing.requestPricePerUnit ?? pricing.request ?? model.request_price_per_unit ?? model.requestPricePerUnit);
  const maxOutputTokens = numberValue(model.max_output_tokens ?? model.max_output_length ?? model.maxOutputTokens ?? objectValue(model.top_provider).max_completion_tokens ?? model.max_tokens);
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
function modelPrivacy(metadata: Record<string, unknown>): Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'> {
  if (metadata.attestationSupported === true && metadata.providerType !== 'external') return { privacyBoundary: 'tee' };
  const config = objectValue(metadata.providerConfig);
  let host: string | undefined;
  try { host = typeof config.base_url === 'string' ? new URL(config.base_url).hostname.replace(/^api\./, '') : undefined; } catch { host = undefined; }
  return { privacyBoundary: 'cloud', forwardedTo: host ?? stringValue(config.backend) ?? stringValue(metadata.providerType) };
}

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
    const nextMetadata = usageFromPayload(parsed.usage ?? {}, metadata, metadata.requestId, stringValue(parsed.provider) ?? metadata.provider);
    nextMetadata.estimatedCostUsd = estimateCostUsd(model ?? { id: '' }, nextMetadata.inputTokens, nextMetadata.outputTokens, nextMetadata.cachedInputTokens) ?? metadata.estimatedCostUsd;
    const text = stringValue(parsed.choices?.[0]?.delta?.content) ?? '';
    return text || parsed.usage ? { type: 'text', text, metadata: nextMetadata } : undefined;
  } catch {
    throw new NearAiError(0, 'NEAR AI returned malformed streaming data.', false, metadata.requestId);
  }
}

function metadataFromHeaders(headers: Headers, startedAt: number): UsageMetadata {
  // NEAR identifies a completion for billing by `inference-id`; `x-request-id` is only a transport ID.
  // TEE verification is never inferred from headers: it needs NEAR's attestation/signature endpoints.
  return { requestId: headers.get('inference-id') ?? undefined, verificationStatus: 'unknown', latencyMs: Date.now() - startedAt };
}

function usageFromPayload(payload: Record<string, unknown>, base: UsageMetadata, requestId?: string, provider?: string): UsageMetadata {
  const next: UsageMetadata = {
    ...base,
    requestId: requestId ?? stringValue(payload.request_id ?? payload.requestId) ?? base.requestId,
    provider: provider ?? stringValue(payload.provider) ?? base.provider,
    inputTokens: numberValue(payload.input_tokens ?? payload.prompt_tokens ?? payload.inputTokens) ?? base.inputTokens,
    outputTokens: numberValue(payload.output_tokens ?? payload.completion_tokens ?? payload.outputTokens) ?? base.outputTokens
  };
  // NEAR reports prompt-cache hits as prompt_tokens_details.cached_tokens (input_tokens_details in the Responses API).
  const details = objectValue(payload.prompt_tokens_details ?? payload.input_tokens_details);
  const cached = numberValue(details.cached_tokens ?? payload.cached_tokens);
  if (cached !== undefined) next.cachedInputTokens = cached;
  const reasoning = numberValue(objectValue(payload.completion_tokens_details ?? payload.output_tokens_details).reasoning_tokens);
  if (reasoning !== undefined) next.reasoningTokens = reasoning;
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

type ReadResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };

/**
 * The next chunk of a stream, or a StreamInterruptedError when nothing arrives within `idleMs`
 * or the connection drops. Each call starts a fresh wait, so the limit is on silence only.
 */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number, signal: AbortSignal | undefined, requestId: string | undefined): Promise<ReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next: ReadResult | 'stalled';
  try {
    next = await Promise.race([reader.read() as Promise<ReadResult>, new Promise<'stalled'>((resolve) => { timer = setTimeout(() => resolve('stalled'), idleMs); })]);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new StreamInterruptedError(`The connection to NEAR AI dropped mid-response (${error instanceof Error ? error.message : 'network error'}).`, false, requestId);
  } finally {
    clearTimeout(timer);
  }
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (next === 'stalled') {
    await reader.cancel().catch(() => undefined);
    throw new StreamInterruptedError(`NEAR AI stopped sending the response (nothing for ${Math.round(idleMs / 1000)} seconds).`, true, requestId);
  }
  return next;
}

interface StreamWatchOptions {
  /** How long the stream may go without progress. */
  idleMs: number;
  /** How long the whole stream may take. */
  turnMs: number;
  signal?: AbortSignal;
  requestId?: string;
  model?: string;
  /** Closes the HTTP request itself, so a stalled connection is shut rather than left open. */
  abortRequest?: () => void;
}

/**
 * Reads a streamed body under two limits: `idleMs` without progress (the reader calls `progress()`
 * for each delta of reasoning, text, a tool call, usage, or the end; SSE keep-alive comments and
 * empty chunks are not progress) and `turnMs` in total. Running out of either, or the caller's
 * signal, closes the request at once, even while no byte is arriving.
 */
class StreamWatch {
  private readonly startedAt = Date.now();
  private lastProgressAt = this.startedAt;
  private stopped = false;

  public constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly options: StreamWatchOptions) {}

  public progress(): void { this.lastProgressAt = Date.now(); }

  /** The stream said it is done: what is left (the connection closing) gets only `graceMs` more. */
  public ending(graceMs = STREAM_END_GRACE_MS): void { this.endDue = Date.now() + graceMs; }
  private endDue = Number.POSITIVE_INFINITY;

  /** Milliseconds since the stream started, and since its last progress. */
  public get elapsedMs(): number { return Date.now() - this.startedAt; }
  public get quietMs(): number { return Date.now() - this.lastProgressAt; }

  public async next(): Promise<ReadResult> {
    const { signal, requestId, model } = this.options;
    if (signal?.aborted) { this.stop(); throw abortError(); }
    const idleDue = this.lastProgressAt + this.options.idleMs;
    const turnDue = this.startedAt + this.options.turnMs;
    const limit: 'stalled' | 'turn-limit' = turnDue <= idleDue ? 'turn-limit' : 'stalled';
    // Checked before reading: a flood of keep-alive comments must not keep winning the race.
    const waitMs = Math.min(idleDue, turnDue, this.endDue) - Date.now();
    if (waitMs <= 0) throw this.limitReached(limit);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let next: ReadResult | 'timeout' | 'aborted';
    try {
      next = await Promise.race([
        this.reader.read() as Promise<ReadResult>,
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), waitMs); }),
        new Promise<'aborted'>((resolve) => { onAbort = () => resolve('aborted'); signal?.addEventListener('abort', onAbort, { once: true }); })
      ]);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError();
      this.stop();
      throw new StreamInterruptedError(`The connection to NEAR AI dropped mid-response (${error instanceof Error ? error.message : 'network error'}).`, false, requestId, { kind: 'dropped', model });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    if (next === 'aborted' || signal?.aborted) { this.stop(); throw abortError(); }
    if (next === 'timeout') throw this.limitReached(limit);
    return next;
  }

  /** Closes the connection and the reader without waiting on either (a dead connection may never answer a cancel). */
  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.options.abortRequest?.(); } catch { /* already closed */ }
    void this.reader.cancel().catch(() => undefined);
  }

  private limitReached(limit: 'stalled' | 'turn-limit'): StreamInterruptedError {
    this.stop();
    const { requestId, model, idleMs, turnMs } = this.options;
    if (limit === 'stalled') return new StreamInterruptedError(`NEAR AI stopped sending the response (no data for ${formatSeconds(idleMs)} seconds).`, true, requestId, { kind: 'stalled', idleMs, model });
    const minutes = Math.max(1, Math.round(turnMs / 60_000));
    return new StreamInterruptedError(`${model ?? 'The model'}'s reply was still streaming after ${minutes} minute${minutes === 1 ? '' : 's'}, the most one model turn may take, so it was stopped. Your work is kept: send a message to continue, or switch to another model.`, false, requestId, { kind: 'turn-limit', model, retryable: false });
  }
}

/** NEAR's error event in the middle of a stream ({"error": {...}}, or a choice that finished with "error"). */
function streamErrorFrom(value: unknown, requestId: string | undefined, model: string | undefined, apiKey: string): NearAiError {
  const details = errorBodyDetails(JSON.stringify({ error: value ?? {} }), apiKey);
  const code = Number(details.errorCode);
  // A client error NEAR only noticed mid-stream cannot be fixed by sending the same request again.
  if (Number.isInteger(code) && code >= 400 && code < 500 && code !== 408 && code !== 429) {
    return new NearAiError(code, `NEAR AI request failed with HTTP ${code}${model ? ` for ${model}` : ''}${details.detail ? `: ${details.detail}` : ''}.`, false, requestId, { ...details, model });
  }
  return new StreamInterruptedError(`NEAR AI reported an error mid-response${details.detail ? `: ${details.detail}` : ''}.`, false, requestId, { kind: 'error', model, ...(details.detail ? { detail: details.detail } : {}) });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
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

/** The local "still cooling down" error: status 429 so callers treat it as a rate limit, but nothing was sent. */
function coolingError(model: string, remainingMs: number): NearAiError {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return new NearAiError(429, `NEAR AI is rate limiting ${model}; this client is holding requests to it for about ${seconds} s before trying again.`, true, undefined, { retryAfterMs: remainingMs, cooling: true, model });
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return waitForRetry(Math.max(0, ms), 0, signal);
}

/** Resolves when `promise` settles, or rejects with an AbortError as soon as `signal` aborts. */
function untilSettled(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(() => resolve(), () => resolve()).finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

/** Up to MAX_ERROR_BODY_BYTES of an error body as text; the stream is always read or cancelled, never left open. */
async function readErrorBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { return ''; }
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const next = await readWithin(reader, 5_000, undefined, undefined);
      if (next.done) break;
      size += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    /* a body that stalls or drops still yields what arrived */
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return text.slice(0, MAX_ERROR_BODY_BYTES);
}

/** NEAR's message, type, and code from an OpenAI-style (or plain-text) error body, secrets removed. */
export function errorBodyDetails(text: string, apiKey?: string): Pick<NearAiErrorDetails, 'detail' | 'errorType' | 'errorCode'> {
  const clean = (value: unknown): string | undefined => {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string') return undefined;
    let out = value.replace(/\s+/g, ' ').trim().replace(/bearer\s+[^\s,;]+/gi, '[REDACTED]');
    if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('[REDACTED]');
    out = redactSecrets(out);
    return out ? (out.length > MAX_ERROR_DETAIL_CHARS ? `${out.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : out) : undefined;
  };
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
  if (parsed === undefined) return /^</.test(trimmed) ? {} : { detail: clean(trimmed) };
  const root = objectValue(parsed);
  const inner = typeof root.error === 'object' && root.error !== null ? objectValue(root.error) : {};
  const detailList = Array.isArray(root.detail) ? root.detail.map((item) => stringValue(objectValue(item).msg) ?? (typeof item === 'string' ? item : undefined)).filter(Boolean).join('; ') : undefined;
  const details: Pick<NearAiErrorDetails, 'detail' | 'errorType' | 'errorCode'> = {};
  const detail = clean(inner.message ?? (typeof root.error === 'string' ? root.error : undefined) ?? root.message ?? (typeof root.detail === 'string' ? root.detail : detailList));
  const errorType = clean(inner.type ?? root.type);
  const errorCode = clean(inner.code ?? root.code);
  if (detail) details.detail = detail;
  if (errorType) details.errorType = errorType;
  if (errorCode && errorCode !== errorType) details.errorCode = errorCode;
  return details;
}

import { createHash } from 'node:crypto';
import { AttestationReportCache, NOT_CHECKED_IN_EDITOR, sha256Hex, verifyResponse, type ResponseEvidence, type VerificationResult } from './attestation';
import { isNearCloudEndpoint, isSecureEndpoint } from '../domain/config';
import { bindingReason, decideRoute, isBindingFresh, routeCheckFailed, routingWhileFailedClosed } from '../domain/gate/routing';
import type { ConnectionBindingFact, PassportRefusal, RouteDecision, RouteFacts, RouteRule, RoutingTable } from '../domain/gate/routing';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import type { Label } from '../domain/gate/labels';
import type { Mark } from '../domain/gate/dominance';
import { currentSessionRoute, defaultSessionRoute, endpointPinRefusal, noteNotAccredited, privateOnlyNow, routeEventRecordFor, routeRecordFor, routingOf, UNCHECKABLE_ANSWER_REASONS } from '../gate/sessionMark';
import { floorFor, pinnedFetchAny, requestTrust, routeFactsFor } from './privateRoute';
import type { TrustFacts } from '../domain/gate/trust';
import type { RouteRecordContext, SessionRoute } from '../gate/sessionMark';
import { ConnectionNotBoundError } from './connectionBinding';
import type { ConnectionBindingSource } from './connectionBinding';
import { redactSecrets } from '../domain/redaction';
import { currentSpendTag, SpendKind, SpendTag, usdToNano } from './spendLedger';
import type { SpendSink } from './spendAccount';
import type { BillingCostsAnswer } from './spendReconciler';
import type { CapabilityPrivacyBoundary, SkillCapability, ProviderOperation } from '../domain/capabilities';
import type { AgentMessage, ChatMessage, CompletionEvent, ModelInfo, ToolCall, ToolDefinition, UsageMetadata, VerificationStatus } from '../domain/provider/messages';
import type { EndpointFacts, ModelEndpoint } from '../domain/provider/endpoint';

export type { AgentMessage, ChatMessage, CompletionEvent, ModelInfo, ToolCall, ToolDefinition, UsageMetadata, VerificationStatus } from '../domain/provider/messages';

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
  /**
   * A model's cooldown after a 429 or 503: Retry-After (or this base, when there is none) the first time, then doubling while the probe after each cooldown
   * is refused again, never shorter than Retry-After (default 5 s, at most 60 s).
   */
  cooldownBaseMs?: number;
  /** Requests to one model in flight at once while it is paced, that is, within pacedWindowMs of its last 429 or 503 (default PACED_CONCURRENCY). */
  pacedConcurrency?: number;
  /** How long after a model's last 429 or 503 its requests stay paced (default PACED_WINDOW_MS). */
  pacedWindowMs?: number;
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
  /**
   * Which route this client is (CLAS-06): NEAR AI Cloud, or a local runtime. The provider factory sets it for every client that sends content; a client
   * that does not say is refused at every level stricter than any-cloud (`route.no-session`).
   */
  route?: 'near' | 'local';
  /**
   * Says whether the connection to this client's host is proven to end inside private hardware (D-50). The provider factory gives one to a NEAR client on
   * NEAR AI Cloud's own endpoint (NearConnectionBinding); every other client has none, so attested-cloud levels never go through it.
   */
  binding?: ConnectionBindingSource;
  /** True when the session can use a local model instead of this client (a hybrid profile's NEAR client), so a refusal names the right fix. */
  localModelAvailable?: boolean;
  /** The fetch held to a place's TLS pins when your organization's rules pin it (D-26). Defaults to pinnedFetchAny; tests give their own. */
  pinnedFetchFor?: (pins: readonly string[]) => typeof fetch;
  /** For tests: the root the after-answer check trusts instead of Intel's, and the time it checks certificates at. Production leaves it unset. */
  attestationTrust?: { trustedRoot?: string; now?: () => Date };
}

/**
 * A list of paths no caller can change (PR #81 review): a frozen view over a set only this function holds, so neither `add` nor `Set.prototype.add.call`
 * can put a path on it or take one off. A content path added at run time would otherwise skip the route check.
 */
function readOnlyPaths(paths: readonly string[]): ReadonlySet<string> {
  const held = new Set(paths);
  const view: ReadonlySet<string> = Object.freeze({
    has: (value: string): boolean => held.has(value),
    get size(): number { return held.size; },
    forEach: (callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void => {
      for (const value of held) callback.call(thisArg, value, value, view);
    },
    entries: () => new Set(held).entries(),
    keys: () => new Set(held).keys(),
    values: () => new Set(held).values(),
    [Symbol.iterator]: () => new Set(held).values()
  });
  return view;
}

/**
 * The requests that carry content to a model (a POST to one of these). The one list of them: BILLABLE_PATHS is this same set, because NEAR AI bills exactly
 * the requests that carry content, so the spend check and the route check can never disagree about a path (PR 4a review).
 */
export const CONTENT_PATHS: ReadonlySet<string> = readOnlyPaths(['/chat/completions', '/images/generations', '/images/edits', '/audio/transcriptions']);

/** Endpoints NEAR bills for; every 2xx answer from one is recorded in the spend ledger. The same set as CONTENT_PATHS, never a copy of it. */
export const BILLABLE_PATHS: ReadonlySet<string> = CONTENT_PATHS;

/**
 * The only requests other than a GET that the client sends without a route check: billing lookups and the key check, which carry request ids and nothing
 * else. Every other request that is not a GET is route checked, so a content path someone adds and forgets to list is checked, never sent unchecked.
 */
export const NON_CONTENT_POST_PATHS: ReadonlySet<string> = readOnlyPaths(['/billing/costs', '/check_api_key']);

/** Whether a request is route checked: every method but GET and HEAD, except the listed non-content paths. */
export function needsRouteCheck(path: string, method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return false;
  return !NON_CONTENT_POST_PATHS.has(path.replace(/[?#].*$/, ''));
}

/** A model request the session's route does not allow (CLAS-06): thrown before anything is sent, with the plain sentence that says so. */
export class RouteRefusedError extends Error {
  public constructor(public readonly rule: RouteRule, message: string, public readonly passport?: PassportRefusal) {
    super(message);
    this.name = 'RouteRefusedError';
  }
}

/** How many after-answer checks a client keeps, by chat id: the newest 50. */
export const ANSWER_CHECKS_KEPT = 50;

/** Whether two URLs or hosts name the same host, by the URL parser's lowercase host name; anything that does not parse never matches. */
function sameHostName(a: string, b: string): boolean {
  const name = (value: string): string | undefined => { try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase() || undefined; } catch { return undefined; } };
  const first = name(a);
  return first !== undefined && first === name(b);
}

/** A check that threw: unavailable, never failed (D-55). */
function uncheckable(error: unknown): VerificationResult {
  return { outcome: 'unavailable', summary: `The answer could not be checked (${error instanceof Error ? error.message : 'unknown error'}).`, checks: {}, notChecked: NOT_CHECKED_IN_EDITOR };
}

/** A bound fact older than this (8 minutes) is checked again in the background, so it is renewed before it stops counting at 10 minutes. */
export const BINDING_REFRESH_AFTER_MS = 480_000;
/** A fact that is not bound (no model listed yet, offline, a mismatch) is checked again after this (30 seconds) when a request needs it. */
export const BINDING_RETRY_AFTER_MS = 30_000;

/** What the route check of one content request found: the decision, the route it was made in, the facts it read, and how to record a later refusal. */
interface RouteCheck {
  readonly route: SessionRoute;
  readonly decision: RouteDecision;
  readonly facts: RouteFacts;
  readonly context: Omit<RouteRecordContext, 'checkFailed' | 'connectionFallback'>;
  /** The binding fact the check read, when the client has a binding source. */
  readonly connection?: ConnectionBindingFact;
  /** The bound fact the request must be pinned to: set exactly when the request was allowed at attested-cloud to NEAR AI Cloud. */
  readonly pinned?: ConnectionBindingFact;
  /**
   * The fresh bound fact an any-cloud request to NEAR AI Cloud is pinned to when it can be (owner, 2026-11-18): a mismatch falls back to an unpinned send
   * rather than refusing.
   */
  readonly optionalPin?: ConnectionBindingFact;
  /** Writes a second record for an optionally pinned request that fell back to an unpinned send (the first was written at the decision). Once only. */
  readonly recordFallback?: () => void;
  /** The TLS pins of your organization's server the send is held to (D-26): a level that needs a pin, allowed there. */
  readonly pinTo?: readonly string[];
  /** The TrustFacts of the allowed request (D-38), kept per response for the answer's badge. */
  readonly trust?: TrustFacts;
}

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
/** Requests to one model in flight at once while NEAR has recently answered it with 429 or 503 (owner's D-48 run: six members at once on one model). */
export const PACED_CONCURRENCY = 2;
/** A model stays paced this long after its last 429 or 503. */
export const PACED_WINDOW_MS = 30_000;
/** A request let through after waiting for a paced slot first waits up to this long more, at random, so the waiters do not start together. */
export const PACED_GAP_MS = 250;
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

/** Where rate-limit and error diagnostics go (the SovAI output channel in the extension). */
let diagnosticsSink: ((line: string) => void) | undefined;
export function setNearAiDiagnostics(sink: ((line: string) => void) | undefined): void {
  diagnosticsSink = sink;
}
function diagnose(line: string): void {
  try { diagnosticsSink?.(redactSecrets(line)); } catch { /* diagnostics never break a request */ }
}
/** A line in the SovAI output channel from elsewhere in the extension (secrets redacted); nothing when no channel is set (tests). */
export function nearAiLog(line: string): void {
  diagnose(line);
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

export class NearAiClient implements ModelEndpoint {
  private readonly fetchFn: typeof fetch;
  private readonly models = new Map<string, ModelInfo>();
  private pricingEndpointAbsent = false;
  /**
   * Models NEAR refused with a 429 or 503, shared by every caller of this client (the main agent,
   * its sub-agents, and the auto mode's safety check): until `until`, nobody sends to the model;
   * after it, one probe goes out while the others wait for its answer.
   */
  private readonly cooling = new Map<string, { until: number; strikes: number; probe?: Promise<void> }>();
  /**
   * Models NEAR answered with a 429 or 503 within the last pacedWindowMs: while paced, at most pacedConcurrency requests to the model are in flight at once
   * (a stream holds its slot until it ends), so the members of a run waiting on one model go one or two at a time rather than all together.
   */
  private readonly paced = new Map<string, { until: number; active: number; waiters: Array<() => void> }>();
  /** The spend ledger entry of each billable response still being read. */
  private readonly charges = new WeakMap<Response, { finish: (result: Parameters<ReturnType<SpendSink['begin']>>[0]) => void; inputTokens: number; model?: string }>();
  /** Each streamed response's connection: `abort` closes it, `release` unhooks the caller's signal once the body is done. */
  private readonly streams = new WeakMap<Response, { abort: () => void; release: () => void }>();
  /** The binding fact the route check read for each content response, when the client has a binding source; its usage carries it. */
  private readonly connections = new WeakMap<Response, ConnectionBindingFact>();
  /** The TrustFacts of each content response's request (D-38); its usage carries them to the answer's badge. */
  private readonly trusts = new WeakMap<Response, TrustFacts>();
  /** The content responses that came over a connection pinned to a fresh bound fact's key; their usage says so. */
  private readonly pinnedResponses = new WeakSet<Response>();
  /** The binding refresh running for each host, at most one: a route check that finds the fact missing or old starts one, never waits for it (OFFL-01). */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** The route of each response its route check allowed at attested-cloud to NEAR AI Cloud: its answer is checked afterwards (D-36). */
  private readonly attestedAnswers = new WeakMap<Response, SessionRoute>();
  /** The check after each attested-cloud answer, by the answer's chat id, the newest ANSWER_CHECKS_KEPT. */
  private readonly answerChecks = new Map<string, Promise<VerificationResult>>();
  /** The trust badge's check of each other answer (not checked by the route), by chat id, the newest ANSWER_CHECKS_KEPT (CLAS-08). */
  private readonly badgeChecks = new Map<string, Promise<VerificationResult>>();
  /** Verified attestation reports by signing address for 10 minutes, used only by the checks after each answer (A3). */
  private readonly reportCache = new AttestationReportCache(() => this.now());

  public constructor(private readonly options: NearAiClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    options.spend?.attach(this);
  }

  /** The host this client sends model requests to, lowercase (the gate's tool manifests name it); undefined when the base URL has none. */
  public get baseHost(): string | undefined {
    try { return new URL(this.options.baseUrl).hostname.toLowerCase() || undefined; } catch { return undefined; }
  }

  /** This client's endpoint is NEAR AI Cloud's own, where a TEE model's answers can be checked (the trust badge reads it, CLAS-08). */
  public get nearEndpoint(): boolean { return isNearCloudEndpoint(this.options.baseUrl); }

  /** What the policy layer may know about this endpoint (D-43): its route, base URL and whether it is NEAR AI Cloud's own. Never the key or headers. */
  public get facts(): EndpointFacts { return Object.freeze({ ...(this.options.route === undefined ? {} : { route: this.options.route }), baseUrl: this.options.baseUrl, nearEndpoint: isNearCloudEndpoint(this.options.baseUrl) }); }

  /** The cached catalog entry of a model, or undefined when the catalog has not listed it. Never fetches. */
  public catalogEntry(id: string): ModelInfo | undefined { return this.models.get(id); }

  /** The key's spend account, when spend tracking is on for this client. */
  public get spend(): SpendSink | undefined { return this.options.spend; }

  /** The source that says whether this client's connection is proven to end inside private hardware, when it has one (D-50). */
  public get connectionBinding(): ConnectionBindingSource | undefined { return this.options.binding; }

  /** The check after the attested-cloud answer with this chat id, while it is among the newest ANSWER_CHECKS_KEPT; undefined otherwise. */
  public answerCheck(chatId: string): Promise<VerificationResult> | undefined {
    return this.answerChecks.get(chatId);
  }

  /** A private (TEE) model id from this client's cached catalog, or undefined while none is listed. Never fetches. */
  public cachedTeeModel(): string | undefined {
    for (const model of this.models.values()) if (model.privacyBoundary === 'tee') return model.id;
    return undefined;
  }

  /** An authenticated GET against this client's /v1 base, read as JSON: the request verifyResponse and the binding check go through. Carries no content. */
  public async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.request(path, { method: 'GET', ...(signal === undefined ? {} : { signal }) })).json();
  }

  /**
   * Starts a binding check of the host in the background when the fact is missing, a bound one is older than BINDING_REFRESH_AFTER_MS, or another state is
   * older than BINDING_RETRY_AFTER_MS. At most one per host runs; it is never awaited and its failure is swallowed, so no request waits for it (OFFL-01).
   */
  public refreshBinding(host: string = this.options.baseUrl, now: number = Date.now()): void {
    const source = this.options.binding;
    if (source === undefined || this.refreshing.has(host)) return;
    let fact: ConnectionBindingFact | undefined;
    try { fact = source.current(host); } catch { fact = undefined; }
    const age = fact?.checkedAt === undefined ? Number.POSITIVE_INFINITY : now - fact.checkedAt;
    if (fact !== undefined && age >= 0 && age < (fact.state === 'bound' ? BINDING_REFRESH_AFTER_MS : BINDING_RETRY_AFTER_MS)) return;
    let started: Promise<unknown>;
    try { started = Promise.resolve(source.refresh(host)); } catch { started = Promise.resolve(); }
    const done = started.then(() => undefined, () => undefined).finally(() => { if (this.refreshing.get(host) === done) this.refreshing.delete(host); });
    this.refreshing.set(host, done);
  }

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
    let privacy: Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo' | 'attestationSupported'>>;
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
  public async listModelPrivacy(signal?: AbortSignal): Promise<Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo' | 'attestationSupported'>>> {
    const response = await this.request('/model/list', { method: 'GET', signal });
    const body = objectValue(await response.json());
    const rows = Array.isArray(body.models) ? body.models.map(objectValue) : [];
    const privacy = new Map<string, Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo' | 'attestationSupported'>>();
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
      result = imageResult(await response.json(), this.usageStart(response, started));
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
    this.answerUncheckable(response, model, 'no-hashes');
    return result;
  }

  /** Speech to text through NEAR's `/audio/transcriptions` (multipart: file, model, response_format). */
  public async transcribeAudio(model: string, audio: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal): Promise<{ text: string; usage: UsageMetadata }> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([audio.slice()], { type: mimeType }), fileName);
    form.append('model', model);
    form.append('response_format', 'json');
    const response = await this.request('/audio/transcriptions', { method: 'POST', signal, body: form }, { model });
    let body: Record<string, unknown>;
    try { body = objectValue(await response.json()); } catch (error) { this.settleCharge(response, 'partial'); throw error; }
    const usage = usageFromPayload(objectValue(body.usage), this.usageStart(response, started));
    const info = this.models.get(model);
    const estimate = usage.inputTokens !== undefined || usage.outputTokens !== undefined ? estimateCostUsd(info ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : info?.requestPricePerUnit;
    if (usage.estimatedCostUsd === undefined && estimate !== undefined) usage.estimatedCostUsd = estimate;
    this.settleCharge(response, 'completed', usage);
    this.answerUncheckable(response, model, 'no-hashes');
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
    const usage = usageFromPayload(objectValue(body.usage), this.usageStart(response, started));
    usage.estimatedCostUsd = estimateCostUsd(this.models.get(model) ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
    this.settleCharge(response, 'completed', usage);
    this.answerUncheckable(response, model, 'no-hashes');
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
    const usage = usageFromPayload(objectValue(body.usage), this.usageStart(response, started));
    usage.estimatedCostUsd = estimateCostUsd(this.models.get(model) ?? { id: '' }, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
    this.settleCharge(response, 'completed', usage);
    this.answerUncheckable(response, model, 'no-hashes');
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
    const metadata = this.usageStart(response, started);
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
          this.answerUncheckable(response, model, 'no-hashes');
          yield { text: '', done: true, usage: event.metadata };
        }
      }
      if (!signal?.aborted && !completed) { this.settleCharge(response, 'completed', latest); this.answerUncheckable(response, model, 'no-hashes'); yield { text: '', done: true, usage: { ...latest, latencyMs: Date.now() - started } }; }
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
    const metadata = this.usageStart(response, started);
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
      this.answerUncheckable(response, model, 'no-hashes');
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
    const requestBody = completionRequestBody(model, messages, tools, maxTokens);
    const response = await this.request('/chat/completions', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: requestBody }, { model, stream: true });
    const connection = this.streams.get(response);
    let usage = this.usageStart(response, started);
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
          if (delta.tool_calls?.length) yield { type: 'progress' };
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
    const evidence: ResponseEvidence | undefined = chatId ? { chatId, requestHash: sha256Hex(requestBody), responseHash: rawResponse.digest('hex') } : undefined;
    // D-36: an answer sent at attested-cloud is checked afterwards, in the background; nothing here or in the next decision waits for it (OFFL-01).
    if (evidence !== undefined) this.checkAnswer(response, model, evidence);
    else this.answerUncheckable(response, model, 'no-signature-id');
    yield {
      type: 'done',
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finishReason,
      usage: { ...usage, latencyMs: Date.now() - started, ...(firstTokenAt !== undefined ? { firstTokenMs: firstTokenAt - started } : {}), reasoningChars, answerChars, ...(evidence ? { evidence } : {}) }
    };
    } finally {
      // Stopped or broken off before the end: recorded with what arrived, and reconciled by its inference-id.
      this.settleCharge(response, signal?.aborted ? 'aborted' : 'partial', usage, { streamedChars: reasoningChars + answerChars });
    }
  }

  /**
   * The check after an answer whose request the route check allowed at attested-cloud to NEAR AI Cloud (D-36, D-55): started here, never awaited. It goes
   * through the 10-minute report cache. When it settles the route hears it, a failed one stops attested-cloud for the route's chat (unless the chat was
   * closed), and route.attestation-checked is recorded with verified, failed or unavailable. Anything thrown is unavailable, never failed.
   */
  private checkAnswer(response: Response, model: string, evidence: ResponseEvidence): void {
    const route = this.attestedAnswers.get(response);
    if (route === undefined) return;
    this.attestedAnswers.delete(response);
    const check = verifyResponse(evidence, model, (path) => this.getJson(path), { cache: this.reportCache, ...this.trustOptions() }).catch(uncheckable);
    this.answerChecks.delete(evidence.chatId);
    this.answerChecks.set(evidence.chatId, check);
    while (this.answerChecks.size > ANSWER_CHECKS_KEPT) this.answerChecks.delete(this.answerChecks.keys().next().value as string);
    void check.then((result) => {
      const attestation = result.outcome === 'signed' ? 'verified' : result.outcome;
      if (attestation === 'failed') {
        try {
          const state = route.attestation;
          if (state !== undefined && state.closed !== true) state.failed = true;
        } catch { /* a state that cannot be set is read as unproven, which never counts as bound */ }
      }
      try { route.onAnswerChecked?.(evidence.chatId, result, { model, evidence }); } catch { /* a listener never changes the check */ }
      try { route.sink?.record(routeEventRecordFor(route, 'route.attestation-checked', { model, attestation })); } catch { /* D-21 */ }
    });
  }

  /**
   * The check behind an answer's trust badge (CLAS-08): the route's own check of the same chat id when its request was at attested-cloud (D-36), or else one
   * check through the same 10-minute report cache, kept so a second call for the answer makes no second signature request. `fresh` (a person's Check
   * again) always runs a new check without the cache. It never rejects: anything thrown is unavailable, never failed.
   */
  public verificationFor(model: string, evidence: ResponseEvidence, options: { fresh?: boolean } = {}): Promise<VerificationResult> {
    if (options.fresh === true) return this.verifyResponse(model, evidence).catch(uncheckable);
    const known = this.answerChecks.get(evidence.chatId) ?? this.badgeChecks.get(evidence.chatId);
    if (known !== undefined) return known;
    const check = verifyResponse(evidence, model, (path) => this.getJson(path), { cache: this.reportCache, ...this.trustOptions() }).catch(uncheckable);
    this.badgeChecks.set(evidence.chatId, check);
    while (this.badgeChecks.size > ANSWER_CHECKS_KEPT) this.badgeChecks.delete(this.badgeChecks.keys().next().value as string);
    return check;
  }

  /**
   * An answer whose request the route allowed at attested-cloud but which cannot be checked (PR #89 review): NEAR AI gave no signature id, or the path that
   * read it keeps no hashes (a non-streamed answer, an image, a transcription, a plain text stream). route.attestation-checked is recorded as unavailable with the plain reason; nothing else changes (D-55).
   */
  private answerUncheckable(response: Response, model: string, cause: keyof typeof UNCHECKABLE_ANSWER_REASONS): void {
    const route = this.attestedAnswers.get(response);
    if (route === undefined) return;
    this.attestedAnswers.delete(response);
    try { route.sink?.record(routeEventRecordFor(route, 'route.attestation-checked', { model, attestation: 'unavailable', reason: UNCHECKABLE_ANSWER_REASONS[cause] })); } catch { /* D-21 */ }
  }

  /** The trust the checks use: Intel's root and the system clock, unless a test set `attestationTrust`. */
  private trustOptions(): { trustedRoot?: string; now?: Date } {
    const trust = this.options.attestationTrust;
    return { ...(trust?.trustedRoot === undefined ? {} : { trustedRoot: trust.trustedRoot }), ...(trust?.now === undefined ? {} : { now: trust.now() }) };
  }

  /** Checks NEAR's signature and attestation for a completion this client received. */
  public async verifyResponse(model: string, evidence: ResponseEvidence, signal?: AbortSignal, trust: { trustedRoot?: string; now?: Date } = this.trustOptions()): Promise<VerificationResult> {
    return verifyResponse(evidence, model, (path) => this.getJson(path, signal), trust);
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
    // A client with a binding source checks its connection as soon as a private model is listed to ask the attestation for (in the background).
    if (this.options.binding !== undefined && models.some((model) => model.privacyBoundary === 'tee')) this.refreshBinding();
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
    const backoffMs = Math.min(MAX_RETRY_AFTER_MS, base * (2 ** (strikes - 1)));
    // The first refusal waits what NEAR asked; a probe refused again backs off exponentially, never for less than NEAR asked.
    const durationMs = strikes <= 1 ? retryAfterMs ?? backoffMs : Math.max(retryAfterMs ?? 0, backoffMs);
    const until = Math.max(existing?.until ?? 0, this.now() + durationMs);
    if (existing) { existing.until = until; existing.strikes = strikes; } else this.cooling.set(model, { until, strikes });
    return until - this.now();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** True while `model` is paced after a recent 429 or 503 (its requests go at most pacedConcurrency at a time). */
  public isPaced(model: string): boolean {
    const state = this.paced.get(model);
    return state !== undefined && state.until > this.now();
  }

  /** After a 429 or 503: the model is paced until pacedWindowMs from now. */
  private startPacing(model: string): void {
    const until = this.now() + Math.max(0, this.options.pacedWindowMs ?? PACED_WINDOW_MS);
    const state = this.paced.get(model);
    if (state) state.until = Math.max(state.until, until); else this.paced.set(model, { until, active: 0, waiters: [] });
  }

  /**
   * A slot for one request to `model` while it is paced: a release function, or undefined when the model is not paced (nothing to release). Waits while
   * pacedConcurrency requests are in flight, until one ends or the pacing window does; a request that waited then waits a short random gap more.
   * `failFast` (the safety check) throws the local 429 at once instead of waiting.
   */
  private async paceSlot(model: string | undefined, signal: AbortSignal | undefined, failFast = false): Promise<(() => void) | undefined> {
    if (!model) return undefined;
    const cap = Math.max(1, this.options.pacedConcurrency ?? PACED_CONCURRENCY);
    let waited = false;
    for (;;) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const state = this.paced.get(model);
      if (!state) return undefined;
      const remaining = state.until - this.now();
      if (remaining <= 0) {
        // The window is over: everyone waiting goes, and the entry goes once nothing it counts is in flight.
        for (const wake of state.waiters.splice(0)) wake();
        if (state.active === 0) this.paced.delete(model);
        return undefined;
      }
      if (state.active < cap) {
        if (waited) {
          await sleepFor(Math.round((this.options.random ?? Math.random)() * PACED_GAP_MS), signal);
          waited = false;
          continue;
        }
        state.active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          state.active -= 1;
          state.waiters.shift()?.();
          if (state.active === 0 && !state.waiters.length && state.until <= this.now() && this.paced.get(model) === state) this.paced.delete(model);
        };
      }
      if (failFast) throw coolingError(model, remaining);
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          const index = state.waiters.indexOf(done);
          if (index >= 0) state.waiters.splice(index, 1);
          resolve();
        };
        state.waiters.push(done);
        timer = setTimeout(done, remaining);
        signal?.addEventListener('abort', done, { once: true });
      });
      waited = true;
    }
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

  /**
   * The route check of one content request (CLAS-06, D-31, D-36): the session's route (or the default one outside every route), and only local facts: this
   * client's route kind, host and endpoint, the model's entry in this client's own cached catalog, the binding fact held in memory, and the clock. No network
   * call is made here (OFFL-01). Throws RouteRefusedError when the route refuses. Returns the binding fact when this client has a binding source.
   */
  private checkRoute(model: string | undefined): RouteCheck {
    const inSession = currentSessionRoute();
    const route = inSession ?? defaultSessionRoute();
    // Until the route's policy has been read, the record names the failed-closed routing and no policy hash (PR #81 review: a state that cannot be read for
    // its routing is refused and recorded below, never thrown past the check).
    let routing: RoutingTable = routingWhileFailedClosed();
    let defaultLabel: Label = SHIPPED_DEFAULT_LABEL;
    let bundleHash = '';
    const host = this.options.baseUrl;
    const fact = this.bindingFact(host);
    const now = clockOf(route);
    // The decision reads the fact held now; a missing or old one is checked again out of band for the next request (OFFL-01).
    this.refreshBinding(host, now);
    // D-37: privacyMode tee-only and a private member or agent team give one floor; decideRoute reads its tier and its allowed models.
    const floor = floorFor({ privateOnly: privateOnlyNow() });
    const facts = routeFactsFor({ clientRoute: this.options.route, host, info: model === undefined ? undefined : this.models.get(model), attestation: attestationStateOf(route), fact, now, localModelAvailable: this.options.localModelAvailable === true, sessionless: inSession === undefined, allowedModels: floor.allowedModels, catalog: this.models });
    let decision: RouteDecision;
    let mark: Mark = [];
    let checkFailed = false;
    let policyVersion: RouteRecordContext['policyVersion'];
    try {
      ({ routing, defaultLabel, bundleHash } = routingOf(route));
      mark = route.markOf();
      // D-36: the effective policy of the route's own host; none (or a route without one) decides as the safety patch did. A throw is a failed check.
      const policy = route.routePolicy?.(now);
      policyVersion = policy?.policyVersion;
      // Coherence review S4: the floor raises the tier to at least attested-cloud, so a model counts as private only when the gate's own check passes.
      decision = decideRoute(mark, routing, facts, defaultLabel, floor.tier, policy);
    } catch {
      // A policy state, a mark or a routing table that cannot be read means the route cannot be worked out: it is refused with a fixed rule and a plain
      // sentence, and recorded, rather than guessed or left to throw something nobody can read (PR 4a review).
      mark = [];
      checkFailed = true;
      policyVersion = undefined;
      decision = routeCheckFailed();
    }
    const context = { mark, defaultLabel, bundleHash, routing, ...(policyVersion === undefined ? {} : { policyVersion }) };
    // An attested-cloud request to NEAR AI Cloud is allowed only through a fresh bound fact (D-50); it is sent over a connection pinned to that fact's key.
    const pinned = decision.allowed && decision.tier === 'attested-cloud' && this.options.route === 'near' && facts.binding?.state === 'bound' ? facts.binding : undefined;
    // Owner, 2026-11-18: an any-cloud request to NEAR AI Cloud's own endpoint also goes over the pinned connection while a fresh proof for this host exists,
    // so its answer can show Verified private model; on a mismatch it falls back to an unpinned send. With no fresh proof it is sent as before.
    const optionalPin = decision.allowed && decision.tier === 'any-cloud' && this.options.route === 'near' && facts.nearEndpoint && this.options.binding?.fetchFor !== undefined
      && isBindingFresh(fact, now) && sameHostName(fact.host, host) ? fact : undefined;
    // GATE-07, D-52: every model request leaves one record, allowed or refused, through the route's sink, at the decision, before anything is sent, so a host
    // that dies mid-request still leaves it (PR #95 review round 3). A record that cannot be built or kept never changes the request (D-21).
    const write = (fellBack: boolean): void => {
      try {
        route.sink?.record(routeRecordFor(route, decision, facts, model === undefined ? {} : { model }, { ...context, checkFailed, ...(fellBack ? { connectionFallback: 'unpinned' as const } : {}) }));
      } catch { /* see above */ }
    };
    write(false);
    if (decision.allowed && !checkFailed) noteNotAccredited(route, decision, facts, model, context);
    let fellBackRecorded = false;
    const recordFallback = (): void => { if (!fellBackRecorded) { fellBackRecorded = true; write(true); } };
    if (!decision.allowed) throw new RouteRefusedError(decision.rule, decision.reason ?? 'Nothing was sent.', decision.passportRefusal);
    return {
      route,
      decision,
      facts,
      context,
      ...(this.options.binding === undefined ? {} : { connection: fact }),
      ...(pinned === undefined ? {} : { pinned }),
      ...(optionalPin === undefined ? {} : { optionalPin, recordFallback }),
      ...(decision.pinTo === undefined ? {} : { pinTo: decision.pinTo }),
      ...requestTrust(decision, facts, context, model === undefined ? undefined : this.models.get(model)?.forwardedTo)
    };
  }

  /**
   * The fetch a content request goes through: the normal one, or for an attested-cloud request to NEAR AI Cloud the source's fetch pinned to the bound key.
   * A source that cannot give a pinned fetch cannot carry the request at all: refused, never sent over an unpinned connection (CLAS-05).
   */
  private fetchFor(check: RouteCheck | undefined): typeof fetch {
    if (check?.pinTo !== undefined) { try { return (this.options.pinnedFetchFor ?? pinnedFetchAny)(check.pinTo); } catch { throw this.pinRefused(check); } }
    if (check?.pinned === undefined && check?.optionalPin !== undefined) {
      // At any-cloud a source that gives no pinned fetch leaves the request as it was before (unpinned, not proven), never refused.
      try { return this.options.binding?.fetchFor?.(check.optionalPin) ?? this.fetchFn; } catch { return this.fetchFn; }
    }
    if (check?.pinned === undefined) return this.fetchFn;
    let pinned: typeof fetch | undefined;
    try { pinned = this.options.binding?.fetchFor?.(check.pinned); } catch { pinned = undefined; }
    if (pinned === undefined) throw this.notBound(check, 'The binding source gives no pinned connection.');
    return pinned;
  }

  /** A connection to your organization's server that matched none of its pins (D-26): recorded, and nothing was sent. */
  private pinRefused(check: RouteCheck): RouteRefusedError {
    const refused = endpointPinRefusal(check.route, check.decision, check.facts, check.context);
    return new RouteRefusedError(refused.rule, refused.reason ?? 'Nothing was sent.');
  }

  /** A pinned connection that did not present the attested key: the host is marked not-bound, the refusal is recorded, and nothing was sent. */
  private notBound(check: RouteCheck, detail: string): RouteRefusedError {
    try { this.options.binding?.markNotBound(this.options.baseUrl, detail); } catch { /* the fact is unknown then, which never counts as bound */ }
    const reason = bindingReason('not-bound', 'route.connection-not-bound');
    const decision: RouteDecision = { allowed: false, tier: check.decision.tier, rule: 'route.connection-not-bound', reason };
    try {
      check.route.sink?.record(routeRecordFor(check.route, decision, { ...check.facts, binding: { state: 'not-bound', host: check.facts.host } }, check.facts.model === undefined ? {} : { model: check.facts.model.id }, check.context));
    } catch { /* a record that cannot be kept never changes the refusal (D-21) */ }
    return new RouteRefusedError('route.connection-not-bound', reason);
  }

  /** The binding fact held in memory for the host. No source, a source that throws, or a fact it does not have is unknown, never bound (D-50). */
  private bindingFact(host: string): ConnectionBindingFact {
    const source = this.options.binding;
    if (source !== undefined) {
      try {
        const fact = source.current(host);
        if (fact !== undefined) return fact;
      } catch { /* a source that throws is unknown */ }
    }
    return { state: 'unknown', host };
  }

  /** The usage a response starts with: its headers, and the binding fact the route check read when there is one. */
  private usageStart(response: Response, started: number): UsageMetadata {
    const connection = this.connections.get(response);
    const trust = this.trusts.get(response);
    return { ...metadataFromHeaders(response.headers, started), ...(connection === undefined ? {} : { connection }), ...(this.pinnedResponses.has(response) ? { connectionPinned: true as const } : {}), ...(trust === undefined ? {} : { trust }) };
  }

  private async request(path: string, init: RequestInit, overrides: { maxRetries?: number; model?: string; failFast?: boolean; spendKind?: SpendKind; secret?: string; stream?: boolean } = {}): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    if (!isSecureEndpoint(url)) throw new NearAiError(0, 'NEAR AI endpoint must use HTTPS; plain HTTP is only allowed for localhost.', false);
    // CLAS-06: the route is decided once, here, for every content request, before the spend check, before the cooldown probe slot is taken and before the first
    // byte is sent, whether or not spend tracking is on. A retry below is the same request and is not decided again.
    const check = needsRouteCheck(path, init.method) ? this.checkRoute(overrides.model) : undefined;
    return this.send(url, path, init, overrides, check, { fellBack: false });
  }

  /** Sends one content or plain request, after its route check, with the retry, the cooldown slot and the spend ledger. */
  private async send(url: string, path: string, init: RequestInit, overrides: { maxRetries?: number; model?: string; failFast?: boolean; spendKind?: SpendKind; secret?: string; stream?: boolean }, check: RouteCheck | undefined, sent: { fellBack: boolean }): Promise<Response> {
    // One retry layer: the agent loop backs off between model turns. Here, at most one quick retry,
    // and only for failures that are usually momentary (never for 429 or 503).
    const maxRetries = Math.max(0, Math.min(1, overrides.maxRetries ?? this.options.maxRetries ?? 1));
    const retryBaseDelayMs = Math.max(0, this.options.retryBaseDelayMs ?? 250);
    const random = this.options.random ?? Math.random;
    const responseTimeoutMs = Math.max(1, this.options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
    const model = overrides.model;
    let connection = check?.connection;
    let fetchFn = this.fetchFor(check);
    // Pinned at any-cloud (owner, 2026-11-18): set while the request still goes over the pinned connection.
    let optionalPin = check?.optionalPin !== undefined && fetchFn !== this.fetchFn;
    const billable = BILLABLE_PATHS.has(path) && (init.method ?? 'GET') === 'POST' && this.options.spend !== undefined;
    if (billable) {
      // The daily limit is checked before every billable request, whoever sends it.
      const reached = this.options.spend!.limitReached();
      if (reached) throw new SpendLimitError(reached.spentUsd, reached.limitUsd, reached.source);
    }
    const release = await this.admit(model, init.signal ?? undefined, overrides.failFast === true);
    // Paced after a recent 429/503: a slot, held by a stream until it ends (its reader releases it) and by anything else until this request returns.
    let pace: (() => void) | undefined;
    try { pace = await this.paceSlot(model, init.signal ?? undefined, overrides.failFast === true); } catch (error) { release?.(); throw error; }
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
          response = await fetchFn(url, {
            ...init,
            signal: attemptAbort.signal,
            headers: { ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}), ...(init.headers ?? {}) }
          });
        } catch (error) {
          unhook();
          const notBound = error instanceof ConnectionNotBoundError || (error as { cause?: unknown } | undefined)?.cause instanceof ConnectionNotBoundError;
          // At any-cloud a pinned connection that presented another key falls back to an unpinned send of the same request (nothing was written over the
          // pinned one): the host is not bound any more, the record names the fallback, and the usage carries a not-bound fact, so the answer's badge says the
          // connection was not proven (owner, 2026-11-18).
          if (check !== undefined && notBound && optionalPin) {
            try { this.options.binding?.markNotBound(this.options.baseUrl, (error as Error).message); } catch { /* the fact is unknown then, which never counts as bound */ }
            optionalPin = false;
            sent.fellBack = true;
            // The request's record was written at the decision; a second record says it fell back, naming no content, host or key (GATE-07).
            check.recordFallback?.();
            fetchFn = this.fetchFn;
            connection = { state: 'not-bound', host: this.options.baseUrl };
            clearTimeout(timer);
            attempt -= 1;
            continue;
          }
          if (check?.pinTo !== undefined && notBound) throw this.pinRefused(check);
          // The pinned connection presented another key: nothing was written, the host is not bound any more, and the request is refused (CLAS-05).
          if (check !== undefined && notBound) throw this.notBound(check, (error as Error).message);
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
          if (connection !== undefined) this.connections.set(response, connection);
          if (check?.trust !== undefined) this.trusts.set(response, check.trust);
          if (check?.pinned !== undefined) { this.attestedAnswers.set(response, check.route); this.pinnedResponses.add(response); }
          if (optionalPin) this.pinnedResponses.add(response);
          if (billable) this.charge(path, init, model, overrides.spendKind, response, 'open');
          // A stream keeps the caller's stop wired to the connection while its body is read, and its
          // reader can close the connection itself when the stream stalls; the reader releases it.
          if (overrides.stream) {
            const slot = pace;
            pace = undefined;
            this.streams.set(response, { abort: () => attemptAbort.abort(), release: () => { unhook(); slot?.(); } });
          } else unhook();
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
      pace?.();
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
    if (model && (status === 429 || status === 503)) { cooldownMs = this.startCooling(model, retryAfterMs, wasProbe); this.startPacing(model); }
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
function modelPrivacy(metadata: Record<string, unknown>): Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo' | 'attestationSupported'> {
  if (metadata.attestationSupported === true && metadata.providerType !== 'external') return { privacyBoundary: 'tee', attestationSupported: true };
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

/**
 * PERF-02: the exact body of an agent's chat completion request. One function builds it so the prompt-cache contract can be tested: the tools and every
 * earlier message serialize to the same bytes on every turn, and a turn only appends, so NEAR can serve the shared prefix from its prompt cache.
 */
export function completionRequestBody(model: string, messages: AgentMessage[], tools: ToolDefinition[], maxTokens: number): string {
  return JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) });
}

/**
 * The route's shared answer-check state (PR #85 review): `failed` only when a check really failed (`attestation.failed === true`); `unproven` when the
 * state is missing or cannot be read, which never claims a failed check but is never proof either; otherwise `ok`. Only the attested-cloud tier reads it:
 * an unproven state there gets no binding, so the content stays on this computer (D-50), and every other tier ignores it.
 */
function attestationStateOf(route: SessionRoute): 'ok' | 'failed' | 'unproven' {
  try {
    const failed = (route.attestation as { failed?: unknown } | undefined)?.failed;
    if (failed === true) return 'failed';
    return failed === false ? 'ok' : 'unproven';
  } catch {
    return 'unproven';
  }
}

/** The time of a route decision: the route's clock, or the system clock when the route has none or its clock throws. */
function clockOf(route: SessionRoute): number {
  try {
    const now = route.clock?.();
    if (typeof now === 'number' && Number.isFinite(now)) return now;
  } catch { /* the system clock below */ }
  return Date.now();
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

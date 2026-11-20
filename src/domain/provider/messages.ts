// FND-09, D-43: the chat message types every AI service adapter and the agent share. Moved verbatim from src/services/nearAiClient.ts (and
// ResponseEvidence from src/services/attestation.ts), which re-export them, so their importers compile unchanged. Pure: types only.
import type { CapabilityMetadataStatus, CapabilityModality, CapabilityPrivacyBoundary, SkillCapability, ProviderOperation } from '../capabilities';
import type { ConnectionBindingFact } from '../gate/routing';

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
  /** A tool call's name or arguments arrived: the reply is still making progress even though no text streams (PERF-03 stall detection). */
  | { type: 'progress' }
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
  /** NEAR's model list says this model runs in a TEE whose attestation can be checked (`attestationSupported` in /model/list metadata). */
  attestationSupported?: boolean;
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
  /** The connection binding fact the route check read for this request, when the client has a binding source (plan 25 gives NEAR clients one). */
  connection?: ConnectionBindingFact;
  /**
   * True only when the request went over a connection pinned to that fact's key, which the route check allows only while the fact is fresh and bound
   * (D-50). A bound fact alone does not prove the connection: a request sent without the pin may have reached another server (CLAS-08).
   */
  connectionPinned?: true;
}

/** What a completion keeps so it can be verified later. Hashes only; no prompt or answer text. */
export interface ResponseEvidence { chatId: string; requestHash: string; responseHash: string }

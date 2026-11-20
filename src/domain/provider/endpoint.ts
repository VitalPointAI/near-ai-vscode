// FND-09, D-43: what the agent needs from any AI service. NearAiClient is the first adapter; later adapters (other providers, local servers) implement
// the same interface, and each keeps the gate's route check inside itself, so this seam adds no way around it. Listing models is not here: it differs
// by route today and stays on the concrete client until a later phase decides it. Pure: types only.
import type { AgentMessage, CompletionEvent, ToolDefinition, UsageMetadata } from './messages';

/** What the policy layer may know about an endpoint: never a key, a header or any secret. */
export interface EndpointFacts {
  /** The route the endpoint is (NEAR AI Cloud or a local runtime); absent when the client was built without one, which every stricter level refuses. */
  readonly route?: 'near' | 'local';
  readonly baseUrl: string;
  /** True only for NEAR AI Cloud's own endpoint, where a TEE model's answers can be checked. */
  readonly nearEndpoint: boolean;
  /** The policy endpoint id, filled by a caller that knows it; nothing sets it yet. */
  readonly endpointId?: string;
}

/** An AI service the agent can send a conversation to. The signatures are NearAiClient's own, so it implements this with no change. */
export interface ModelEndpoint {
  readonly facts: EndpointFacts;
  streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, options?: { idleTimeoutMs?: number; turnTimeoutMs?: number; maxOutputTokens?: number }): AsyncGenerator<CompletionEvent>;
  completeOnce(model: string, messages: AgentMessage[], options: { maxTokens: number; signal?: AbortSignal; noThinking?: boolean }): Promise<{ text: string; usage: UsageMetadata; reasoning?: string; finishReason?: string }>;
  /** How long a model stays cooling after the service refused it for load; endpoints with no cooldown leave it out. */
  cooldownRemainingMs?(model: string): number;
}

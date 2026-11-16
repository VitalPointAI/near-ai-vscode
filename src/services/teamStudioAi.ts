import type { NearAiSettings } from '../domain/config';
import { routeAllows, type PrivateRoute } from './agentSession';
import type { AgentMessage, ModelInfo } from './nearAiClient';
import { OutboundGuard } from './outboundGuard';

// Every model call Team Studio makes (drafting a team from a description, Improve with AI) goes through here, so it passes the same outbound check as
// chat: emergency stop, the daily spend limit, TEE-only mode and the privacy preflight (0.4.27: draftTeam used to call the model directly and skipped
// all four). A call that needs a private model gets one, a NEAR TEE model on an attested route or a local model, or does not happen. No VS Code
// imports, so the tests drive it with fakes.

/** `private`: only a model that runs in NEAR's TEE on NEAR's own endpoint, or on this machine. `any`: whatever the settings and TEE-only mode allow. */
export type TeamAiNeed = 'private' | 'any';

export interface TeamAiInput {
  /** The key's catalogue (with privacy), as activeProvider loads it. */
  models: ModelInfo[];
  /** Preferred models in order: the deep tier, the standard tier, the main model. Empty values are skipped. */
  preferred: string[];
  /** The route a request for this model takes (privateRouteFor(provider, clientFor(active, model).local)). */
  routeFor(model: ModelInfo): PrivateRoute;
  privacyMode: NearAiSettings['privacyMode'];
}

export type TeamAiChoice = { ok: true; model: string; info: ModelInfo; private: boolean } | { ok: false; reason: string };

const FAILED_ATTESTATION = /\b(?:fail|failed|failure|unverified|invalid|revoked|expired|false|error|untrusted|mismatch|not[-_ ]?(?:attested|verified|supported|valid))\b/i;
const GOOD_ATTESTATION = /\b(?:verified|attested|supported|pass|passed|ok|valid|true)\b/i;

/**
 * Why a TEE model does not count as private for Team Studio's private-only calls (0.4.27), or undefined when it does. Fails closed: a failed or
 * unverified attestation refuses it, and so does a model whose attestation NEAR has not reported at all. NEAR's model list reports it
 * (`attestationSupported`, the same metadata that marks a model TEE), or the catalogue's verification or attestation status says verified.
 */
export function attestationProblem(model: Pick<ModelInfo, 'id' | 'privacyBoundary' | 'attestationSupported' | 'attestationStatus' | 'verificationStatus'>): string | undefined {
  if (model.privacyBoundary !== 'tee') return undefined;
  const status = model.attestationStatus?.trim() ?? '';
  if (model.verificationStatus === 'unverified' || (status && FAILED_ATTESTATION.test(status))) return `${model.id}: its attestation is reported as failed or unverified`;
  if (model.attestationSupported === true || model.verificationStatus === 'verified' || (status && GOOD_ATTESTATION.test(status))) return undefined;
  return `${model.id}: NEAR has not reported that its attestation is supported or verified`;
}

/** Whether a catalogue entry can answer in text (image-only models are left out). */
const textModel = (model: ModelInfo) => !model.outputModalities?.length || model.outputModalities.includes('text');

/**
 * The model a Team Studio call uses. Preferred models first (the deep tier, then standard, then the main model), then the rest of the catalogue. For a
 * private need, only a model `routeAllows` accepts on its own route; with TEE-only mode on, only a TEE or local model, so the guard is not set up to
 * refuse a model the studio picked itself.
 */
export function chooseTeamModel(need: TeamAiNeed, input: TeamAiInput): TeamAiChoice {
  const byId = new Map(input.models.map((model) => [model.id, model]));
  const ordered = [...new Set([...input.preferred.filter(Boolean), ...input.models.map((model) => model.id)])].map((id) => byId.get(id)).filter((model): model is ModelInfo => Boolean(model) && textModel(model!));
  const isPrivate = (model: ModelInfo) => routeAllows(input.routeFor(model), model) && attestationProblem(model) === undefined;
  if (!ordered.length) return { ok: false, reason: 'Your NEAR AI key lists no chat models, so no model can be asked.' };
  if (need === 'private') {
    const chosen = ordered.find(isPrivate);
    if (chosen) return { ok: true, model: chosen.id, info: chosen, private: true };
    return { ok: false, reason: noPrivateModel(ordered, input) };
  }
  const allowed = input.privacyMode === 'tee-only' ? ordered.filter((model) => model.privacyBoundary === 'tee' || model.privacyBoundary === 'local') : ordered;
  const chosen = allowed[0];
  if (!chosen) return { ok: false, reason: 'TEE-only mode is on, and none of your key\'s models runs in NEAR\'s TEE or on this machine. Pick a model marked "Private", or turn off nearAi.privacyMode.' };
  return { ok: true, model: chosen.id, info: chosen, private: isPrivate(chosen) };
}

/** Why no private model is available, in plain words. */
function noPrivateModel(models: ModelInfo[], input: TeamAiInput): string {
  const tee = models.filter((model) => model.privacyBoundary === 'tee');
  // TEE models on NEAR's own endpoint whose attestation is failed, unverified or unreported: said by name, so the person knows which and why.
  const unattested = tee.filter((model) => routeAllows(input.routeFor(model), model)).map(attestationProblem).filter((problem): problem is string => Boolean(problem));
  if (unattested.length) return `It needs a private model, and no TEE model on this profile has an attestation that counts (${unattested.slice(0, 3).join('; ')}). Choose another NEAR TEE model, or add a local model.`;
  if (tee.length && tee.every((model) => { const route = input.routeFor(model); return route.kind === 'near' && !route.attestation; })) {
    return 'It needs a private model, and your profile\'s endpoint is not NEAR AI Cloud, so a TEE model\'s attestation cannot be checked. Use NEAR AI Cloud, or add a local model.';
  }
  return 'It needs a private model (one that runs in NEAR\'s TEE or on this machine), and none is available on this profile. Choose a NEAR TEE model for a tier, or add a local model.';
}

export interface TeamAiCall {
  need: TeamAiNeed;
  messages: AgentMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface TeamAiDeps extends TeamAiInput {
  settings: Pick<NearAiSettings, 'privacyMode' | 'dailySpendLimitUsd' | 'actionPolicy'>;
  /** Today's spend from the key's ledger, as chat reads it. */
  spentTodayUsd(): Promise<number>;
  complete(model: string, messages: AgentMessage[], options: { maxTokens: number; signal?: AbortSignal; noThinking?: boolean }): Promise<{ text: string; finishReason?: string }>;
}

export type TeamAiResult =
  | { ok: true; text: string; model: string; private: boolean; finishReason?: string }
  /** `blocked`: nothing was sent (no allowed model, or the outbound check refused). */
  | { ok: false; blocked: true; reason: string; model?: string };

/**
 * Chooses the model, runs the outbound check on exactly what would be sent, then sends it. Nothing reaches a provider unless the check allows it. A
 * check that would ask for confirmation in chat (personal data) refuses here: Team Studio has no one-time override, so the person is told what to remove.
 */
export async function teamModelCall(deps: TeamAiDeps, call: TeamAiCall): Promise<TeamAiResult> {
  const choice = chooseTeamModel(call.need, deps);
  if (!choice.ok) return { ok: false, blocked: true, reason: choice.reason };
  const text = call.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  const verdict = new OutboundGuard(deps.settings).check({ model: choice.model, modelInfo: choice.info, text }, await deps.spentTodayUsd());
  if (verdict.outcome !== 'allow') return { ok: false, blocked: true, model: choice.model, reason: `${verdict.reason}${verdict.outcome === 'confirm' ? ' Team Studio cannot send it; remove it and try again.' : ''}` };
  if (call.signal?.aborted) return { ok: false, blocked: true, model: choice.model, reason: 'Cancelled.' };
  const reply = await deps.complete(choice.model, call.messages, { maxTokens: call.maxTokens, ...(call.signal ? { signal: call.signal } : {}), noThinking: true });
  return { ok: true, text: reply.text, model: choice.model, private: choice.private, ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) };
}

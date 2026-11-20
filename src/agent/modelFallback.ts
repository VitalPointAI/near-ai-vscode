// Sub-agent model fallback (owner's D-48 run, 2026-11-19): a member whose model NEAR AI keeps refusing as overloaded (429/503), or whose model keeps
// sending nothing, moves to the next model of a chain that is at least as private, instead of failing. This module holds the pure parts: the words the
// person reads, why a member failed, and the run-wide memory of which models are in trouble. The chain itself is built in src/gsd/library.ts
// (fallbackModelsFor), and the switch happens in the agent loop (AgentRun.modelTurn).

/** Why a member moved to another model. `refused`: the route gate refused the fallback it was moving to, so it moved on again. */
export type ModelSwitchCause = 'overloaded' | 'stalled' | 'refused';

/** Continuous 429/503 answers for one turn, for at least this long (and at least twice), before the member moves to its next model. */
export const SWITCH_AFTER_MS = 60_000;
/** Times a model sent nothing for the stall limit, within one turn, before the member moves to its next model. */
export const SWITCH_AFTER_STALLS = 2;
/** How long a model another member of the run gave up on is skipped as a fallback. */
export const TROUBLE_MS = 3 * 60_000;

/**
 * A model ID in words a person reads: "moonshotai/kimi-k3" is "Kimi K3", "Qwen/Qwen3.6-35B-A3B-FP8" is "Qwen 3.6", "z-ai/glm-5.3" is "GLM 5.3". The
 * provider prefix and the size and precision parts are left out; a lower-case word is capitalized, and a short one (three letters or fewer) is upper-cased.
 */
export function modelDisplayName(id: string): string {
  const name = id.slice(id.lastIndexOf('/') + 1).trim();
  if (!name) return id;
  const words: string[] = [];
  for (const part of name.split(/[-_\s]+/).filter(Boolean)) {
    // Sizes (35B, 8x7B), active parameters (A3B), precision (FP8, BF16, INT4) and packaging words end the name.
    if (/^(?:\d+x)?\d+(?:\.\d+)?[bmk]$|^a\d+(?:\.\d+)?b$|^(?:fp|bf|int|q)\d+$|^(?:instruct|chat|it|hf|gguf|awq|gptq)$/i.test(part)) break;
    // "Qwen3.6" reads "Qwen 3.6": letters followed by a version number are two words.
    const split = /^([A-Za-z]{2,})(\d+(?:\.\d+)*)$/.exec(part);
    words.push(...(split ? [split[1], split[2]] : [part]));
  }
  if (!words.length) return name;
  return words.map((word) => (/^[a-z]+\d*(?:\.\d+)*$/.test(word) ? (word.replace(/\d.*$/, '').length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)) : word)).join(' ');
}

/** Seconds as the person reads them: "90", "2.5". */
function secondsOf(ms: number): string {
  return ms >= 10_000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10);
}

/** Why the member left `from`, in words: "Kimi K3 is overloaded at NEAR AI", "Kimi K3 gave no answer for 90 s". */
export function switchReason(from: string, cause: ModelSwitchCause, quietMs?: number): string {
  const name = modelDisplayName(from);
  if (cause === 'overloaded') return `${name} is overloaded at NEAR AI`;
  if (cause === 'stalled') return `${name} gave no answer${quietMs ? ` for ${secondsOf(quietMs)} s` : ''}`;
  return `${name} is not allowed for this chat by policy`;
}

/**
 * The line the person reads when a member moves: "threat-analyst switched from Kimi K3 to Qwen 3.6: Kimi K3 is overloaded at NEAR AI". A member whose
 * team file names its model says so, since the person chose that model.
 */
export function switchNotice(label: string, from: string, to: string, reason: string, pinned = false): string {
  return `${label} switched from ${modelDisplayName(from)} to ${modelDisplayName(to)}: ${reason}.${pinned ? ` Its team file names ${modelDisplayName(from)}; it goes back to it on its next task.` : ''}`;
}

/**
 * Why a run or one model request failed, in words, for the activity record and the lead's tool result: "GLM 5.3 is overloaded at NEAR AI", "Kimi K3
 * gave no answer for 90 s", "refused by policy: ...". Reads the error's name and fields (it may be wrapped in an AgentRunError's `cause`), so it needs
 * no import of the client or the loop. Undefined for a failure it has no words for: the caller keeps the error's own message then.
 */
export function failureReason(error: unknown): string | undefined {
  const outer = error as { name?: unknown; cause?: unknown } | undefined;
  const failure = (outer?.name === 'AgentRunError' && outer.cause !== undefined ? outer.cause : error) as {
    name?: unknown; status?: unknown; model?: unknown; symptom?: unknown; idleMs?: unknown; kind?: unknown; message?: unknown; stalled?: unknown
  } | undefined;
  if (!failure || typeof failure !== 'object') return undefined;
  const model = typeof failure.model === 'string' && failure.model ? modelDisplayName(failure.model) : 'The model';
  const message = typeof failure.message === 'string' ? failure.message : '';
  switch (failure.name) {
    case 'ModelUnavailableError':
      return failure.status === 429 || failure.status === 503 ? `${model} is overloaded at NEAR AI` : `NEAR AI kept failing for ${model} (HTTP ${String(failure.status)})`;
    case 'ModelStalledError': {
      const quiet = typeof failure.symptom === 'string' ? /no data for ([\d.]+) s/.exec(failure.symptom) : null;
      return quiet ? `${model} gave no answer for ${quiet[1]} s` : `${model} stopped answering (${typeof failure.symptom === 'string' ? failure.symptom : 'no answer'})`;
    }
    case 'RouteRefusedError': return `refused by policy: ${message.replace(/\s+/g, ' ').slice(0, 200)}`;
    case 'SpendLimitError': return 'the spend limit was reached';
    case 'StreamInterruptedError':
      return failure.kind === 'stalled' || failure.stalled === true ? `${model} gave no answer${typeof failure.idleMs === 'number' ? ` for ${secondsOf(failure.idleMs)} s` : ''}` : `${model} broke off its answer`;
    default: break;
  }
  if (failure.name === 'NearAiError' || typeof failure.status === 'number') {
    if (failure.status === 429 || failure.status === 503) return `${model} is overloaded at NEAR AI`;
    if (failure.status === 402) return 'the NEAR AI spend limit was reached';
    if (failure.status === 401 || failure.status === 403) return 'NEAR AI refused the API key';
  }
  return undefined;
}

/**
 * The models members of one run found in trouble, shared by every member of the run: a member does not move to a model another member just left
 * because it was overloaded or gave no answer. Entries end after TROUBLE_MS.
 */
export class ModelTrouble {
  private readonly until = new Map<string, number>();
  public constructor(private readonly now: () => number = Date.now, private readonly forMs = TROUBLE_MS) {}
  public mark(model: string): void { this.until.set(model, this.now() + this.forMs); }
  public answering(model: string): boolean {
    const until = this.until.get(model);
    if (until === undefined) return true;
    if (until > this.now()) return false;
    this.until.delete(model);
    return true;
  }
}

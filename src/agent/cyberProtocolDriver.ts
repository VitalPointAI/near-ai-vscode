import type { Step, StepRole, ValidateOptions } from '../domain/cyberProtocol';
import { isModelIncompatible, MAX_STEP_REPAIRS, parseStep, ProtocolParseError } from '../domain/cyberProtocol';

// The thin agent-layer driver (D-19, D-20, CYBER-04). A raw-completion model gets four calls with
// four prompts; every reply is parsed through the one Step schema before anything executes. The
// completion client is injected as a single function so plan 25-05 can wire the real NearAiClient
// path without this module importing the extension host.

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The minimal seam the run handoff supplies: model + messages -> the reply text. */
export type CompleteFn = (model: string, messages: CompletionMessage[], signal?: AbortSignal) => Promise<string>;

export interface DriverOptions {
  model: string;
  complete: CompleteFn;
  /** The engagement's scope check, applied to every step before it is returned (T-25-32). */
  inScope?: (target: string) => boolean;
  /** How many corrective replies one role may ask for; defaults to MAX_STEP_REPAIRS. */
  maxRepairs?: number;
}

export interface StepSuccess {
  kind: 'steps';
  role: StepRole;
  steps: Step[];
  /** How many corrective replies it took; 0 on a first-try parse. */
  repairs: number;
}

/** The visible typed failure the panel renders — never an exception, never a free-text fallthrough. */
export interface IncompatibleResult {
  kind: 'incompatible';
  role: StepRole;
  reason: string;
  /** How many replies were consumed before the role was declared incompatible. */
  attempts: number;
}

export type AskRoleResult = StepSuccess | IncompatibleResult;

const CORRECTION = 'Your last reply was not a single valid Step JSON object. Reply again with only the Step JSON — no prose, no code fence, and every field filled in.';

/** Every Step JSON object in one reply, in order, for ledger replay. */
export function stepsFromText(text: string, options: ValidateOptions = {}): Step[] {
  const steps: Step[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  const bodies: string[] = [];
  for (let match = fenced.exec(text); match; match = fenced.exec(text)) bodies.push(match[1]);
  if (!bodies.length) {
    // One unfenced object per reply is the contract; a reply with extra objects still parses the first.
    bodies.push(text);
  }
  for (const body of bodies) {
    try {
      steps.push(parseStep(body, options));
    } catch {
      // A fenced block that is not a step is skipped; the caller still sees any that are.
      continue;
    }
  }
  return steps;
}

export class CyberProtocolDriver {
  private readonly model: string;
  private readonly complete: CompleteFn;
  private readonly inScope?: (target: string) => boolean;
  private readonly maxRepairs: number;
  /** Consecutive parse failures per role, so incompatibility is measured per role (CYBER-04). */
  private readonly failures = new Map<StepRole, number>();

  public constructor(options: DriverOptions) {
    this.model = options.model;
    this.complete = options.complete;
    this.inScope = options.inScope;
    this.maxRepairs = Math.max(1, Math.floor(options.maxRepairs ?? MAX_STEP_REPAIRS));
  }

  /** How many times this role has failed in a row; reset by any successful parse. */
  public consecutiveFailures(role: StepRole): number {
    return this.failures.get(role) ?? 0;
  }

  /** Whether the role is already unusable, so a caller can skip calling the model at all. */
  public isIncompatible(role: StepRole): boolean {
    return isModelIncompatible(this.consecutiveFailures(role));
  }

  /**
   * One role call. The reply is parsed; on a parse failure a corrective user turn is appended and the
   * role asked again, up to the bound. Success resets the role's failure count; exhausting the bound
   * returns a typed incompatibility instead of throwing, so the panel can render it.
   */
  public async askRole(role: StepRole, messages: CompletionMessage[], signal?: AbortSignal): Promise<AskRoleResult> {
    const conversation: CompletionMessage[] = [...messages];
    let lastReason = 'the model produced no usable Step JSON';
    for (let attempt = 0; attempt <= this.maxRepairs; attempt += 1) {
      const reply = await this.complete(this.model, conversation, signal);
      try {
        const step = parseStep(reply, { ...(this.inScope ? { inScope: this.inScope } : {}) });
        this.failures.set(role, 0);
        return { kind: 'steps', role, steps: [step], repairs: attempt };
      } catch (error) {
        lastReason = error instanceof ProtocolParseError ? `${error.code}: ${error.reason}` : 'the reply could not be parsed';
        conversation.push({ role: 'assistant', content: reply });
        conversation.push({ role: 'user', content: CORRECTION });
      }
    }
    const failures = this.consecutiveFailures(role) + 1;
    this.failures.set(role, failures);
    return { kind: 'incompatible', role, reason: lastReason, attempts: this.maxRepairs + 1 };
  }

  /** The parse of one reply without a model call, for ledger replay and the panel's re-run view. */
  public stepsFromText(text: string): Step[] {
    return stepsFromText(text, { ...(this.inScope ? { inScope: this.inScope } : {}) });
  }
}

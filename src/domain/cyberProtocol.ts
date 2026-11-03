// The JSON-in-text step protocol (D-19, CYBER-04). Every step the harness executes is a JSON object
// parsed out of a raw-completion model's prose: no native tool calling is assumed, so the reply is
// extracted, repaired through five bounded passes, and validated field by field before any tool sees
// it. A reply that cannot be repaired is a typed, visible failure — never free text executed as a call.

export type StepRole = 'planner' | 'operator' | 'critic' | 'reporter';

export type StepAction = 'recon' | 'probe' | 'exploit' | 'verify' | 'report';

export type StepSandbox = 'auto' | 'container' | 'tempFolder' | 'none';

export interface StepSafetyFlags {
  maxDurationMs: number;
  /** Operations per minute the step may issue; 0 means the engagement's rate limit stands. */
  rateLimit: number;
  denyList: string[];
}

/** The single step schema shared by all four role prompts (D-20). */
export interface Step {
  id: string;
  role: StepRole;
  action: StepAction;
  target: string;
  tool: string;
  args: string[];
  sandbox: StepSandbox;
  expectedResult: string;
  safetyFlags: StepSafetyFlags;
}

export type ParseErrorCode = 'no-json' | 'invalid-json' | 'invalid-step' | 'out-of-scope';

export class ProtocolParseError extends Error {
  public constructor(public readonly code: ParseErrorCode, public readonly reason: string) {
    super(reason);
    this.name = 'ProtocolParseError';
  }
}

/** How many parse-repair replies one role may ask for before the model is declared incompatible. */
export const MAX_STEP_REPAIRS = 3;

/** A role is incompatible once it has failed the bound in a row; the panel renders this, it is not thrown. */
export function isModelIncompatible(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_STEP_REPAIRS;
}

// ---- Extraction and repair ----------------------------------------------------------------------

const FENCE = /^\s*```[a-zA-Z0-9_-]*\s*$/gm;

/** Removes a ```json fence's markers while leaving the JSON between them. */
function stripFences(text: string): string {
  return text.replace(FENCE, '');
}

/** The first `{` to the last `}`; prose before or after the object is dropped. */
function sliceObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * Removes `//` and block comments, but only outside strings — a step's target is often a URL, whose
 * `//` must survive.
 */
function stripComments(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      out += char;
      if (char === '\\') { out += next ?? ''; index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Converts single-quoted strings to double-quoted ones, escaping any double quote inside them. */
function normalizeQuotes(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'/g, (match) => {
    const body = match.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return `"${body}"`;
  });
}

/** Trailing commas before a closing bracket or brace are legal in the model's dialect, not in JSON. */
function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

/** The five repair passes in the order they are cheap and safe to apply. */
export function repairJson(text: string): string {
  return removeTrailingCommas(normalizeQuotes(stripComments(stripFences(text))));
}

// ---- Validation ---------------------------------------------------------------------------------

const ROLES: StepRole[] = ['planner', 'operator', 'critic', 'reporter'];
const ACTIONS: StepAction[] = ['recon', 'probe', 'exploit', 'verify', 'report'];
const SANDBOXES: StepSandbox[] = ['auto', 'container', 'tempFolder', 'none'];

const MAX_FIELD = 4_000;

export type StepValidation =
  | { ok: true; step: Step }
  | { ok: false; code: Exclude<ParseErrorCode, 'no-json' | 'invalid-json'>; reason: string };

export interface ValidateOptions {
  /** The engagement's scope check; a step outside it is invalid before any tool runs (T-25-32). */
  inScope?: (target: string) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isShortString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FIELD;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length <= MAX_FIELD);

const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Hand-rolled boundary validation of an untrusted step, in the chatBridge.ts style: field by field,
 * no schema library, and the first failure names the field the model must fix.
 */
export function validateStep(value: unknown, options: ValidateOptions = {}): StepValidation {
  if (!isRecord(value)) return { ok: false, code: 'invalid-step', reason: 'the reply is not a JSON object' };
  const fail = (reason: string): StepValidation => ({ ok: false, code: 'invalid-step', reason });
  for (const field of ['id', 'target', 'tool', 'expectedResult']) {
    if (!isShortString(value[field])) return fail(`"${field}" must be a non-empty string`);
  }
  if (!ROLES.includes(value.role as StepRole)) return fail(`"role" must be one of ${ROLES.join(', ')}`);
  if (!ACTIONS.includes(value.action as StepAction)) return fail(`"action" must be one of ${ACTIONS.join(', ')}`);
  if (!SANDBOXES.includes(value.sandbox as StepSandbox)) return fail(`"sandbox" must be one of ${SANDBOXES.join(', ')}`);
  if (!isStringArray(value.args)) return fail('"args" must be an array of strings');
  if (!isRecord(value.safetyFlags)) return fail('"safetyFlags" must be an object');
  const flags = value.safetyFlags;
  if (!isPositiveNumber(flags.maxDurationMs)) return fail('"safetyFlags.maxDurationMs" must be a positive number');
  if (!isPositiveNumber(flags.rateLimit) && flags.rateLimit !== 0) return fail('"safetyFlags.rateLimit" must be zero or a positive number');
  if (!isStringArray(flags.denyList)) return fail('"safetyFlags.denyList" must be an array of strings');

  const step: Step = {
    id: value.id as string,
    role: value.role as StepRole,
    action: value.action as StepAction,
    target: value.target as string,
    tool: value.tool as string,
    args: value.args as string[],
    sandbox: value.sandbox as StepSandbox,
    expectedResult: value.expectedResult as string,
    safetyFlags: { maxDurationMs: flags.maxDurationMs as number, rateLimit: flags.rateLimit as number, denyList: flags.denyList as string[] }
  };

  if (options.inScope) {
    let allowed: boolean;
    try { allowed = options.inScope(step.target); } catch { allowed = false; }
    if (!allowed) return { ok: false, code: 'out-of-scope', reason: `"${step.target}" is outside the engagement scope` };
  }
  return { ok: true, step };
}

/** The raw JSON text in a reply, or a typed error when the reply contains no object at all. */
function extractObject(text: string): string {
  const sliced = sliceObject(stripFences(text));
  if (!sliced) throw new ProtocolParseError('no-json', 'the reply contains no JSON object; reply with only the Step JSON');
  return sliced;
}

/**
 * Parses one step out of a model reply. Extraction and repair are attempted, then validation; the
 * error carries a code the driver uses to decide whether to retry.
 */
export function parseStep(text: string, options: ValidateOptions = {}): Step {
  const candidate = extractObject(text);
  let invalidJson = false;
  for (const attempt of [candidate, repairJson(candidate)]) {
    let value: unknown;
    try { value = JSON.parse(attempt); } catch { invalidJson = true; continue; }
    const result = validateStep(value, options);
    if (!result.ok) throw new ProtocolParseError(result.code, result.reason);
    return result.step;
  }
  throw new ProtocolParseError('invalid-json', invalidJson ? 'the reply is not valid JSON after repair; reply again with only the Step JSON' : 'the reply is not valid JSON');
}

// ---- Compaction ---------------------------------------------------------------------------------

/** One recorded step as compaction sees it; evidenceHashes are kept in full, never summarized. */
export interface ProtocolStepRecord {
  id: string;
  action: StepAction;
  target: string;
  result: string;
  reasoning: string;
  evidenceHashes: string[];
  /** True when this entry was compressed to a summary. */
  compacted: boolean;
}

const SUMMARY_RESULT = 160;
const SUMMARY_REASONING = 120;

/**
 * The research's context-compaction rule: the last N steps stay verbatim, older ones keep their
 * identity and every evidence hash but lose their bulk. Evidence hashes are what a report cites, so
 * they are never dropped.
 */
export function compactSteps(steps: ProtocolStepRecord[], keepLastN = 6): ProtocolStepRecord[] {
  const keep = Math.max(0, Math.floor(keepLastN));
  const boundary = steps.length - keep;
  return steps.map((step, index) => (index < boundary
    ? {
      id: step.id,
      action: step.action,
      target: step.target,
      result: step.result.length > SUMMARY_RESULT ? `${step.result.slice(0, SUMMARY_RESULT)}…` : step.result,
      reasoning: step.reasoning.length > SUMMARY_REASONING ? `${step.reasoning.slice(0, SUMMARY_REASONING)}…` : step.reasoning,
      evidenceHashes: [...step.evidenceHashes],
      compacted: true
    }
    : { ...step, evidenceHashes: [...step.evidenceHashes], compacted: false }));
}

// ---- Role prompts (D-20) ------------------------------------------------------------------------

const STEP_FIELDS = '"id", "role", "action", "target", "tool", "args", "sandbox", "expectedResult", "safetyFlags"';

const REPLY_RULE = `Reply with exactly one JSON object and nothing else — no prose, no code fence, no commentary before or after it. The object has the fields ${STEP_FIELDS}.`;

/** The allowed value for every enumerated field, and a complete worked example. */
const FIELD_VALUES = `Field values:
- "id": any short unique string, e.g. "step-1".
- "role": exactly one of "planner", "operator", "critic", "reporter" — use the role you are acting as.
- "action": exactly one of "recon", "probe", "exploit", "verify", "report".
- "target": the host, URL, IP, or folder this step works on. It must be inside the engagement scope.
- "tool": the name of one tool offered to you, or "done" when no further step is needed.
- "args": an array of strings, possibly empty.
- "sandbox": exactly one of "auto", "container", "tempFolder", "none".
- "expectedResult": one sentence describing the output that would confirm the step ran.
- "safetyFlags": an object with "maxDurationMs" (a positive number), "rateLimit" (0 or a positive number), and "denyList" (an array of strings, possibly empty).

A complete example, which you should copy the shape of exactly:
{"id":"step-1","role":"planner","action":"probe","target":"http://127.0.0.1:8080/","tool":"CyberHttpProbe","args":[],"sandbox":"none","expectedResult":"a 200 response with its headers","safetyFlags":{"maxDurationMs":10000,"rateLimit":0,"denyList":[]}}`;

/** Four separate calls, four jobs: one model plays every role, so the prompts must not overlap (D-20). */
export const ROLE_PROMPTS: Record<StepRole, string> = {
  planner: `You are the planner of a penetration test. Given the engagement scope and the evidence so far, choose the next single step that most reduces uncertainty: recon before probing, probing before exploitation, and never a step outside the scope. Your "role" is "planner". Return the step as JSON. ${FIELD_VALUES} ${REPLY_RULE}`,
  operator: `You are the operator of a penetration test. Execute the step you are given by naming exactly one tool and its arguments, and state in "expectedResult" what output would confirm it ran. Do not invent a tool that was not offered. Your "role" is "operator". Return the step as JSON. ${FIELD_VALUES} ${REPLY_RULE}`,
  critic: `You are the critic of a penetration test. Judge each finding only against a reproduction command or captured evidence; if neither exists, ask for a bounded re-probe instead of accepting it, and mark the finding unverified when the reprobe still cannot reproduce it. Your "role" is "critic". Return your judgement as JSON in the same step shape, with "action" set to "verify". ${FIELD_VALUES} ${REPLY_RULE}`,
  reporter: `You are the reporter of a penetration test. Turn verified findings into PTES report content — severity, CVSS 3.1 vector, WSTG id, evidence reference, remediation — and state "none" rather than inventing a finding. Your "role" is "reporter", with "action" set to "report". Return the report step as JSON. ${FIELD_VALUES} ${REPLY_RULE}`
};

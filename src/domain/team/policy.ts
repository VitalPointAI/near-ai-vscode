// Team policy defaults (D-13, with integer basis points from D-30) and the policy field validators. Every call returns fresh arrays and objects.
import { ROLES, TEAM_REJECTION_REASONS } from './types';
import type { DispatchWeight, Role, TeamPolicy } from './types';

export const DEFAULT_SHARED_PATHS: readonly string[] = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'CHANGELOG.md', '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'];
export const DEFAULT_RESOURCES: readonly string[] = ['integrator', 'deps', 'db-schema', 'release'];
export const DEFAULT_WIP_LIMIT = 2;

export function defaultTeamPolicy(options: { integrationBranch?: string } = {}): TeamPolicy {
  const allowedModels: Record<Role, string[]> = { owner: [], lead: [], developer: [], reviewer: [], observer: [] };
  const dispatchWeightsBp: Record<DispatchWeight, number> = { roleFit: 3000, fileAffinity: 2500, continuity: 1500, capacity: 1500, budgetHeadroom: 1000, criticalPath: 500 };
  return {
    dispatchMode: 'offer', offerTimeoutMinutes: 30, leaseTtlMinutes: 60, heartbeatMinutes: 10, enforceWip: true,
    sharedPaths: [...DEFAULT_SHARED_PATHS], resources: [...DEFAULT_RESOURCES], verifyCommands: ['npm run lint', 'npm test'], reviewPolicy: 'agent-then-human',
    integrationMode: 'merge-train', integrationBranch: options.integrationBranch ?? 'main', budgetPeriod: 'monthly', unspentPolicy: 'return-to-pool',
    safetyFactorBp: 12500, overrunFactorBp: 15000, reconcileToleranceBp: 500, allowedModels, teeOnly: false,
    peerMetricsVisible: false, requireLeadConfirmation: true, developerMayIntegrate: false, dispatchWeightsBp
  };
}

/**
 * Team Mode's inputs to a request's private floor (D-37): `teeOnly` and the role's allowed models (an empty list is no filter). Read side only: floorFor
 * turns them into the floor decideRoute applies. No call site reads Team Mode policy for a model request yet.
 */
export function teamRouteInputs(policy: TeamPolicy, role: Role): { readonly teeOnly: boolean; readonly allowedModels: readonly string[] } {
  return { teeOnly: policy.teeOnly === true, allowedModels: [...(policy.allowedModels[role] ?? [])] };
}

// Policy validation (D-13, D-30). Every TeamPolicy key has one validator; the Record type makes a missing key a compile error.
// Reasons are `invalid event body: <path>` where the path starts at the caller-supplied prefix.
const DISPATCH_WEIGHT_KEYS: readonly DispatchWeight[] = ['roleFit', 'fileAffinity', 'continuity', 'capacity', 'budgetHeadroom', 'criticalPath'];
const MAX_REF_NAME = 255;
// Characters git refuses in a ref name (check-ref-format) plus controls and invisible format characters, which could spoof what a person reads.
const FORBIDDEN_REF_CHARACTERS = /[\u0000-\u0020\u007F-\u009F\s~^:?*[\\\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const MAX_BASIS_POINTS = 100_000;
const WEIGHT_TOTAL_BP = 10000; // dispatch weights must sum to 10000 basis points
const MAX_LIST = 64;
const MAX_TEXT = 200;
const MAX_MODEL_LIST = 32;
const MAX_MODEL_ID = 160;
const MAX_VERIFY_COMMANDS = 16;
const MAX_MINUTES = 10_080;

type PolicyCheck = (value: unknown) => boolean;

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function oneOf(...allowed: string[]): PolicyCheck {
  return (value) => typeof value === 'string' && allowed.includes(value);
}

function integerBetween(min: number, max: number): PolicyCheck {
  return (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isBoolean(value: unknown): boolean {
  return typeof value === 'boolean';
}

function stringList(maxEntries: number, entry: (item: string) => boolean): PolicyCheck {
  return (value) => Array.isArray(value) && value.length <= maxEntries && value.every((item) => typeof item === 'string' && entry(item));
}

function isRelativePosixPath(item: string): boolean {
  if (item.length < 1 || item.length > MAX_TEXT || CONTROL_CHARACTERS.test(item) || item.includes('\\')) return false;
  if (item.startsWith('/')) return false;
  return !item.split('/').includes('..');
}

function isVerifyCommand(item: string): boolean {
  return item.length >= 1 && item.length <= MAX_TEXT && !CONTROL_CHARACTERS.test(item);
}

function isModelId(item: string): boolean {
  return item.length >= 1 && item.length <= MAX_MODEL_ID && !CONTROL_CHARACTERS.test(item);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isAllowedModels(value: unknown): boolean {
  if (!isPlain(value) || !hasExactly(value, ROLES)) return false;
  const check = stringList(MAX_MODEL_LIST, isModelId);
  return ROLES.every((role) => check(value[role]));
}

function isDispatchWeights(value: unknown): boolean {
  if (!isPlain(value) || !hasExactly(value, DISPATCH_WEIGHT_KEYS)) return false;
  const weight = integerBetween(0, WEIGHT_TOTAL_BP);
  let total = 0;
  for (const key of DISPATCH_WEIGHT_KEYS) {
    const entry = value[key];
    if (!weight(entry)) return false;
    total += entry as number;
  }
  return total === WEIGHT_TOTAL_BP;
}

// One validator for every branch or ref name Team Mode signs or reads. It follows `git check-ref-format --branch`: any letters, digits and
// punctuation git allows, but not the sequences it refuses (.., @{, //, a leading or trailing slash, a trailing dot, a component that
// starts with a dot or ends in .lock) and not a leading dash, which a command line would read as an option.
export function isGitRefName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REF_NAME) return false;
  if (value === '@' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{') || FORBIDDEN_REF_CHARACTERS.test(value)) return false;
  return value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

function isIntegrationBranch(value: unknown): boolean {
  return isGitRefName(value);
}

const POLICY_CHECKS: Record<keyof TeamPolicy, PolicyCheck> = {
  dispatchMode: oneOf('suggest', 'offer', 'auto'),
  offerTimeoutMinutes: integerBetween(1, MAX_MINUTES),
  leaseTtlMinutes: integerBetween(1, MAX_MINUTES),
  heartbeatMinutes: integerBetween(1, MAX_MINUTES),
  enforceWip: isBoolean,
  sharedPaths: stringList(MAX_LIST, isRelativePosixPath),
  resources: stringList(MAX_LIST, isRelativePosixPath),
  verifyCommands: stringList(MAX_VERIFY_COMMANDS, isVerifyCommand),
  reviewPolicy: oneOf('human', 'agent', 'agent-then-human'),
  integrationMode: oneOf('merge-train', 'pull-request'),
  integrationBranch: isIntegrationBranch,
  budgetPeriod: oneOf('monthly', 'milestone'),
  unspentPolicy: oneOf('rollover', 'return-to-pool', 'expire'),
  safetyFactorBp: integerBetween(0, MAX_BASIS_POINTS),
  overrunFactorBp: integerBetween(0, MAX_BASIS_POINTS),
  reconcileToleranceBp: integerBetween(0, MAX_BASIS_POINTS),
  allowedModels: isAllowedModels,
  teeOnly: isBoolean,
  peerMetricsVisible: isBoolean,
  requireLeadConfirmation: isBoolean,
  developerMayIntegrate: isBoolean,
  dispatchWeightsBp: isDispatchWeights
};
const POLICY_KEYS = Object.keys(POLICY_CHECKS) as Array<keyof TeamPolicy>;

function reason(path: string): string {
  const safe = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120);
  return `${TEAM_REJECTION_REASONS.invalidBody}: ${safe}`;
}

function isPolicyKey(key: string): key is keyof TeamPolicy {
  return Object.prototype.hasOwnProperty.call(POLICY_CHECKS, key);
}

// Full policy as carried by team.created: exactly the TeamPolicy keys, each valid. Returns the failure reason or undefined.
export function validatePolicy(value: unknown, path = 'policy'): string | undefined {
  if (!isPlain(value)) return reason(path);
  const present = Object.keys(value);
  for (const key of POLICY_KEYS) {
    if (!present.includes(key)) return reason(`${path}.${key}`);
  }
  for (const key of present) {
    if (!isPolicyKey(key)) return reason(`${path}.${key.slice(0, 40)}`);
  }
  for (const key of POLICY_KEYS) {
    if (!POLICY_CHECKS[key](value[key])) return reason(`${path}.${key}`);
  }
  return undefined;
}

// policy.changed carries a non-empty partial policy; each present key is validated like the full policy.
export function validatePolicyChanges(value: unknown, path = 'changes'): string | undefined {
  if (!isPlain(value)) return reason(path);
  const present = Object.keys(value);
  if (present.length === 0) return reason(path);
  for (const key of present) {
    if (!isPolicyKey(key)) return reason(`${path}.${key.slice(0, 40)}`);
    if (!POLICY_CHECKS[key](value[key])) return reason(`${path}.${key}`);
  }
  return undefined;
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => cloneJson(item)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneJson(entry);
    return copy as T;
  }
  return value;
}

// Returns a new policy; neither argument is modified. The caller validates the changes first (validatePolicyChanges).
export function applyPolicyChanges(policy: TeamPolicy, changes: Partial<TeamPolicy>): TeamPolicy {
  const next = cloneJson(policy) as unknown as Record<string, unknown>;
  for (const key of Object.keys(changes)) {
    if (!isPolicyKey(key)) continue;
    next[key] = cloneJson((changes as Record<string, unknown>)[key]);
  }
  return next as unknown as TeamPolicy;
}

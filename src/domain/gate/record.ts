// The gate's decision record (GATE-07, D-20, D-21): one record per decision, shaped after OCSF 1.9.0 (API Activity, class 6003, profile ai_operation) so a
// later audit chain can sign it unchanged. "Shaped after" is deliberate: this file checks only what the shape needs and never claims full OCSF schema
// validity (assumption A1 of the research). Pure: no I/O, no clock (the caller passes epoch milliseconds), no vscode, no package. A record carries names and
// paths, never file contents, prompts or model output.
import { redactCredentialArguments, redactSecrets } from '../redaction';
import { canonicalize } from '../team/canonical';
import { findSecrets } from '../team/secrets';
import { POLICY_EVENT_IDS } from './bundle';
import { RECORD_RULE_IDS, RECORD_UNKNOWN_RULE } from './decide';
import type { ActorRef, GateDecision } from './decide';
import { LABEL_EVENT_IDS } from './labels';
import type { Label } from './labels';
import { ROUTE_EVENT_IDS, ROUTE_REFUSALS, ROUTE_REFUSALS_NAMED_AHEAD, ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD } from './routing';
import { USE_TIERS } from './models';
import type { UseTier } from './models';
import { PASSPORT_GAPS } from './passportStep';
import type { PassportGapId } from './passportStep';
import type { ConnectionBindingState } from './routing';
import { isRecord, ownValue, refused } from './shape';
import type { Parsed, Refusal } from './shape';
import { CAPABILITY_VERBS } from './vocabulary';
import type { Capability } from './vocabulary';

export const RECORD_VERSION = 1;

/**
 * The policy versions a record may name in `authorizations[].policy.version` (Phase 41 D-10): `bundle-1` while the effective policy is a v1 bundle (the
 * default, as every record before Phase 41 says), `bundle-2` once it is a v2 document. validateDecisionRecord refuses any other.
 */
export const POLICY_RECORD_VERSIONS = Object.freeze(['bundle-1', 'bundle-2'] as const);
export type PolicyRecordVersion = (typeof POLICY_RECORD_VERSIONS)[number];
export const OCSF_VERSION = '1.9.0';
/** API Activity (class 6003) in Application Activity (category 6). The gate's "API" is the use of a capability. */
export const OCSF_API_ACTIVITY = Object.freeze({ class_uid: 6003, category_uid: 6 } as const);

export const DECISION_OUTCOMES = Object.freeze(['allowed', 'asked', 'approved', 'denied', 'refused-by-floor'] as const);
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

const PRODUCT = Object.freeze({ name: 'NEAR AI for VS Code', vendor_name: 'VitalPoint' } as const);
const SOURCE_NAME = 'near-ai-vscode';
const WAITING_TEXT = 'waiting for a person';
const MAX_DETAIL = 300;

interface OutcomeFields { readonly action_id: number; readonly disposition_id: number; readonly status_id: number; readonly severity_id: number }

// The enums of the OCSF version this record declares (OCSF_VERSION, 1.9.0), as read from that schema's API Activity class. action_id: 0 Unknown, 1 Allowed,
// 2 Denied, 3 Observed, 4 Modified, 99 Other. disposition_id: 1 Allowed, 2 Blocked, 3 Quarantined, 8 Approved, 25 Rejected, 26 Unauthorized, 99 Other (among
// others this record never uses). status_id: 1 Success, 2 Failure. An ask has no value of its own that this record uses, so until a person answers it is
// written as 99 Other for both action and disposition, with the gate's own word for it (`outcome: 'asked'`) in `unmapped.nearAi.outcome`; the answer is a
// second record with the same call id. Action 3 (Observed) and disposition 3 (Quarantined) are never used.
const OUTCOME_FIELDS: Readonly<Record<DecisionOutcome, OutcomeFields>> = Object.freeze({
  allowed: { action_id: 1, disposition_id: 1, status_id: 1, severity_id: 1 },
  asked: { action_id: 99, disposition_id: 99, status_id: 1, severity_id: 3 },
  approved: { action_id: 1, disposition_id: 8, status_id: 1, severity_id: 3 },
  denied: { action_id: 2, disposition_id: 25, status_id: 2, severity_id: 4 },
  'refused-by-floor': { action_id: 2, disposition_id: 2, status_id: 2, severity_id: 4 }
});

/** The disposition of a clearance failure: denied, and Unauthorized rather than Rejected. */
const CLEARANCE_DISPOSITION = 26;

export interface DecisionResource {
  /** A name or a path, never contents. */
  readonly name: string;
  readonly type: string;
  readonly uid?: string;
}

export interface DecisionRecordInput {
  /** A fresh id for this record; the caller makes it, so this file holds no random source. */
  readonly recordId: string;
  /** The position of the record in its file, whole numbers from 0. */
  readonly sequence: number;
  /** Epoch milliseconds. */
  readonly time: number;
  readonly productVersion: string;
  readonly actor: ActorRef;
  readonly model?: { readonly name: string; readonly provider: string };
  readonly callId: string;
  readonly capability: Capability;
  readonly resource: DecisionResource;
  readonly outcome: DecisionOutcome;
  /** The rule id that decided, for example `floor.protected-write`. */
  readonly rule: string;
  readonly reason?: string;
  readonly bundleHash: string;
  readonly label?: Label;
  readonly tier?: string;
  /** Set when a denial was a failed clearance check, which records disposition 26 (Unauthorized). */
  readonly clearanceFailure?: boolean;
  /** The floor rule a shadow floor would have applied. Only 0.4.28, whose floor only reported, wrote it; the floor is enforced now and nothing sets it. Kept so records of that version still read. */
  readonly shadowFloor?: string;
  /**
   * The session's whole mark, when it is not the policy's default label (D-52): one `data_classifications` entry and one `unmapped.nearAi.mark` entry per
   * label, beside the single `label` field. Optional, so the record stays version 1.
   */
  readonly mark?: readonly Label[];
  /**
   * A label event's previous mark (PR #87 review round 3): on every label event `mark` is the chat's mark after the event, `label` the event's target, and
   * `from` the mark before it. Optional, so the record stays version 1.
   */
  readonly from?: readonly Label[];
  /** What the answer check after a response found (plan 25). Never a report, a key or a fingerprint. */
  readonly attestation?: 'verified' | 'failed' | 'unavailable';
  /** The connection binding state the route read (D-50). Never the host or the fingerprint. */
  readonly connection?: ConnectionBindingState;
  /** Which refusal of label.outbound-match this is (match, earlier, unchecked, pending, full, unreadable, reads-and-sends). Optional: record version 1. */
  readonly outboundCause?: string;
  /**
   * Set on a model request at any-cloud that was to go over the connection pinned to NEAR AI Cloud's attested key, met another key, and was sent unpinned
   * instead (owner, 2026-11-18). Names no content, host or key. Optional: record version 1.
   */
  readonly connectionFallback?: 'unpinned';
  /**
   * The short form of a routine record (D-52, owner decision after PR 4a's measurement): nothing is written twice. The resource list is empty because the
   * capability names what was used, and the policy entry carries no uid because `unmapped.nearAi.bundleHash` holds the policy's hash. Every field the record
   * check needs is still there, so the record stays version 1.
   */
  readonly short?: boolean;
  /** The effective policy's version, `bundle-1` when absent (D-10, D-58). Optional: record version 1. */
  readonly policyVersion?: PolicyRecordVersion;
  /**
   * Route rules that would have refused this request but only report in this version (D-36: `route.passport`, and `route.accredited-device` until your
   * organization turns it on), written sorted to `unmapped.nearAi.wouldRefuse`. Each must be a refusing route rule. Optional: record version 1.
   */
  readonly wouldRefuse?: readonly string[];
  /** The use the passport step checked (74.1 D-23), written to `unmapped.nearAi.useTier`. Optional: record version 1. */
  readonly useTier?: UseTier;
  /** The passport that decided the request, by id, and the SHA-256 of its canonical bytes (D-23). Optional: record version 1. */
  readonly passport?: { readonly id: string; readonly hash: string };
  /** Why the passport did not cover the request (D-11), written to `unmapped.nearAi.passportGap`. Optional: record version 1. */
  readonly passportGap?: PassportGapId;
  /** A checking route's families (74.1 D-19, D-23), written to `unmapped.nearAi.checkFamilies`. Optional: record version 1. */
  readonly checkFamilies?: CheckRecordFamilies;
  /** `t0` for a request from the research workspace (74.1 D-17), written to `unmapped.nearAi.lane`; no other value exists. Optional: record version 1. */
  readonly lane?: 't0';
}

/** The families of a check: the writers' (sorted) and the checker's, which is never one of them (74.1 D-19). */
export interface CheckRecordFamilies {
  readonly author: readonly string[];
  readonly checker: string;
}

/**
 * Who hears that a record was given a rule nobody knows. Nothing listens in the product (the record is kept under RECORD_UNKNOWN_RULE, with the id beside
 * it); the gate's test helper listens and throws, so a writer with a new id fails the test that runs it (PR #74 review round 11).
 */
export const unknownRuleListeners = new Set<(id: string) => void>();

/** The record's rule, known: an unknown one becomes RECORD_UNKNOWN_RULE with the id it was given (shown plainly, at most 120 characters) beside it. */
export function withKnownRule(record: DecisionRecord): DecisionRecord {
  const entry = record.authorizations[0];
  const rule = entry?.policy.name;
  if (entry === undefined || typeof rule !== 'string' || RECORD_RULE_IDS.includes(rule)) return record;
  for (const listener of [...unknownRuleListeners]) listener(rule);
  const shown = rule.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 120);
  return {
    ...record,
    authorizations: [{ ...entry, policy: { ...entry.policy, name: RECORD_UNKNOWN_RULE } }, ...record.authorizations.slice(1)],
    unmapped: { ...record.unmapped, nearAi: { ...record.unmapped.nearAi, unknownRule: shown } }
  };
}

export interface DecisionRecord {
  readonly metadata: {
    readonly version: string;
    readonly product: { readonly name: string; readonly vendor_name: string; readonly version: string };
    readonly profiles: readonly string[];
    readonly uid: string;
    readonly sequence: number;
    readonly data_classifications?: readonly { readonly confidentiality: string; readonly confidentiality_id: number; readonly category_id: number }[];
  };
  readonly time: number;
  readonly severity_id: number;
  readonly class_uid: number;
  readonly category_uid: number;
  readonly activity_id: number;
  readonly activity_name: string;
  readonly type_uid: number;
  readonly action_id: number;
  readonly disposition_id: number;
  readonly status_id: number;
  readonly status_detail?: string;
  readonly actor: { readonly user: { readonly uid: string }; readonly session: { readonly uid: string } };
  readonly ai_agent?: {
    readonly name: string;
    readonly uid: string;
    readonly instance_uid: string;
    readonly ai_model?: { readonly name: string; readonly ai_provider: string };
  };
  readonly api: { readonly operation: string; readonly request: { readonly uid: string } };
  readonly resources: readonly DecisionResource[];
  readonly authorizations: readonly {
    readonly decision: string;
    /** `uid` is the policy's hash; a short record leaves it out, since unmapped.nearAi.bundleHash holds the same hash. */
    readonly policy: { readonly name: string; readonly uid?: string; readonly version: string; readonly is_applied: boolean };
  }[];
  readonly src_endpoint: { readonly name: string };
  readonly unmapped: {
    readonly nearAi: {
      readonly recordVersion: number;
      readonly capability: Capability;
      readonly bundleHash: string;
      /** Present only on a record whose action and disposition are 99 Other (an ask): the gate's own name for the outcome. The standard ids describe every other outcome. */
      readonly outcome?: DecisionOutcome;
      readonly label?: Label;
      readonly tier?: string;
      readonly shadowFloor?: string;
      /** The rule a writer gave that nobody knows; the record's rule is then RECORD_UNKNOWN_RULE. */
      readonly unknownRule?: string;
      readonly mark?: readonly Label[];
      readonly from?: readonly Label[];
      readonly attestation?: 'verified' | 'failed' | 'unavailable';
      readonly connection?: ConnectionBindingState;
      readonly outboundCause?: string;
      readonly connectionFallback?: 'unpinned';
      /** Report-only route rules that would have refused (D-36), sorted. */
      readonly wouldRefuse?: readonly string[];
      readonly useTier?: UseTier;
      readonly passport?: string;
      readonly passportHash?: string;
      readonly passportGap?: PassportGapId;
      readonly checkFamilies?: CheckRecordFamilies;
      readonly lane?: 't0';
    };
  };
}

/** Activity ids: 2 Read for read and plan, 3 Update for a workspace write, 4 Delete for destroy, 99 Other (named by the verb) for the rest. */
function activityOf(capability: Capability): { id: number; name: string } {
  switch (capability.verb) {
    case 'read':
    case 'plan':
      return { id: 2, name: 'Read' };
    case 'workspaceWrite':
      return { id: 3, name: 'Update' };
    case 'destroy':
      return { id: 4, name: 'Delete' };
    default:
      return { id: 99, name: capability.verb };
  }
}

function copyLabel(label: Label): Label {
  return { scale: label.scale, level: label.level, compartments: [...label.compartments], releasability: [...label.releasability], handling: [...label.handling] };
}

function detailFor(input: DecisionRecordInput): string | undefined {
  if (input.outcome === 'asked') return WAITING_TEXT;
  if (input.reason === undefined || input.reason === '') return undefined;
  return input.reason.length > MAX_DETAIL ? input.reason.slice(0, MAX_DETAIL) : input.reason;
}

/** The outcome a gate decision is recorded as: a floor refusal (including a floor ask that nobody could answer) is its own outcome, distinct from any other denial. */
export function outcomeOf(decision: Pick<GateDecision, 'outcome' | 'floor'>): DecisionOutcome {
  if (decision.outcome === 'allow') return 'allowed';
  if (decision.outcome === 'ask') return 'asked';
  return decision.floor ? 'refused-by-floor' : 'denied';
}

/** One string as a record keeps it: credentials carried as command arguments removed by class, then every known token shape. */
function redactString(value: string): string {
  return redactSecrets(redactCredentialArguments(value));
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = redactValue(value[key]);
    return out;
  }
  return value;
}

/**
 * A copy of the record with every string redacted: credentials a command carries in its arguments (redactCredentialArguments: a URL's user part, `-u
 * user:pass`, `--password=`/`--token`-style options, credential headers, `NAME_TOKEN=` assignments) and every known token shape (redactSecrets), so a
 * credential in a command's first line, a reason or a name never reaches a file.
 */
export function redactRecord(record: DecisionRecord): DecisionRecord {
  return redactValue(record) as DecisionRecord;
}

/** The record for one decision, already redacted. Every number is a whole number and every string is a name, a path, a rule id or a plain sentence. */
export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const outcome = OUTCOME_FIELDS[input.outcome];
  const activity = activityOf(input.capability);
  const detail = detailFor(input);
  const disposition = input.clearanceFailure === true && input.outcome === 'denied' ? CLEARANCE_DISPOSITION : outcome.disposition_id;
  const allowed = outcome.action_id === 1;
  // One entry per distinct level: the label and the mark often name the same one (a refusal names the label of its mark that decided it).
  const classifications = [...new Set([...(input.label === undefined ? [] : [input.label]), ...(input.mark ?? [])].map((label) => `${label.scale}/${label.level}`))]
    .map((confidentiality) => ({ confidentiality, confidentiality_id: 99, category_id: 99 }));
  const record: DecisionRecord = {
    metadata: {
      version: OCSF_VERSION,
      product: { name: PRODUCT.name, vendor_name: PRODUCT.vendor_name, version: input.productVersion },
      profiles: ['ai_operation'],
      uid: input.recordId,
      sequence: input.sequence,
      ...(classifications.length === 0 ? {} : { data_classifications: classifications })
    },
    time: input.time,
    severity_id: outcome.severity_id,
    class_uid: OCSF_API_ACTIVITY.class_uid,
    category_uid: OCSF_API_ACTIVITY.category_uid,
    activity_id: activity.id,
    activity_name: activity.name,
    type_uid: OCSF_API_ACTIVITY.class_uid * 100 + activity.id,
    action_id: outcome.action_id,
    disposition_id: disposition,
    status_id: outcome.status_id,
    ...(detail === undefined ? {} : { status_detail: detail }),
    actor: { user: { uid: input.actor.deviceFingerprint }, session: { uid: input.actor.sessionId } },
    ...(input.actor.kind === 'person'
      ? {}
      : {
        ai_agent: {
          name: input.actor.agentLabel ?? input.actor.agentId ?? input.actor.kind,
          uid: input.actor.agentId ?? input.actor.kind,
          instance_uid: input.actor.sessionId,
          ...(input.model === undefined ? {} : { ai_model: { name: input.model.name, ai_provider: input.model.provider } })
        }
      }),
    api: { operation: input.capability.verb, request: { uid: input.callId } },
    resources: input.short === true ? [] : [input.resource.uid === undefined
      ? { name: input.resource.name, type: input.resource.type }
      : { name: input.resource.name, type: input.resource.type, uid: input.resource.uid }],
    authorizations: [{
      decision: allowed ? 'Allowed' : input.outcome === 'asked' ? 'Observed' : 'Denied',
      policy: input.short === true
        ? { name: input.rule, version: input.policyVersion ?? 'bundle-1', is_applied: true }
        : { name: input.rule, uid: input.bundleHash, version: input.policyVersion ?? 'bundle-1', is_applied: true }
    }],
    src_endpoint: { name: SOURCE_NAME },
    unmapped: {
      nearAi: {
        recordVersion: RECORD_VERSION,
        capability: input.capability,
        bundleHash: input.bundleHash,
        ...(outcome.action_id === 99 ? { outcome: input.outcome } : {}),
        ...(input.label === undefined ? {} : { label: copyLabel(input.label) }),
        ...(input.tier === undefined ? {} : { tier: input.tier }),
        ...(input.shadowFloor === undefined ? {} : { shadowFloor: input.shadowFloor }),
        ...(input.mark === undefined ? {} : { mark: input.mark.map(copyLabel) }),
        ...(input.from === undefined ? {} : { from: input.from.map(copyLabel) }),
        ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
        ...(input.connection === undefined ? {} : { connection: input.connection }),
        ...(input.outboundCause === undefined ? {} : { outboundCause: input.outboundCause }),
        ...(input.connectionFallback === undefined ? {} : { connectionFallback: input.connectionFallback }),
        ...(input.wouldRefuse === undefined ? {} : { wouldRefuse: [...input.wouldRefuse].sort() }),
        ...(input.useTier === undefined ? {} : { useTier: input.useTier }),
        ...(input.passport === undefined ? {} : { passport: input.passport.id, passportHash: input.passport.hash }),
        ...(input.passportGap === undefined ? {} : { passportGap: input.passportGap }),
        ...(input.checkFamilies === undefined ? {} : { checkFamilies: { author: [...input.checkFamilies.author].sort(), checker: input.checkFamilies.checker } }),
        ...(input.lane === undefined ? {} : { lane: input.lane })
      }
    }
  };
  return withKnownRule(redactRecord(record));
}

type Kind = 'int' | 'string' | 'array';
const REQUIRED: readonly (readonly [string, Kind])[] = Object.freeze([
  ['metadata.version', 'string'], ['metadata.uid', 'string'], ['metadata.sequence', 'int'], ['metadata.profiles', 'array'], ['metadata.product.name', 'string'],
  ['metadata.product.version', 'string'], ['time', 'int'], ['severity_id', 'int'], ['class_uid', 'int'], ['category_uid', 'int'], ['activity_id', 'int'],
  ['activity_name', 'string'], ['type_uid', 'int'], ['action_id', 'int'], ['disposition_id', 'int'], ['status_id', 'int'], ['actor.user.uid', 'string'],
  ['actor.session.uid', 'string'], ['api.operation', 'string'], ['api.request.uid', 'string'], ['resources', 'array'], ['authorizations', 'array'],
  ['src_endpoint.name', 'string'], ['unmapped.nearAi.recordVersion', 'int'], ['unmapped.nearAi.bundleHash', 'string']
] as const);

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = ownValue(current, key);
  }
  return current;
}

function kindOk(value: unknown, kind: Kind): boolean {
  if (kind === 'int') return typeof value === 'number' && Number.isSafeInteger(value);
  if (kind === 'string') return typeof value === 'string';
  return Array.isArray(value);
}

/** Whether any string in the value still holds a credential argument that redactCredentialArguments would remove. */
function carriesCredentialArgument(value: unknown): boolean {
  if (typeof value === 'string') return redactCredentialArguments(value) !== value;
  if (Array.isArray(value)) return value.some(carriesCredentialArgument);
  if (isRecord(value)) return Object.keys(value).some((key) => carriesCredentialArgument(value[key]));
  return false;
}

/** The rules of a model request's record (the route rules) and of the events about a session's routing: the records the model-request log holds. */
const MODEL_REQUEST_RULES: ReadonlySet<string> = new Set<string>([...ROUTE_RULES, ...ROUTE_EVENT_IDS, ...ROUTE_RULES_NAMED_AHEAD]);

/**
 * Whether a record is about a model request (an infer record, or a route event) rather than a tool call or the policy. Model-request records have a log of
 * their own (owner decision after PR 4a's measurement); everything else stays in the decision log. Decided by the rule, the one thing every writer sets
 * from a closed list: no tool decision carries a route rule, and a tool whose effect is `infer` still has a tool rule.
 */
export function isModelRequestRecord(record: Pick<DecisionRecord, 'authorizations'>): boolean {
  const rule = record.authorizations[0]?.policy.name;
  return typeof rule === 'string' && MODEL_REQUEST_RULES.has(rule);
}

/** What `api.operation` may name: a capability verb, one of the policy's own events, or a label event (D-49). Route events use the operation `infer`. */
const RECORD_OPERATIONS: ReadonlySet<string> = new Set<string>([...CAPABILITY_VERBS, ...POLICY_EVENT_IDS, ...LABEL_EVENT_IDS]);
const RECORD_RULES: ReadonlySet<string> = new Set(RECORD_RULE_IDS);

/** The rules a wouldRefuse list may name: refusing route rules, shipped or named ahead (D-36). */
const WOULD_REFUSE_RULES: ReadonlySet<string> = new Set<string>([...Object.keys(ROUTE_REFUSALS), ...Object.keys(ROUTE_REFUSALS_NAMED_AHEAD)]);
const POLICY_VERSIONS: ReadonlySet<string> = new Set<string>(POLICY_RECORD_VERSIONS);
// Field paths are joined at run time: the record id scan reads any quoted text that starts with a rule namespace as a rule id.
const VERSION_FIELD = ['policy', 'version'].join('.');
const WOULD_REFUSE_FIELD = ['unmapped', 'nearAi', 'wouldRefuse'].join('.');
const USE_TIER_SET: ReadonlySet<string> = new Set<string>(USE_TIERS);
const PASSPORT_GAP_SET: ReadonlySet<string> = new Set<string>(PASSPORT_GAPS);
const PASSPORT_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const FAMILY_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHECK_FAMILIES_FIELD = ['unmapped', 'nearAi', 'checkFamilies'].join('.');

/** The passport fields of a model request's record (74.1 D-23): each optional, each from its own closed list or shape. */
function passportFieldsKnown(value: Record<string, unknown>): Refusal | undefined {
  const checks: ReadonlyArray<readonly [string, (found: unknown) => boolean]> = [
    ['useTier', (found) => typeof found === 'string' && USE_TIER_SET.has(found)],
    ['passport', (found) => typeof found === 'string' && PASSPORT_ID.test(found)],
    ['passportHash', (found) => typeof found === 'string' && HEX_64.test(found)],
    ['passportGap', (found) => typeof found === 'string' && PASSPORT_GAP_SET.has(found)],
    // The research workspace's lane (74.1 D-17): t0 is the only lane; any other value is refused.
    ['lane', (found) => found === 't0']
  ];
  for (const [key, ok] of checks) {
    const field = ['unmapped', 'nearAi', key].join('.');
    const found = readPath(value, field);
    if (found !== undefined && !ok(found)) return refused('not-allowed-here', field);
  }
  // A check's families (74.1 D-23): family tokens, and a checker never of a writer's family, so a forged same-family check is caught.
  const families = readPath(value, CHECK_FAMILIES_FIELD);
  if (families !== undefined) {
    const author = readPath(families, 'author');
    const checker = readPath(families, 'checker');
    const token = (found: unknown): found is string => typeof found === 'string' && FAMILY_TOKEN.test(found);
    if (!Array.isArray(author) || !author.every(token) || !token(checker) || author.includes(checker)) return refused('not-allowed-here', CHECK_FAMILIES_FIELD);
  }
  return undefined;
}

/** Every rule a record carries is one of RECORD_RULE_IDS, and its operation is a verb, a policy event or a label event, so no writer can put an id nobody knows on file. */
function idsKnown(value: Record<string, unknown>): Refusal | undefined {
  const authorizations = value.authorizations;
  if (!Array.isArray(authorizations)) return refused('wrong-type', 'authorizations');
  for (const [index, entry] of authorizations.entries()) {
    const rule = readPath(entry, 'policy.name');
    if (typeof rule !== 'string' || !RECORD_RULES.has(rule)) return refused('not-allowed-here', `authorizations[${index}].policy.name`);
    const version = readPath(entry, VERSION_FIELD);
    if (typeof version !== 'string' || !POLICY_VERSIONS.has(version)) return refused('not-allowed-here', `authorizations[${index}].${VERSION_FIELD}`);
  }
  const wouldRefuse = readPath(value, WOULD_REFUSE_FIELD);
  if (wouldRefuse !== undefined) {
    if (!Array.isArray(wouldRefuse)) return refused('wrong-type', WOULD_REFUSE_FIELD);
    for (const [index, id] of wouldRefuse.entries()) {
      if (typeof id !== 'string' || !WOULD_REFUSE_RULES.has(id)) return refused('not-allowed-here', `${WOULD_REFUSE_FIELD}[${index}]`);
    }
  }
  const operation = readPath(value, 'api.operation');
  if (typeof operation !== 'string' || !RECORD_OPERATIONS.has(operation)) return refused('not-allowed-here', 'api.operation');
  return passportFieldsKnown(value);
}

/**
 * Check a record only for what its shape needs: the class arithmetic (class 6003, category 6, type_uid = 600300 + activity_id), every required key with
 * the right kind, the record version, a known rule and operation, whole numbers only, no secret-like string and no credential argument left in any string. Nothing here claims the record is valid
 * against the full OCSF schema.
 */
export function validateDecisionRecord(value: unknown): Parsed<DecisionRecord> {
  if (!isRecord(value)) return refused('wrong-type', '');
  for (const [path, kind] of REQUIRED) {
    const found = readPath(value, path);
    if (found === undefined) return refused('missing-field', path);
    if (!kindOk(found, kind)) return refused('wrong-type', path);
  }
  if (value.class_uid !== OCSF_API_ACTIVITY.class_uid || value.category_uid !== OCSF_API_ACTIVITY.category_uid) return refused('not-allowed-here', 'class_uid');
  if (typeof value.activity_id !== 'number' || value.type_uid !== OCSF_API_ACTIVITY.class_uid * 100 + value.activity_id) return refused('not-allowed-here', 'type_uid');
  if (readPath(value, 'metadata.version') !== OCSF_VERSION) return refused('unknown-version', 'metadata.version');
  if (readPath(value, 'unmapped.nearAi.recordVersion') !== RECORD_VERSION) return refused('unknown-version', 'unmapped.nearAi.recordVersion');
  const unknownId = idsKnown(value);
  if (unknownId !== undefined) return unknownId;
  // Whole numbers only (D-35): the canonical form refuses a fraction, negative zero, undefined and anything that is not plain data.
  try {
    canonicalize(value);
  } catch {
    return refused('wrong-type', 'canonical');
  }
  if (findSecrets(value).length > 0) return refused('not-allowed-here', 'secret');
  if (carriesCredentialArgument(value)) return refused('not-allowed-here', 'credential-argument');
  return { ok: true, value: value as unknown as DecisionRecord };
}

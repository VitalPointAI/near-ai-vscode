// The gate's decision record (GATE-07, D-20, D-21): one record per decision, shaped after OCSF 1.9.0 (API Activity, class 6003, profile ai_operation) so a
// later audit chain can sign it unchanged. "Shaped after" is deliberate: this file checks only what the shape needs and never claims full OCSF schema
// validity (assumption A1 of the research). Pure: no I/O, no clock (the caller passes epoch milliseconds), no vscode, no package. A record carries names and
// paths, never file contents, prompts or model output.
import { redactSecrets } from '../redaction';
import { canonicalize } from '../team/canonical';
import { findSecrets } from '../team/secrets';
import { POLICY_EVENT_IDS } from './bundle';
import { RECORD_RULE_IDS } from './decide';
import type { ActorRef, GateDecision } from './decide';
import type { Label } from './labels';
import { isRecord, ownValue, refused } from './shape';
import type { Parsed, Refusal } from './shape';
import { CAPABILITY_VERBS } from './vocabulary';
import type { Capability } from './vocabulary';

export const RECORD_VERSION = 1;
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
    readonly policy: { readonly name: string; readonly uid: string; readonly version: string; readonly is_applied: boolean };
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

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = redactValue(value[key]);
    return out;
  }
  return value;
}

/** A copy of the record with `redactSecrets` run over every string, so a token that slipped into a reason or a name never reaches a file. */
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
  const record: DecisionRecord = {
    metadata: {
      version: OCSF_VERSION,
      product: { name: PRODUCT.name, vendor_name: PRODUCT.vendor_name, version: input.productVersion },
      profiles: ['ai_operation'],
      uid: input.recordId,
      sequence: input.sequence,
      ...(input.label === undefined
        ? {}
        : { data_classifications: [{ confidentiality: `${input.label.scale}/${input.label.level}`, confidentiality_id: 99, category_id: 99 }] })
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
    resources: [input.resource.uid === undefined
      ? { name: input.resource.name, type: input.resource.type }
      : { name: input.resource.name, type: input.resource.type, uid: input.resource.uid }],
    authorizations: [{
      decision: allowed ? 'Allowed' : input.outcome === 'asked' ? 'Observed' : 'Denied',
      policy: { name: input.rule, uid: input.bundleHash, version: 'bundle-1', is_applied: true }
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
        ...(input.shadowFloor === undefined ? {} : { shadowFloor: input.shadowFloor })
      }
    }
  };
  return redactRecord(record);
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

/** What `api.operation` may name: a capability verb, or one of the policy's own events. */
const RECORD_OPERATIONS: ReadonlySet<string> = new Set<string>([...CAPABILITY_VERBS, ...POLICY_EVENT_IDS]);
const RECORD_RULES: ReadonlySet<string> = new Set(RECORD_RULE_IDS);

/** Every rule a record carries is one of RECORD_RULE_IDS, and its operation is a verb or a policy event, so no writer can put an id nobody knows on file. */
function idsKnown(value: Record<string, unknown>): Refusal | undefined {
  const authorizations = value.authorizations;
  if (!Array.isArray(authorizations)) return refused('wrong-type', 'authorizations');
  for (const [index, entry] of authorizations.entries()) {
    const rule = readPath(entry, 'policy.name');
    if (typeof rule !== 'string' || !RECORD_RULES.has(rule)) return refused('not-allowed-here', `authorizations[${index}].policy.name`);
  }
  const operation = readPath(value, 'api.operation');
  if (typeof operation !== 'string' || !RECORD_OPERATIONS.has(operation)) return refused('not-allowed-here', 'api.operation');
  return undefined;
}

/**
 * Check a record only for what its shape needs: the class arithmetic (class 6003, category 6, type_uid = 600300 + activity_id), every required key with
 * the right kind, the record version, a known rule and operation, whole numbers only and no secret-like string. Nothing here claims the record is valid
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
  return { ok: true, value: value as unknown as DecisionRecord };
}

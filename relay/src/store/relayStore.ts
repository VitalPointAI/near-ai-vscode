// The relay's storage contract (D-04, D-05). Nothing outside relay/src/store names SQL or a database; every later phase adds methods here and
// never a second access path. Message, run and approval operations are scoped by tenant and never rely on ids being unique across tenants
// or contiguous, so a JSON-file-per-tenant store (the deferred fallback of D-05) can implement the same contract. Methods are async although
// node:sqlite is synchronous, for the same reason. A method that returns after a write has committed it: the caller may acknowledge then and
// not before (D-06).

export type Channel = 'teams' | 'signal';
export const CHANNELS: readonly Channel[] = ['teams', 'signal'];

export type TenantStatus = 'active' | 'suspended';

export interface TenantRecord {
  tenantId: string;
  displayName: string;
  status: TenantStatus;
  createdAt: number;
  updatedAt: number;
}

export interface InboundMessage {
  tenantId: string;
  channel: Channel;
  conversationId: string;
  requesterId: string;
  /** What makes a redelivery of the same message recognisable; unique per tenant. */
  dedupeKey: string;
  /** The message text, opaque to the store. It is kept in the private state directory and never logged (D-11). */
  payload: string;
  receivedAt: number;
}

export type MessageState = 'queued' | 'claimed' | 'done';

export interface QueuedMessage extends InboundMessage {
  messageId: number;
  state: MessageState;
  attempts: number;
  claimedAt: number | null;
}

export const RUN_STATES = ['queued', 'running', 'waiting-approval', 'finished', 'failed', 'cancelled', 'interrupted'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The states /healthz counts as in flight. */
export const IN_FLIGHT_RUN_STATES: readonly RunState[] = ['running', 'waiting-approval'];

export interface RunRecord {
  tenantId: string;
  runId: string;
  messageId: number;
  channel: Channel;
  conversationId: string;
  requesterId: string;
  state: RunState;
  createdAt: number;
  updatedAt: number;
}

export interface AcceptResult {
  /** True when this tenant had already accepted a message with the same dedupe key; nothing was written. */
  duplicate: boolean;
  messageId: number;
  runId: string;
}

export type StoreErrorCode = 'newer-schema' | 'unknown-tenant' | 'binding-conflict' | 'unknown-run' | 'invalid-record';

/** A store failure. The message is a plain sentence and never contains a message payload. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface RelayStore {
  /** The random id this state directory was created with (relay_meta). It identifies the data, not the process. */
  instanceId(): Promise<string>;

  putTenant(record: TenantRecord): Promise<void>;
  getTenant(tenantId: string): Promise<TenantRecord | undefined>;
  listTenants(): Promise<TenantRecord[]>;

  /** Atomic: queue the message and create its run record in one commit, or recognise a duplicate and write nothing. */
  acceptInbound(message: InboundMessage, runId: string): Promise<AcceptResult>;
  getMessage(tenantId: string, dedupeKey: string): Promise<QueuedMessage | undefined>;
  /** Takes the oldest queued message of one conversation: it becomes claimed and its attempts rise by one. */
  claimNext(tenantId: string, channel: Channel, conversationId: string, now: number): Promise<QueuedMessage | undefined>;
  /** Claimed to done. False when the message was not claimed. */
  ackMessage(tenantId: string, messageId: number, now: number): Promise<boolean>;
  /** Messages of this tenant that are not done. */
  queueDepth(tenantId: string): Promise<number>;

  getRun(tenantId: string, runId: string): Promise<RunRecord | undefined>;
  /** Compare and set. False when the run is not in state `from`. */
  transitionRun(tenantId: string, runId: string, from: RunState, to: RunState, now: number): Promise<boolean>;
  /** Runs in any of these states, across all tenants. */
  countRuns(states: readonly RunState[]): Promise<number>;

  close(): Promise<void>;
}

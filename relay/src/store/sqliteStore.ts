import { closeSync, openSync } from 'node:fs';
import { Database } from 'node:sqlite';
import {
  APPROVAL_DECISIONS,
  CHANNELS,
  RUN_STATES,
  StoreError,
  type AcceptResult,
  type ApprovalAnswerOutcome,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalState,
  type Channel,
  type ConversationBinding,
  type InboundMessage,
  type MessageState,
  type NewApproval,
  type QueuedMessage,
  type RelayStore,
  type RunRecord,
  type RunState,
  type TenantRecord,
} from './relayStore';
import { migrate } from './schema';

// The node:sqlite implementation of RelayStore (D-04). The only file that holds SQL.
//
// Commit discipline (D-06, Pitfall 7): every write runs in BEGIN IMMEDIATE ... COMMIT and its method resolves only after COMMIT returned, so
// a caller that acknowledges on resolution never acknowledges something a restart could lose. synchronous = FULL is set on every connection.
// Only parameter binding is used; no SQL text is built from a value.

type Statement = ReturnType<Database['prepare']>;
type Row = Record<string, unknown>;

const MAX_ID_LENGTH = 256;
/** An approval title is one line shown to a person (the tool call it asks about), not a document. */
const MAX_TITLE_LENGTH = 1000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const BUSY_TIMEOUT_MS = 5000;

function invalid(field: string, reason: string): StoreError {
  return new StoreError('invalid-record', `The record was not stored: ${field} ${reason}.`);
}

function checkId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(field, 'must be a non-empty text');
  if (value.length > MAX_ID_LENGTH) throw invalid(field, `must be at most ${MAX_ID_LENGTH} characters`);
  return value;
}

function checkTime(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(field, 'must be a whole number of milliseconds');
  return value;
}

function checkChannel(value: unknown): Channel {
  if (!(CHANNELS as readonly unknown[]).includes(value)) throw invalid('channel', `must be one of ${CHANNELS.join(', ')}`);
  return value as Channel;
}

function checkRunState(field: string, value: unknown): RunState {
  if (!(RUN_STATES as readonly unknown[]).includes(value)) throw invalid(field, 'is not a run state');
  return value as RunState;
}

function checkDecision(value: unknown): ApprovalDecision {
  if (!(APPROVAL_DECISIONS as readonly unknown[]).includes(value)) throw invalid('decision', `must be one of ${APPROVAL_DECISIONS.join(', ')}`);
  return value as ApprovalDecision;
}

function checkApproval(approval: NewApproval): void {
  checkId('tenantId', approval.tenantId);
  checkId('approvalId', approval.approvalId);
  checkId('runId', approval.runId);
  checkId('requesterId', approval.requesterId);
  checkId('callId', approval.callId);
  checkId('tool', approval.tool);
  if (typeof approval.title !== 'string') throw invalid('title', 'must be text');
  if (approval.title.length > MAX_TITLE_LENGTH) throw invalid('title', `must be at most ${MAX_TITLE_LENGTH} characters`);
  checkTime('createdAt', approval.createdAt);
  checkTime('expiresAt', approval.expiresAt);
}

function checkInbound(message: InboundMessage): void {
  checkId('tenantId', message.tenantId);
  checkChannel(message.channel);
  checkId('conversationId', message.conversationId);
  checkId('requesterId', message.requesterId);
  checkId('dedupeKey', message.dedupeKey);
  checkTime('receivedAt', message.receivedAt);
  if (typeof message.payload !== 'string') throw invalid('payload', 'must be text');
  if (Buffer.byteLength(message.payload, 'utf8') > MAX_PAYLOAD_BYTES) throw invalid('payload', 'must be at most 1 MiB');
}

function toMessage(row: Row): QueuedMessage {
  return {
    messageId: Number(row.message_id),
    tenantId: row.tenant_id as string,
    channel: row.channel as Channel,
    conversationId: row.conversation_id as string,
    requesterId: row.requester_id as string,
    dedupeKey: row.dedupe_key as string,
    payload: row.payload as string,
    state: row.state as MessageState,
    attempts: Number(row.attempts),
    receivedAt: Number(row.received_at),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
  };
}

function toRun(row: Row): RunRecord {
  return {
    tenantId: row.tenant_id as string,
    runId: row.run_id as string,
    messageId: Number(row.message_id),
    channel: row.channel as Channel,
    conversationId: row.conversation_id as string,
    requesterId: row.requester_id as string,
    state: row.state as RunState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toBinding(row: Row): ConversationBinding {
  return {
    channel: row.channel as Channel,
    conversationId: row.conversation_id as string,
    tenantId: row.tenant_id as string,
    createdAt: Number(row.created_at),
  };
}

function toApproval(row: Row): ApprovalRecord {
  return {
    tenantId: row.tenant_id as string,
    approvalId: row.approval_id as string,
    runId: row.run_id as string,
    requesterId: row.requester_id as string,
    callId: row.call_id as string,
    tool: row.tool as string,
    title: row.title as string,
    state: row.state as ApprovalState,
    decision: row.decision === null ? null : (row.decision as ApprovalDecision),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    answeredAt: row.answered_at === null ? null : Number(row.answered_at),
  };
}

function toTenant(row: Row): TenantRecord {
  return {
    tenantId: row.tenant_id as string,
    displayName: row.display_name as string,
    status: row.status as TenantRecord['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Creates the file 0600 first so SQLite's -wal and -shm files inherit 0600 whatever the umask (Pitfall 6). */
function precreatePrivate(file: string): void {
  closeSync(openSync(file, 'a', 0o600));
}

export async function openSqliteStore(file: string, options: { now?: () => number } = {}): Promise<SqliteStore> {
  precreatePrivate(file);
  const db = new Database(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== 'wal') throw new Error('The database could not be put in write-ahead mode.');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, options.now ?? Date.now);
    return new SqliteStore(db, options.now ?? Date.now);
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

export class SqliteStore implements RelayStore {
  private readonly stmt: Record<string, Statement>;
  private closed = false;

  constructor(
    private readonly db: Database,
    now: () => number = Date.now,
  ) {
    // Recovery from a previous process that stopped without finishing its work (a crash, kill -9 or power loss), in one commit:
    //  - a message that was claimed was never finished: it goes back to the queue (attempts are kept);
    //  - a run that was running or waiting for an approval was cut off: it becomes interrupted, so /healthz no longer counts it in flight;
    //  - a pending approval of such a run can no longer resume it: it expires.
    // claimNext puts an interrupted run back to queued when it hands out the run's message again, so the redelivery starts like a new run.
    const recoveredAt = checkTime('now', now());
    this.transaction(() => {
      db.exec(`UPDATE messages SET state = 'queued', claimed_at = NULL WHERE state = 'claimed'`);
      db.prepare(`UPDATE runs SET state = 'interrupted', updated_at = ? WHERE state IN ('running', 'waiting-approval')`).run(recoveredAt);
      db.exec(
        `UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND EXISTS (
           SELECT 1 FROM runs r WHERE r.tenant_id = approvals.tenant_id AND r.run_id = approvals.run_id AND r.state = 'interrupted')`,
      );
    });
    this.stmt = {
      instanceId: db.prepare(`SELECT value FROM relay_meta WHERE key = 'instance_id'`),
      putTenant: db.prepare(
        `INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status, updated_at = excluded.updated_at`,
      ),
      getTenant: db.prepare('SELECT * FROM tenants WHERE tenant_id = ?'),
      listTenants: db.prepare('SELECT * FROM tenants ORDER BY tenant_id'),
      getBinding: db.prepare('SELECT * FROM conversation_bindings WHERE channel = ? AND conversation_id = ?'),
      insertBinding: db.prepare('INSERT INTO conversation_bindings (channel, conversation_id, tenant_id, created_at) VALUES (?, ?, ?, ?)'),
      messageByDedupe: db.prepare('SELECT * FROM messages WHERE tenant_id = ? AND dedupe_key = ?'),
      runIdForMessage: db.prepare('SELECT run_id FROM runs WHERE tenant_id = ? AND message_id = ?'),
      insertMessage: db.prepare(
        `INSERT INTO messages (tenant_id, channel, conversation_id, requester_id, dedupe_key, payload, state, attempts, received_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      ),
      insertRun: db.prepare(
        `INSERT INTO runs (tenant_id, run_id, message_id, channel, conversation_id, requester_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ),
      // A conversation is worked on one message at a time: while one of its messages is claimed, nothing else of it is handed out.
      oldestQueued: db.prepare(
        `SELECT * FROM messages m WHERE m.tenant_id = ? AND m.channel = ? AND m.conversation_id = ? AND m.state = 'queued'
           AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.tenant_id = m.tenant_id AND c.channel = m.channel
                             AND c.conversation_id = m.conversation_id AND c.state = 'claimed')
         ORDER BY m.message_id LIMIT 1`,
      ),
      claim: db.prepare(`UPDATE messages SET state = 'claimed', attempts = attempts + 1, claimed_at = ? WHERE tenant_id = ? AND message_id = ?`),
      requeueInterruptedRun: db.prepare(
        `UPDATE runs SET state = 'queued', updated_at = ? WHERE tenant_id = ? AND message_id = ? AND state = 'interrupted'`,
      ),
      messageById: db.prepare('SELECT * FROM messages WHERE tenant_id = ? AND message_id = ?'),
      ack: db.prepare(`UPDATE messages SET state = 'done', done_at = ? WHERE tenant_id = ? AND message_id = ? AND state = 'claimed'`),
      queueDepth: db.prepare(`SELECT count(*) AS depth FROM messages WHERE tenant_id = ? AND state != 'done'`),
      getRun: db.prepare('SELECT * FROM runs WHERE tenant_id = ? AND run_id = ?'),
      transitionRun: db.prepare('UPDATE runs SET state = ?, updated_at = ? WHERE tenant_id = ? AND run_id = ? AND state = ?'),
      insertApproval: db.prepare(
        `INSERT INTO approvals (tenant_id, approval_id, run_id, requester_id, call_id, tool, title, state, decision, created_at, expires_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      ),
      getApproval: db.prepare('SELECT * FROM approvals WHERE tenant_id = ? AND approval_id = ?'),
      answerApproval: db.prepare(
        `UPDATE approvals SET state = 'answered', decision = ?, answered_at = ?
         WHERE tenant_id = ? AND approval_id = ? AND requester_id = ? AND state = 'pending' AND expires_at > ?
           AND EXISTS (SELECT 1 FROM runs r WHERE r.tenant_id = approvals.tenant_id AND r.run_id = approvals.run_id AND r.state = 'waiting-approval')`,
      ),
      expireApprovals: db.prepare(`UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?`),
      pendingForTenant: db.prepare(
        `SELECT * FROM approvals WHERE tenant_id = ? AND state = 'pending' ORDER BY created_at, approval_id`,
      ),
      pendingForRequester: db.prepare(
        `SELECT * FROM approvals WHERE tenant_id = ? AND state = 'pending' AND requester_id = ? ORDER BY created_at, approval_id`,
      ),
      runCounts: db.prepare('SELECT state, count(*) AS total FROM runs GROUP BY state'),
    };
  }

  private statement(name: string): Statement {
    const found = this.stmt[name];
    if (!found) throw new Error(`no statement ${name}`);
    return found;
  }

  /** Runs body inside BEGIN IMMEDIATE and COMMIT. The caller resolves only after this returned, which is after COMMIT. */
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async instanceId(): Promise<string> {
    const row = this.statement('instanceId').get() as Row | undefined;
    if (!row || typeof row.value !== 'string') throw new Error('The state has no instance id.');
    return row.value;
  }

  async putTenant(record: TenantRecord): Promise<void> {
    checkId('tenantId', record.tenantId);
    checkId('displayName', record.displayName);
    if (record.status !== 'active' && record.status !== 'suspended') throw invalid('status', 'must be active or suspended');
    checkTime('createdAt', record.createdAt);
    checkTime('updatedAt', record.updatedAt);
    this.transaction(() => {
      this.statement('putTenant').run(record.tenantId, record.displayName, record.status, record.createdAt, record.updatedAt);
    });
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    checkId('tenantId', tenantId);
    const row = this.statement('getTenant').get(tenantId) as Row | undefined;
    return row ? toTenant(row) : undefined;
  }

  async listTenants(): Promise<TenantRecord[]> {
    return (this.statement('listTenants').all() as Row[]).map(toTenant);
  }

  async bindConversation(binding: ConversationBinding): Promise<'created' | 'existing'> {
    checkChannel(binding.channel);
    checkId('conversationId', binding.conversationId);
    checkId('tenantId', binding.tenantId);
    checkTime('createdAt', binding.createdAt);
    return this.transaction((): 'created' | 'existing' => {
      const held = this.statement('getBinding').get(binding.channel, binding.conversationId) as Row | undefined;
      if (held) {
        if (held.tenant_id === binding.tenantId) return 'existing';
        throw new StoreError('binding-conflict', 'The conversation is already bound to another tenant and was not moved.');
      }
      if (!this.statement('getTenant').get(binding.tenantId)) {
        throw new StoreError('unknown-tenant', 'The conversation was not bound: its tenant is not registered.');
      }
      this.statement('insertBinding').run(binding.channel, binding.conversationId, binding.tenantId, binding.createdAt);
      return 'created';
    });
  }

  async getBinding(channel: Channel, conversationId: string): Promise<ConversationBinding | undefined> {
    checkChannel(channel);
    checkId('conversationId', conversationId);
    const row = this.statement('getBinding').get(channel, conversationId) as Row | undefined;
    return row ? toBinding(row) : undefined;
  }

  /**
   * The checks every queue operation makes inside its transaction: the tenant is registered and active, and the conversation is not bound to
   * another tenant. Returns whether the conversation is bound yet. `what` names the operation in the error sentence.
   */
  private checkConversation(tenantId: string, channel: Channel, conversationId: string, what: string): boolean {
    const tenantRow = this.statement('getTenant').get(tenantId) as Row | undefined;
    if (!tenantRow) throw new StoreError('unknown-tenant', `${what}: its tenant is not registered.`);
    if (tenantRow.status !== 'active') throw new StoreError('tenant-suspended', `${what}: its tenant is suspended.`);
    const binding = this.statement('getBinding').get(channel, conversationId) as Row | undefined;
    if (binding && binding.tenant_id !== tenantId) {
      throw new StoreError('binding-conflict', `${what}: the conversation belongs to another tenant.`);
    }
    return binding !== undefined;
  }

  async acceptInbound(message: InboundMessage, runId: string): Promise<AcceptResult> {
    checkInbound(message);
    checkId('runId', runId);
    return this.transaction((): AcceptResult => {
      const bound = this.checkConversation(message.tenantId, message.channel, message.conversationId, 'The message was not stored');
      const existing = this.statement('messageByDedupe').get(message.tenantId, message.dedupeKey) as Row | undefined;
      if (existing) {
        const messageId = Number(existing.message_id);
        const run = this.statement('runIdForMessage').get(message.tenantId, messageId) as Row | undefined;
        return { duplicate: true, messageId, runId: run ? (run.run_id as string) : runId };
      }
      if (this.statement('getRun').get(message.tenantId, runId)) throw invalid('runId', 'is already used by another run of this tenant');
      if (!bound) this.statement('insertBinding').run(message.channel, message.conversationId, message.tenantId, message.receivedAt);
      const inserted = this.statement('insertMessage').run(
        message.tenantId,
        message.channel,
        message.conversationId,
        message.requesterId,
        message.dedupeKey,
        message.payload,
        message.receivedAt,
      );
      const messageId = Number(inserted.lastInsertRowid);
      this.statement('insertRun').run(
        message.tenantId,
        runId,
        messageId,
        message.channel,
        message.conversationId,
        message.requesterId,
        message.receivedAt,
        message.receivedAt,
      );
      return { duplicate: false, messageId, runId };
    });
  }

  async getMessage(tenantId: string, dedupeKey: string): Promise<QueuedMessage | undefined> {
    checkId('tenantId', tenantId);
    checkId('dedupeKey', dedupeKey);
    const row = this.statement('messageByDedupe').get(tenantId, dedupeKey) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  async claimNext(tenantId: string, channel: Channel, conversationId: string, now: number): Promise<QueuedMessage | undefined> {
    checkId('tenantId', tenantId);
    checkChannel(channel);
    checkId('conversationId', conversationId);
    checkTime('now', now);
    return this.transaction(() => {
      this.checkConversation(tenantId, channel, conversationId, 'No message was claimed');
      const next = this.statement('oldestQueued').get(tenantId, channel, conversationId) as Row | undefined;
      if (!next) return undefined;
      const messageId = Number(next.message_id);
      this.statement('claim').run(now, tenantId, messageId);
      this.statement('requeueInterruptedRun').run(now, tenantId, messageId);
      return toMessage(this.statement('messageById').get(tenantId, messageId) as Row);
    });
  }

  async ackMessage(tenantId: string, messageId: number, now: number): Promise<boolean> {
    checkId('tenantId', tenantId);
    checkTime('messageId', messageId);
    checkTime('now', now);
    return this.transaction(() => Number(this.statement('ack').run(now, tenantId, messageId).changes) === 1);
  }

  async queueDepth(tenantId: string): Promise<number> {
    checkId('tenantId', tenantId);
    const row = this.statement('queueDepth').get(tenantId) as Row;
    return Number(row.depth);
  }

  async getRun(tenantId: string, runId: string): Promise<RunRecord | undefined> {
    checkId('tenantId', tenantId);
    checkId('runId', runId);
    const row = this.statement('getRun').get(tenantId, runId) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  async transitionRun(tenantId: string, runId: string, from: RunState, to: RunState, now: number): Promise<boolean> {
    checkId('tenantId', tenantId);
    checkId('runId', runId);
    checkRunState('from', from);
    checkRunState('to', to);
    checkTime('now', now);
    return this.transaction(() => Number(this.statement('transitionRun').run(to, now, tenantId, runId, from).changes) === 1);
  }

  async countRuns(states: readonly RunState[]): Promise<number> {
    for (const state of states) checkRunState('states', state);
    const wanted = new Set<RunState>(states);
    let total = 0;
    for (const row of this.statement('runCounts').all() as Row[]) {
      if (wanted.has(row.state as RunState)) total += Number(row.total);
    }
    return total;
  }

  async addApproval(approval: NewApproval): Promise<void> {
    checkApproval(approval);
    this.transaction(() => {
      const run = this.statement('getRun').get(approval.tenantId, approval.runId) as Row | undefined;
      if (!run) {
        throw new StoreError('unknown-run', 'The approval was not stored: that run does not exist for this tenant.');
      }
      // Only the person who asked for the run may be offered its approvals, and answerApproval checks the answer against this requester.
      if (run.requester_id !== approval.requesterId) throw invalid('requesterId', "must be the run's requester");
      if (this.statement('getApproval').get(approval.tenantId, approval.approvalId)) {
        throw invalid('approvalId', 'is already used by another approval of this tenant');
      }
      this.statement('insertApproval').run(
        approval.tenantId,
        approval.approvalId,
        approval.runId,
        approval.requesterId,
        approval.callId,
        approval.tool,
        approval.title,
        approval.createdAt,
        approval.expiresAt,
      );
    });
  }

  async getApproval(tenantId: string, approvalId: string): Promise<ApprovalRecord | undefined> {
    checkId('tenantId', tenantId);
    checkId('approvalId', approvalId);
    const row = this.statement('getApproval').get(tenantId, approvalId) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  async answerApproval(
    tenantId: string,
    approvalId: string,
    requesterId: string,
    decision: ApprovalDecision,
    now: number,
  ): Promise<ApprovalAnswerOutcome> {
    checkId('tenantId', tenantId);
    checkId('approvalId', approvalId);
    checkId('requesterId', requesterId);
    checkDecision(decision);
    checkTime('now', now);
    return this.transaction((): ApprovalAnswerOutcome => {
      const row = this.statement('getApproval').get(tenantId, approvalId) as Row | undefined;
      if (!row) return 'unknown-approval';
      if (row.requester_id !== requesterId) return 'wrong-requester';
      if (row.state === 'answered') return 'already-answered';
      if (row.state === 'expired' || Number(row.expires_at) <= now) return 'expired';
      const run = this.statement('getRun').get(tenantId, row.run_id as string) as Row | undefined;
      if (!run || run.state !== 'waiting-approval') return 'run-not-waiting';
      // The UPDATE repeats every condition, so the write is a compare and set whatever the reads above saw.
      const changes = Number(this.statement('answerApproval').run(decision, now, tenantId, approvalId, requesterId, now).changes);
      return changes === 1 ? 'answered' : 'already-answered';
    });
  }

  async expireApprovals(now: number): Promise<number> {
    checkTime('now', now);
    return this.transaction(() => Number(this.statement('expireApprovals').run(now).changes));
  }

  async listPendingApprovals(tenantId: string, requesterId?: string): Promise<ApprovalRecord[]> {
    checkId('tenantId', tenantId);
    const rows =
      requesterId === undefined
        ? (this.statement('pendingForTenant').all(tenantId) as Row[])
        : (this.statement('pendingForRequester').all(tenantId, checkId('requesterId', requesterId)) as Row[]);
    return rows.map(toApproval);
  }

  /**
   * The durability settings of this store's own connection, read back from SQLite (synchronous is per connection, so a second connection
   * could not show it). Not part of RelayStore: only the node:sqlite store has these. synchronous 2 is FULL.
   */
  durability(): { journalMode: string; synchronous: number; foreignKeys: number } {
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const synchronous = this.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    return { journalMode: journal.journal_mode, synchronous: Number(synchronous.synchronous), foreignKeys: Number(foreignKeys.foreign_keys) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.db.isOpen) this.db.close();
  }
}

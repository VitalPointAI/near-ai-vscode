import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IN_FLIGHT_RUN_STATES,
  StoreError,
  type ApprovalDecision,
  type InboundMessage,
  type NewApproval,
  type RelayStore,
  type RunState,
  type TenantRecord,
} from '../../src/store/relayStore';

// Phase 68, plan 05 (RELAY-03, D-05): the storage contract as a suite. relayStoreContract(name, factory) registers every case against whatever
// store the factory makes, so a second implementation (the deferred JSON-file-per-tenant store) is proven by passing the same file with its own
// factory and not by editing a case. The suite works only through the RelayStore interface and the handle below: it names no database driver and
// no implementation module, and it never reads storage behind the store's back. Case names start with `{name}: ` so two implementations' results
// read side by side.

export interface StoreHandle {
  /** The store under test. `reopen` replaces it, so read this property again after a reopen. */
  store: RelayStore;
  /** Closes the current store and opens a new one over the same data, as a restart would. */
  reopen(): Promise<RelayStore>;
  /** Closes everything and removes the data. Called once, in `finally`. */
  dispose(): Promise<void>;
}

export interface StoreFactory {
  create(): Promise<StoreHandle>;
}

const T0 = 1_700_000_000_000;

export function tenant(tenantId: string, overrides: Partial<TenantRecord> = {}): TenantRecord {
  return { tenantId, displayName: `Tenant ${tenantId}`, status: 'active', createdAt: T0, updatedAt: T0, ...overrides };
}

export function inbound(tenantId: string, dedupeKey: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    tenantId,
    channel: 'teams',
    conversationId: 'c1',
    requesterId: 'person-1',
    dedupeKey,
    payload: `body of ${dedupeKey}`,
    receivedAt: T0,
    ...overrides,
  };
}

function approval(tenantId: string, approvalId: string, runId: string, overrides: Partial<NewApproval> = {}): NewApproval {
  return {
    tenantId,
    approvalId,
    runId,
    requesterId: 'person-1',
    callId: `call-${approvalId}`,
    tool: 'run_command',
    title: 'Run npm test',
    createdAt: T0 + 10,
    expiresAt: T0 + 1000,
    ...overrides,
  };
}

async function expectStoreError(action: Promise<unknown>, code: StoreError['code']): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof StoreError, `expected a StoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

export function relayStoreContract(name: string, factory: StoreFactory): void {
  async function withStore(body: (handle: StoreHandle) => Promise<void>): Promise<void> {
    const handle = await factory.create();
    try {
      await body(handle);
    } finally {
      await handle.dispose();
    }
  }

  test(`${name}: a tenant round-trips through putTenant and getTenant and survives a reopen`, () =>
    withStore(async (handle) => {
      assert.equal(await handle.store.getTenant('acme'), undefined);
      await handle.store.putTenant(tenant('acme'));
      assert.deepEqual(await handle.store.getTenant('acme'), tenant('acme'));
      await handle.reopen();
      assert.deepEqual(await handle.store.getTenant('acme'), tenant('acme'));
    }));

  test(`${name}: a second putTenant keeps createdAt and updates displayName, status and updatedAt`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('acme', { displayName: 'Acme Renamed', status: 'suspended', createdAt: T0 + 5, updatedAt: T0 + 10 }));
      assert.deepEqual(await handle.store.getTenant('acme'), tenant('acme', { displayName: 'Acme Renamed', status: 'suspended', createdAt: T0, updatedAt: T0 + 10 }));
      assert.equal((await handle.store.listTenants()).length, 1);
    }));

  test(`${name}: listTenants is ordered by tenantId`, () =>
    withStore(async (handle) => {
      for (const id of ['charlie', 'alpha', 'bravo']) await handle.store.putTenant(tenant(id));
      assert.deepEqual((await handle.store.listTenants()).map((record) => record.tenantId), ['alpha', 'bravo', 'charlie']);
    }));

  test(`${name}: an empty tenantId is an invalid-record error and nothing is stored`, () =>
    withStore(async (handle) => {
      await expectStoreError(handle.store.putTenant(tenant('')), 'invalid-record');
      assert.deepEqual(await handle.store.listTenants(), []);
    }));

  test(`${name}: bindConversation returns created and then existing for the same tenant`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const binding = { channel: 'teams' as const, conversationId: 'chat-1', tenantId: 'acme', createdAt: T0 + 1 };
      assert.equal(await handle.store.bindConversation(binding), 'created');
      assert.equal(await handle.store.bindConversation({ ...binding, createdAt: T0 + 99 }), 'existing');
      assert.deepEqual(await handle.store.getBinding('teams', 'chat-1'), binding);
    }));

  test(`${name}: a conversation bound to one tenant is never rebound to another (binding-conflict)`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      const first = { channel: 'signal' as const, conversationId: 'thread-9', tenantId: 'acme', createdAt: T0 + 1 };
      await handle.store.bindConversation(first);
      await expectStoreError(handle.store.bindConversation({ ...first, tenantId: 'globex', createdAt: T0 + 2 }), 'binding-conflict');
      assert.deepEqual(await handle.store.getBinding('signal', 'thread-9'), first);
      await handle.reopen();
      assert.deepEqual(await handle.store.getBinding('signal', 'thread-9'), first);
    }));

  test(`${name}: the same conversation id on two channels is two bindings`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      await handle.store.bindConversation({ channel: 'teams', conversationId: 'same', tenantId: 'acme', createdAt: T0 });
      await handle.store.bindConversation({ channel: 'signal', conversationId: 'same', tenantId: 'globex', createdAt: T0 });
      assert.equal((await handle.store.getBinding('teams', 'same'))?.tenantId, 'acme');
      assert.equal((await handle.store.getBinding('signal', 'same'))?.tenantId, 'globex');
    }));

  test(`${name}: binding to an unregistered tenant is unknown-tenant and a missing binding is undefined`, () =>
    withStore(async (handle) => {
      await expectStoreError(handle.store.bindConversation({ channel: 'teams', conversationId: 'chat-1', tenantId: 'nobody', createdAt: T0 }), 'unknown-tenant');
      assert.equal(await handle.store.getBinding('teams', 'chat-1'), undefined);
    }));

  test(`${name}: tenants and bindings are unchanged after reopen`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex', { status: 'suspended' }));
      await handle.store.bindConversation({ channel: 'teams', conversationId: 'chat-1', tenantId: 'acme', createdAt: T0 + 1 });
      await handle.store.bindConversation({ channel: 'teams', conversationId: 'chat-2', tenantId: 'globex', createdAt: T0 + 2 });
      const before = await handle.store.listTenants();
      await handle.reopen();
      assert.deepEqual(await handle.store.listTenants(), before);
      assert.equal((await handle.store.getBinding('teams', 'chat-1'))?.tenantId, 'acme');
      assert.equal((await handle.store.getBinding('teams', 'chat-2'))?.tenantId, 'globex');
    }));

  // Queue

  test(`${name}: a second acceptInbound with the same tenant and dedupe key is a duplicate and writes nothing`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const first = await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      assert.equal(first.duplicate, false);
      assert.equal(first.runId, 'run-1');
      const second = await handle.store.acceptInbound(inbound('acme', 'k1', { payload: 'a redelivery' }), 'run-2');
      assert.deepEqual(second, { duplicate: true, messageId: first.messageId, runId: 'run-1' });
      assert.equal(await handle.store.queueDepth('acme'), 1);
      assert.equal((await handle.store.getMessage('acme', 'k1'))?.payload, 'body of k1');
      assert.equal(await handle.store.getRun('acme', 'run-2'), undefined);
    }));

  test(`${name}: the same dedupe key under another tenant is a new message`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      const a = await handle.store.acceptInbound(inbound('acme', 'k1', { payload: 'for acme' }), 'run-a');
      const g = await handle.store.acceptInbound(inbound('globex', 'k1', { payload: 'for globex' }), 'run-g');
      assert.equal(a.duplicate, false);
      assert.equal(g.duplicate, false);
      assert.equal((await handle.store.getMessage('acme', 'k1'))?.payload, 'for acme');
      assert.equal((await handle.store.getMessage('globex', 'k1'))?.payload, 'for globex');
      assert.equal(await handle.store.queueDepth('acme'), 1);
      assert.equal(await handle.store.queueDepth('globex'), 1);
    }));

  test(`${name}: acceptInbound for an unknown tenant is unknown-tenant and writes nothing`, () =>
    withStore(async (handle) => {
      await expectStoreError(handle.store.acceptInbound(inbound('nobody', 'k1'), 'run-1'), 'unknown-tenant');
      assert.equal(await handle.store.getMessage('nobody', 'k1'), undefined);
      assert.equal(await handle.store.getRun('nobody', 'run-1'), undefined);
      assert.equal(await handle.store.queueDepth('nobody'), 0);
    }));

  test(`${name}: claimNext takes one conversation's messages in the order received and never another conversation's`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.acceptInbound(inbound('acme', 'k1', { receivedAt: T0 + 1 }), 'run-1');
      await handle.store.acceptInbound(inbound('acme', 'k2', { receivedAt: T0 + 2 }), 'run-2');
      await handle.store.acceptInbound(inbound('acme', 'other', { conversationId: 'c2', receivedAt: T0 + 3 }), 'run-3');
      await handle.store.acceptInbound(inbound('acme', 'k3', { receivedAt: T0 + 4 }), 'run-4');
      const order: string[] = [];
      for (;;) {
        const next = await handle.store.claimNext('acme', 'teams', 'c1', T0 + 100);
        if (!next) break;
        assert.equal(next.state, 'claimed');
        assert.equal(next.attempts, 1);
        assert.equal(next.conversationId, 'c1');
        order.push(next.dedupeKey);
      }
      assert.deepEqual(order, ['k1', 'k2', 'k3']);
      const other = await handle.store.claimNext('acme', 'teams', 'c2', T0 + 100);
      assert.equal(other?.dedupeKey, 'other');
    }));

  test(`${name}: claimNext with nothing queued is undefined, also for another tenant or channel`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      assert.equal(await handle.store.claimNext('acme', 'teams', 'c1', T0), undefined);
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      assert.equal(await handle.store.claimNext('globex', 'teams', 'c1', T0), undefined);
      assert.equal(await handle.store.claimNext('acme', 'signal', 'c1', T0), undefined);
      assert.equal((await handle.store.claimNext('acme', 'teams', 'c1', T0))?.dedupeKey, 'k1');
    }));

  test(`${name}: ackMessage moves a claimed message to done and lowers queueDepth, and refuses another tenant`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      assert.equal(await handle.store.queueDepth('acme'), 1);
      const claimed = await handle.store.claimNext('acme', 'teams', 'c1', T0 + 5);
      assert.ok(claimed);
      assert.equal(await handle.store.ackMessage('globex', claimed.messageId, T0 + 6), false);
      assert.equal((await handle.store.getMessage('acme', 'k1'))?.state, 'claimed');
      assert.equal(await handle.store.ackMessage('acme', claimed.messageId, T0 + 6), true);
      assert.equal((await handle.store.getMessage('acme', 'k1'))?.state, 'done');
      assert.equal(await handle.store.queueDepth('acme'), 0);
      assert.equal(await handle.store.ackMessage('acme', claimed.messageId, T0 + 7), false);
      assert.equal(await handle.store.claimNext('acme', 'teams', 'c1', T0 + 8), undefined);
    }));

  test(`${name}: a message that is queued and not yet claimed cannot be acknowledged`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const accepted = await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      assert.equal(await handle.store.ackMessage('acme', accepted.messageId, T0 + 1), false);
      assert.equal(await handle.store.queueDepth('acme'), 1);
    }));

  test(`${name}: a claimed, unacknowledged message is delivered again after a reopen with attempts 2`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      const first = await handle.store.claimNext('acme', 'teams', 'c1', T0 + 5);
      assert.equal(first?.attempts, 1);
      await handle.reopen();
      assert.equal(await handle.store.queueDepth('acme'), 1);
      const again = await handle.store.claimNext('acme', 'teams', 'c1', T0 + 9);
      assert.equal(again?.dedupeKey, 'k1');
      assert.equal(again?.attempts, 2);
    }));

  test(`${name}: queued messages and their payloads survive a reopen exactly, multi-byte characters included`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const payload = 'Gr\u00fc\u00dfe \u2014 \u65e5\u672c\u8a9e \ud83d\ude80 "quoted" \\ end';
      await handle.store.acceptInbound(inbound('acme', 'k1', { payload }), 'run-1');
      await handle.reopen();
      const stored = await handle.store.getMessage('acme', 'k1');
      assert.equal(stored?.payload, payload);
      assert.equal(stored?.state, 'queued');
    }));

  test(`${name}: a payload of exactly 1 MiB in UTF-8 bytes is accepted and one byte more is invalid-record`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const mebibyte = 1024 * 1024;
      const exactAscii = 'a'.repeat(mebibyte);
      const exactWide = '\u00e9'.repeat(mebibyte / 2); // two bytes each
      assert.equal((await handle.store.acceptInbound(inbound('acme', 'ascii', { payload: exactAscii }), 'run-1')).duplicate, false);
      assert.equal((await handle.store.acceptInbound(inbound('acme', 'wide', { payload: exactWide }), 'run-2')).duplicate, false);
      assert.equal((await handle.store.getMessage('acme', 'wide'))?.payload, exactWide);
      await expectStoreError(handle.store.acceptInbound(inbound('acme', 'big1', { payload: `${exactAscii}a` }), 'run-3'), 'invalid-record');
      await expectStoreError(handle.store.acceptInbound(inbound('acme', 'big2', { payload: `${exactWide}a` }), 'run-4'), 'invalid-record');
      assert.equal(await handle.store.getMessage('acme', 'big1'), undefined);
      assert.equal(await handle.store.queueDepth('acme'), 2);
    }));

  // Atomicity

  test(`${name}: when the run cannot be written no message remains for that dedupe key`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      await assert.rejects(handle.store.acceptInbound(inbound('acme', 'k2'), 'run-1'));
      assert.equal(await handle.store.getMessage('acme', 'k2'), undefined);
      assert.equal(await handle.store.queueDepth('acme'), 1);
      await handle.reopen();
      assert.equal(await handle.store.getMessage('acme', 'k2'), undefined);
      assert.equal(await handle.store.queueDepth('acme'), 1);
    }));

  // Runs

  test(`${name}: acceptInbound creates a run in state queued that belongs to its message`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      const accepted = await handle.store.acceptInbound(inbound('acme', 'k1', { conversationId: 'c7', requesterId: 'person-7', receivedAt: T0 + 3 }), 'run-1');
      const run = await handle.store.getRun('acme', 'run-1');
      assert.ok(run);
      assert.equal(run.state, 'queued');
      assert.equal(run.messageId, accepted.messageId);
      assert.equal(run.conversationId, 'c7');
      assert.equal(run.requesterId, 'person-7');
      assert.equal(run.createdAt, T0 + 3);
      await handle.reopen();
      assert.equal((await handle.store.getRun('acme', 'run-1'))?.state, 'queued');
    }));

  test(`${name}: transitionRun is a compare and set: a wrong from leaves the state, another tenant sees nothing`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      assert.equal(await handle.store.transitionRun('acme', 'run-1', 'running', 'finished', T0 + 1), false);
      assert.equal((await handle.store.getRun('acme', 'run-1'))?.state, 'queued');
      assert.equal(await handle.store.transitionRun('globex', 'run-1', 'queued', 'running', T0 + 2), false);
      assert.equal(await handle.store.getRun('globex', 'run-1'), undefined);
      assert.equal((await handle.store.getRun('acme', 'run-1'))?.state, 'queued');
      assert.equal(await handle.store.transitionRun('acme', 'run-1', 'queued', 'running', T0 + 3), true);
      const run = await handle.store.getRun('acme', 'run-1');
      assert.equal(run?.state, 'running');
      assert.equal(run?.updatedAt, T0 + 3);
      await handle.reopen();
      assert.equal((await handle.store.getRun('acme', 'run-1'))?.state, 'running');
    }));

  test(`${name}: countRuns of the in-flight states counts running and waiting-approval only, across tenants`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.putTenant(tenant('globex'));
      const plan: Array<[string, string, RunState]> = [
        ['acme', 'r-queued', 'queued'],
        ['acme', 'r-running', 'running'],
        ['acme', 'r-waiting', 'waiting-approval'],
        ['globex', 'r-finished', 'finished'],
        ['globex', 'r-running', 'running'],
      ];
      for (const [tenantId, runId, target] of plan) {
        await handle.store.acceptInbound(inbound(tenantId, `key-${runId}`), runId);
        if (target !== 'queued') assert.equal(await handle.store.transitionRun(tenantId, runId, 'queued', target, T0 + 1), true);
      }
      assert.equal(await handle.store.countRuns(IN_FLIGHT_RUN_STATES), 3);
      assert.equal(await handle.store.countRuns(['queued']), 1);
      assert.equal(await handle.store.countRuns([]), 0);
      await handle.reopen();
      assert.equal(await handle.store.countRuns(IN_FLIGHT_RUN_STATES), 3);
    }));

  test(`${name}: an unknown run state is invalid-record`, () =>
    withStore(async (handle) => {
      await handle.store.putTenant(tenant('acme'));
      await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
      await expectStoreError(handle.store.transitionRun('acme', 'run-1', 'queued', 'sleeping' as RunState, T0 + 1), 'invalid-record');
      await expectStoreError(handle.store.transitionRun('acme', 'run-1', 'dreaming' as RunState, 'running', T0 + 1), 'invalid-record');
      await expectStoreError(handle.store.countRuns(['nonsense' as RunState]), 'invalid-record');
      assert.equal((await handle.store.getRun('acme', 'run-1'))?.state, 'queued');
    }));

  // Approvals

  async function withRun(handle: StoreHandle): Promise<void> {
    await handle.store.putTenant(tenant('acme'));
    await handle.store.putTenant(tenant('globex'));
    await handle.store.acceptInbound(inbound('acme', 'k1'), 'run-1');
  }

  test(`${name}: addApproval for an existing run stores a pending approval that survives a reopen`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'ap-1', 'run-1'));
      const expected = { ...approval('acme', 'ap-1', 'run-1'), state: 'pending', decision: null, answeredAt: null };
      assert.deepEqual(await handle.store.getApproval('acme', 'ap-1'), expected);
      await handle.reopen();
      assert.deepEqual(await handle.store.getApproval('acme', 'ap-1'), expected);
    }));

  test(`${name}: addApproval for a run of another tenant or an unknown run is unknown-run and stores nothing`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await expectStoreError(handle.store.addApproval(approval('globex', 'ap-1', 'run-1')), 'unknown-run');
      await expectStoreError(handle.store.addApproval(approval('acme', 'ap-2', 'run-missing')), 'unknown-run');
      assert.equal(await handle.store.getApproval('globex', 'ap-1'), undefined);
      assert.equal(await handle.store.getApproval('acme', 'ap-2'), undefined);
      assert.deepEqual(await handle.store.listPendingApprovals('globex'), []);
    }));

  test(`${name}: answerApproval returns true once and false on a second answer, and keeps the first decision`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'ap-1', 'run-1'));
      assert.equal(await handle.store.answerApproval('acme', 'ap-1', 'allow-run', T0 + 20), true);
      assert.equal(await handle.store.answerApproval('acme', 'ap-1', 'deny', T0 + 21), false);
      const answered = await handle.store.getApproval('acme', 'ap-1');
      assert.equal(answered?.state, 'answered');
      assert.equal(answered?.decision, 'allow-run');
      assert.equal(answered?.answeredAt, T0 + 20);
      assert.deepEqual(await handle.store.listPendingApprovals('acme'), []);
      await handle.reopen();
      assert.equal((await handle.store.getApproval('acme', 'ap-1'))?.decision, 'allow-run');
    }));

  test(`${name}: every one of the four decisions can be recorded`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      const decisions: ApprovalDecision[] = ['allow', 'allow-run', 'allow-always', 'deny'];
      for (const decision of decisions) {
        await handle.store.addApproval(approval('acme', `ap-${decision}`, 'run-1'));
        assert.equal(await handle.store.answerApproval('acme', `ap-${decision}`, decision, T0 + 20), true);
        assert.equal((await handle.store.getApproval('acme', `ap-${decision}`))?.decision, decision);
      }
    }));

  test(`${name}: a decision outside the four values is invalid-record and the approval stays pending`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'ap-1', 'run-1'));
      await expectStoreError(handle.store.answerApproval('acme', 'ap-1', 'pending' as ApprovalDecision, T0 + 20), 'invalid-record');
      await expectStoreError(handle.store.answerApproval('acme', 'ap-1', 'maybe' as ApprovalDecision, T0 + 20), 'invalid-record');
      assert.equal((await handle.store.getApproval('acme', 'ap-1'))?.state, 'pending');
    }));

  test(`${name}: another tenant cannot read or answer an approval`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'ap-1', 'run-1'));
      assert.equal(await handle.store.getApproval('globex', 'ap-1'), undefined);
      assert.equal(await handle.store.answerApproval('globex', 'ap-1', 'allow', T0 + 20), false);
      assert.deepEqual(await handle.store.listPendingApprovals('globex'), []);
      assert.equal((await handle.store.getApproval('acme', 'ap-1'))?.state, 'pending');
      assert.equal(await handle.store.answerApproval('acme', 'ap-1', 'allow', T0 + 20), true);
    }));

  test(`${name}: an answer at or after expiresAt is refused and the approval is not answered`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'ap-1', 'run-1', { expiresAt: T0 + 100 }));
      await handle.store.addApproval(approval('acme', 'ap-2', 'run-1', { expiresAt: T0 + 100 }));
      assert.equal(await handle.store.answerApproval('acme', 'ap-1', 'allow', T0 + 100), false);
      assert.equal(await handle.store.answerApproval('acme', 'ap-2', 'allow', T0 + 101), false);
      assert.equal((await handle.store.getApproval('acme', 'ap-1'))?.decision, null);
      assert.equal(await handle.store.answerApproval('acme', 'ap-1', 'allow', T0 + 99), true);
    }));

  test(`${name}: expireApprovals marks overdue pending approvals expired, counts them, and leaves answered and future ones`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.addApproval(approval('acme', 'late', 'run-1', { expiresAt: T0 + 100 }));
      await handle.store.addApproval(approval('acme', 'later', 'run-1', { expiresAt: T0 + 500 }));
      await handle.store.addApproval(approval('acme', 'done', 'run-1', { expiresAt: T0 + 100 }));
      assert.equal(await handle.store.answerApproval('acme', 'done', 'allow', T0 + 50), true);
      assert.equal(await handle.store.expireApprovals(T0 + 99), 0);
      assert.equal(await handle.store.expireApprovals(T0 + 100), 1);
      assert.equal(await handle.store.expireApprovals(T0 + 100), 0);
      assert.equal((await handle.store.getApproval('acme', 'late'))?.state, 'expired');
      assert.equal((await handle.store.getApproval('acme', 'late'))?.decision, null);
      assert.equal((await handle.store.getApproval('acme', 'later'))?.state, 'pending');
      assert.equal((await handle.store.getApproval('acme', 'done'))?.state, 'answered');
      assert.equal(await handle.store.answerApproval('acme', 'late', 'allow', T0 + 101), false);
      await handle.reopen();
      assert.equal((await handle.store.getApproval('acme', 'late'))?.state, 'expired');
      assert.deepEqual((await handle.store.listPendingApprovals('acme')).map((record) => record.approvalId), ['later']);
    }));

  test(`${name}: listPendingApprovals filters by tenant and optional requester and is ordered by createdAt`, () =>
    withStore(async (handle) => {
      await withRun(handle);
      await handle.store.acceptInbound(inbound('globex', 'g1'), 'run-g');
      await handle.store.addApproval(approval('acme', 'third', 'run-1', { createdAt: T0 + 30, requesterId: 'person-1' }));
      await handle.store.addApproval(approval('acme', 'first', 'run-1', { createdAt: T0 + 10, requesterId: 'person-2' }));
      await handle.store.addApproval(approval('acme', 'second', 'run-1', { createdAt: T0 + 20, requesterId: 'person-1' }));
      await handle.store.addApproval(approval('globex', 'foreign', 'run-g', { createdAt: T0 + 5 }));
      assert.deepEqual((await handle.store.listPendingApprovals('acme')).map((record) => record.approvalId), ['first', 'second', 'third']);
      assert.deepEqual((await handle.store.listPendingApprovals('acme', 'person-1')).map((record) => record.approvalId), ['second', 'third']);
      assert.deepEqual((await handle.store.listPendingApprovals('acme', 'person-9')).map((record) => record.approvalId), []);
      assert.deepEqual((await handle.store.listPendingApprovals('globex')).map((record) => record.approvalId), ['foreign']);
      await handle.reopen();
      assert.deepEqual((await handle.store.listPendingApprovals('acme', 'person-2')).map((record) => record.approvalId), ['first']);
    }));
}

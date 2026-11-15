import assert from 'node:assert/strict';
import test from 'node:test';
import { StoreError, type RelayStore, type TenantRecord } from '../../src/store/relayStore';

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
}

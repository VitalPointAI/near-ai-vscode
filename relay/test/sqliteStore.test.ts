import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSqliteStore } from '../src/store/sqliteStore';
import { relayStoreContract, type StoreFactory } from './contract/relayStore.contract';

// Phase 68, plan 05 (RELAY-03, D-05): the node:sqlite store runs the shared contract suite on real files in temporary directories. `reopen`
// closes the store and opens the same file again, which is what a restart does.

const factory: StoreFactory = {
  async create() {
    const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-store-'));
    const file = path.join(dir, 'relay.db');
    const handle = {
      store: await openSqliteStore(file),
      async reopen() {
        await handle.store.close();
        handle.store = await openSqliteStore(file);
        return handle.store;
      },
      async dispose() {
        await handle.store.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
    return handle;
  },
};

relayStoreContract('sqlite', factory);

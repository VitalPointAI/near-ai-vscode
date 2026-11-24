import { hubMemoryOf } from '@ext/staff/replica/hubSync';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { LiveReplicator } from '@ext/staff/replica/liveReplicator';
import type { LiveReplicatorOptions, LiveStatus } from '@ext/staff/replica/liveReplicator';
import type { Hub } from './hubHarness';
import type { HubWorld, WorldDevice } from './hubWorld';
import { MemorySecrets, memoryReplica } from './memoryReplica';
import type { MemoryReplica } from './memoryReplica';

// Phase 33, plan 09: one device's live replicator over a memory replica, connected to an in-process hub on loopback. Yjs-free and editor-free, as
// the replicator is. The transport names 'localhost' for the fixture certificate and runs on the hub's clock.

export interface LiveClient {
  device: WorldDevice;
  replica: MemoryReplica;
  replicator: LiveReplicator;
  log: string[];
}

export function liveClient(hub: Hub, world: HubWorld, device: WorldDevice, extra: Partial<LiveReplicatorOptions> = {}): LiveClient {
  const replica = memoryReplica(world, device);
  const log: string[] = [];
  const replicator = new LiveReplicator({
    local: replica,
    memory: hubMemoryOf(new MemorySecrets()),
    hub: { id: hub.identity.hub, writer: hub.identity.writer, certPin: hub.identity.certPin },
    address: () => Promise.resolve(`127.0.0.1:${hub.port}`),
    signer: device.signer,
    open: (options) => new HubTransport({ ...options, servername: 'localhost' }),
    now: () => new Date(hub.now()),
    log: (line) => log.push(line),
    ...extra
  });
  return { device, replica, replicator, log };
}

/** Resolves once the replicator's status passes the check, or fails after ms with the status it last had. */
export function reaches(replicator: LiveReplicator, check: (status: LiveStatus) => boolean, what: string, ms = 10_000): Promise<LiveStatus> {
  return new Promise((resolve, reject) => {
    if (check(replicator.status)) { resolve(replicator.status); return; }
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`${what}: not within ${ms} ms; last status ${JSON.stringify(replicator.status)}`)); }, ms);
    const listener = replicator.onStatus((status) => {
      if (!check(status)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(status);
    });
  });
}

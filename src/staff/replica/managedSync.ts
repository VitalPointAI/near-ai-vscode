import { HASH_PATTERN } from '../../domain/replica/entry';
import type { ManagedHandoff } from './managedGrantDelivery';

export interface ManagedSyncRoute {
  put(handle: string, packet: unknown): Promise<boolean>;
  get(handle: string): Promise<unknown>;
}

/** Handoffs live on the confidential side. The opaque route is never given a cell or a recipient. */
export interface ManagedSyncHandoffs {
  offers(): Promise<readonly ManagedHandoff[]>;
  pending(): Promise<readonly string[]>;
  published(offer: ManagedHandoff, handle: string): Promise<void>;
  accepted(handle: string): Promise<void>;
  superseded?(handle: string): Promise<void>;
}

export interface ManagedSyncLocal {
  seal(offer: ManagedHandoff): Promise<{ handle: string; packet: unknown } | undefined>;
  stage(value: unknown): Promise<boolean>;
  superseded?(value: unknown): Promise<boolean>;
}

export interface ManagedPacket { handle: string; packet: unknown }
export interface ManagedInbox { packets: readonly ManagedPacket[]; waiting: boolean }

const MAX_MANAGED_BATCH = 16;

/** Fetch each opaque packet once; roster ingestion may pair an authenticated continuity receipt with its entry. */
export async function fetchManaged(handoffs: ManagedSyncHandoffs, route: ManagedSyncRoute): Promise<ManagedInbox> {
  const packets: ManagedPacket[] = [];
  try {
    const handles = [...new Set((await handoffs.pending()).filter((handle) => HASH_PATTERN.test(handle)))];
    let waiting = handles.length > MAX_MANAGED_BATCH;
    for (const handle of handles.slice(0, MAX_MANAGED_BATCH)) {
      const packet = await route.get(handle);
      if (packet === undefined) waiting = true;
      else packets.push({ handle, packet });
    }
    return { packets, waiting };
  } catch {
    return { packets, waiting: true };
  }
}

export async function exchangeManaged(handoffs: ManagedSyncHandoffs, local: ManagedSyncLocal | undefined,
  route: ManagedSyncRoute | undefined, inbox: ManagedInbox | undefined, paired: ReadonlySet<string>): Promise<'waiting' | 'complete'> {
  if (route === undefined || local === undefined || inbox === undefined) return 'waiting';
  try {
    const offers = await handoffs.offers();
    let waiting = inbox.waiting || offers.length > MAX_MANAGED_BATCH;
    for (const offer of offers.slice(0, MAX_MANAGED_BATCH)) {
      const sealed = await local.seal(offer);
      if (sealed === undefined || !HASH_PATTERN.test(sealed.handle) || !await route.put(sealed.handle, sealed.packet)) {
        waiting = true;
        continue;
      }
      await handoffs.published(offer, sealed.handle);
    }
    for (const packet of inbox.packets) {
      if (paired.has(packet.handle) || await local.stage(packet)) await handoffs.accepted(packet.handle);
      else if (handoffs.superseded !== undefined && await local.superseded?.(packet)) await handoffs.superseded(packet.handle);
      else waiting = true;
    }
    return waiting ? 'waiting' : 'complete';
  } catch {
    // A route or provider failure leaves the handoff queued without exposing its metadata in the sync report.
    return 'waiting';
  }
}

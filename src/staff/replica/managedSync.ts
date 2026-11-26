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
}

export interface ManagedSyncLocal {
  seal(offer: ManagedHandoff): Promise<{ handle: string; packet: unknown } | undefined>;
  stage(value: unknown): Promise<boolean>;
}

const MAX_MANAGED_BATCH = 16;

export async function exchangeManaged(handoffs: ManagedSyncHandoffs, local?: ManagedSyncLocal, route?: ManagedSyncRoute): Promise<'waiting' | 'complete'> {
  if (route === undefined || local === undefined) return 'waiting';
  try {
    const offers = await handoffs.offers();
    const handles = [...new Set((await handoffs.pending()).filter((handle) => HASH_PATTERN.test(handle)))];
    let waiting = offers.length > MAX_MANAGED_BATCH || handles.length > MAX_MANAGED_BATCH;
    for (const offer of offers.slice(0, MAX_MANAGED_BATCH)) {
      const sealed = await local.seal(offer);
      if (sealed === undefined || !HASH_PATTERN.test(sealed.handle) || !await route.put(sealed.handle, sealed.packet)) {
        waiting = true;
        continue;
      }
      await handoffs.published(offer, sealed.handle);
    }
    for (const handle of handles.slice(0, MAX_MANAGED_BATCH)) {
      const packet = await route.get(handle);
      if (packet === undefined || !await local.stage({ handle, packet })) {
        waiting = true;
        continue;
      }
      await handoffs.accepted(handle);
    }
    return waiting ? 'waiting' : 'complete';
  } catch {
    // Keep the handoff queued on a route or provider failure. No private metadata reaches the sync report.
    return 'waiting';
  }
}

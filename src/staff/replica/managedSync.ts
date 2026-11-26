import { HASH_PATTERN } from '../../domain/replica/entry';
import type { ManagedHandoff } from './managedGrantDelivery';

export interface ManagedSyncRoute {
  put(handle: string, packet: unknown): Promise<boolean>;
  get(handle: string): Promise<unknown>;
}

/** Handoffs live on the confidential side. The opaque route is never given a cell or a recipient. */
export interface ManagedSyncHandoffs {
  offers(): Promise<readonly ManagedHandoff[]>;
  pending(): Promise<readonly string[] | ManagedPendingBatch>;
  published(offer: ManagedHandoff, handle: string, expiresAt?: number): Promise<void>;
  accepted(handle: string): Promise<void>;
  superseded?(handle: string): Promise<void>;
}

export interface ManagedSyncLocal {
  seal(offer: ManagedHandoff): Promise<{ handle: string; packet: unknown } | undefined>;
  prepare?(offer: ManagedHandoff): Promise<ManagedStagedSend | undefined>;
  stage(value: unknown): Promise<boolean>;
  superseded?(value: unknown): Promise<boolean>;
}

export type ManagedStagedSend =
  | { handle: string; expiresAt: number; state: 'published' }
  | { handle: string; expiresAt: number; state: 'uploaded'; published(): Promise<void> }
  | { handle: string; expiresAt: number; state: 'queued'; packet: unknown; uploaded(): Promise<boolean>; published(): Promise<void> };

export interface ManagedPacket { handle: string; packet: unknown; expectedExpiry?: number }
export interface ManagedInbox { packets: readonly ManagedPacket[]; waiting: boolean }

export interface ManagedPendingBatch { handles: readonly string[]; waiting: boolean; deadlines?: ReadonlyMap<string, number> }

export const MAX_MANAGED_BATCH = 16;
export const MANAGED_HANDOFF_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Fetch each opaque packet once; roster ingestion may pair an authenticated continuity receipt with its entry. */
export async function fetchManaged(handoffs: ManagedSyncHandoffs, route: ManagedSyncRoute): Promise<ManagedInbox> {
  const packets: ManagedPacket[] = [];
  try {
    const pending = await handoffs.pending();
    const batch: ManagedPendingBatch = 'handles' in pending ? pending : { handles: pending, waiting: false };
    const handles = [...new Set(batch.handles.filter((handle) => HASH_PATTERN.test(handle)))];
    let waiting = batch.waiting || handles.length > MAX_MANAGED_BATCH;
    for (const handle of handles.slice(0, MAX_MANAGED_BATCH)) {
      const packet = await getManagedPacket(route, handle);
      if (packet === undefined) waiting = true;
      else {
        const expectedExpiry = batch.deadlines?.get(handle);
        packets.push({ handle, packet, ...(expectedExpiry === undefined ? {} : { expectedExpiry }) });
      }
    }
    return { packets, waiting };
  } catch {
    return { packets, waiting: true };
  }
}

async function getManagedPacket(route: ManagedSyncRoute, handle: string): Promise<unknown> {
  try {
    return await route.get(handle);
  } catch {
    return undefined;
  }
}

export async function exchangeManaged(handoffs: ManagedSyncHandoffs, local: ManagedSyncLocal | undefined,
  route: ManagedSyncRoute | undefined, inbox: ManagedInbox | undefined, paired: ReadonlySet<string>): Promise<'waiting' | 'complete'> {
  if (route === undefined || local === undefined || inbox === undefined) return 'waiting';
  try {
    const offers = await handoffs.offers();
    let waiting = inbox.waiting || offers.length > MAX_MANAGED_BATCH;
    for (const offer of offers.slice(0, MAX_MANAGED_BATCH)) {
      if (!await offerManaged(handoffs, local, route, offer)) waiting = true;
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

async function offerManaged(handoffs: ManagedSyncHandoffs, local: ManagedSyncLocal, route: ManagedSyncRoute, offer: ManagedHandoff): Promise<boolean> {
  try {
    if (local.prepare === undefined) {
      const sealed = await local.seal(offer);
      if (sealed === undefined || !HASH_PATTERN.test(sealed.handle) || !await route.put(sealed.handle, sealed.packet)) return false;
      await handoffs.published(offer, sealed.handle);
      return true;
    }
    const staged = await local.prepare(offer);
    if (staged === undefined || !HASH_PATTERN.test(staged.handle)) return false;
    if (staged.state === 'published') return true;
    if (staged.state === 'queued') {
      if (!await route.put(staged.handle, staged.packet)) return false;
      if (!await staged.uploaded()) return false;
    }
    await handoffs.published(offer, staged.handle, staged.expiresAt);
    await staged.published();
    return true;
  } catch {
    return false;
  }
}

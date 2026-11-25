/**
 * A person's own computer slots (Phase 71, D-25, owner decision of 2026-11-25 closing G466). Backend only; nothing here imports Theia.
 *
 * A person binds their own computer (71-10's bindComputer), and the DeviceBindingCredential needs one revocation and one suspension place in
 * your organization's status lists. The person claims them in their own session, with their own token, through a narrow create-only path:
 *
 *   kv/site/device-slots/<own entity>/slot-1 … slot-5     the person's computer slots: at most 5 bound at once. OpenBao itself allows only these
 *                                                           five names, only under the person's own entity, create and read only, so nobody
 *                                                           claims another person's slot or changes a claimed one.
 *   kv/site/status-index/device-<purpose>-<list>/<index>   the place itself, claimed once (check-and-set 0) so no two computers share a bit. Device
 *                                                           places come from the top quarter of each list (DEVICE_INDEX_FROM and up); officers'
 *                                                           credentials use the rest, so the two never meet.
 *
 * The person never signs a status list: revoking a computer is an officer's act. A lost computer is reported through the revocation inbox
 * (reportLostComputer, reason computer-lost); the officer revokes the binding and removes the slot, which frees it for another computer.
 * A slot that holds the same computer is used again, so a step-up refused half-way never uses up a slot.
 */
import { randomInt } from 'node:crypto';
import { IDENTITY_TEXT, type BoundComputer } from '../../common/identity.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { IdentityKv, StatusAllocator, StatusSlot } from './identity-service.js';

/** The most computers a person has bound at once (owner, 2026-11-25). */
export const MAX_COMPUTERS = 5;
/** Status list places for device bindings: the top quarter of each 131,072-entry list. Officers draw below it. */
export const DEVICE_INDEX_FROM = 98_304;
export const STATUS_LIST_SIZE = 131_072;
export const DEVICE_SLOT_FORMAT = 'sterling-device-slot/1';
export const REVOCATION_REQUEST_FORMAT = 'sterling-revocation-request/1';
export const COMPUTER_LOST_REASON = 'computer-lost';

export const slotPath = (entity: string, slot: number): string => `site/device-slots/${entity}/slot-${String(slot)}`;
const listName = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);
const DEVICE = /^dev-[0-9a-f]{32}$/;

export interface DeviceSlotRecord {
  readonly device: string;
  readonly revocation: StatusSlot;
  readonly suspension: StatusSlot;
  readonly claimedAt: string;
}

function placeOf(value: unknown): StatusSlot | undefined {
  const place = value as { list?: unknown; index?: unknown } | undefined;
  return typeof place?.list === 'string' && Number.isSafeInteger(place.index) ? { list: place.list, index: place.index as number } : undefined;
}

/** A slot record as written by deviceSlotAllocator, or undefined. */
export function slotRecordOf(data: Record<string, unknown> | undefined): DeviceSlotRecord | undefined {
  if (data?.format !== DEVICE_SLOT_FORMAT || typeof data.device !== 'string' || typeof data.claimedAt !== 'string') return undefined;
  const revocation = placeOf(data.revocation);
  const suspension = placeOf(data.suspension);
  return revocation === undefined || suspension === undefined ? undefined : { device: data.device, revocation, suspension, claimedAt: data.claimedAt };
}

export interface DeviceSlotDeps {
  readonly kv: IdentityKv;
  readonly entityId: () => string | undefined;
  /** The revocation and suspension list ids of your organization's rules in force; undefined while none reached this session. */
  readonly lists: () => { readonly revocation: string; readonly suspension: string } | undefined;
  readonly now?: () => number;
  readonly randomIndex?: (size: number) => number;
}

const iso = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The StatusAllocator bindComputer uses: the person's first free slot (or the one already holding this computer), with two fresh places. */
export function deviceSlotAllocator(deps: DeviceSlotDeps): StatusAllocator {
  const now = deps.now ?? Date.now;
  const randomIndex = deps.randomIndex ?? ((size: number): number => randomInt(size));

  async function place(purpose: 'revocation' | 'suspension', list: string): Promise<StatusSlot | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const index = DEVICE_INDEX_FROM + randomIndex(STATUS_LIST_SIZE - DEVICE_INDEX_FROM);
      if ((await deps.kv.create(`site/status-index/device-${purpose}-${listName(list)}/${String(index)}`, { claimedAt: iso(now()) })) === 'created') return { list, index };
    }
    return undefined;
  }

  return {
    async allocate(device) {
      const entity = deps.entityId();
      const lists = deps.lists();
      if (entity === undefined || lists === undefined || typeof device !== 'string' || !DEVICE.test(device)) return undefined;
      let free: number | undefined;
      for (let slot = 1; slot <= MAX_COMPUTERS; slot += 1) {
        const held = await deps.kv.read(slotPath(entity, slot));
        const record = slotRecordOf(held);
        // The same computer again (a binding that stopped at the step-up): its places, never a second slot.
        if (record !== undefined && record.device === device) return { revocation: record.revocation, suspension: record.suspension, slot };
        if (held === undefined && free === undefined) free = slot;
      }
      if (free === undefined) return 'full';
      const revocation = await place('revocation', lists.revocation);
      const suspension = revocation === undefined ? undefined : await place('suspension', lists.suspension);
      if (revocation === undefined || suspension === undefined) return undefined;
      // Create only: a slot another of the person's sessions took a moment ago is never overwritten; those two places stay unused.
      for (let slot = free; slot <= MAX_COMPUTERS; slot += 1) {
        const created = await deps.kv.create(slotPath(entity, slot), { format: DEVICE_SLOT_FORMAT, device, revocation, suspension, claimedAt: iso(now()) });
        if (created === 'created') return { revocation, suspension, slot };
      }
      return 'full';
    },
  };
}

/** The person's bound computers, from their own slots. */
export async function listComputers(deps: Pick<DeviceSlotDeps, 'kv' | 'entityId'>): Promise<ServiceResult<readonly BoundComputer[]>> {
  const entity = deps.entityId();
  if (entity === undefined) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
  const found: BoundComputer[] = [];
  for (let slot = 1; slot <= MAX_COMPUTERS; slot += 1) {
    const record = slotRecordOf(await deps.kv.read(slotPath(entity, slot)));
    if (record !== undefined) found.push({ slot, device: record.device, claimedAt: record.claimedAt });
  }
  return ok(found);
}

/** The sub of a forwarded sign-in token (read only to name the person's own entity; OpenBao checks the name against the token). */
export function subjectOf(jwt: string | undefined): string | undefined {
  const payload = jwt?.split('.')[1];
  if (payload === undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  try {
    const sub = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    return undefined;
  }
}

export interface LostComputerDeps extends Pick<DeviceSlotDeps, 'kv' | 'entityId' | 'now'> {
  /** The person's Keycloak subject (the forwarded token's sub). Their OpenBao entity is named keycloak-<sub>, or guest-<sub> for a guest. */
  readonly subject: () => string | undefined;
}

/**
 * Files one sterling-revocation-request/1 with reason computer-lost for a slot, once (check-and-set 0), at
 * kv/site/revocation-requests/<own entity name>-computer-lost-<slot>. OpenBao lets a person create only under their own entity name, so the
 * name is tried as staff first, then as a guest; the one OpenBao refuses is not theirs.
 */
export async function reportLostComputer(deps: LostComputerDeps, slot: number): Promise<ServiceResult<{ readonly filed: boolean }>> {
  const entity = deps.entityId();
  const sub = deps.subject();
  if (entity === undefined || sub === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sub)) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > MAX_COMPUTERS) return refused(IDENTITY_TEXT.noComputer);
  const record = slotRecordOf(await deps.kv.read(slotPath(entity, slot)));
  if (record === undefined) return refused(IDENTITY_TEXT.noComputer);
  const seenAt = iso((deps.now ?? Date.now)());
  for (const name of [`keycloak-${sub}`, `guest-${sub}`]) {
    try {
      const created = await deps.kv.create(`site/revocation-requests/${name}-${COMPUTER_LOST_REASON}-${String(slot)}`, {
        format: REVOCATION_REQUEST_FORMAT, entity: name, keycloakId: sub, reason: COMPUTER_LOST_REASON, slot, device: record.device, seenAt, job: 'workbench: a lost computer',
      });
      // 'exists' is either this person's earlier report or a name that is not theirs (OpenBao refuses both alike); a guest's name comes second.
      if (created === 'created') return ok({ filed: true });
    } catch {
      // The store did not answer: try nothing else.
      return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    }
  }
  return ok({ filed: false });
}

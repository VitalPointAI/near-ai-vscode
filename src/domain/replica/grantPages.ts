// Grant pages (33.2 D-04, D-12): a cell-wrap/v2 wrap is 1,214 bytes against 92 for v1, so one signed grant of at most GRANT_MAX_BYTES holds about 600
// v2 wraps against 4,095. An epoch grant may therefore span several signed pages (purpose staff-cell-grant, each within GRANT_MAX_BYTES):
// - the founding page { cell, epoch, roster, labelSealed, wraps, pages } carries the sealed label and pages, the sorted grant hashes of the others;
// - every other page has the same fields with an empty labelSealed and an empty pages list.
// The founding entry (genesis cells, cell.create, cell.rekey) commits to the founding page by grantHash, and the founding page commits to every other
// page, so the one hash the roster holds covers every wrap. A grant with only v1 wraps that fits one grant is built exactly as buildGrant builds it.
// Hub-side and pure: node:crypto and src/domain only, no clock, no I/O.
import { GRANT_MAX_BYTES, MAX_GRANT_PAGES, MAX_GRANT_WRAPS, MAX_LABEL_SEALED_CHARS, WRAP_BYTES, buildGrant, buildGrantAsync, grantHash, readGrant, sealLabel } from './cellKeys';
import type { CellGrant, GrantWrap } from './cellKeys';
import { wrapForDevice } from './cellWrapV2';
import type { KemPublicKeys } from './cellWrapV2';
import type { AsyncPayloadSigner, PayloadSigner, SignRefused, SignedPayload } from '../team/signedPayload';

// One v2 wrap in a page's canonical JSON: {"wrap":"<1,619 base64url characters>","writer":"<64 hex>"} and its comma (1,707 bytes).
const V2_WRAP_ENTRY_BYTES = 1707;
// Room for the signed envelope (purpose, signer, signedAt, sig), the fixed fields and the pages list of the founding page.
const PAGE_OVERHEAD_BYTES = 4096;
// The most v2 wraps one page holds with the longest label, so every page, founding or not, fits GRANT_MAX_BYTES: 607.
export const MAX_WRAPS_PER_V2_PAGE = Math.floor((GRANT_MAX_BYTES - MAX_LABEL_SEALED_CHARS - PAGE_OVERHEAD_BYTES) / V2_WRAP_ENTRY_BYTES);

// Builds the pages of one epoch grant, the founding page first. Only v1 wraps, up to MAX_GRANT_WRAPS: one v1 grant, as today. Otherwise pages of at
// most MAX_WRAPS_PER_V2_PAGE wraps each. Throws on an invalid grant, more than MAX_GRANT_WRAPS wraps or a repeated writer.
export function buildGrantPages(signer: PayloadSigner, input: CellGrant): Array<SignedPayload<CellGrant>> {
  const plan = grantPagePlan(input);
  if (plan.single !== undefined) return [buildGrant(signer, plan.single)];
  const others = plan.others.map((page) => buildGrant(signer, page));
  return [buildGrant(signer, plan.founding(others.map((page) => grantHash(page)))), ...others];
}

// buildGrantPages with a signer that answers later: the person key in a hosted session signs as the device the roster names (Phase 33 D-60). The
// same pages and hashes buildGrantPages makes with that key; the first refusal comes back as it is and nothing else is signed after it.
export async function buildGrantPagesAsync(signer: PayloadSigner | AsyncPayloadSigner, input: CellGrant): Promise<Array<SignedPayload<CellGrant>> | SignRefused> {
  const plan = grantPagePlan(input);
  if (plan.single !== undefined) {
    const one = await buildGrantAsync(signer, plan.single);
    return 'refused' in one ? one : [one];
  }
  const others: Array<SignedPayload<CellGrant>> = [];
  for (const page of plan.others) {
    const signed = await buildGrantAsync(signer, page);
    if ('refused' in signed) return signed;
    others.push(signed);
  }
  const founding = await buildGrantAsync(signer, plan.founding(others.map((page) => grantHash(page))));
  return 'refused' in founding ? founding : [founding, ...others];
}

// The unsigned pages of one epoch grant: one v1 grant when only v1 wraps fit, else the other pages and the founding page given their hashes.
export function grantPagePlan(input: CellGrant): { single?: CellGrant; others: CellGrant[]; founding: (hashes: string[]) => CellGrant } {
  const wraps = input.wraps;
  if (wraps.length > MAX_GRANT_WRAPS) throw new Error('A grant names at most 4,095 devices.');
  if (new Set(wraps.map((item) => item.writer)).size !== wraps.length) throw new Error('A grant names each device once.');
  const base = { cell: input.cell, epoch: input.epoch, roster: input.roster };
  const chunks: GrantWrap[][] = [];
  for (let at = 0; at < wraps.length; at += MAX_WRAPS_PER_V2_PAGE) chunks.push(wraps.slice(at, at + MAX_WRAPS_PER_V2_PAGE));
  const founding = (hashes: string[]): CellGrant => ({ ...base, labelSealed: input.labelSealed, wraps: chunks[0] ?? [], pages: [...hashes].sort() });
  if (wraps.every((item) => Buffer.from(item.wrap, 'base64url').length === WRAP_BYTES)) return { single: { ...base, labelSealed: input.labelSealed, wraps }, others: [], founding };
  return { others: chunks.slice(1).map((chunk) => ({ ...base, labelSealed: '', wraps: chunk, pages: [] })), founding };
}

export const GRANT_PAGE_REFUSALS = {
  'founding-malformed': 'The first page of this cell grant is not in a shape this version can read, or its signature does not match.',
  'page-bad-signature': 'A page of this cell grant was changed or was not made by the key it names.',
  'page-other-epoch': 'A page of this cell grant belongs to another grant, or was signed by someone else.',
  'page-not-listed': 'A page given with this cell grant is not one its first page lists.',
  'page-missing': 'A page of this cell grant has not arrived yet.',
  'page-repeats-device': 'A device is named on more than one page of this cell grant.'
} as const;
export type GrantPageRefusal = keyof typeof GRANT_PAGE_REFUSALS;

export type GrantPagesRead =
  | { ok: true; grant: CellGrant; hash: string; pageHashes: string[]; signer: { publicKey: string; writer: string } }
  | { ok: false; reason: GrantPageRefusal };

// Reads one epoch grant from its founding page and the pages given with it (in any order). Every page's signature, cell, epoch, roster and signer must
// match the founding page, every page must be listed by it and every listed page given, and no device may appear twice. The answer is one grant
// holding every wrap and the founding page's label, under the founding page's hash. Never throws.
export function readGrantPages(founding: unknown, pages: readonly unknown[]): GrantPagesRead {
  const head = readGrant(founding);
  if (!head.ok || head.grant.pages === undefined) return { ok: false, reason: 'founding-malformed' };
  const listed = new Set(head.grant.pages);
  const wraps: GrantWrap[] = [...head.grant.wraps];
  const seen = new Set<string>();
  for (const value of pages) {
    const page = readGrant(value);
    if (!page.ok) return { ok: false, reason: page.reason === 'bad-signature' ? 'page-bad-signature' : 'page-other-epoch' };
    const grant = page.grant;
    if (grant.cell !== head.grant.cell || grant.epoch !== head.grant.epoch || grant.roster !== head.grant.roster || page.signer.publicKey !== head.signer.publicKey) return { ok: false, reason: 'page-other-epoch' };
    if (grant.labelSealed !== '' || grant.pages === undefined || grant.pages.length > 0) return { ok: false, reason: 'page-other-epoch' };
    if (!listed.has(page.hash)) return { ok: false, reason: 'page-not-listed' };
    if (seen.has(page.hash)) continue;
    seen.add(page.hash);
    wraps.push(...grant.wraps);
  }
  if (seen.size !== listed.size || head.grant.pages.length > MAX_GRANT_PAGES) return { ok: false, reason: 'page-missing' };
  if (new Set(wraps.map((item) => item.writer)).size !== wraps.length || wraps.length > MAX_GRANT_WRAPS) return { ok: false, reason: 'page-repeats-device' };
  const grant: CellGrant = { cell: head.grant.cell, epoch: head.grant.epoch, roster: head.grant.roster, labelSealed: head.grant.labelSealed, wraps, pages: [...head.grant.pages] };
  return { ok: true, grant, hash: head.hash, pageHashes: [...head.grant.pages], signer: head.signer };
}

// ---- wraps through the one entry point (33.2 D-05, D-09) ----

/** A receiving device as the roster names it: its writer id, its X25519 key (v1) and its device.kem or descriptor keys (v2), whichever it has. */
export interface WrapDevice { writer: string; x25519?: string; kem?: KemPublicKeys }

/**
 * The wraps of one epoch key to each device, in the format asked for, through wrapForDevice. A device that has no keys of that format gets no wrap
 * and is listed in waiting (D-05: it is given the key later, never the older format instead).
 */
export function wrapsFor(input: { format: 1 | 2; cell: string; epoch: number; epochKey: Buffer; devices: readonly WrapDevice[] }): { wraps: GrantWrap[]; waiting: string[] } {
  const wraps: GrantWrap[] = [];
  const waiting: string[] = [];
  for (const device of input.devices) {
    const recipient = { ...(device.x25519 === undefined ? {} : { x25519: device.x25519 }), ...(device.kem === undefined ? {} : { kem: device.kem }) };
    const made = wrapForDevice({ format: input.format, cell: input.cell, epoch: input.epoch, writer: device.writer, epochKey: input.epochKey, recipient });
    if (made.ok) wraps.push({ writer: device.writer, wrap: made.wrap });
    else waiting.push(device.writer);
  }
  return { wraps, waiting };
}

export interface EarlierEpochInput {
  cell: string;
  // Every epoch of the cell the device is cleared for, with its key and the format its wrap must use (wrapFormat.ts), oldest first.
  epochs: ReadonlyArray<{ epoch: number; key: Buffer; format?: 1 | 2 }>;
  // The roster the grants are valid at: normally the one that admitted the device. It must not be the roster an epoch's founding entry cites
  // (only the founding grant is valid there); when the current epoch was founded at the admission roster, put the device in the founding grant.
  roster: string;
  // The receiving device's writer id and keys: recipient is its X25519 key (v1), kem its v2 keys.
  writer: string;
  recipient?: string;
  kem?: KemPublicKeys;
  // The cell's label, sealed into each grant under that epoch's key, when given.
  label?: unknown;
}

// One signed grant per epoch, each wrapping that epoch's key to the one device through wrapForDevice, so a device admitted later can open the cell's
// history (D-45). An epoch whose format the device has no keys for is left out (the device waits for it). The roster fold accepts each grant when the
// signer is a roster writer at the named roster and the device is admitted there. Throws on a bad key, cell, epoch, roster or recipient, and on an
// empty or repeated epoch list.
export function earlierEpochGrants(signer: PayloadSigner, input: EarlierEpochInput): Array<SignedPayload<CellGrant>> {
  if (input.epochs.length === 0) throw new Error('Name at least one epoch to grant.');
  const seen = new Set<number>();
  const device: WrapDevice = { writer: input.writer, ...(input.recipient === undefined ? {} : { x25519: input.recipient }), ...(input.kem === undefined ? {} : { kem: input.kem }) };
  return input.epochs.flatMap(({ epoch, key, format }) => {
    if (seen.has(epoch)) throw new Error('Each epoch is granted once.');
    seen.add(epoch);
    const { wraps } = wrapsFor({ format: format ?? 1, cell: input.cell, epoch, epochKey: key, devices: [device] });
    if (wraps.length === 0) return [];
    const labelSealed = input.label === undefined ? '' : sealLabel(key, input.cell, epoch, input.label);
    return buildGrantPages(signer, { cell: input.cell, epoch, roster: input.roster, labelSealed, wraps });
  });
}

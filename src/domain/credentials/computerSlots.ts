// A person's computer slots (Phase 71, D-25 and D-26; G467): the record every verifier checks before a DeviceBindingCredential counts. Pure: no I/O, no
// clock, no package.
//
// The verifiable form is the person's own did:webvh log. When a person binds a computer, their backend adds one service entry to their DID document,
// signed with their own key after the step-up like every entry:
//
//   { id: "<did>#computer-<slot>", type: "SterlingComputerSlot", serviceEndpoint: "urn:sterling:computer:<revocation index>:<suspension index>:<did:key>" }
//
// A binding counts only when both its status places are in the computer part of the lists (index 98,304 and up, where officers never issue) and the
// person's DID document in force at the time of the check lists that computer with exactly those places, in one of at most five slots. A document with
// more than five slots, a slot number outside 1 to 5, or a place listed twice counts no binding at all.
//
// Why the DID log and not a list signed by the status-list key: every verifier (the fold's checkEvidence, the hub, the wallet, an edge) already holds
// and verifies the person's log for the issuer key check; the hub hosts it and the trust export carries it, so no new channel or key is needed; the log
// is append-only and hash-chained, so every slot ever used stays visible; and the person binds a computer without waiting for an officer to sign
// anything. A slot entry grants nothing: it only narrows which bindings count (PROJECT decision 8). The HQ hub also refuses a log whose computer place
// another person's document lists (hub trustStore), so two computers never share a status bit.
import type { VerifiedCredential } from './profile';
import { DEVICE_BINDING_TYPE } from './types';
import { readDidDocument } from '../did/didDocument';
import type { DidDocument } from '../did/didDocument';
import { versionAt } from '../did/didWebvh';
import type { WebvhState } from '../did/didWebvh';

export const COMPUTER_SLOT_SERVICE = 'SterlingComputerSlot';
/** The most computers a person has bound at once (owner, 2026-11-25). */
export const MAX_COMPUTER_SLOTS = 5;
/** The first status list place for computers; officers' credentials use the places below it (D-25). */
export const COMPUTER_INDEX_FROM = 98_304;
export const COMPUTER_INDEX_TO = 131_072;
const ENDPOINT = /^urn:sterling:computer:(\d{1,6}):(\d{1,6}):(did:key:z[1-9A-HJ-NP-Za-km-z]{1,128})$/;
const SLOT_ID = /#computer-([1-9][0-9]?)$/;

export interface ComputerSlot {
  readonly slot: number;
  readonly device: string;
  readonly revocation: number;
  readonly suspension: number;
}

export type ComputerBindingRefusal = 'binding-outside-computer-range' | 'binding-not-in-slots';

export const COMPUTER_SLOT_TEXT = {
  'binding-outside-computer-range': 'A cited computer binding uses status list places that are not for computers.',
  'binding-not-in-slots': 'A cited computer binding is not one of the computers its person lists in their identity.',
} as const;

export const inComputerRange = (index: number): boolean => Number.isSafeInteger(index) && index >= COMPUTER_INDEX_FROM && index < COMPUTER_INDEX_TO;

/** The service entry for a slot, as the person's backend writes it into their DID document. */
export function computerSlotService(did: string, slot: ComputerSlot): { readonly id: string; readonly type: string; readonly serviceEndpoint: string } {
  return { id: `${did}#computer-${String(slot.slot)}`, type: COMPUTER_SLOT_SERVICE, serviceEndpoint: `urn:sterling:computer:${String(slot.revocation)}:${String(slot.suspension)}:${slot.device}` };
}

/**
 * The computer slots a DID document lists, or 'invalid' when they break a rule (more than five, a slot number outside 1 to 5 or used twice, a place
 * outside the computer part or listed twice, an endpoint that is not one). Other services are left alone.
 */
export function computerSlotsOf(document: DidDocument): readonly ComputerSlot[] | 'invalid' {
  const slots: ComputerSlot[] = [];
  for (const service of document.service) {
    if (service.type !== COMPUTER_SLOT_SERVICE) continue;
    const id = SLOT_ID.exec(service.id);
    const endpoint = ENDPOINT.exec(service.serviceEndpoint);
    if (id === null || endpoint === null) return 'invalid';
    const slot = { slot: Number(id[1]), device: endpoint[3] as string, revocation: Number(endpoint[1]), suspension: Number(endpoint[2]) };
    if (slot.slot > MAX_COMPUTER_SLOTS || !inComputerRange(slot.revocation) || !inComputerRange(slot.suspension) || slot.revocation === slot.suspension) return 'invalid';
    slots.push(slot);
  }
  if (slots.length > MAX_COMPUTER_SLOTS || new Set(slots.map((slot) => slot.slot)).size !== slots.length) return 'invalid';
  const places = slots.flatMap((slot) => [slot.revocation, slot.suspension]);
  if (new Set(places).size !== places.length) return 'invalid';
  return Object.freeze(slots);
}

/** The slots of a DID's version in force at `at`, or 'invalid' (no version then, deactivated, not the minimal document, or broken slots). */
export function computerSlotsAt(state: WebvhState, at: number): readonly ComputerSlot[] | 'invalid' {
  const version = versionAt(state, at);
  if (version === undefined || version.deactivated) return 'invalid';
  const read = readDidDocument(version.document, version.did);
  return read.ok ? computerSlotsOf(read.document) : 'invalid';
}

/**
 * Whether a verified DeviceBindingCredential counts at `at`: undefined when it does, else the refusal. `issuerState` is the verified state of the
 * binding's issuer (the person). Any other credential type is not this rule's and passes.
 */
export function checkComputerBinding(binding: VerifiedCredential, issuerState: WebvhState | undefined, at: number): ComputerBindingRefusal | undefined {
  if (binding.type !== DEVICE_BINDING_TYPE) return undefined;
  const revocation = binding.status.find((entry) => entry.statusPurpose === 'revocation')?.statusListIndex;
  const suspension = binding.status.find((entry) => entry.statusPurpose === 'suspension')?.statusListIndex;
  if (revocation === undefined || suspension === undefined || !inComputerRange(revocation) || !inComputerRange(suspension)) return 'binding-outside-computer-range';
  if (issuerState === undefined) return 'binding-not-in-slots';
  const slots = computerSlotsAt(issuerState, at);
  if (slots === 'invalid') return 'binding-not-in-slots';
  return slots.some((slot) => slot.device === binding.claims.id && slot.revocation === revocation && slot.suspension === suspension) ? undefined : 'binding-not-in-slots';
}

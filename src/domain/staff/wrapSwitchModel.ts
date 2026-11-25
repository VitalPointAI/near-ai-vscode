// The cards of the switch to post-quantum keys (33.2 D-05, D-11): pure, read from the folded roster only. Each card is the one next step of one person
// and goes away when its condition is gone, so the rollout has no state that waits without an action:
//
//   no card     the project is switched and every current key is post-quantum, or this device is not the one to act
//   Switch      a lead or deputy device with post-quantum keys, in a project not switched yet; lists who has not published keys, by name
//   Move        after the switch, a lead or deputy device, while any part's current key still has an older (X25519) wrap; ready and waiting parts
//   Give keys   a holder of a part's current post-quantum key, while a computer that held an earlier key of that part now has post-quantum keys
//               and no wrap of the current one (it updated late); nobody is ever removed for being late
import { wrapFormatOf } from '../replica/cellWrapV2';
import { kemKeysAt } from '../replica/deviceKem';
import { isRosterWriterAt } from '../replica/roster';
import type { RosterState } from '../replica/roster';
import { epochAt, granteesAt } from '../replica/rosterCells';
import { deviceAt, memberAt } from '../replica/rosterMembers';
import { WRAP_FEATURE } from '../replica/wrapFormat';

export const SWITCH_CARD_TEXT = 'Switch to post-quantum keys';
export const SWITCH_CARD_EXPLAIN_TEXT = 'This protects shared work against future quantum computers.';
export const SWITCH_NOT_READY_TEXT = 'These people have a computer that has not published its post-quantum keys yet. It gets its keys once it does:';
export const MOVE_CARD_TEXT = 'Move all shared work to the new keys';
export const MOVE_CARD_EXPLAIN_TEXT = 'Some shared work still has older keys. Moving gives it new post-quantum keys.';
export const MOVE_WAITING_TEXT = 'Part of it waits for a computer that has not published its post-quantum keys. It moves when that computer does, or now if you choose, and that computer gets its keys later.';
/** The Move card's second way forward: the parts still waiting move at once, their late computers left to Give keys. */
export const MOVE_NOW_TEXT = 'Move it now without waiting';
export const GIVE_KEYS_ACTION_TEXT = 'Give keys';
/** "Two computers are ready for keys. Give keys." for two; one sentence for any count. */
export function giveKeysText(count: number): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const number = count < words.length ? words[count] : String(count);
  return `${number} ${count === 1 ? 'computer is' : 'computers are'} ready for keys. Give keys.`;
}

export type WrapCard =
  | { kind: 'switch'; text: string; explain: string; notReady: string[] }
  | { kind: 'move'; text: string; ready: string[]; waiting: string[] }
  | { kind: 'give-keys'; text: string; grants: Array<{ cell: string; epoch: number; writers: string[] }> };

const hasV1 = (wraps: ReadonlyArray<{ wrap: string }>): boolean => wraps.some((item) => { const format = wrapFormatOf(item.wrap); return format.ok && format.format === 1; });

/**
 * The cards this device (`me`, its writer id) sees in the roster as it stands at its head. cleared says whether a device may hold a part now: the
 * host's clearance check (membership.clearedDevices), so a computer dropped for a lowered clearance is never offered and a new one that waited from
 * its admission is. Without it, a computer counts when it held an earlier key of the part.
 */
export function wrapSwitchCards(state: RosterState, me: string, cleared?: (writer: string, cell: string) => boolean): WrapCard[] {
  const head = state.positions.length - 1;
  const admitted = (writer: string): boolean => deviceAt(state.members, writer, head) !== undefined;
  const people = (): Array<{ writer: string; member: string }> =>
    [...state.members.devices.keys()].map((writer) => deviceAt(state.members, writer, head)).filter((device) => device !== undefined && device.kind === 'person')
      .map((device) => ({ writer: device!.writer, member: device!.member }));
  const lead = isRosterWriterAt(state, me, head);
  const switched = state.requiredFrom.get(WRAP_FEATURE);
  const cards: WrapCard[] = [];
  if (switched === undefined) {
    if (lead && kemKeysAt(state, me) !== undefined) {
      const names = people().filter((device) => kemKeysAt(state, device.writer) === undefined).map((device) => memberAt(state.members, device.member, head)?.name ?? device.member);
      cards.push({ kind: 'switch', text: SWITCH_CARD_TEXT, explain: SWITCH_CARD_EXPLAIN_TEXT, notReady: [...new Set(names)].sort() });
    }
    return cards;
  }
  const ready: string[] = [];
  const waiting: string[] = [];
  const give: Array<{ cell: string; epoch: number; writers: string[] }> = [];
  for (const [cell, record] of [...state.cells.cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const epoch = epochAt(state.cells, cell, head);
    const holders = granteesAt(state.cells, cell, head, admitted);
    if (epoch === undefined || holders === undefined) continue;
    const current = record.grants.filter((grant) => grant.epoch === epoch);
    if (current.some((grant) => hasV1(grant.grant.wraps))) {
      (holders.every((writer) => kemKeysAt(state, writer) !== undefined) ? ready : waiting).push(cell);
      continue;
    }
    // The current key is post-quantum: an admitted person computer that may hold this part, now with post-quantum keys and no wrap of the current
    // key, was waiting for its keys and is given the key by a holder.
    const earlier = new Set(record.grants.filter((grant) => grant.epoch < epoch).flatMap((grant) => grant.writers));
    const may = cleared ?? ((writer: string): boolean => earlier.has(writer));
    const late = people().map((device) => device.writer).filter((writer) => !holders.includes(writer) && kemKeysAt(state, writer) !== undefined && may(writer, cell)).sort();
    if (late.length > 0 && holders.includes(me)) give.push({ cell, epoch, writers: late });
  }
  if (lead && ready.length + waiting.length > 0) cards.push({ kind: 'move', text: MOVE_CARD_TEXT, ready, waiting });
  if (give.length > 0) cards.push({ kind: 'give-keys', text: giveKeysText(new Set(give.flatMap((item) => item.writers)).size), grants: give });
  return cards;
}

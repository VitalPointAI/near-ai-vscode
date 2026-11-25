// The Staff Room's live model (Phase 33, D-06, D-12, D-21 to D-26, D-44, D-48, D-59, D-67, D-69; DESIGN 10.5 and 19). Pure and host-neutral: no I/O,
// no clock, no editor API. It turns what the live engine knows about one shared work into the plain data the native Staff Room draws: who is here,
// the sync sentence and its one action, the offline banner, the cards that ask for a decision, and one row per product. Every sentence a person reads
// is a constant here or in liveSentences.ts, so the widget holds no text of its own and the copy lint reads them all.
//
// Words follow the glossary: "your organization's server", "changes", "Who can see this", the mode's own people and lead words from term(), and
// "shared work" for the folder (D-69: Defence text never calls it a project).
import { trustLine } from '../gate/trust';
import type { TrustFacts } from '../gate/trust';
import type { ScaleTable } from '../gate/labels';
import { term } from '../org/terms';
import type { ModeId } from '../org/modes';
import type { RosterState } from '../replica/roster';
import { deviceAt, memberAt } from '../replica/rosterMembers';
import type { SyncState } from '../replica/syncMachine';
import { presenceText, SYNC_WORDS, syncAccessibleName, syncAction, syncSentence } from './liveSentences';
import type { SentenceStatus, SyncAction } from './liveSentences';
import { GIVE_KEYS_ACTION_TEXT, MOVE_CARD_EXPLAIN_TEXT, MOVE_CARD_TEXT, MOVE_NOW_TEXT, MOVE_WAITING_TEXT, SWITCH_CARD_TEXT, SWITCH_NOT_READY_TEXT } from './wrapSwitchModel';
import type { WrapCard } from './wrapSwitchModel';

/** D-23: the banner while offline, word for word. */
export const OFFLINE_BANNER_TEXT = 'You are offline. Your changes are kept here and will sync when your organization\'s server is back. Decisions you make now may become contested if someone else decides the same thing.';

/** D-23: a decision folded after the newest checkpoint. */
export const UNCONFIRMED_TEXT = 'not yet confirmed by your organization\'s server';

/** D-12: a join request a lead or deputy compares with the person. {name} and {code} are filled in. */
export const JOIN_REQUEST_TEXT = '{name} wants to join. Compare this code with them: {code}';

/** A join request whose name and code this computer has not fetched yet. */
export const JOIN_WAITING_TEXT = 'Someone wants to join. Admit shows their name and the code to compare with them.';

/** D-25: the owner's prompt after about 20 changes since a version. {version} and {title} are filled in; never a withdrawal. */
export const OWNER_PROMPT_TEXT = '{version} of {title} has {count} changes since. Propose a new version when the text is ready.';

/** D-48: shared work made shared by 0.4.35, whose products sit in its base key group. */
export const EARLY_SHARE_COPY_TEXT = 'This shared work was made shared by an earlier version of SovAI, so its products sit where your organization\'s server reads them. Make a single-machine copy and share that copy again.';

/** "Who can see this" (glossary): the people cleared for the product's label. */
export const WHO_CAN_SEE_TEXT = 'Who can see this';

/** When nobody but this person can see a product yet. */
export const ONLY_YOU_TEXT = 'Only you';

/** Each action's label, as a button shows it. */
export const STAFF_ROOM_ACTION_TEXT = Object.freeze({
  share: 'Share with People',
  'sync-now': 'Sync Now',
  'show-details': 'Show Details',
  readmit: 'Re-admit Your Organization\'s Server',
  'update-extension': 'Show Details',
  admit: 'Admit',
  decline: 'Decline',
  choose: 'Choose This Change',
  propose: 'Propose a New Version',
  dismiss: 'Not Now',
  'make-copy': 'Make a Single-Machine Copy'
});

/** One person in the people list (livePresence.ts PresencePerson, as the engine hands it). */
export interface StaffRoomPersonInput {
  readonly member: string;
  readonly name: string;
  readonly position?: string;
  readonly live: boolean;
  readonly lastSeen: number;
  readonly product?: string;
  readonly runs?: number;
}

/** A contested version (contested.ts ContestedCard). */
export interface StaffRoomContestedInput {
  readonly product: string;
  readonly hash: string;
  readonly number: number;
  readonly text: string;
  readonly decisions: ReadonlyArray<{ readonly name: string; readonly outcome: string; readonly reasons: readonly string[] }>;
  readonly actions: ReadonlyArray<{ readonly outcome: 'approve' | 'reject'; readonly label: string }>;
}

/** A version and the changes made since it (contested.ts ChangesSinceRow). */
export interface StaffRoomVersionInput {
  readonly product: string;
  readonly hash: string;
  readonly number: number;
  readonly text: string;
  readonly changesSince: number;
  readonly ownerPromptDue: boolean;
}

export interface StaffRoomProductInput {
  readonly product: string;
  readonly title?: string;
  /** The product's label as the label service shows it. */
  readonly label?: string;
  /** The names of the people cleared for its label. */
  readonly whoCanSee: readonly string[];
  /** True when this person's position owns the product. */
  readonly owned?: boolean;
}

export interface StaffRoomLiveInput {
  readonly mode?: ModeId;
  readonly status: SentenceStatus;
  /** Changes still to exchange while catching up. */
  readonly remaining?: number;
  /** A lead or deputy device: only it sees join requests and roster splits. */
  readonly isLeadDevice: boolean;
  readonly people: readonly StaffRoomPersonInput[];
  readonly products: readonly StaffRoomProductInput[];
  readonly versions: readonly StaffRoomVersionInput[];
  readonly contested: readonly StaffRoomContestedInput[];
  /** Versions with a decision after the newest checkpoint (contested.ts pendingConfirmation). */
  readonly unconfirmed: ReadonlyArray<{ readonly product: string; readonly hash: string }>;
  readonly joins: ReadonlyArray<{ readonly invite: string; readonly name?: string; readonly code?: string }>;
  /** Roster splits not chosen yet, each branch with the sentence that says what it changes. */
  readonly splits: ReadonlyArray<{ readonly at: string; readonly text: string; readonly branches: ReadonlyArray<{ readonly hash: string; readonly text: string }> }>;
  /** Agent runs on this shared work; the trust line shows only where TrustFacts exist (D-44). */
  readonly agents: ReadonlyArray<{ readonly run: string; readonly name: string; readonly trust?: TrustFacts }>;
  readonly scales?: ScaleTable;
  /** D-48: shared work made shared by 0.4.35, with products in its base key group. */
  readonly earlyShareCopyNeeded?: boolean;
  /** Owner prompts this person put away this session, as product and hash. */
  readonly dismissed?: readonly string[];
  /** The switch to post-quantum keys (33.2 D-05): this computer's next step, as wrapSwitchCards gives it. */
  readonly wrapCards?: readonly WrapCard[];
}

export interface StaffRoomAction {
  readonly id: SyncAction | 'admit' | 'decline' | 'choose' | 'approve' | 'reject' | 'propose' | 'dismiss' | 'make-copy'
    | 'switch-keys' | 'move-keys' | 'move-keys-now' | 'give-keys';
  readonly label: string;
  /** The button's accessible name: the label with what it acts on. */
  readonly accessibleName: string;
  readonly product?: string;
  readonly hash?: string;
  readonly invite?: string;
  readonly branch?: string;
}

export interface StaffRoomPerson {
  readonly member: string;
  readonly name: string;
  readonly position?: string;
  readonly live: boolean;
  /** "Live", "Working on ...", or "Last seen HH:MM": the dot is never the only carrier of state. */
  readonly presence: string;
  readonly accessibleName: string;
}

export type StaffRoomCard =
  | { readonly kind: 'update'; readonly id: string; readonly text: string; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'early-share-copy'; readonly id: string; readonly text: string; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'contested'; readonly id: string; readonly text: string; readonly decisions: StaffRoomContestedInput['decisions']; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'join'; readonly id: string; readonly text: string; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'roster-split'; readonly id: string; readonly text: string; readonly branches: ReadonlyArray<{ readonly text: string; readonly action: StaffRoomAction }>; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'owner-prompt'; readonly id: string; readonly text: string; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'agent'; readonly id: string; readonly text: string; readonly trustLine?: string; readonly actions: readonly StaffRoomAction[] }
  | { readonly kind: 'switch-keys' | 'move-keys' | 'give-keys'; readonly id: string; readonly text: string; readonly actions: readonly StaffRoomAction[] };

export interface StaffRoomRow {
  readonly product: string;
  readonly title: string;
  /** "v5 awaiting decision, 37 changes since" for the newest version, when there is one. */
  readonly version?: string;
  readonly label?: string;
  /** "Who can see this: ..." */
  readonly whoCanSee: string;
  /** UNCONFIRMED_TEXT when a decision on the newest version waits for your organization's server. */
  readonly unconfirmed?: string;
  readonly accessibleName: string;
}

export interface StaffRoomLiveView {
  /** The mode's word for the people list. */
  readonly peopleHeading: string;
  readonly people: readonly StaffRoomPerson[];
  readonly bar: {
    readonly state: SyncState;
    readonly word: string;
    readonly sentence: string;
    readonly action: StaffRoomAction;
    readonly accessibleName: string;
  };
  readonly banner?: string;
  readonly cards: readonly StaffRoomCard[];
  readonly rows: readonly StaffRoomRow[];
}

const fill = (text: string, values: Readonly<Record<string, string>>): string => text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

function action(id: StaffRoomAction['id'], label: string, about: string, extra: Partial<StaffRoomAction> = {}): StaffRoomAction {
  return { id, label, accessibleName: about === '' ? label : `${label}: ${about}`, ...extra };
}

/** The newest version of each product, by number. */
function newestVersions(versions: readonly StaffRoomVersionInput[]): Map<string, StaffRoomVersionInput> {
  const out = new Map<string, StaffRoomVersionInput>();
  for (const version of versions) {
    const known = out.get(version.product);
    if (known === undefined || version.number > known.number) out.set(version.product, version);
  }
  return out;
}

/**
 * The switch to post-quantum keys as Staff Room cards (33.2 D-05, D-11): each with its sentence and at least one way forward. Move moves the ready
 * parts first; while some wait, its other action moves them now and leaves their late computers to Give keys.
 */
function wrapCardsOf(cards: readonly WrapCard[]): StaffRoomCard[] {
  return cards.map((card): StaffRoomCard => {
    if (card.kind === 'switch') {
      const names = card.notReady.length === 0 ? '' : ` ${SWITCH_NOT_READY_TEXT} ${card.notReady.join(', ')}.`;
      return { kind: 'switch-keys', id: 'switch-keys', text: `${card.explain}${names}`, actions: [action('switch-keys', SWITCH_CARD_TEXT, '')] };
    }
    if (card.kind === 'move') {
      return {
        kind: 'move-keys', id: 'move-keys', text: card.waiting.length === 0 ? MOVE_CARD_EXPLAIN_TEXT : `${MOVE_CARD_EXPLAIN_TEXT} ${MOVE_WAITING_TEXT}`,
        actions: [
          ...(card.ready.length === 0 ? [] : [action('move-keys', MOVE_CARD_TEXT, '')]),
          ...(card.waiting.length === 0 ? [] : [action('move-keys-now', MOVE_NOW_TEXT, '')]),
        ],
      };
    }
    return { kind: 'give-keys', id: 'give-keys', text: card.text, actions: [action('give-keys', GIVE_KEYS_ACTION_TEXT, '')] };
  });
}

/** The Staff Room of one shared work, as plain data. */
export function staffRoomLive(input: StaffRoomLiveInput): StaffRoomLiveView {
  const { mode, status } = input;
  const titles = new Map(input.products.map((product) => [product.product, product.title ?? product.product]));
  const titleOf = (product: string): string => titles.get(product) ?? product;
  const context = { mode, isLeadDevice: input.isLeadDevice, ...(input.remaining === undefined ? {} : { remaining: input.remaining }) };

  const people = [...input.people]
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name))
    .map((person): StaffRoomPerson => {
      const presence = presenceText(person, titleOf);
      return {
        member: person.member, name: person.name, ...(person.position === undefined ? {} : { position: person.position }), live: person.live, presence,
        accessibleName: [person.name, person.position, presence].filter((part) => part !== undefined && part !== '').join(', '),
      };
    });

  const syncId = syncAction(status, context);
  const sentence = syncSentence(status, context);
  const bar = {
    state: status.state, word: SYNC_WORDS[status.state], sentence,
    action: action(syncId, STAFF_ROOM_ACTION_TEXT[syncId], ''),
    accessibleName: syncAccessibleName(status, context),
  };

  const cards: StaffRoomCard[] = [];
  if (status.state === 'needs-update') cards.push({ kind: 'update', id: 'update', text: sentence, actions: [] });
  if (input.earlyShareCopyNeeded === true) {
    cards.push({ kind: 'early-share-copy', id: 'early-share-copy', text: EARLY_SHARE_COPY_TEXT, actions: [action('make-copy', STAFF_ROOM_ACTION_TEXT['make-copy'], '')] });
  }
  for (const card of input.contested) {
    const version = `v${card.number}`;
    cards.push({
      kind: 'contested', id: `contested:${card.product}:${card.hash}`, text: card.text, decisions: card.decisions,
      actions: card.actions.map((item) => action(item.outcome, item.label, `${version} of ${titleOf(card.product)}`, { product: card.product, hash: card.hash })),
    });
  }
  if (input.isLeadDevice) {
    for (const join of input.joins) {
      const text = join.name !== undefined && join.code !== undefined ? fill(JOIN_REQUEST_TEXT, { name: join.name, code: join.code }) : JOIN_WAITING_TEXT;
      const who = join.name ?? '';
      cards.push({
        kind: 'join', id: `join:${join.invite}`, text,
        actions: [action('admit', STAFF_ROOM_ACTION_TEXT.admit, who, { invite: join.invite }), action('decline', STAFF_ROOM_ACTION_TEXT.decline, who, { invite: join.invite })],
      });
    }
    for (const split of input.splits) {
      cards.push({
        kind: 'roster-split', id: `split:${split.at}`, text: split.text, actions: [],
        branches: split.branches.map((branch) => ({ text: branch.text, action: action('choose', STAFF_ROOM_ACTION_TEXT.choose, branch.text, { branch: branch.hash }) })),
      });
    }
  }
  cards.push(...wrapCardsOf(input.wrapCards ?? []));
  const newest = newestVersions(input.versions);
  const dismissed = new Set(input.dismissed ?? []);
  for (const product of input.products) {
    const version = newest.get(product.product);
    if (version === undefined || !version.ownerPromptDue || product.owned !== true || dismissed.has(`${version.product}:${version.hash}`)) continue;
    const title = titleOf(product.product);
    cards.push({
      kind: 'owner-prompt', id: `prompt:${version.product}:${version.hash}`,
      text: fill(OWNER_PROMPT_TEXT, { version: `v${version.number}`, title, count: String(version.changesSince) }),
      actions: [action('propose', STAFF_ROOM_ACTION_TEXT.propose, title, { product: product.product }), action('dismiss', STAFF_ROOM_ACTION_TEXT.dismiss, title, { product: product.product, hash: version.hash })],
    });
  }
  for (const agent of input.agents) {
    const line = agent.trust !== undefined && input.scales !== undefined ? trustLine(agent.trust, input.scales).text : undefined;
    cards.push({ kind: 'agent', id: `agent:${agent.run}`, text: agent.name, ...(line === undefined ? {} : { trustLine: line }), actions: [] });
  }

  const unconfirmed = new Set(input.unconfirmed.map((item) => `${item.product}:${item.hash}`));
  const rows = input.products.map((product): StaffRoomRow => {
    const version = newest.get(product.product);
    const title = titleOf(product.product);
    const whoCanSee = `${WHO_CAN_SEE_TEXT}: ${product.whoCanSee.length === 0 ? ONLY_YOU_TEXT : product.whoCanSee.join(', ')}`;
    const waiting = version !== undefined && unconfirmed.has(`${version.product}:${version.hash}`) ? UNCONFIRMED_TEXT : undefined;
    return {
      product: product.product, title, whoCanSee,
      ...(version === undefined ? {} : { version: version.text }),
      ...(product.label === undefined ? {} : { label: product.label }),
      ...(waiting === undefined ? {} : { unconfirmed: waiting }),
      accessibleName: [title, version?.text, product.label, whoCanSee, waiting].filter((part) => part !== undefined).join('. '),
    };
  });

  return {
    peopleHeading: term('people', mode), people, bar,
    ...(status.state === 'offline' && status.reason !== 'restoring' ? { banner: OFFLINE_BANNER_TEXT } : {}),
    cards, rows,
  };
}

/** A member's name in the roster at the roster hash `at` (as contestedCards asks for it), or undefined when the roster does not know it. */
export function memberNameAt(roster: RosterState, member: string, at: string): string | undefined {
  const position = roster.positionOf.get(at);
  return position === undefined ? undefined : memberAt(roster.members, member, position)?.name;
}

/**
 * The names of the people who can see what `stream` holds at the roster head (glossary "Who can see this"): the members whose devices hold the key
 * group's current key. A stream the roster has no key group for (the base of the shared work) is seen by every current member. Sorted, each once.
 */
export function whoCanSee(roster: RosterState, stream: string): string[] {
  const head = roster.positions.length - 1;
  const names = new Set<string>();
  const record = roster.cells.cells.get(stream);
  if (record === undefined) {
    for (const member of roster.members.members.keys()) {
      const name = memberAt(roster.members, member, head)?.name;
      if (name !== undefined) names.add(name);
    }
  } else {
    const epoch = record.epochs.at(-1)?.epoch;
    for (const grant of record.grants) {
      if (grant.epoch !== epoch) continue;
      for (const writer of grant.writers) {
        const device = deviceAt(roster.members, writer, head);
        const name = device === undefined || device.kind !== 'person' ? undefined : memberAt(roster.members, device.member, head)?.name;
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

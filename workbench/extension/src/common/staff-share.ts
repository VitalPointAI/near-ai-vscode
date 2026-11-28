/**
 * Share with people (Phase 33 D-10, D-13, D-21, D-42, D-58; 33-27), as the browser sees it: the RPC path, the view of the open staff project's
 * sharing and the actions. Every action runs in the backend over the executed Phase 31 and 32 flows and the Phase 33 server actions; the browser
 * sends choices and opaque confirmation requests, and receives sentences, safety words and files to save. No key, token or grant crosses. Nothing here
 * imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const MANAGED_KEY_FILE_EXTENSION = '.near-staff-keys';
export const MANAGED_KEY_FILE_MAX_BYTES = 12 * 1024 * 1024;

export const STAFF_SHARE_PATH = '/services/sterling-staff-share';
export const StaffShareServer = Symbol('StaffShareServer');

/** A person in the shared work, as the roster names them. */
export interface SharePerson {
  readonly member: string;
  readonly name: string;
  readonly seat?: string;
}

/** A part of the shared work (a cell) with its label as this computer reads it, and whether your organization's server holds it. */
export interface SharePart {
  readonly cell: string;
  readonly label: string;
  readonly onServer: boolean;
}

/** Your organization's server for this shared work: its id, the twelve words of its certificate to compare, and the address this computer uses. */
export interface ShareServer {
  readonly hub: string;
  readonly standing: 'admitted' | 'revoked';
  readonly words: readonly string[];
  readonly address?: string;
}

export interface ShareView {
  /** no-project: the open folder holds no staff project; not-shared: a staff project on this computer only; shared: shared work. */
  readonly state: 'no-project' | 'not-shared' | 'shared';
  readonly project?: string;
  /** True when this computer may change who is in the shared work (a lead or deputy device). */
  readonly lead: boolean;
  readonly people: readonly SharePerson[];
  readonly parts: readonly SharePart[];
  readonly managedKeyFiles?: readonly ManagedKeyFileChoice[];
  readonly canOpenManagedKeyFile?: true;
  readonly keyChanges?: readonly Pick<SharePart, 'cell' | 'label'>[];
  readonly server?: ShareServer;
  /** "Show others what I am working on" (D-21), on unless the person turned it off. */
  readonly showWork: boolean;
}

export interface ManagedKeyFileChoice {
  readonly cell: string;
  readonly label: string;
  readonly recipients: readonly { readonly writer: string; readonly label: string }[];
}
export interface SaveManagedKeyFileInput { readonly project: string; readonly cell: string; readonly recipient: string; readonly repeat?: string }
export interface OpenManagedKeyFileInput { readonly project: string; readonly text: string }

/** An uncommitted action review page. */
export interface ShareConfirmation { readonly requestId: string; readonly url: string }

/** An action result with any associated notices, file, safety words, or confirmation. */
export interface ShareOutcome {
  readonly confirmation?: ShareConfirmation;
  readonly message: string;
  readonly notices: readonly string[];
  readonly fileRepeat?: string;
  readonly file?: { readonly name: string; readonly text: string };
  readonly safetyWords?: readonly string[];
  /** Conversion only: each product left out with the way out (conversionNotice.ts, D-31). */
  readonly withheld?: readonly string[];
}

/** A join request waiting at your organization's server, for a lead to compare and admit. text is the request file, passed back to admit. */
export interface ShareJoinRequest {
  readonly invite: string;
  readonly name: string;
  readonly safetyWords: readonly string[];
  readonly text: string;
}

export interface InviteInput {
  readonly name: string;
  readonly seat: string;
  /** The clearance the lead declares for the person (Phase 70 shape). */
  readonly clearance: unknown;
  readonly days?: number;
}

export interface StaffShareServer {
  view(): Promise<ServiceResult<ShareView>>;
  /** Shares the open staff project: converts it, arms the feature check, and makes this person (their person key in a hosted session) its lead. */
  turnOn(input: { readonly clearance?: unknown }): Promise<ServiceResult<ShareOutcome>>;
  /** Connects your organization's server from the hub file its operator gave. */
  connectServer(input: { readonly hubFile: string; readonly ceiling?: unknown }): Promise<ServiceResult<ShareOutcome>>;
  invite(input: InviteInput): Promise<ServiceResult<ShareOutcome>>;
  /** Opens an invitation file: makes this computer's join request and sends it through your organization's server when the invitation names it. */
  openInvitation(input: { readonly text: string; readonly name: string }): Promise<ServiceResult<ShareOutcome>>;
  /** Opens the welcome file the lead returned: the shared work opens here. */
  openWelcome(input: { readonly text: string }): Promise<ServiceResult<ShareOutcome>>;
  joinRequests(): Promise<ServiceResult<readonly ShareJoinRequest[]>>;
  /** Admits the person of a join request; refused unless the lead confirmed the six words matched. */
  admit(input: { readonly request: string; readonly codeMatched: boolean }): Promise<ServiceResult<ShareOutcome>>;
  remove(input: { readonly member: string; readonly requestId?: string }): Promise<ServiceResult<ShareOutcome>>;
  saveManagedKeys(input: SaveManagedKeyFileInput): Promise<ServiceResult<ShareOutcome>>;
  openManagedKeys(input: OpenManagedKeyFileInput): Promise<ServiceResult<ShareOutcome>>;
  finishKeyChange(input: { readonly cell: string; readonly requestId?: string }): Promise<ServiceResult<ShareOutcome>>;
  /** Gives your organization's server one part; refused unless the lead confirmed STAFF_SHARE_TEXT.tradeOff, shown word for word first. */
  grant(input: { readonly cell: string; readonly confirmed: boolean }): Promise<ServiceResult<ShareOutcome>>;
  /** Removes your organization's server from this shared work; every part it held moves to a new key. */
  revoke(): Promise<ServiceResult<ShareOutcome>>;
  /** Changes the address this computer reaches your organization's server at; the pin is kept and checked at the next connection. */
  changeAddress(input: { readonly address: string }): Promise<ServiceResult<ShareOutcome>>;
  /** Trusts your organization's server again after comparing its twelve words (D-42). certPin: the pin compared, the roster's when absent. */
  readmit(input: { readonly words: string; readonly certPin?: string }): Promise<ServiceResult<ShareOutcome>>;
  /** Makes a single-machine copy in another folder and names what it left out. */
  singleCopy(input: { readonly destination: string }): Promise<ServiceResult<ShareOutcome>>;
  setShowWork(on: boolean): Promise<ServiceResult<boolean>>;
}

/** Every sentence of Share with people that is not the engine's own: no em-dashes, "your organization's server", the product short name SovAI. */
export const STAFF_SHARE_TEXT = {
  title: 'Share with people',
  intro: 'Work on this staff work with other people through your organization\'s server. Everyone sees the same work, and each person signs their own changes.',
  noProject: 'Open a folder with staff work to share it with people.',
  notShared: 'This staff work is on this computer only.',
  turnOn: 'Share this work',
  shared: 'This staff work is shared. Connect your organization\'s server, then invite people.',
  connect: 'Connect your organization\'s server',
  invite: 'Invite a person',
  openInvitation: 'Open an invitation',
  openWelcome: 'Open a welcome file',
  joinRequests: 'Check join requests',
  openJoinRequest: 'Open a join request file',
  admit: 'Admit',
  wordsMatch: 'The six words match',
  remove: 'Remove',
  reviewRemoval: 'Review removal',
  finishRemoval: 'Finish removal',
  removalReady: 'Review and confirm the removal, then return here to finish it.',
  removalNeedsReview: 'Start the removal again to confirm it for the current shared work.',
  managedKeyFiles: 'Key files',
  managedKeyRecipient: 'Device',
  saveManagedKeys: 'Save key file',
  repeatManagedKeys: 'Save the same key file again',
  openManagedKeys: 'Open a key file',
  managedKeyFileTooLarge: 'This key file is too large to open.',
  managedKeyFileProjectChanged: 'Open the shared work you selected and try the key file again.',
  managedKeyFileUnavailable: 'A key file is unavailable for this part and device in the current shared work.',
  managedKeyFileRepeatUnavailable: 'This copy is no longer available. Select the part and device to prepare a new file.',
  managedKeyFileSaved: 'Give this key file directly to the selected device’s owner.',
  keyChanges: 'Pending key changes',
  startKeyChange: 'Start key change',
  reviewKeyChange: 'Review key change',
  finishKeyChange: 'Finish key change',
  keyChangeReady: 'Review and confirm the key change for this part, then return here to finish it.',
  keyChangeNeedsReview: 'Start the key change again to confirm it for the current shared work.',
  keyChangeUnavailable: 'This computer cannot prepare a key change for this part from the current record of access.',
  removalUnavailable: 'This computer cannot prepare the removal from the current record of who has access.',
  grant: 'Give this part to the server',
  revoke: 'Remove your organization\'s server',
  changeAddress: 'Change your organization\'s server address',
  readmit: 'Trust your organization\'s server again',
  readmitHelp: 'Compare these twelve words with the person who runs your organization\'s server. Type them below only if they match.',
  singleCopy: 'Make a single-machine copy',
  showWork: 'Show others what I am working on',
  // hubMembership.ts HUB_GRANT_TRADE_OFF, word for word (DESIGN 10.2); the workbench test checks the copy.
  tradeOff: 'The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer.',
  notOpen: 'This shared work is not open in this session yet. Wait a moment and try again.',
  notLead: 'Only a lead or deputy can do this. Ask your lead.',
  noServer: 'Connect your organization\'s server first.',
  badAddress: 'That is not an address of your organization\'s server. Give the name and port its operator published, such as server.example.org:8443.',
  addressChanged: 'This computer now reaches your organization\'s server at the new address. Its certificate is checked at the next connection, as before.',
  showWorkOn: 'Others see what you are working on.',
  showWorkOff: 'Others see only that you are here.',
  // The section's own sentences (33-27), kept here so the widgets hold none of their own (33-26 D-69).
  noBackend: 'SovAI could not reach its backend. Try again.',
  noJoinRequest: 'No join request is waiting at your organization\'s server.',
  noAddress: 'This computer has no address for it yet.',
  worksUntil: (day: string): string => `The invitation works until ${day}.`,
  reachesAt: (address: string): string => `This computer reaches it at ${address}.`,
} as const;

/** What the invitation open handler says about a file it does not open (33-27). */
export const INVITE_OPEN_TEXT = {
  tooLarge: 'This file is larger than an invitation can be, so it was not opened. Ask the person who sent it for a new file.',
  unreadable: 'This file could not be read as an invitation. Ask the person who sent it for a new file.',
} as const;

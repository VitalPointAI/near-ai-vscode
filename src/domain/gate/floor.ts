// The floor (GATE-05, D-16, D-17, D-44): what the gate refuses, or asks a person about, in every mode and every context. Pure: no I/O, no clock, no vscode,
// no package, and nothing from src/agent. Nothing a person sets, no bundle value and no approval mode turns a floor rule into an allowance: a refusal rule
// refuses with no card, an ask rule asks with no "always allow" and no run-wide grant (the gate, in decide.ts, enforces that; this file only names the rule).
import { PROTECTED_WRITE, STATE_KEYS_PATH, namesStateKeys, normalizeRelative, protectedWriteReason, stateKeysReason } from '../protectedPaths';
import type { Capability } from './vocabulary';

/** What each rule does. `refuse` means no card and no way through; `ask` means a person is asked, with no shortcut offered. */
export const FLOOR_RULES = Object.freeze({
  'floor.state-keys': 'refuse',
  'floor.credential-store': 'refuse',
  'floor.identity-files': 'refuse',
  'floor.protected-write': 'ask',
  'floor.publish': 'ask',
  'floor.destroy': 'ask',
  'floor.shared-write': 'ask'
} as const);
export type FloorRule = keyof typeof FLOOR_RULES;
export type FloorKind = (typeof FLOOR_RULES)[FloorRule];

/**
 * The order rules are tried in, so one call always records the same rule. Refusals come first, so a refusal wins over an ask when both match, and inside
 * each group the order is the order they are listed here.
 */
export const FLOOR_RULE_ORDER: readonly FloorRule[] = Object.freeze([
  'floor.state-keys', 'floor.credential-store', 'floor.identity-files', 'floor.protected-write', 'floor.publish', 'floor.destroy', 'floor.shared-write'
] as const);

const TEAM_SETTINGS_FILE = '.planning/.near-ai/team.md';

/**
 * Whether a write to this project-relative path always asks: everything PROTECTED_WRITE covers, except the one file the team builder and Team Studio write
 * on purpose, `.planning/.near-ai/team.md` at the project root (D-44). The exemption is that one path after `.` and `..` are folded away, so `team.md.bak`
 * and `labels.json` beside it are covered, a copy of the file inside a nested folder (`sub/.planning/.near-ai/team.md`) or above the root asks, and a
 * `.github/` folder is not a `.git` folder.
 */
export function isFloorProtectedWrite(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized === TEAM_SETTINGS_FILE) return false;
  return PROTECTED_WRITE.test(normalized);
}

export interface FloorVerdict {
  readonly rule: FloorRule;
  readonly kind: FloorKind;
  /** One plain sentence for the person. */
  readonly reason: string;
}

// The credential stores outside the project (D-16, research 4.2). Home-relative, so each is matched after `~/`, `$HOME/`, `${HOME}/` or the literal home folder.
// A whole folder is named by its folder; a single file by its file. Workspace files such as `.env` are not here: they stay with the settings layer (D-18).
// The research's "proposed additions" (A5: gh hosts.yml, cargo credentials, terraform credentials, keyring folders, token printers) are NOT added: they are
// an owner question carried to the PR 3 body.
export const CREDENTIAL_STORES: readonly string[] = Object.freeze([
  '.near-credentials', '.ssh', '.aws', '.config/gcloud', '.azure', '.docker/config.json', '.netrc', '.git-credentials', '.gnupg', '.kube', '.npmrc', '.pypirc',
  '.near-kb', '.kbkey'
]);

/** VS Code's own secrets database, matched by file name anywhere: it holds the encrypted SecretStorage, which includes the device key. */
export const VSCODE_SECRET_FILES: readonly string[] = Object.freeze(['state.vscdb', 'state.vscdb.backup']);

/** Commands that print a secret from the operating system's keychain. */
export const KEYCHAIN_COMMANDS: readonly string[] = Object.freeze([
  'security find-generic-password', 'security find-internet-password', 'security dump-keychain', 'security export', 'secret-tool lookup', 'secret-tool search'
]);

/** The folders of this extension's global storage that hold its identity and its gate files (the signing key history and lock, the policy bundle and the logs). */
export const EXTENSION_STORAGE_FOLDERS: readonly string[] = Object.freeze(['identity', 'gate']);

/** The portable form of the extension's storage folder: VS Code lowercases the extension id (publisher VitalPoint, name near-ai-vscode). */
export const EXTENSION_STORAGE_TEXT = 'globalStorage/vitalpoint.near-ai-vscode';

/** What the floor's text checks cannot see, in the floor's own words (the same honesty as namesStateKeys). Shown wherever the floor is described. */
export const FLOOR_CANNOT_SEE_TEXT =
  'The checks that keep agents out of key and credential folders read the text of a command. They cannot see a path built while the command runs, a program that reads a store for you (for example git credential fill), a walk down from a parent folder or a folder change followed by a bare file name, or anything an add-on server or the cyber host tools do inside themselves. There is no operating-system sandbox around the shell yet, so a determined command can still get past them.';

/** Where the person's home folder and this extension's global storage are, as the adapter knows them. Both are optional: the portable text forms always match. */
export interface FloorLocations {
  readonly home?: string;
  readonly globalStorage?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function forwardSlashes(text: string): string {
  return text.replace(/\\/g, '/');
}

function trimmedFolder(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  const clean = forwardSlashes(folder.trim()).replace(/\/+$/, '');
  return clean === '' ? undefined : clean;
}

/** A name ends here: the end of text, a separator, a quote, a shell operator or a glob character. A letter, digit, dot, dash or underscore continues a longer name. */
const NAME_END = '(?![\\w.-])';
const HOME_PREFIX = '(?:(?<![\\w.~-])~|(?<![\\w$])\\$\\{HOME\\}|(?<![\\w$])\\$HOME(?!\\w))["\']?/+';

function homePrefix(locations: FloorLocations): string {
  const home = trimmedFolder(locations.home);
  return home === undefined ? HOME_PREFIX : `(?:${HOME_PREFIX}|(?<![\\w./-])${escapeRegExp(home)}/+)`;
}

function firstMatch(pattern: RegExp, text: string): string | undefined {
  const found = pattern.exec(text);
  return found === null ? undefined : found[0].trim().slice(0, 120);
}

function credentialReason(shown: string): string {
  return `${shown} names a place where passwords, keys or tokens are kept. Agents may not read, write, list or run anything there, in any approval mode.`;
}

/**
 * Whether the text of a command names a credential store outside the project: a store folder or file after `~/`, `$HOME/`, `${HOME}/` or the literal home
 * folder, VS Code's secrets database by name, or a keychain command that prints a secret. A heuristic, and an honest one (see FLOOR_CANNOT_SEE_TEXT): it
 * reads text only and never runs anything. Returns a plain reason, or undefined.
 */
export function namesCredentialStore(text: string, locations: FloorLocations = {}): string | undefined {
  const flat = forwardSlashes(text);
  const stores = new RegExp(`${homePrefix(locations)}(?:${CREDENTIAL_STORES.map(escapeRegExp).join('|')})${NAME_END}`, 'i');
  const secrets = new RegExp(`(?<![\\w.-])(?:${VSCODE_SECRET_FILES.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})${NAME_END}`, 'i');
  const keychain = new RegExp(`(?<![\\w.-])(?:${KEYCHAIN_COMMANDS.map((command) => command.split(' ').map(escapeRegExp).join('\\s+')).join('|')})(?![\\w-])`, 'i');
  const shown = firstMatch(stores, flat) ?? firstMatch(secrets, flat) ?? firstMatch(keychain, flat);
  return shown === undefined ? undefined : credentialReason(shown);
}

/** Whether the text of a command names the identity or gate folder of this extension's global storage, by the portable form or by the real folder. */
export function namesIdentityFiles(text: string, locations: FloorLocations = {}): string | undefined {
  const flat = forwardSlashes(text);
  const folders = EXTENSION_STORAGE_FOLDERS.map(escapeRegExp).join('|');
  const bases = [escapeRegExp(EXTENSION_STORAGE_TEXT)];
  const real = trimmedFolder(locations.globalStorage);
  if (real !== undefined) bases.push(escapeRegExp(real));
  const pattern = new RegExp(`(?:${bases.join('|')})/+(?:${folders})${NAME_END}`, 'i');
  const shown = firstMatch(pattern, flat);
  return shown === undefined ? undefined : `${shown} is where NEAR AI keeps this device's signing keys and its policy and decision records. Agents may not read, write, list or run anything there, in any approval mode.`;
}

/** Facts the caller already knows. Each carries the plain reason, or is true for the one that needs none. */
export interface FloorFacts {
  readonly stateKeys?: string;
  readonly credentialStore?: string;
  readonly identityFiles?: string;
  readonly protectedWrite?: string;
  /** Set from `fromActionCapability` when the shorthand was `sharedWrite` (the shared team knowledge store). */
  readonly sharedWrite?: boolean;
}

/** What `floorFor` reads from a request. The gate's own request type extends this. */
export interface FloorInput {
  readonly effects: readonly Capability[];
  /** The shell command, when the tool runs one. */
  readonly command?: string;
  /** Today's `tool.forbidden` hook: the reason the key folder was named. */
  readonly forbidden?: string;
  readonly floorFacts?: FloorFacts;
}

function pathsOf(capability: Capability): readonly string[] {
  return capability.verb === 'read' || capability.verb === 'workspaceWrite' || capability.verb === 'destroy' ? capability.paths : [];
}

function stateKeysMatch(input: FloorInput): string | undefined {
  if (input.forbidden !== undefined && input.forbidden !== '') return input.forbidden;
  if (input.floorFacts?.stateKeys !== undefined) return input.floorFacts.stateKeys;
  for (const effect of input.effects) {
    for (const shown of pathsOf(effect)) {
      if (STATE_KEYS_PATH.test(normalizeRelative(shown))) return stateKeysReason(shown);
    }
  }
  return input.command !== undefined && namesStateKeys(input.command) ? stateKeysReason(input.command) : undefined;
}

function protectedWriteMatch(input: FloorInput): string | undefined {
  if (input.floorFacts?.protectedWrite !== undefined) return input.floorFacts.protectedWrite;
  for (const effect of input.effects) {
    if (effect.verb !== 'workspaceWrite' && effect.verb !== 'destroy') continue;
    for (const shown of effect.paths) {
      if (isFloorProtectedWrite(shown)) return protectedWriteReason(shown) ?? `${shown} is a protected place. Approve this write only if you expect it.`;
    }
  }
  return undefined;
}

const PUBLISH_REASON = 'This sends or publishes something outside this computer, where it may not be undone. It always needs a person to approve it, in every mode.';
const DESTROY_REASON = 'This deletes or rewrites something that may not come back. It always needs a person to approve it, in every mode.';
const SHARED_WRITE_REASON = 'This writes to knowledge your team shares, which every member and later run reads. It always needs a person to approve it, in every mode.';

function effectMatch(input: FloorInput, matches: (effect: Capability) => boolean, reason: string): string | undefined {
  return input.effects.some(matches) ? reason : undefined;
}

/**
 * The first floor rule, in FLOOR_RULE_ORDER, that this call matches, or undefined. A pure function of the request and the two locations: no I/O, so every
 * decision is the same with or without a network. A workspace credential-file read (`.env`) is never a floor verdict (D-18).
 */
export function floorFor(input: FloorInput, locations: FloorLocations = {}): FloorVerdict | undefined {
  const command = input.command;
  const facts = input.floorFacts;
  const matched = new Map<FloorRule, string>();
  const set = (rule: FloorRule, reason: string | undefined): void => { if (reason !== undefined) matched.set(rule, reason); };
  set('floor.state-keys', stateKeysMatch(input));
  set('floor.credential-store', facts?.credentialStore ?? (command === undefined ? undefined : namesCredentialStore(command, locations)));
  set('floor.identity-files', facts?.identityFiles ?? (command === undefined ? undefined : namesIdentityFiles(command, locations)));
  set('floor.protected-write', protectedWriteMatch(input));
  set('floor.publish', effectMatch(input, (effect) => effect.verb === 'publish' || effect.verb === 'send', PUBLISH_REASON));
  set('floor.destroy', effectMatch(input, (effect) => effect.verb === 'destroy', DESTROY_REASON));
  set('floor.shared-write', facts?.sharedWrite === true ? SHARED_WRITE_REASON : effectMatch(input, (effect) => effect.verb === 'skill.write' && effect.scope === 'team', SHARED_WRITE_REASON));
  for (const rule of FLOOR_RULE_ORDER) {
    const reason = matched.get(rule);
    if (reason !== undefined) return Object.freeze({ rule, kind: FLOOR_RULES[rule], reason });
  }
  return undefined;
}

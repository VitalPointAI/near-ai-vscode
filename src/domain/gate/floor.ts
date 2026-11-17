// The floor (GATE-05, D-16, D-17, D-44): what the gate refuses, or asks a person about, in every mode and every context. Pure: no I/O, no clock, no vscode,
// no package, and nothing from src/agent. Nothing a person sets, no bundle value and no approval mode turns a floor rule into an allowance: a refusal rule
// refuses with no card, an ask rule asks with no "always allow" and no run-wide grant (the gate, in decide.ts, enforces that; this file only names the rule).
import { PROTECTED_WRITE, STATE_KEYS_PATH, namesStateKeys, normalizeRelative, protectedWriteReason, stateKeysReason } from '../protectedPaths';
import { coversPath } from './pathCover';
import type { Capability } from './vocabulary';

/** What each rule does. `refuse` means no card and no way through; `ask` means a person is asked, with no shortcut offered. */
export const FLOOR_RULES = Object.freeze({
  'floor.state-keys': 'refuse',
  'floor.credential-store': 'refuse',
  'floor.identity-files': 'refuse',
  'floor.protected-write': 'ask',
  'floor.publish': 'ask',
  'floor.credential-change': 'ask',
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
  'floor.state-keys', 'floor.credential-store', 'floor.identity-files', 'floor.protected-write', 'floor.publish', 'floor.credential-change', 'floor.destroy',
  'floor.shared-write'
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
  return PROTECTED_WRITE.test(normalized) || holdsProtectedPlace(normalized);
}

// A folder name covers everything under it (owner-confirmed 2026-11-16, PR #70 review), so a write or delete of a whole folder that holds a protected place is a
// write to that place: `.planning` holds `.planning/.near-ai`, and `.near-ai` holds its state. These are one file in each project-root folder the rule protects.
// A glob, the project root and a folder that climbs out are left to the path check above: they name no one folder, and the root always has been `**`.
const PROTECTED_PLACES: readonly string[] = Object.freeze(['.planning/.near-ai/settings.json', '.near-ai/state/meta.json']);

function holdsProtectedPlace(normalized: string): boolean {
  if (normalized === '' || normalized.startsWith('..') || /[*?[{]/.test(normalized)) return false;
  return PROTECTED_PLACES.some((place) => coversPath(normalized, place));
}

export interface FloorVerdict {
  readonly rule: FloorRule;
  readonly kind: FloorKind;
  /** One plain sentence for the person. */
  readonly reason: string;
}

// The credential stores outside the project (D-16, research 4.2). Home-relative, so each is matched after `~/`, `$HOME/`, `${HOME}/` or the literal home folder.
// A whole folder is named by its folder; a single file by its file. Workspace files such as `.env` are not here: they stay with the settings layer (D-18).
// The research's additions (A5) were approved by the owner after PR #74: the GitHub CLI's hosts file, cargo's credentials, terraform's, the GitLab and hub
// CLIs', RubyGems', the desktop keyring folder and yarn's home settings (which can hold a registry token).
export const CREDENTIAL_STORES: readonly string[] = Object.freeze([
  '.near-credentials', '.ssh', '.aws', '.config/gcloud', '.azure', '.docker/config.json', '.netrc', '.git-credentials', '.gnupg', '.kube', '.npmrc', '.pypirc',
  '.near-kb', '.kbkey',
  '.config/gh/hosts.yml', '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d/credentials.tfrc.json', '.config/glab-cli', '.config/hub', '.gem/credentials',
  '.local/share/keyrings', '.yarnrc.yml'
]);

/**
 * VS Code's own secrets database: it holds the encrypted SecretStorage, which includes the device key. Matched only where VS Code keeps it (PR #74 review),
 * never by file name anywhere, so a project file of the same name is the project's: in a folder named `globalStorage`, or `workspaceStorage/<id>`, in any
 * VS Code's layout, and anywhere under this VS Code's own user-data folder when its global storage is known (vscodeStorageRoots).
 */
export const VSCODE_SECRET_FILES: readonly string[] = Object.freeze(['state.vscdb', 'state.vscdb.backup']);

/**
 * The folders where this VS Code keeps its secrets database, from this extension's global storage (`<user data>/User/globalStorage/<extension id>`): the
 * global storage folder that holds it, and, in that standard layout, the user-data folder above (which also holds `workspaceStorage`). Forward slashes.
 */
export function vscodeStorageRoots(globalStorage: string | undefined): string[] {
  const storage = trimmedFolder(globalStorage);
  if (storage === undefined) return [];
  const parent = storage.slice(0, storage.lastIndexOf('/'));
  if (parent === '') return [];
  const roots = [parent];
  const grandparent = parent.slice(0, parent.lastIndexOf('/'));
  if (parent.slice(parent.lastIndexOf('/') + 1).toLowerCase() === 'globalstorage' && grandparent !== '') roots.push(grandparent);
  return roots;
}

/** The folder a call works in, and the shell's folder for a command: a path that resolves inside the project is the project's own (PR #74 review round 11). */
export interface FloorWorkspace {
  readonly root: string;
  readonly cwd?: string;
}

/**
 * Whether a path as written resolves inside the project: from the shell's folder (or the project) for a relative path, with `~` and `$HOME` read as the
 * home folder. Another variable, or a home folder nobody gave, is not known to be inside. Text only: nothing is opened. Forward slashes throughout.
 */
export function resolvesInsideWorkspace(written: string, workspace: FloorWorkspace, locations: FloorLocations = {}): boolean {
  let text = forwardSlashes(written.trim().replace(/^["']+|["']+$/g, ''));
  const home = trimmedFolder(locations.home);
  const homeForm = /^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/.exec(text);
  if (homeForm) {
    if (home === undefined) return false;
    text = `${home}${text.slice(homeForm[0].length)}`;
  }
  if (text.includes('$') || text === '') return false;
  const root = trimmedFolder(workspace.root);
  if (root === undefined) return false;
  const absolute = text.startsWith('/') || /^[A-Za-z]:\//.test(text);
  const base = trimmedFolder(workspace.cwd) ?? root;
  const resolved = normalizeSlashes(absolute ? text : `${base}/${text}`);
  return resolved === root || resolved.startsWith(`${root}/`);
}

/** `a/./b/../c` as `a/c`, on forward slashes, keeping a leading `/` or drive. */
function normalizeSlashes(text: string): string {
  const lead = /^(?:[A-Za-z]:)?\/?/.exec(text)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of text.slice(lead.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return `${lead}${parts.join('/')}`.replace(/\/+$/, '') || lead;
}

/** The written path a match sits in: the match back to the start of its word (a space, a quote, a shell operator, `=`). */
function wordAround(text: string, index: number, end: number): string {
  let start = index;
  while (start > 0 && !/[\s'"`;&|()<>=]/.test(text[start - 1]!)) start -= 1;
  return text.slice(start, end);
}

/**
 * VS Code's secrets database where VS Code keeps it: after its storage folder names in any VS Code's layout (unless the path resolves inside the project,
 * where a folder of that name is the project's own), or under one of this VS Code's own storage folders. The match as written, or undefined.
 */
function namesVscodeSecrets(text: string, locations: FloorLocations, workspace: FloorWorkspace | undefined): string | undefined {
  const names = VSCODE_SECRET_FILES.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
  const real = vscodeStorageRoots(locations.globalStorage).map((root) => `(?<![\\w./-])${escapeRegExp(root)}/+(?:[^\\s'"]*/+)?`);
  if (real.length > 0) {
    const own = firstMatch(new RegExp(`(?:${real.join('|')})(?:${names})${NAME_END}`, 'i'), text);
    if (own !== undefined) return own;
  }
  const portable = new RegExp(`(?<![\\w.-])(?:globalStorage|workspaceStorage/+[^/\\s'"]+)/+(?:${names})${NAME_END}`, 'gi');
  for (const match of text.matchAll(portable)) {
    const at = match.index ?? 0;
    const written = wordAround(text, at, at + match[0].length);
    if (workspace !== undefined && resolvesInsideWorkspace(written, workspace, locations)) continue;
    return written.trim().slice(0, 120);
  }
  return undefined;
}

/** Commands that print a secret from the operating system's keychain. */
export const KEYCHAIN_COMMANDS: readonly string[] = Object.freeze([
  'security find-generic-password', 'security find-internet-password', 'security dump-keychain', 'security export', 'secret-tool lookup', 'secret-tool search'
]);

/** The plain reason for a command that prints a stored login or token (refused as `floor.credential-store`). */
export function printerReason(shown: string): string {
  return `${shown} prints a stored password, key or token. Agents may not run it, in any approval mode.`;
}

/** The folders of this extension's global storage that hold its identity and its gate files (the signing key history and lock, the policy bundle and the logs). */
export const EXTENSION_STORAGE_FOLDERS: readonly string[] = Object.freeze(['identity', 'gate']);

/** The portable form of the extension's storage folder: VS Code lowercases the extension id (publisher VitalPoint, name near-ai-vscode). */
export const EXTENSION_STORAGE_TEXT = 'globalStorage/vitalpoint.near-ai-vscode';

/**
 * What the floor's checks of key and credential folders cannot see, in the floor's own words (the same honesty as namesStateKeys). Shown wherever the floor
 * is described; SECURITY.md carries it word for word. It says what the code does: the text of the command, each word resolved from the shell's folder and from
 * any `cd` or `pushd` earlier in the same command (shellReachesCredentialStore), and nothing a script or program does once it runs.
 */
export const FLOOR_CANNOT_SEE_TEXT =
  'The checks that keep agents out of key and credential folders read the text of a command, following the shell\'s folder and any cd or pushd earlier in the same command. They cannot see a path built while the command runs (from a variable or $(...)), what a script or an npm script the command starts does, a program that reads a store for you (for example git credential fill), a walk down from a parent folder, or anything an add-on server or the cyber host tools do inside themselves. There is no operating-system sandbox around the shell yet, so a determined command can still get past them. Because they read text, a command that only mentions one of these folders (a commit message that names ~/.ssh, say) is refused too, with nothing to approve: rephrase the command so it does not name the folder, or do that step yourself.';

/**
 * What the checks that find publishing, destruction and protected writes in a shell command cannot see (classifyCommand's effect tags, plan 16): a command
 * they cannot read has no tag, so under fully-autonomous it runs without asking. One they stop reading (the nesting bound, the length caps, a program they
 * do not know with a flagged command after it) has unknown effects instead, and asks (PR #74 review). SECURITY.md carries it word for word; gateDocs checks each named gap is real and each named stop asks.
 */
export const FLOOR_EFFECTS_CANNOT_SEE_TEXT =
  'The checks that find publishing, destruction and protected writes in a shell command also read its text, through npm, yarn, pnpm and bun scripts (from the package.json of the folder the command runs in, after any cd on the line) and wrappers such as bash -c, sudo, xargs, pipes, subshells, timeout, nice, stdbuf, flock and watch. They do not see a command built while it runs (bash -c "$CMD"), a file run with source or piped into sh, or a script written or changed earlier on the same line (it is read as it was before the line ran). Under fully-autonomous such a command runs without asking. A command nested more than four levels deep, too long to read, one they cannot parse (a quote left open, say), one with an option they do not know where they would read what it runs, running a package script in a folder they cannot tell or whose package.json they cannot read, or started by a program they do not know with a command they would flag among the words after it, is not guessed at: it asks, and it is refused when nobody is there to answer.';

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

/** The plain reason for `floor.credential-store`, naming the store as the command reached it. */
export function credentialReason(shown: string): string {
  return `${shown} names a place where passwords, keys or tokens are kept. Agents may not read, write, list or run anything there, in any approval mode.`;
}

/** The plain reason for `floor.identity-files`, naming the folder as the command reached it. */
export function identityFilesReason(shown: string): string {
  return `${shown} is where NEAR AI keeps this device's signing keys and its policy and decision records. Agents may not read, write, list or run anything there, in any approval mode.`;
}

/**
 * Whether the text of a command names a credential store outside the project: a store folder or file after `~/`, `$HOME/`, `${HOME}/` or the literal home
 * folder, VS Code's secrets database where VS Code keeps it, or a keychain command that prints a secret. A heuristic, and an honest one (see FLOOR_CANNOT_SEE_TEXT): it
 * reads text only and never runs anything. Returns a plain reason, or undefined.
 */
export function namesCredentialStore(text: string, locations: FloorLocations = {}, workspace?: FloorWorkspace): string | undefined {
  const flat = forwardSlashes(text);
  const stores = new RegExp(`${homePrefix(locations)}(?:${CREDENTIAL_STORES.map(escapeRegExp).join('|')})${NAME_END}`, 'i');
  const keychain = new RegExp(`(?<![\\w.-])(?:${KEYCHAIN_COMMANDS.map((command) => command.split(' ').map(escapeRegExp).join('\\s+')).join('|')})(?![\\w-])`, 'i');
  const shown = firstMatch(stores, flat) ?? namesVscodeSecrets(flat, locations, workspace) ?? firstMatch(keychain, flat);
  // The commands that print a stored token are found by how the command runs (the classifier's printsCredential), not by their words anywhere in the
  // text, so a commit message or a search that mentions one is not refused (PR #76 review round 3).
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
  return shown === undefined ? undefined : identityFilesReason(shown);
}

/** Facts the caller already knows. Each carries the plain reason, or is true for the one that needs none. */
export interface FloorFacts {
  readonly stateKeys?: string;
  readonly credentialStore?: string;
  readonly identityFiles?: string;
  readonly protectedWrite?: string;
  /** Set from `fromActionCapability` when the shorthand was `sharedWrite` (the shared team knowledge store). */
  readonly sharedWrite?: boolean;
  /**
   * The command signs in or out of a registry or account, or changes a stored login or token (owner decision after PR #74): what it is, in a sentence.
   * It is not an effect of the vocabulary (it may send nothing anywhere); it changes the credentials kept on this computer, so a person is asked.
   */
  readonly credentialChange?: string;
}

/** What `floorFor` reads from a request. The gate's own request type extends this. */
export interface FloorInput {
  readonly effects: readonly Capability[];
  /** The shell command, when the tool runs one. */
  readonly command?: string;
  /** Today's `tool.forbidden` hook: the reason the key folder was named. */
  readonly forbidden?: string;
  readonly floorFacts?: FloorFacts;
  /** The project and the shell's folder, so a path inside the project named like VS Code's storage is read as the project's own. */
  readonly workspace?: FloorWorkspace;
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
      if (isFloorProtectedWrite(shown)) return protectedWriteReason(shown) ?? `${shown} holds this project's NEAR AI settings or saved state, so changing the whole folder changes them. Approve this write only if you expect it.`;
    }
  }
  return undefined;
}

const PUBLISH_REASON = 'This sends or publishes something outside this computer, where it may not be undone. It always needs a person to approve it, in every mode.';
const DESTROY_REASON = 'This deletes or rewrites something that may not come back. It always needs a person to approve it, in every mode.';
const CREDENTIAL_CHANGE_REASON = 'It changes the logins or tokens kept on this computer. It always needs a person to approve it, in every mode.';
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
  set('floor.credential-store', facts?.credentialStore ?? (command === undefined ? undefined : namesCredentialStore(command, locations, input.workspace)));
  set('floor.identity-files', facts?.identityFiles ?? (command === undefined ? undefined : namesIdentityFiles(command, locations)));
  set('floor.protected-write', protectedWriteMatch(input));
  set('floor.publish', effectMatch(input, (effect) => effect.verb === 'publish' || effect.verb === 'send', PUBLISH_REASON));
  set('floor.credential-change', facts?.credentialChange === undefined ? undefined : `${facts.credentialChange} ${CREDENTIAL_CHANGE_REASON}`);
  set('floor.destroy', effectMatch(input, (effect) => effect.verb === 'destroy', DESTROY_REASON));
  set('floor.shared-write', facts?.sharedWrite === true ? SHARED_WRITE_REASON : effectMatch(input, (effect) => effect.verb === 'skill.write' && effect.scope === 'team', SHARED_WRITE_REASON));
  for (const rule of FLOOR_RULE_ORDER) {
    const reason = matched.get(rule);
    if (reason !== undefined) return Object.freeze({ rule, kind: FLOOR_RULES[rule], reason });
  }
  return undefined;
}

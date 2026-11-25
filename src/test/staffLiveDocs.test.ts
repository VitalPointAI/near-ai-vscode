// The documents about live multi-user staff projects say what was built (33-15, D-36, D-32, D-33, D-67): README, SECURITY.md, the operator guide in
// relay/README.md, the workbench README and the CHANGELOG. The fixed sentences are imported from the code, never copied, and every label a section
// names in bold is a contributed command (resolved through package.json) or a string the built staff code shows. Pure: reads the repository's own files, no vscode.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import { multiUserNoticeLines } from '../domain/staff/multiUser';
import { UPDATE_SENTENCE } from '../domain/replica/features';
import { SESSION_REFUSALS } from '../domain/replica/sessionKeys';
import { OFFLINE_BANNER_TEXT, WHO_CAN_SEE_TEXT } from '../domain/staff/staffRoomLive';
import { RESTORING_TEXT, SYNC_WORDS } from '../domain/staff/liveSentences';
import { FULL_REPLAY_SENTENCE, SESSION_EXPIRED_SENTENCE } from '../staff/replica/hubSync';
import { CHANGED_WHILE_DECIDING_TEXT } from '../staff/replica/versionActs';
import { HUB_GRANT_TRADE_OFF } from '../staff/replica/hubMembership';
import { countHits } from './helpers/copyLintScan';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const README = read('README.md');
const SECURITY = read('SECURITY.md');
const RELAY = read('relay/README.md');
const WORKBENCH = read('workbench/README.md');
const CHANGELOG = read('CHANGELOG.md');
const MANIFEST = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };

const EM_DASH = '—';
const README_HEADING = '### Work on a staff project with other people';
const SECURITY_HEADING = '## Multi-user staff projects';
const HUB_HEADING = "## Your organization's sync hub";

// Limit 2 of the hub section as it stood on the base (32's text): D-32 keeps it word for word.
const LIMIT_TWO = '**Limit: a checkpoint nobody received.** If the hub signed a checkpoint that no member\'s computer received, and later checkpoints come '
  + 'after it, a restore that loses it cannot be mended by members: the hub signs nothing more for that project until it is started again on a state '
  + 'whose checkpoints agree. Changes still sync; members\' computers in time report the hub as delayed.';

// From a heading line to the next heading of the same or a higher level (or the end of the file).
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${heading} exists`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  const body = text.slice(start + 1);
  const next = body.slice(heading.length + 1).search(new RegExp(`\\n#{1,${String(level)}} `));
  return next < 0 ? body : body.slice(0, heading.length + 1 + next);
}

const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** Every TypeScript source under a folder, as one text with \' unescaped, so a label is found as the string literal the code shows. */
function sourcesOf(...folders: string[]): string {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
      const rel = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(rel);
    }
  };
  for (const folder of folders) walk(folder);
  return files.map(read).join('\n').replace(/\\'/g, '\'');
}

const BUILT_LABELS = sourcesOf('workbench/extension/src/common', 'workbench/extension/src/browser/staff', 'src/domain/staff');
const COMMAND_TITLES = new Set(MANIFEST.contributes.commands.map((command) => `${command.category ?? ''}: ${command.title}`));

/** The bold labels of a section that are not a SovAI command each appear as a string literal in the built staff code. */
function assertBuiltLabels(section: string, where: string): void {
  const labels = [...flat(section).matchAll(/\*\*([^*]+)\*\*/g)].map((match) => (match[1] ?? '').trim());
  const buttons = labels.filter((label) => !/[.:]$/.test(label));
  assert.ok(buttons.length >= 5, `${where} names the actions people use`);
  for (const label of buttons) {
    if (label.startsWith('SovAI: ')) assert.ok(COMMAND_TITLES.has(label), `${where}: ${label} is a contributed command`);
    else assert.ok(BUILT_LABELS.includes(`'${label}'`), `${where}: "${label}" is a label the built code shows`);
  }
}

/** The copy rules the documents keep (no em-dash, bare team, compliance claim, old product name or provider before organization). */
function assertCopy(section: string, file: string, rules: readonly string[]): void {
  const hits = countHits([{ text: flat(section) }], file)[file] ?? {};
  for (const rule of rules) assert.equal((hits as Record<string, number | undefined>)[rule], undefined, `${file}: ${rule}`);
}

const readmeSection = (): string => sectionOf(README, README_HEADING);
const multiUser = (): string => sectionOf(SECURITY, SECURITY_HEADING);
const hub = (): string => sectionOf(SECURITY, HUB_HEADING);

// ---- README ----

test('README has "Work on a staff project with other people" once, in the Sterling workbench section, with the three notices word for word', () => {
  assert.equal(README.split(`\n${README_HEADING}\n`).length - 1, 1);
  const workbench = sectionOf(README, '## The Sterling workbench');
  assert.ok(workbench.includes(README_HEADING), 'inside the workbench section');
  assert.ok(CLEARANCE_SELF_ASSERTED_TEXT.startsWith('Until verified credentials arrive'));
  for (const line of [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, ...multiUserNoticeLines()]) assert.ok(flat(readmeSection()).includes(line), line);
});

test('README no longer calls several people on one staff project a preview, names no preview setting, and points the staff paragraph to the section', () => {
  assert.doesNotMatch(flat(README), /Several people on their own computers sharing one staff project is a preview/);
  assert.ok(!README.includes('nearAi.staff.multiUserPreview'));
  assert.ok(!README.includes('live editing across computers comes in a later release'));
  assert.ok(flat(README).includes('see **Work on a staff project with other people**'), 'the staff paragraph points to the section');
});

test('the README section says how to start and join, what people see and that your organization runs the server, with the code\'s sentences', () => {
  const text = flat(readmeSection());
  for (const phrase of ['Share with people', 'invitation file', 'six words', 'passkey or security key', "your organization's server", 'operator',
    'undo', 'Staff Room', 'contested', 'status bar']) assert.ok(text.includes(phrase), phrase);
  for (const sentence of [OFFLINE_BANNER_TEXT, UPDATE_SENTENCE, WHO_CAN_SEE_TEXT]) assert.ok(text.includes(sentence), sentence);
  for (const word of [SYNC_WORDS.live, SYNC_WORDS.offline, SYNC_WORDS.attention]) assert.ok(text.includes(`"${word}"`), word);
});

test('the README section states what is not in SovAI yet: who else is here, cursors, Show Who Wrote This, and the late joiner\'s two limits (G430)', () => {
  const text = flat(readmeSection());
  assert.ok(text.includes('the Staff Room lists only you for now'), 'presence is not run by the native engine yet (G435)');
  assert.ok(text.includes("other people's cursors") && text.includes('Show Who Wrote This'), 'not built natively');
  assert.ok(text.includes(FULL_REPLAY_SENTENCE), 'a part the server keeps no summary of is read in full, and the person is told so');
  assert.ok(text.includes('complete only once the earlier history has arrived'), 'the text waits for the earlier history');
});

test('every label the README section names in bold is a contributed command or a label the built staff code shows, and the section keeps the copy rules', () => {
  assertBuiltLabels(readmeSection(), 'README');
  assertCopy(readmeSection(), 'README.md', ['em-dash', 'bare-team', 'compliance-claim', 'product-name', 'provider-organization', 'brand']);
});

// ---- SECURITY.md ----

test('SECURITY.md titles the section "Multi-user staff projects" (no preview), turns sharing on per project and drops the preview switch', () => {
  assert.ok(!SECURITY.includes('## Multi-user staff projects (preview)'));
  assert.equal(SECURITY.split(`\n${SECURITY_HEADING}\n`).length - 1, 1);
  const text = flat(multiUser());
  assert.ok(!text.includes('Off unless you turn it on'));
  assert.ok(!text.includes('nearAi.staff.multiUserPreview'));
  assert.ok(text.includes('**Share with people**') && text.includes('A project that never shares behaves exactly as before.'));
  for (const line of multiUserNoticeLines()) assert.ok(text.includes(line), line);
  assertCopy(multiUser(), 'SECURITY.md', ['em-dash', 'compliance-claim', 'product-name', 'provider-organization']);
});

test('the live path: local first, sealed changes relayed by your organization\'s server, checked on arrival, decisions stamped and contested ones kept', () => {
  const text = flat(sectionOf(SECURITY, '### Live sharing through your organization\'s server'));
  for (const phrase of ['first', 'sealed', 'checks each change', 'contested', 'Neither applies']) assert.ok(text.includes(phrase), phrase);
  for (const sentence of [OFFLINE_BANNER_TEXT, CHANGED_WHILE_DECIDING_TEXT]) assert.ok(text.includes(sentence), sentence);
  assert.ok(text.includes('undo') && text.includes('header'), 'the editor binding: undo of your own changes, the header kept');
  assert.ok(text.includes('The browser receives') && text.includes('never a key'), 'Yjs and the cell keys stay in the session backend');
});

test('hosted sessions: the person key in your organization\'s key store signs decisions and roster changes after a fresh confirmation; session keys sign typing and end', () => {
  const text = flat(sectionOf(SECURITY, '### Keys in a hosted session'));
  for (const phrase of ['passkey or security key', 'session.certify', '12 hours', '24 hours', 'four', 'Transit', 'key-encryption key', 'X25519', 'memory'])
    assert.ok(text.includes(phrase), phrase);
  for (const sentence of [SESSION_REFUSALS['person-key-required'], SESSION_EXPIRED_SENTENCE]) assert.ok(text.includes(sentence), sentence);
  assert.ok(text.includes('not yet bound to the one action'), 'G440, stated as a limit');
  assert.ok(text.includes('any key that signed'), 'G441, stated as a limit');
});

test('presence is advisory, sealed per part, never stored and never evidence, and SovAI does not send it yet', () => {
  const text = flat(sectionOf(SECURITY, '### Presence')).toLowerCase();
  for (const phrase of ['advisory', 'sealed', 'never stored', 'never evidence', 'own part', 'does not send it yet']) assert.ok(text.includes(phrase), phrase);
});

test('roster.require: a project requires features, a computer without one stops with the update sentence and keeps everything, a 0.4.35 computer stalls, the server refuses', () => {
  const text = flat(sectionOf(SECURITY, '### Required features and older versions'));
  const hubSentence = 'This shared work needs a newer version of your organization\'s server. Ask its operator to update it.';
  assert.ok(read('hub/src/append/checks.ts').replace(/\\'/g, '\'').includes(`'${hubSentence}'`), 'the hub\'s own sentence');
  for (const sentence of [UPDATE_SENTENCE, hubSentence]) assert.ok(text.includes(sentence), sentence);
  for (const phrase of ['roster.require', 'keeps every entry', '0.4.35', 'refuses', 'session']) assert.ok(text.includes(phrase), phrase);
});

test('the late joiner\'s two limits (G430) are stated plainly in SECURITY.md', () => {
  const text = flat(sectionOf(SECURITY, '### A person who joins late'));
  assert.ok(text.includes(FULL_REPLAY_SENTENCE));
  for (const phrase of ['checkpoint', 'granted', 'read in full', 'complete only once the earlier history has arrived']) assert.ok(text.includes(phrase), phrase);
});

test('the sync hub section: SovAI connects to it, restore mode replaces limit 1, Re-admit your organization\'s server, limit 2 word for word, the remaining limits', () => {
  const text = flat(hub());
  assert.ok(!flat(SECURITY).includes("editor's hub commands"));
  assert.ok(!text.includes('the editor cannot connect a project to it until a later release'));
  assert.ok(text.includes('**Connect your organization\'s server**'));
  for (const phrase of ['restore mode', 'restore-mode', RESTORING_TEXT, 'not followed']) assert.ok(text.includes(phrase), phrase);
  assert.ok(text.includes("Re-admit your organization's server") && text.includes('twelve words') && text.includes('deputy'));
  assert.ok(text.includes(LIMIT_TWO), 'limit 2 is kept word for word');
  const remaining = flat(sectionOf(SECURITY, '### Limits that remain'));
  for (const phrase of ['cannot open', '64 KiB', 'recompute', 'deleted']) assert.ok(remaining.includes(phrase), phrase);
  assert.ok(text.includes(HUB_GRANT_TRADE_OFF), 'the grant trade-off stays word for word');
  assert.ok(text.includes('session.certify') || text.includes('session key'), 'session keys at the server');
  assertCopy(hub(), 'SECURITY.md', ['em-dash', 'compliance-claim', 'product-name']);
});

// ---- relay/README.md ----

test('the operator guide no longer says people cannot connect from the editor or that re-admitting comes later, and keeps the restore marker step', () => {
  const guide = sectionOf(RELAY, HUB_HEADING);
  const text = flat(guide);
  for (const old of ['People cannot connect a staff project to it from the editor yet', 'When members can connect projects from the editor',
    "arrives with the editor's hub commands", 'The editor command the staff lead uses for this arrives in a later release'])
    assert.ok(!text.includes(old), old);
  assert.ok(!/This release ships the hub for operators only/.test(text));
  assert.ok(text.includes("Re-admit your organization's server"));
  assert.ok(text.includes('**Connect your organization\'s server**'));
  assert.ok(sectionOf(RELAY, '### The restore drill').includes('restore-mode'), 'the drill keeps 33-07\'s marker step');
  assert.ok(!guide.includes(EM_DASH));
});

// ---- workbench/README.md and CHANGELOG.md ----

test('the workbench README lists STERLING_WORKBENCH and every staff live service path the image serves', () => {
  const table = sectionOf(WORKBENCH, '## Interface with Phase 47');
  assert.ok(table.includes('`STERLING_WORKBENCH`'));
  const paths = [...sourcesOf('workbench/extension/src/common').matchAll(/export const STAFF_[A-Z_]*PATH = '([^']+)'/g)].map((match) => match[1] ?? '');
  assert.ok(paths.length >= 4, 'status, binding, Staff Room and Share with people');
  for (const servicePath of paths) assert.ok(table.includes(`\`${servicePath}\``), servicePath);
});

test('CHANGELOG ## Unreleased has a section for working on a staff project with other people, in people\'s words and labels the code shows', () => {
  assert.ok(CHANGELOG.indexOf('\n## Unreleased\n') >= 0 && CHANGELOG.indexOf('\n## Unreleased\n') < CHANGELOG.indexOf('\n## 0.4.39\n'), 'above the last release');
  const unreleased = sectionOf(CHANGELOG, '## Unreleased');
  const section = sectionOf(unreleased, '### Work on a staff project with other people');
  const text = flat(section);
  for (const phrase of ['Share with people', 'undo', 'Staff Room', 'contested', 'offline', 'status bar', "Re-admit your organization's server", 'operator'])
    assert.ok(text.includes(phrase), phrase);
  assert.ok(text.includes(UPDATE_SENTENCE));
  assertBuiltLabels(section, 'CHANGELOG');
  assertCopy(section, 'CHANGELOG.md', ['em-dash', 'bare-team', 'compliance-claim', 'product-name', 'provider-organization', 'brand']);
});

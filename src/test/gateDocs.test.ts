// The docs say what the code does (OFFL-02, D-27, D-34): SECURITY.md and README carry the exact strings the code owns (the clearance is self-declared, a
// manifest is a claim, a local server runs with your permissions), name the two commands as the package contributes them, and match the code's numbers.
// The new sections have no em-dash and never say "NEAR organization". Pure: reads the repository's own files, no vscode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import { CONNECTION_BINDING_TEXT, DEFAULT_ROUTING } from '../domain/gate/routing';
import { BADGE_CHECK_TIMEOUT_MS, TRUST_BADGE_STATES, TRUST_BADGE_TEXT, TRUST_BADGE_TITLES } from '../domain/gate/trustBadge';
import { NOT_CHECKED_IN_EDITOR } from '../services/attestation';
import { USE_BRANCH_LABELS_ACTION } from '../gate/labelMapStore';
import { FLOOR_CANNOT_SEE_TEXT, FLOOR_EFFECTS_CANNOT_SEE_TEXT, namesCredentialStore } from '../domain/gate/floor';
import { classifyCommand, MAX_COMMAND_LENGTH, MAX_NESTING } from '../agent/commandSafety';
import { BUNDLE_FAILURES } from '../domain/gate/bundle';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT } from '../domain/gate/words';
import { MAX_DECISION_LOG_BYTES, MAX_ROTATED_FILES, MODEL_REQUESTS_DIR } from '../gate/decisionLog';
import { redactCredentialArguments } from '../domain/redaction';
import { OUTBOUND_EARLIER_TEXT, OUTBOUND_LIMITS_TEXT, OUTBOUND_REOPENED_DOCS_TEXT, OUTBOUND_UNCHECKED_TEXT } from '../agent/outboundCheck';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import { ENROLMENT_FILE_EXTENSION, ISSUER_WORDS_DOMAIN, ISSUER_WORDS_MATCH, MAX_ENROLMENT_FILE_BYTES, issuerWordsPrompt, issuerWordsQuestion, organizationEndedText } from '../domain/gate/enrolment';

const ROOT = path.resolve(__dirname, '..', '..');
const SECURITY = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };

const EM_DASH = '—';
const POLICY_HEADING = '### Your policy file and decision records';
const BADGE_HEADING = '### The trust badge on each answer';

// From a heading line to the next heading of the same or a higher level (or the end of the file).
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${heading} exists`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  const body = text.slice(start + 1);
  const next = body.slice(heading.length + 1).search(new RegExp(`\\n#{1,${String(level)}} `));
  return next < 0 ? body : body.slice(0, heading.length + 1 + next);
}

function commandName(id: string): string {
  const entry = MANIFEST.contributes.commands.find((command) => command.command === id);
  assert.ok(entry, `${id} is contributed`);
  return `${entry.category ?? ''}: ${entry.title}`;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const policySection = sectionOf(SECURITY, POLICY_HEADING);
const mcpSection = sectionOf(SECURITY, '## MCP connections');
const readmeMcp = sectionOf(README, '### MCP connections');
const readmePolicy = README.slice(README.indexOf('- **Your Standing Orders.**'), README.indexOf("- API keys live in VS Code's encrypted"));

test('SECURITY.md has the policy section once, after "What the agent can do without asking" and before the sub-agent section', () => {
  assert.equal(SECURITY.split(POLICY_HEADING).length - 1, 1);
  const here = SECURITY.indexOf(POLICY_HEADING);
  assert.ok(SECURITY.indexOf('### What the agent can do without asking') < here);
  assert.ok(here < SECURITY.indexOf('### Sub-agents nobody is watching'));
});

test('the policy section carries the code\'s clearance text word for word, and that text still begins "Until verified credentials arrive"', () => {
  assert.ok(CLEARANCE_SELF_ASSERTED_TEXT.startsWith('Until verified credentials arrive'));
  assert.ok(policySection.includes(CLEARANCE_SELF_ASSERTED_TEXT));
});

test('README names the current Standing Orders actions and recorded failure text describes the scope of reset', () => {
  // D-44 (41-14): Show and Reset remain contributed off the palette.
  const reset = commandName('nearAi.policy.reset');
  const show = commandName('nearAi.policy.show');
  const policy = commandName('nearAi.policy.open');
  assert.equal(reset, 'SovAI: Reset Standing Orders to Defaults');
  assert.equal(show, 'SovAI: Show Standing Orders');
  assert.equal(policy, 'SovAI: Standing Orders');
  assert.ok(flat(readmePolicy).includes(`**${policy}**`));
  assert.ok(flat(readmePolicy).includes('**Reset my Standing Orders**'), 'the page\'s reset');
  assert.ok(flat(readmePolicy).includes('**Show as stored**'), 'the page\'s stored view');
  assert.ok(flat(policySection).includes('**Show as stored**'), 'the security guide covers the stored view');
  assert.ok(flat(README).includes(policy) && flat(README).includes('Reset my Standing Orders'));
  // Every failure sentence that offers a reset names the policy page and says it resets your own rules (D-21).
  for (const sentence of Object.values(BUNDLE_FAILURES)) {
    if (/reset/i.test(sentence)) assert.ok(sentence.includes('Open SovAI: Policy and choose Reset my rules') && sentence.includes('it resets your own rules only'), sentence);
  }
});

test('the policy section says what the code does: own storage not the project, own device key (created at activation in every folder), default allows what settings allow, only the command re-signs, no network, records redacted and not synced, and routing by label is described in its own section', () => {
  for (const phrase of [
    "this extension's own storage",
    'never in your project',
    'Your own device key',
    "creates this install's device identity in every folder",
    'because it signs the first policy file',
    'allows what your settings allow',
    'only reading and planning run',
    'Deleting the file does not reset a policy',
    'Only **Reset my rules** re-signs a policy that failed, and it resets your own rules only',
    'keeps the old file beside the new one',
    'records the reset',
    'Nothing in a decision needs the network',
    'before a record is written SovAI removes',
    'Records are not synced',
    'Where a labelled chat\'s content may be sent is in [Classification labels and routing](#classification-labels-and-routing)'
  ]) {
    assert.ok(flat(policySection).includes(phrase), phrase);
  }
});

test('the numbers in the policy section match the decision log\'s own limits', () => {
  assert.equal(MAX_DECISION_LOG_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_ROTATED_FILES, 4);
  assert.match(flat(policySection), /rolls over at about 5 MB and keeps the last four older files/);
});

test('SECURITY.md\'s MCP section says what plan 10 shipped: declared tools, restrictive new servers, a local server runs with your permissions, a manifest is a claim', () => {
  assert.ok(mcpSection.includes(MANIFEST_IS_A_CLAIM_TEXT));
  assert.ok(mcpSection.includes(RUNS_ON_THIS_MACHINE_TEXT));
  assert.match(mcpSection, /Servers added from this version on/);
  assert.match(mcpSection, /"What it does" menu/);
  assert.match(flat(mcpSection), /An undeclared tool asks before every call in every mode, `fully-autonomous` included/);
  assert.doesNotMatch(flat(mcpSection), /every mode except `fully-autonomous`/);
  assert.match(mcpSection, /behave as they did/);
  // PR #76 review round 3: a local server's declaration is a statement of trust, said plainly, and never claimed to keep the floor in charge of its calls.
  const trust = 'A declaration is your statement that you trust what that server\'s tools do: the gate does not check each call\'s arguments against it, so a declared tool runs without asking in Full auto. Only declare servers you trust like your own code.';
  assert.ok(flat(mcpSection).includes(trust), 'SECURITY.md');
  assert.ok(flat(readmeMcp).includes(trust), 'README MCP section');
  assert.ok(flat(README).includes(`| \`nearAi.mcp.localServerEffects\` | \`{}\` |`) && flat(README).includes(trust), 'README settings row');
  assert.doesNotMatch(flat(SECURITY), /cannot be declared, so the floor still decides them/);
  const setting = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { markdownDescription?: string }> } | Array<{ properties: Record<string, { markdownDescription?: string }> }> } }).contributes.configuration;
  const described = (Array.isArray(setting) ? setting : [setting]).map((block) => block.properties['nearAi.mcp.localServerEffects']?.markdownDescription).find((text) => text !== undefined) ?? '';
  assert.match(described, /^A declaration here is your statement that you trust what that server's tools do: the gate does not check each call's arguments against it, so a declared tool runs without asking in Full auto; only declare servers you trust like your own code\./);
});

test('README names the two commands, points to the SECURITY.md section, and repeats the MCP changes in its own words', () => {
  assert.ok(readmePolicy.includes('(SECURITY.md#your-policy-file-and-decision-records)'));
  assert.ok(readmeMcp.includes(MANIFEST_IS_A_CLAIM_TEXT));
  assert.match(flat(readmeMcp), /with your permissions/);
  assert.match(flat(readmeMcp), /an undeclared tool asks before every call in every mode, `fully-autonomous` included/);
  assert.doesNotMatch(flat(readmeMcp), /every mode except `fully-autonomous`/);
});

// Plan 17 (D-19, D-34): the floor is enforced, and SECURITY.md and README say so in the same change. The old wording is held here as literals, so it cannot
// come back unnoticed.
const OLD_FLOOR_SENTENCE = 'Under `fully-autonomous` they run without asking (see Known limitations).';
const OLD_LIMITATION_ROW = '| Under `fully-autonomous`, the agent runs commands, reads likely credential files, and writes protected files (`.git/`, `.planning/.near-ai/`, `.near-ai/`) without asking |';
const OLD_README_ROW = 'including credential-file reads and writes into `.git/` (only for throwaway workspaces';
const OLD_GUARD_RAILS = 'in every mode except Full auto, where these run without asking';
const floorSection = sectionOf(SECURITY, '### What the agent can do without asking');
const limitations = sectionOf(SECURITY, '## Known limitations');
const readmeActionPolicy = README.split('\n').find((line) => line.startsWith('| `nearAi.actionPolicy` |')) ?? '';

test('SECURITY.md describes the enforced floor: every mode asks before protected writes, publishing and destruction, with no shortcut, and refuses the key and credential stores', () => {
  const text = flat(floorSection);
  for (const phrase of [
    'In every mode, `fully-autonomous` included, these always ask, with no **Always allow** and no grant for the rest of the run',
    'writing into `.git/`',
    'writing into `.planning/.near-ai/` (other than its `team.md`) or into `.near-ai/` (other than its `scratch/` and `attachments/` folders)',
    'publishing: git push, merging a pull request (`gh pr merge`), a write through `gh api` (a writing method, a field or a body), package and extension publishing, release creation, container image push, deploy commands, and sending email',
    'signing in or out: registry and account logins, logouts and token changes, which change the logins and tokens kept on this computer',
    'destruction: recursive deletes outside scratch and build folders',
    '`git reset --hard`', '`git clean`', 'discarding uncommitted changes', 'deleting branches and tags',
    'In a run with nobody to answer',
    'that exact call (the same tool and arguments, from the same folder) may run once more; the next one asks again',
    'In every mode these are refused, with no card',
    '`~/.near-credentials`', 'SSH keys', 'operating-system keychain commands', "this extension's own identity and policy files",
    'asks first in every mode except `fully-autonomous`, where it runs without asking'
  ]) assert.ok(text.includes(phrase), phrase);
  assert.ok(flat(SECURITY).includes('no **Always allow** and no grant'));
  assert.ok(flat(SECURITY).includes('In a run with nobody to answer'));
});

test('SECURITY.md carries both of the floor\'s own statements of what it cannot see, word for word', () => {
  assert.ok(flat(floorSection).includes(FLOOR_CANNOT_SEE_TEXT), 'the key and credential folder checks');
  assert.ok(flat(floorSection).includes(FLOOR_EFFECTS_CANNOT_SEE_TEXT), 'the publishing and destruction checks');
  // The credential text no longer claims a folder change followed by a bare file name is missed: plan 16 catches `cd ~ && cat .netrc`.
  assert.doesNotMatch(FLOOR_CANNOT_SEE_TEXT, /a folder change followed by a bare file name/);
  // PR #74 review round 7: the credential-store check reads text, so a command that only mentions a store is refused too, with nothing to approve. The
  // text says so and says what to do, and it is true of the code.
  assert.match(FLOOR_CANNOT_SEE_TEXT, /a command that only mentions one of these folders \(a commit message that names ~\/\.ssh, say\) is refused too, with nothing to approve: rephrase the command so it does not name the folder, or do that step yourself\./);
  assert.ok(namesCredentialStore('git commit -m "stop reading ~/.ssh in the deploy script"'), 'a commit message that names ~/.ssh is refused, as the text says');
  // The "false alarm costs one card" sentence is about the publishing and destruction checks only; the credential-store check refuses with no card.
  const floorWords = flat(floorSection);
  assert.match(floorWords, /here a false alarm costs one card and a miss would run unasked\. The check of key and credential folders above is stricter: a mention there is refused, with no card\./);
  assert.doesNotMatch(floorWords, /: a false alarm costs one card, a miss would run unasked\./);
});

test('each gap the publishing and destruction text names is a real gap today, so the text is not out of date in either direction', () => {
  const context = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };
  const tags = (command: string) => classifyCommand(command, context).effects ?? [];
  assert.ok(tags('git push').length > 0, 'the plain command is tagged');
  const nested = (levels: number): string => {
    let command = 'git push';
    for (let level = 0; level < levels; level += 1) command = `sh -c ${JSON.stringify(command)}`;
    return command;
  };
  assert.ok(tags(nested(4)).length > 0, 'four levels deep is still read');
  assert.equal(classifyCommand(nested(4), context).effectsUnknown, undefined, 'four levels deep is read whole');
  for (const hidden of ['bash -c "$CMD"', 'source deploy.sh', 'cat deploy.sh | sh']) {
    assert.deepEqual(tags(hidden), [], `${hidden} is not seen, as the text says`);
    assert.equal(classifyCommand(hidden, context).effectsUnknown, undefined, `${hidden} is read, and nothing in it is a publish the checks know`);
  }
  // PR #74 review: what the text says asks. Five levels deep, or too long to read, is not "no tag": its effects are unknown, and the gate asks about it.
  for (const stopped of [nested(5), `git status # ${'x'.repeat(MAX_COMMAND_LENGTH)}`, 'chronic git push', 'ionice -c3 rm -rf src', 'git push origin main; echo "', 'env --frob git push', 'git -frob x push']) {
    assert.equal(typeof classifyCommand(stopped, context).effectsUnknown, 'string', `${stopped.slice(0, 40)}: its effects are unknown, as the text says`);
  }
  assert.match(FLOOR_EFFECTS_CANNOT_SEE_TEXT, /nested more than four levels deep, too long to read, one they cannot parse \(a quote left open, say\), one with an option they do not know where they would read what it runs, running a package script in a folder they cannot tell or whose package\.json they cannot read, or started by a program they do not know with a command they would flag among the words after it, is not guessed at: it asks/);
  assert.match(FLOOR_EFFECTS_CANNOT_SEE_TEXT, /from the package\.json of the folder the command runs in, after any cd on the line/);
  // PR #74 review round 4: a package script in a folder the line cannot show asks, as the text says; one in a folder it can show is read there.
  for (const stopped of ['cd "$D" && npm test', 'cd .. && npm run build', 'npm --prefix "$P" run build']) {
    assert.equal(typeof classifyCommand(stopped, { ...context, packageScriptsAt: () => ({ kind: 'none' }) }).effectsUnknown, 'string', `${stopped}: unknown, as the text says`);
  }
  const fromSub = classifyCommand('cd sub && npm run sync', { ...context, packageScriptsAt: (folder: string) => (folder === '/work/app/sub' ? { kind: 'found', folder, scripts: { sync: 'git push' } } : { kind: 'none' }) });
  assert.ok((fromSub.effects ?? []).length > 0, 'the script of the folder the command runs in is read');
  assert.equal(MAX_NESTING, 4, 'the text says four levels');
  for (const seen of ['sudo git push', 'bash -c "git push"', 'echo x | xargs git push', '(git push)', 'timeout 5 git push', 'nice git push', 'stdbuf -oL git push', 'flock /tmp/lock git push', 'watch git push']) {
    assert.ok(tags(seen).length > 0, `${seen} is seen, as the text says`);
  }
});

test('the old fully-autonomous wording is gone from SECURITY.md and README, and the new rows say what still asks', () => {
  assert.equal(flat(SECURITY).includes(OLD_FLOOR_SENTENCE), false, 'the sentence that said these run without asking under fully-autonomous');
  assert.equal(SECURITY.includes(OLD_LIMITATION_ROW), false, 'the Known limitations row that said protected files are written without asking');
  assert.equal(README.includes(OLD_README_ROW), false, 'the README row that said fully-autonomous writes into .git/');
  assert.equal(flat(README).includes(OLD_GUARD_RAILS), false, 'the README guard rails that said protected writes run without asking in Full auto');
  const row = limitations.split('\n').find((line) => line.startsWith('| Under `fully-autonomous`')) ?? '';
  assert.match(row, /runs commands and reads likely credential files inside the project without asking/);
  assert.match(row, /publishing and destruction still ask/);
  assert.match(row, /the key folder and credential stores are refused/);
  assert.match(row, /there is no sandbox around the shell yet/);
  // Owner decision after PR #74 (D-18): a credential read holds what could send it out.
  assert.match(row, /After it reads such a file, anything that could send data off this computer asks too/);
  assert.ok(flat(floorSection).includes('Once a run has read such a file, in any mode, a call that could send data off this computer asks in every mode, `fully-autonomous` included, with no **Always allow** and no grant for the rest of the run, and is refused when nobody is there to answer'));
  // PR #76 review round 5: the install claim says exactly what is held.
  assert.ok(flat(floorSection).includes('an install that names a remote address (a URL other than `file://`, or a version-control address) with npm, yarn, pnpm, bun, pip, `python -m pip`, uv, pipx, cargo, gem or composer, `cargo install` or `gem install` from another registry or source, `go get` and `go install` of a module path'));
  assert.ok(flat(floorSection).includes('An install of a package by name from the default registry is not held.'));
  // PR #76 review round 4: two behaviours that surprise, said plainly.
  assert.ok(flat(floorSection).includes('A command that only mentions a credential file (`echo .env`, a commit message that names it) marks the run as a read does, and the mark lasts until the run ends.'));
  assert.ok(flat(floorSection).includes('For aws, gcloud and az, a word that looks like a command that prints a token (such as `get-session-token`, `print-access-token` or `get-access-token`) anywhere among the arguments, even as an option\'s value, makes the command refused as one: rename that word, or run that step yourself.'));
  // What the hold does not see, said plainly: a program the agent starts, and a plain download's address (coordinator, after the first report).
  assert.ok(flat(floorSection).includes('Local work still runs unasked: builds, tests, `npm run` scripts, `make`, and `node` or `python` running a script. A program the agent starts can still read the credential and send it itself, and a plain download\'s address could carry it; only the planned sandbox around the shell closes that.'));
  // Owner decisions after PR #74: signing in or out asks too, and a credential read holds what could send it out.
  assert.match(readmeActionPolicy, /publishing, signing in or out and destruction still ask/);
  assert.match(readmeActionPolicy, /after a credential read anything that could send data out asks too/);
  assert.match(readmeActionPolicy, /the key folder and credential stores are refused/);
  assert.doesNotMatch(readmeActionPolicy, /writes into `\.git\/` \(only for throwaway/);
});

test('the new sections have no em-dash and never say NEAR organization', () => {
  for (const [name, text] of [['policy section', policySection], ['MCP section', mcpSection], ['README policy', readmePolicy], ['README MCP', readmeMcp], ['floor section', floorSection], ['README actionPolicy row', readmeActionPolicy], ['floor texts', `${FLOOR_CANNOT_SEE_TEXT} ${FLOOR_EFFECTS_CANNOT_SEE_TEXT}`]] as const) {
    assert.ok(text.length > 100, name);
    assert.ok(!text.includes(EM_DASH), `${name} has no em-dash`);
    assert.doesNotMatch(text, /NEAR organization/i, name);
  }
});

test('SECURITY.md says where the policy\'s own events and its trust rule are kept: the install log, with or without a folder, and no self-signing outside a true first install', () => {
  const text = flat(policySection);
  assert.match(text, /written to a separate log for the install in the same storage, whether or not a folder is open, and also to the open project's record/);
  assert.match(text, /signs a policy by itself only on a true first install/);
  assert.match(text, /never adopted, even one that carries the default policy/);
});

// The changelog carries the user-facing words for this phase (PR #70 second review). It is checked wherever the entry sits: under "## Unreleased" before the
// release that ships it, and under its version after, so this test does not break at release time.
const CHANGELOG = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

test('CHANGELOG.md has an Unreleased section above the newest release (or the entry already sits in a release) naming the policy changes in plain words', () => {
  const sections = CHANGELOG.split(/\n(?=## )/).slice(1);
  const unreleased = sections.find((section) => section.startsWith('## Unreleased'));
  if (unreleased !== undefined) {
    assert.equal(sections[0]?.startsWith('## Unreleased'), true, 'Unreleased is the first section, above the newest release');
    assert.ok(sections.slice(1).some((section) => /^## \d+\.\d+\.\d+/.test(section)), 'a release section follows it');
  }
  // The policy entry is found by its own words wherever it sits (it shipped in 0.4.28), not taken to be whatever "## Unreleased" holds: a later change's
  // Unreleased entry is not the policy entry (PR #74 review).
  const entry = flat(sections.find((section) => /Reset Policy to Defaults/.test(section)) ?? '');
  assert.notEqual(entry, '', 'the policy entry exists');
  for (const phrase of [
    /status bar/i, /Show Policy/, /Reset Policy to Defaults/, /setup step|setup view|Check your policy/i, /Tools page/, /every tool/i,
    /new (MCP )?server(s)? start(s)? (restrictive|restricted)|start(s)? restrictive/i, /(missing|broken)[^.]*policy file[^.]*(reading and planning|only reading)|only reading and planning/i
  ]) assert.match(entry, phrase);
  assert.ok(!entry.includes(EM_DASH), 'no em-dash');
  assert.ok(!/NEAR organization/i.test(entry), 'your organization, never NEAR organization');
});

// PR #74 review: the enforced floor's user-visible changes are in the changelog, in plain words, under "## Unreleased" until the release that ships them
// (then under that version). Found by its own words, so the test holds across the release.
test('CHANGELOG.md says, in plain words, what Full auto now asks about and refuses, and what else changed for users in this branch', () => {
  const sections = CHANGELOG.split(/\n(?=## )/).slice(1);
  const section = sections.find((candidate) => /Full auto asks before what is hard to undo/.test(candidate)) ?? '';
  assert.notEqual(section, '', 'the floor entry exists');
  assert.ok(/^## (?:Unreleased|\d+\.\d+\.\d+)/.test(section), 'under Unreleased or a release');
  const entry = flat(section);
  for (const phrase of [
    /Full auto included/, /`\.git\/`/, /`\.planning\/\.near-ai\/`/, /publish/i, /git push/, /`git reset --hard`/, /no \*\*Always allow\*\*/,
    /nobody to answer[^.]*refused|refused[^.]*nobody/i, /Everything else still runs without asking/, /NEAR key folder/, /VS Code's own secrets database/,
    /identity and policy files/, /nested more than four levels deep, too long to check, or started by a program the checks do not know/, /search provider/i, /decision record/i,
    // Owner decisions after PR #74.
    /After reading a credential file, sending asks/, /`gh pr merge`/, /Signing in and out asks in every mode/, /`gh auth token`/, /Routine git upkeep/,
    /A file outside your project is refused at once/, /`nearAi\.mcp\.localServerEffects`/, /arguments could not be read/, /`--max-tokens 4096`/
  ]) assert.match(entry, phrase);
  for (const line of section.split('\n').filter((text) => text.startsWith('- '))) assert.match(line, /^- \*\*[^*]+\*\*/, `each bullet leads with a bold sentence: ${line.slice(0, 60)}`);
  assert.ok(!entry.includes(EM_DASH), 'no em-dash');
  assert.ok(!/NEAR organization/i.test(entry), 'your organization, never NEAR organization');
  assert.doesNotMatch(entry, /\b(?:decide\(\)|floorFor|classifyCommand|gateToolCall|effectsUnknown|PR #\d+)\b/, 'no internal names');
});

// PR #70 review carry-over: the record section said "secrets are removed" while only token shapes were. It now says what is removed and what is not, and
// each example it gives is checked against the code that removes it.
test('the decision record paragraph says exactly what is removed from a command and what is not, and each example holds for the code', () => {
  const words = flat(policySection);
  assert.ok(!words.includes('and secrets are removed from it'), 'the old overclaim is gone');
  for (const named of ['first line only', '`-u`, `--user`, `--proxy-user` or `-U` when it holds a colon', '`--password=...`, `--token ...` or `-storepass ...`',
    '`Authorization`, `Proxy-Authorization`, `Cookie`, `Private-Token`', '`GITHUB_TOKEN=...`', '`?api_key=...`', '`-d "password=..."`', '(`https://user:password@host`)',
    'It does not remove a password passed as a plain argument (`sshpass -p`, `mysql -p...`, `htpasswd -b`)', 'command substitution']) {
    assert.ok(words.includes(named), named);
  }
  const removed = (command: string): boolean => !redactCredentialArguments(command).includes('pw-1');
  for (const command of ['curl https://user:pw-1@host.example.test', 'curl -u user:pw-1 x', 'curl --user user:pw-1 x', 'curl --proxy-user user:pw-1 x', 'curl -U user:pw-1 x',
    'tool --password=pw-1', 'tool --token pw-1', 'keytool -storepass pw-1', 'curl -H "Authorization: Basic pw-1"', 'curl -H "Proxy-Authorization: Basic pw-1"',
    'curl -H "Cookie: s=pw-1"', 'curl -H "Private-Token: pw-1"', 'curl -d "password=pw-1" x', 'curl -H "X-Service-Token: pw-1"', 'curl -H "X-Api-Key: pw-1"', 'GITHUB_TOKEN=pw-1 gh', 'curl "https://h.example.test/?api_key=pw-1"']) {
    assert.ok(removed(command), command);
  }
  for (const command of ['sshpass -p pw-1 ssh h', 'mysql -ppw-1 app', 'htpasswd -b users alice pw-1', 'curl -u "$(cat pw-1)" x']) assert.ok(!removed(command), command);
  // PR #74 review round 2: the numeric user and group the paragraph says is kept is kept.
  assert.ok(words.includes('(a numeric user and group, such as `1000:1000`, is kept)'));
  assert.equal(redactCredentialArguments('docker run --user 1000:1000 img'), 'docker run --user 1000:1000 img');
});

// PR 4a (plan 70-19, close-out 70-28a): every model request passes the route check and leaves a record in a log of its own, and the docs say so in the
// same change. The old sentence that said routing was not used is held here as a literal, so it cannot come back.
const OLD_ROUTING_NOT_USED = 'The file also holds scales, clearances and routing tiers. This version stores and shows them and does not use them yet.';

test('SECURITY.md says every model request is checked against the routing tiers and recorded in its own log, and what a routine record holds', () => {
  const words = flat(policySection);
  assert.equal(words.includes(OLD_ROUTING_NOT_USED), false, 'routing is used now');
  for (const phrase of [
    '**Model requests.** Before anything is sent to a model',
    'checks the request against the routing tiers in the policy file, using only what is on this computer',
    'Each chat\'s label decides where its requests may go',
    'a chat that read nothing labelled is at the policy\'s default label, which may go to any model',
    'on a fresh install nothing changes where requests go',
    'A request the routing does not allow is not sent',
    // Plan 25 (PR 4d): the interim "stays on this computer for now" became the rule that ships.
    'Content at a level whose tier needs an attested cloud model goes to NEAR AI Cloud only over a connection proven to end inside its private hardware; otherwise it stays on this computer.',
    `in a log of its own, \`gate/${MODEL_REQUESTS_DIR}/\` in this extension's storage`,
    'rolls over the same way, is never synced and is never put in your project',
    'A routine record holds the time, who asked, the model and its provider, the routing tier, the rule that allowed it and the policy\'s hash',
    'never the content, the endpoint\'s address or a file path',
    // PR 4a review round 1: a refusal always names the label that decided it, the default label included; a route that cannot be worked out names none.
    'a refused request\'s record also holds the plain reason and the label that decided it, which is the policy\'s default label when nothing raised the label',
    'A request whose route cannot be worked out is refused with a fixed reason and no label'
  ]) assert.ok(words.includes(phrase), phrase);
  assert.equal(MODEL_REQUESTS_DIR, 'model-requests');
  assert.ok(!policySection.includes(EM_DASH));
  assert.doesNotMatch(policySection, /NEAR organization/);
});

test('README\'s policy bullet says every model request is checked and recorded in a log of its own, and nothing changes on a fresh install', () => {
  const words = flat(readmePolicy);
  for (const phrase of ['Every model request is checked against its routing before anything is sent', 'leaves a record in a log of its own', 'on a fresh install nothing changes where requests go']) {
    assert.ok(words.includes(phrase), phrase);
  }
});

// PR 4b (plan 21 Task 3): what labels and clearances do in this version, word for word with the code, and nothing more.
test('SECURITY.md\'s labels bullet says what 4b makes live, carries both texts word for word, and names the commands package.json contributes', () => {
  assert.equal(SECURITY.split('What this version does not use yet').length - 1, 0);
  assert.equal(SECURITY.split('Labels and clearances in this version').length - 1, 1);
  assert.ok(policySection.includes(LABELS_NOT_ACCREDITATION_TEXT), 'LABELS_NOT_ACCREDITATION_TEXT word for word');
  assert.ok(policySection.includes(CLEARANCE_SELF_ASSERTED_TEXT), 'CLEARANCE_SELF_ASSERTED_TEXT word for word');
  const setLabel = commandName('nearAi.label.set');
  const edit = commandName('nearAi.policy.edit');
  const applyDraft = commandName('nearAi.policy.applyDraft');
  assert.deepEqual([setLabel, edit, applyDraft], ['SovAI: Set Label', 'SovAI: Edit Policy', 'SovAI: Apply Policy Draft']);
  // D-44: Edit Policy and Apply Policy Draft left the palette; the docs name the page and its two buttons that run them.
  const words = flat(policySection);
  for (const phrase of [setLabel, 'open **SovAI: Policy** and use **Edit my rules**, then **Apply my draft**', '`.planning/.near-ai/labels.json`, signed with your device key, and travel with the project',
    'anyone who can read the project can read its labels, compartment names included', 'only ever makes a label stricter', 'signed again only after you confirm',
    'or that was deleted, stops agents reading the project', 'through the file tools, searches or a command that names it',
    'Decision records hold the labels involved and stay on this computer', 'Where a labelled chat\'s content may be sent is in']) {
    assert.ok(words.includes(phrase), phrase);
  }
  assert.ok(!policySection.includes(EM_DASH));
  assert.doesNotMatch(policySection, /NEAR organization/);
});

test('README names Set Label, Lower This Chat\'s Label and the policy page\'s Edit my rules and Apply my draft, says a chat\'s label decides where its content is sent, and links the policy section', () => {
  const words = flat(readmePolicy);
  for (const id of ['nearAi.label.set', 'nearAi.label.lowerChat', 'nearAi.policy.open']) assert.ok(words.includes(commandName(id)), id);
  assert.ok(words.includes(`Add a clearance in **${commandName('nearAi.policy.open')}** with **Edit my Standing Orders**, then **Apply my draft**.`), 'the clearance sentence names the page');
  assert.ok(words.includes('decides where its content is sent'));
  assert.ok(!words.includes('does not change where content is sent yet'), 'the 4b sentence is gone');
  assert.ok(words.includes('(SECURITY.md#classification-labels-and-routing)'));
  assert.ok(words.includes(LABELS_NOT_ACCREDITATION_TEXT.split('. ')[0] ?? ''), 'the first sentence of LABELS_NOT_ACCREDITATION_TEXT');
  assert.ok(words.includes('(SECURITY.md#your-policy-file-and-decision-records)'));
  assert.ok(!readmePolicy.includes(EM_DASH));
  assert.doesNotMatch(readmePolicy, /NEAR organization/);
});

// D-61, D-62, D-63: the owner's answers to PR 4b's questions, said in the policy section in the code's own words.
test('SECURITY.md says a branch switch holds reads with Use this branch\'s labels, the marker is in secret storage, and the Open-GSD runtime is read at the default label', () => {
  const words = flat(policySection);
  for (const phrase of [
    `with one button, ${USE_BRANCH_LABELS_ACTION}, that makes its labels the current ones`,
    'for example after switching branches',
    "in this computer's secret storage, so deleting files does not make it forget",
    'for example with git restore',
    "Reading SovAI's own Open-GSD runtime files is judged at the default label",
    "a link from there into the project keeps the project file's label",
    'While a label file holds reads, only reads of the project are held: reads of those runtime files go on',
    // PR #85 review: globs, beside the variable-path gap.
    'a read a command does not show (a path built in a variable) is not seen. A glob in a command (such as `secret/*.md`) is checked against every labelled file it could match, and a glob next to a variable is judged by the strictest label in the project'
  ]) assert.ok(words.includes(phrase), phrase);
  assert.ok(!policySection.includes(EM_DASH));
});

test('D-60: SECURITY.md says, word for word with the code, what the outbound check of labelled text catches and what it does not', () => {
  assert.ok(flat(SECURITY).includes(flat(OUTBOUND_LIMITS_TEXT)), 'the limits text is in SECURITY.md');
  for (const phrase of ['copied or quoted', 'does not catch a paraphrase', 'an encoding such as base64', 'a program the agent starts', 'a planned sandbox around the shell', 'never in a record']) {
    assert.ok(OUTBOUND_LIMITS_TEXT.includes(phrase), phrase);
  }
  assert.ok(!OUTBOUND_LIMITS_TEXT.includes(EM_DASH));
  assert.ok(!/NEAR organization/.test(OUTBOUND_LIMITS_TEXT));
});

// Plan 24 (PR 4c, CLAS-07, CLAS-02): the section Classification labels and routing, word for word with the code, in the order of 70-RESEARCH.md section 12.
const LABELS_HEADING = '### Classification labels and routing';

test('SECURITY.md\'s labels and routing section carries the scales caveat, the clearance sentence and the not-accreditation block word for word, in that order', () => {
  assert.equal(SECURITY.split(LABELS_HEADING).length - 1, 1);
  const section = sectionOf(SECURITY, LABELS_HEADING);
  const words = flat(section);
  const caveat = words.indexOf(flat(SCALE_PRESETS_CAVEAT_TEXT));
  const clearance = words.indexOf(flat(CLEARANCE_SELF_ASSERTED_TEXT));
  const block = section.indexOf(`\n${LABELS_NOT_ACCREDITATION_TEXT}\n`);
  assert.ok(caveat >= 0, 'SCALE_PRESETS_CAVEAT_TEXT');
  assert.ok(clearance > caveat, 'CLEARANCE_SELF_ASSERTED_TEXT after the scales');
  assert.ok(block >= 0, 'LABELS_NOT_ACCREDITATION_TEXT as one block');
  assert.ok(flat(section.slice(0, block)).length > clearance, 'the block comes last');
  // The order of what the section says (the must-haves of plan 24).
  const order = ['**What a label is.**', '**Scales.**', '**Clearances.**', '**The chat\'s label.**', '**What a labelled chat writes.**', '**Routing tiers.**', '**Attested cloud in this version.**', '**Local means this computer.**', '**Calls that could send data off this computer.**'];
  const at = order.map((heading) => section.indexOf(heading));
  assert.ok(at.every((index) => index >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  assert.ok(at[at.length - 1]! < block);
  for (const phrase of ['`.planning/.near-ai/labels.json`', 'anyone who can read the project can read its labels', 'A sync never lowers a chat\'s label',
    'Only you lower it, with **SovAI: Lower This Chat\'s Label** and a reason that is recorded', 'declassification signed with your device key that they can check',
    'only when it undoes no raise made there', 'In this version your other computers cannot check another computer\'s key yet, in or outside Team Mode', 'a lowering made on one computer is not applied on the others', 'takes the chat\'s label in the label file, never a lower one',
    'Protected B stays on this computer because no CCCS Medium assessment of NEAR AI Cloud was found, unless your organization changes its policy',
    'unless your organization names another host', 'is refused, whatever the mode']) {
    assert.ok(words.includes(flat(phrase)), phrase);
  }
  assert.ok(!section.includes(EM_DASH));
  assert.doesNotMatch(section, /NEAR organization/);
  // Owner answer (2026-11-17): user-facing text names no phase numbers.
  assert.doesNotMatch(section, /Phase \d/);
  assert.doesNotMatch(OUTBOUND_LIMITS_TEXT, /Phase \d/);
  assert.doesNotMatch(sectionOf(SECURITY, '## Known limitations'), /Phase \d/);
  assert.doesNotMatch(readmePolicy, /Phase \d/);
});

test('the section\'s routing table is the default routing table, level by level', () => {
  const section = sectionOf(SECURITY, LABELS_HEADING);
  const rowOf = (tier: string): string => section.split('\n').find((line) => line.startsWith(`| ${tier} |`)) ?? '';
  for (const [level, tier] of Object.entries(DEFAULT_ROUTING.levels)) assert.ok(rowOf(tier).includes(`\`${level}\``), `${level} is under ${tier}`);
  assert.match(rowOf('deny'), /none by default/);
});

test('the policy section keeps the clearance sentence, and no longer says a label does not change where content is sent', () => {
  assert.ok(policySection.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.ok(!flat(policySection).includes('does not change where content is sent yet'));
  assert.ok(!flat(SECURITY).includes('A label does not change where content is sent yet'));
});

test('Known limitations lists the section-12 gaps that apply in 4c', () => {
  const limits = sectionOf(SECURITY, '## Known limitations');
  for (const phrase of ['Shell reads and network exits are checked from a command\'s text', 'Local-only trusts the address your local runtime is configured with, unless it is loopback',
    'Labels and the policy are signed by your own key', 'effects are their declarations', 'The label file is readable by anyone who can read the project',
    'The outbound check catches labelled text copied into a network call, not a paraphrase or an encoding']) {
    assert.ok(limits.includes(phrase), phrase);
  }
});

test('README carries the first sentence of LABELS_NOT_ACCREDITATION_TEXT and the three label commands, and Set Label shows the same constant', () => {
  const words = flat(readmePolicy);
  assert.ok(words.includes(LABELS_NOT_ACCREDITATION_TEXT.split('. ')[0] ?? ''));
  for (const id of ['nearAi.label.set', 'nearAi.label.lowerChat', 'nearAi.policy.open']) assert.ok(words.includes(commandName(id)), id);
  assert.ok(words.includes('**Edit my Standing Orders**'));
  const commands = readFileSync(path.join(ROOT, 'src', 'services', 'gateCommands.ts'), 'utf8');
  assert.ok(commands.includes('placeHolder: LABELS_NOT_ACCREDITATION_TEXT'), 'Set Label shows the constant itself');
});

test('PR #87 review: SECURITY.md says how a reopened chat treats its earlier results, and the refusal for them says so truly, with the way out', () => {
  assert.ok(flat(sectionOf(SECURITY, '### Classification labels and routing')).includes(flat(OUTBOUND_REOPENED_DOCS_TEXT)));
  assert.match(OUTBOUND_EARLIER_TEXT, /cannot tell which of its earlier results came from labelled files/);
  assert.match(OUTBOUND_EARLIER_TEXT, /SovAI: Lower This Chat's Label/);
  for (const text of [OUTBOUND_REOPENED_DOCS_TEXT, OUTBOUND_EARLIER_TEXT]) {
    assert.ok(!text.includes(EM_DASH));
    assert.doesNotMatch(text, /NEAR organization|Phase \d/);
  }
});

test('PR #87 review round 2: the refusal of a run whose reading could not be checked says so, names the way out, and never claims labelled content was read', () => {
  assert.match(OUTBOUND_UNCHECKED_TEXT, /could not be checked for labelled text/);
  assert.match(OUTBOUND_UNCHECKED_TEXT, /SovAI: Lower This Chat's Label/);
  assert.doesNotMatch(OUTBOUND_UNCHECKED_TEXT, /has read labelled content/);
  assert.ok(!OUTBOUND_UNCHECKED_TEXT.includes(EM_DASH));
  assert.doesNotMatch(OUTBOUND_UNCHECKED_TEXT, /NEAR organization|Phase \d/);
});

test('PR #87 review rounds 2 and 3: SECURITY.md and CHANGELOG say what a written file on another scale really gets, and where a chat starts', () => {
  const section = flat(sectionOf(SECURITY, '### Classification labels and routing'));
  for (const phrase of ['A file holds one label. A file already labelled on a scale the chat\'s label also holds is raised on that scale.',
    'A file labelled only on scales the chat\'s label does not hold is left as it is, so it keeps a label whose tier may let its content go to a private cloud model once those are allowed.']) {
    assert.ok(section.includes(phrase), phrase);
  }
  assert.ok(!section.includes('it is raised only on the scale it already has'), 'the round 2 wording, which was not what the code does, is gone');
  const changelog = flat(CHANGELOG);
  assert.ok(changelog.includes('a file already labelled only on a scale the chat\'s label does not hold is left as it is'));
  assert.ok(changelog.includes('A chat starts at its project\'s label (your policy\'s default label when the project has none), so in an unlabelled project a chat that read nothing labelled works as before.'));
  assert.ok(!changelog.includes('A chat that read nothing labelled works as before.'));
});

// Plan 25 (PR 4d, CLAS-05, CLAS-07, D-55): what the connection and answer checks prove and rely on, word for word with the code.
test('SECURITY.md carries CONNECTION_BINDING_TEXT after the attested-cloud sentence and before the not-accreditation block, and the interim sentence is gone', () => {
  const section = sectionOf(SECURITY, LABELS_HEADING);
  const words = flat(section);
  const attested = words.indexOf(flat('**Attested cloud in this version.** Levels whose tier is attested-cloud'));
  const binding = words.indexOf(flat(CONNECTION_BINDING_TEXT));
  const block = words.indexOf(flat(LABELS_NOT_ACCREDITATION_TEXT));
  assert.ok(attested >= 0, 'the attested-cloud sentence');
  assert.ok(binding > attested, 'CONNECTION_BINDING_TEXT word for word, after it');
  assert.ok(block > binding, 'and before LABELS_NOT_ACCREDITATION_TEXT');
  assert.equal(flat(SECURITY).includes('This version cannot prove that yet'), false, 'the interim sentence is gone');
  assert.equal(flat(SECURITY).includes('stays on this computer for now'), false);
  for (const phrase of [
    'NEAR AI Cloud\'s attestation names the key of the certificate its endpoint serves, so from this release content at these levels can reach a private NEAR AI Cloud model again, whenever that check passes.',
    'nothing more at these levels is sent to NEAR AI Cloud from that chat until **Check again** under that answer passes; a new chat or a window reload also starts without the stop, and the failure stays in the decision log.',
    'A check that cannot be made, for example offline, changes nothing.',
    'Behind a proxy that inspects encrypted traffic, the connection cannot be proven, so content at these levels stays on this computer.'
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  assert.ok(!section.includes(EM_DASH));
  assert.doesNotMatch(section, /NEAR organization/);
  assert.doesNotMatch(section, /Phase \d/);
});

// PR 4e (CLAS-08): the section that described the per-answer action is now "The trust badge on each answer"; plan 25's sentences about the automatic
// check at attested-cloud levels and Check again are read from it.
test('The trust badge on each answer says answers at attested-cloud levels are checked automatically, and Known limitations has both rows', () => {
  const badge = flat(sectionOf(SECURITY, BADGE_HEADING));
  assert.ok(badge.includes(flat('every answer NEAR AI Cloud sends, tool-call turns and helper agents\' answers included, is checked this way too, and a failed check stops those levels for the chat')));
  assert.ok(badge.includes(flat('**Check again** checks the answer again with a fresh report, never a reused one.')));
  assert.ok(!badge.includes(flat('Tool-call turns are signed the same way but are not checked.')), 'tool-call turns are checked at attested-cloud levels now');
  const limits = sectionOf(SECURITY, '## Known limitations');
  assert.ok(limits.includes('The check of an answer\'s attestation and signature runs after the answer, so it cannot stop that answer\'s request; a failed check stops the next ones.'));
  assert.ok(limits.includes('The check that a connection ends inside the enclave relies on NEAR AI Cloud\'s attestation and Intel\'s root of trust. Like the answer check, it does not check the platform\'s TCB status, certificate revocation or which code the enclave runs.'));
  assert.equal(SECURITY.split('relies on NEAR AI Cloud\'s attestation and Intel\'s root of trust').length - 1, 1);
  assert.ok(!limits.includes(EM_DASH));
});

// ---- Plan 27 (PR 4e, CLAS-08, CLAS-07, D-56): the trust badge in SECURITY.md and README, word for word with the code ----

test('SECURITY.md states each badge title with its explanation word for word, and the check\'s cost, timeout, lead-only rule, Check again, Show full attestation and what is not checked', () => {
  const section = sectionOf(SECURITY, BADGE_HEADING);
  const words = flat(section);
  for (const state of TRUST_BADGE_STATES) {
    assert.ok(words.includes(flat(`**${TRUST_BADGE_TITLES[state]}**: ${TRUST_BADGE_TEXT.explanation[state]}`)), `${state}: its title, then its explanation word for word`);
  }
  for (const phrase of [
    'Each cloud answer from a TEE model is checked once, automatically, in the background, after it arrives.',
    'That costs one signature request per answer; an attestation report SovAI has already verified for the same signing key is reused for up to ten minutes.',
    `A check that has not finished after ${String(BADGE_CHECK_TIMEOUT_MS / 1000)} seconds shows **Not verified**, saying it could not be checked in time`,
    'if the check finishes later, the badge changes.',
    'The badge is on the lead agent\'s answers only.',
    'each badge\'s details say that helper agents in the run may have used other models, each request routed by the chat\'s label and recorded.',
    'it lifts that stop when the answer now checks out.',
    '**Show full attestation** opens the details as read-only JSON in a preview tab named for the answer',
    'it cannot be edited and never asks to be saved.',
    'Escape anywhere in the chat closes them and puts the focus back on the badge, unless that Escape already did something else there, such as stopping a run or closing a menu.',
    'Nothing is written to your project or to a decision record.',
    'shows each answer\'s badge in the state its checks reached when the answer arrived'
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  assert.ok(words.includes(flat(`"${TRUST_BADGE_TEXT.checking}"`)), 'the Checking now words');
  // NOT_CHECKED_IN_EDITOR, item by item, in the section's own words.
  assert.equal(NOT_CHECKED_IN_EDITOR.length, 3);
  for (const phrase of ['the platform\'s TCB status and certificate revocation', 'which code the enclave runs (its measurements', 'NVIDIA\'s GPU attestation verdict', 'cloud.near.ai/verify']) assert.ok(words.includes(flat(phrase)), phrase);
  // The numbered list of checks is kept.
  for (const step of ['1. NEAR\'s signature (`/v1/signature/{chat_id}`)', '2. The signature (EIP-191, secp256k1)', '3. A fresh attestation report', '4. The quote\'s `report_data` binds']) assert.ok(words.includes(flat(step)), step);
  assert.ok(!section.includes(EM_DASH));
  assert.doesNotMatch(section, /NEAR organization/);
  assert.doesNotMatch(section, /Phase \d/);
});

test('README describes the badge with its three titles and links to the new section; neither file still names the old per-answer action or links to its anchor', () => {
  for (const title of Object.values(TRUST_BADGE_TITLES)) assert.ok(flat(README).includes(title), title);
  assert.equal(README.split('SECURITY.md#the-trust-badge-on-each-answer').length - 1, 2, 'both README mentions link to the section');
  for (const text of [SECURITY, README]) {
    assert.doesNotMatch(text, /Verify signature/);
    assert.doesNotMatch(text, /#checking-a-responses-signature/);
  }
  assert.ok(SECURITY.includes('(#the-trust-badge-on-each-answer)'), 'the labels section links to it');
  const limits = sectionOf(SECURITY, '## Known limitations');
  assert.ok(limits.includes('The trust badge\'s checks do not check TCB status or revocation, enclave measurements, or NVIDIA\'s verdict'));
  const readmeLines = README.split('\n').filter((line) => /trust badge|Verified private model|SECURITY\.md#the-trust-badge/.test(line));
  assert.ok(readmeLines.length >= 2);
  for (const line of readmeLines) { assert.ok(!line.includes(EM_DASH), line); assert.doesNotMatch(line, /NEAR organization/); }
});

// ---- The owner's decision of 2026-11-18 (PR #95): Public requests over the proven connection, with an unpinned fallback; badges on lead answers only ----

test('SECURITY.md, README and CHANGELOG say Public requests go over the proven connection, fall back unpinned on a mismatch with a record, and attested levels still refuse', () => {
  const badge = flat(sectionOf(SECURITY, BADGE_HEADING));
  for (const phrase of [
    'every request is held to that key, and refused if the server presents another.',
    'At other levels a request to NEAR AI Cloud is held to that key while a fresh proof of the connection exists.',
    'the request is sent without the key held instead of being refused, a second model request record for it says it fell back (and nothing about its content), and the answer\'s badge shows **Model verified, connection not proven**.',
    'With no fresh proof the request is sent as before',
    'The badge is on the lead agent\'s answers only.'
  ]) assert.ok(badge.includes(flat(phrase)), phrase);
  assert.ok(flat(policySection).includes('`connectionFallback: "unpinned"`'), 'the record field is named where model request records are described');
  assert.ok(flat(policySection).includes('Every record is written when the route is decided, before anything is sent.'));
  assert.ok(flat(policySection).includes('gets a second record holding `connectionFallback: "unpinned"`.'));
  const readme = flat(README);
  assert.ok(readme.includes('A **trust badge** under each cloud answer of the lead agent says'));
  assert.ok(readme.includes('It is on the lead agent\'s answers only; a helper agent\'s answer has none.'));
  assert.ok(readme.includes('At a level that needs an attested cloud a mismatch refuses the request; at other levels it is sent without the key held and the badge says so.'));
  // Found by its own words wherever it sits (under "## Unreleased" before the release that ships it, under its version after), like the entries above,
  // so the release step that renames the section does not break this test.
  const entry = flat(CHANGELOG.split(/\n(?=## )/).slice(1).find((section) => section.includes('**Public chats over the proven connection too.**')) ?? '');
  assert.match(entry, /^## (?:Unreleased|\d+\.\d+\.\d+)/, 'the entry sits under Unreleased or a release heading');
  assert.ok(entry.includes('**Public chats over the proven connection too.**'));
  assert.ok(entry.includes('Levels that need an attested cloud still refuse on a mismatch.'));
  for (const text of [badge, entry]) { assert.ok(!text.includes(EM_DASH)); assert.doesNotMatch(text, /NEAR organization/); }
});

// Coherence review safety patch: SECURITY.md and README say what the code now enforces, in the code's own words where the code owns them.
test('safety patch: SECURITY.md and README say what S1, S2, S4, S5, S6 and S8 enforce, and the staff sentence word for word', async () => {
  const { STAFF_PRIVATE_MODELS_TEXT } = await import('../domain/staff/products');
  const { PRIVATE_MODEL_LABEL } = await import('../services/chatBridge');
  const security = flat(SECURITY);
  const readme = flat(README);
  // S5: the same sentence the setup, the team file and the chat show.
  assert.ok(security.includes(STAFF_PRIVATE_MODELS_TEXT), 'SECURITY.md');
  assert.ok(readme.includes(STAFF_PRIVATE_MODELS_TEXT), 'README');
  // S4: the picker's words, and that the check, not the catalog, decides.
  assert.ok(security.includes(`**${PRIVATE_MODEL_LABEL}**`));
  assert.ok(readme.includes(PRIVATE_MODEL_LABEL));
  assert.ok(!security.includes('runs in NEAR TEE') && !readme.includes('runs in NEAR TEE'), 'the old picker words are gone');
  assert.match(security, /the catalog's word only chooses a model/);
  // S1: exact host over https for local-only levels; this computer only for the most sensitive; the rule ids.
  assert.match(security, /names that exact host, not a `\*\.` pattern, and the runtime is reached over https/);
  assert.match(security, /`route\.local-host-not-exact`/);
  assert.match(security, /`route\.this-computer-only`/);
  assert.match(readme, /names that exact host and it uses https/);
  // S2: the notice and its record, and that nothing is refused yet.
  assert.match(security, /`route\.not-accredited` once per chat\. Nothing is refused for it in this version/);
  // S6: update, never Reset, for a policy written for a newer version.
  assert.match(security, /says to update the extension\. It never offers Reset as the fix/);
  assert.match(readme, /A policy written for a newer version of the extension is never reset for you/);
  // S8: shown by the scale's name; Confidential on the organization scale reads Sensitive.
  assert.match(security, /The organization scale's Confidential level is shown as "Sensitive"/);
  assert.match(readme, /the organization's Confidential level reads "Sensitive"/);
  assert.ok(!security.includes(EM_DASH));
  for (const text of [security, readme]) assert.ok(!/NEAR organization/.test(text));
});

test('PR #143 review: SECURITY.md says classified levels stay here whatever tier a policy gives them, the private floor takes only exact https named hosts, and Reset is offered only for the person\'s own policy', () => {
  const security = flat(SECURITY);
  assert.match(security, /This holds whatever tier the policy gives those levels: no cloud and no other host is accredited for them today/);
  assert.match(security, /A model on a host your organization names as local counts only when the policy names that exact host and it is reached over https; a `\*\.` pattern or plain http does not\./);
  assert.match(security, /only for a policy signed by this computer's own key, \*\*SovAI: Policy\*\* offers \*\*Reset my rules\*\*/);
  assert.match(flat(README), /a host your organization names exactly and reaches over https/);
});

// ---- Phase 41 (D-46): the docs say what the organization policy foundation does, word for word with the code ----

const ORGANIZATION_RULES_HEADING = "#### Your organization's rules on this computer";

test("Phase 41: the policy section says how your organization's rules reach this computer", () => {
  assert.equal(SECURITY.split(`\n${ORGANIZATION_RULES_HEADING}\n`).length - 1, 1, 'the block exists once');
  const block = sectionOf(SECURITY, ORGANIZATION_RULES_HEADING);
  assert.ok(policySection.includes(block), 'the block sits inside the policy section');
  const words = flat(block);
  assert.equal(MAX_ENROLMENT_FILE_BYTES, 64 * 1024, 'the cap the text names');
  const contact = 'Security desk (security@example.org)';
  for (const phrase of [
    ISSUER_WORDS_DOMAIN,
    `\`${ENROLMENT_FILE_EXTENSION}\``,
    '64 KiB',
    'secret storage',
    `**${commandName('nearAi.organization.addRules')}**`,
    issuerWordsPrompt([]).trim(),
    issuerWordsQuestion('Example Organization'),
    `**${ISSUER_WORDS_MATCH}**`,
    organizationEndedText('2027-01-31', contact)
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  assert.equal(commandName('nearAi.organization.addRules'), "SovAI: Add Your Organization's Rules");
  assert.ok(!block.includes(EM_DASH));
  assert.doesNotMatch(block, /NEAR (AI )?organization/i);
});

// ---- D-44 (41-14): the contributed editor actions stay off the palette; displayed and recorded wording have separate contracts. ----

/** A command that left the palette, with or without the brand prefix. */
const LEFT_THE_PALETTE = /(?:(?:NEAR AI|SovAI):\s*)?(?:Show (?:Policy|Standing Orders)|Edit Policy|Apply Policy Draft|Reset (?:Policy|Standing Orders) to Defaults)/;
/** The page's own button words (media/policy/policy.js), read from the page so the docs and sentences use the page's words. */
const POLICY_PAGE = readFileSync(path.join(ROOT, 'media', 'policy', 'policy.js'), 'utf8');

test('D-44: no user sentence names a command that left the palette', async () => {
  const { copySourceFiles, extractCopy } = await import('./helpers/copyLintScan');
  const files = copySourceFiles(ROOT).filter((file) => file !== 'package.json');
  assert.ok(files.some((file) => file.startsWith('media/')) && files.some((file) => file.startsWith('src/')), 'src and media are both read');
  const found: string[] = [];
  for (const file of files) {
    for (const { text } of extractCopy(readFileSync(path.join(ROOT, file), 'utf8'), file)) if (LEFT_THE_PALETTE.test(text)) found.push(`${file}: ${text.slice(0, 120)}`);
  }
  assert.deepEqual(found, []);
  // The check has teeth: the extractor finds a planted sentence in a source and in a page script.
  assert.ok(extractCopy("export const PLANTED_TEXT = 'Run SovAI: Edit Policy first.';", 'src/x.ts').some(({ text }) => LEFT_THE_PALETTE.test(text)));
  assert.ok(extractCopy("node.textContent = 'Use Reset Policy to Defaults';", 'media/x.js').some(({ text }) => LEFT_THE_PALETTE.test(text)));
});

test('D-44, D-21: displayed instructions match the editor and recorded reasons keep their wording', async () => {
  const policy = commandName('nearAi.policy.open');
  assert.equal(policy, 'SovAI: Standing Orders');
  for (const button of ['Edit my Standing Orders', 'Apply my draft', 'Reset my Standing Orders', 'Show as stored']) assert.ok(POLICY_PAGE.includes(`'${button}'`), `the page's ${button} button`);
  const uninstall = installVscodeStub(createVscodeStub());
  let commands: typeof import('../services/gateCommands');
  try {
    commands = await import('../services/gateCommands');
  } finally {
    uninstall();
  }
  const { STALE_DRAFT_TEXT, POLICY_DRAFT_SHAPE_TEXT } = await import('../gate/bundleStore');
  const { localHostPatternNotice, ROUTE_CHECK_FAILED_TEXT } = await import('../domain/gate/routing');
  const { mcpCeilingText, mcpCeilingUnjudgedText } = await import('../agent/gateAdapter');
  const { FAILED_CLOSED_LABEL_TEXT, ADD_CLEARANCE_HINT } = await import('../agent/gateLabels');
  const { NO_SIGNING_KEY_TEXT } = await import('../gate/labelMapStore');
  const label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] };
  const ceiling = { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] };
  const resets = Object.values(BUNDLE_FAILURES).filter((sentence) => /reset/i.test(sentence));
  assert.ok(resets.length > 0, 'some failure sentences offer a reset');
  // The safety patch's update sentences never offer one (S6); every other offer names the page and its button, and says it touches your own rules only.
  for (const sentence of resets) {
    assert.ok(sentence.includes('Open SovAI: Policy and choose Reset my rules'), sentence);
    assert.ok(sentence.includes('it resets your own rules only'), sentence);
  }
  const original: Array<[string, string]> = [
    ...resets.map((sentence): [string, string] => ['BUNDLE_FAILURES', sentence]),
    ['BUNDLE_FAILURES unknown-field', BUNDLE_FAILURES['unknown-field']],
    ['STALE_DRAFT_TEXT', STALE_DRAFT_TEXT],
    ['the draft shape error', POLICY_DRAFT_SHAPE_TEXT],
    ['FAILED_CLOSED_LABEL_TEXT', FAILED_CLOSED_LABEL_TEXT],
    ['ADD_CLEARANCE_HINT', ADD_CLEARANCE_HINT],
    ['localHostPatternNotice', localHostPatternNotice(['*.example.test'])],
    ['ROUTE_CHECK_FAILED_TEXT', ROUTE_CHECK_FAILED_TEXT],
    ['mcpCeilingText', mcpCeilingText('example-server', label as never, ceiling as never)],
    ['mcpCeilingUnjudgedText', mcpCeilingUnjudgedText('example-server')],
    ['NO_SIGNING_KEY_TEXT', NO_SIGNING_KEY_TEXT]
  ];
  const display: Array<[string, string]> = [
    ['NO_DRAFT_TEXT', commands.NO_DRAFT_TEXT],
    ['editPolicyNotice', commands.editPolicyNotice(ceiling as never)],
    ['NO_LABELS_WHILE_FAILED_TEXT', commands.NO_LABELS_WHILE_FAILED_TEXT],
    ['notYourClearanceText', commands.notYourClearanceText(label as never)]
  ];
  for (const [group, command, edit] of [[original, 'SovAI: Policy', 'Edit my rules'], [display, policy, 'Edit my Standing Orders']] as const) {
    for (const [name, sentence] of group) {
      assert.ok(sentence.includes(command), `${name} names ${command}: ${sentence}`);
      assert.doesNotMatch(sentence, LEFT_THE_PALETTE, name);
      assert.ok(!sentence.includes(EM_DASH), name);
      assert.doesNotMatch(sentence, /NEAR (AI )?organization/i, name);
      if (/STALE|NO_DRAFT|shape|notYourClearance|ADD_CLEARANCE|localHost|mcpCeilingText$/.test(name)) assert.ok(sentence.includes(edit), `${name}: ${sentence}`);
    }
  }
  assert.ok(commands.editPolicyNotice(ceiling as never).includes(`Apply my draft in ${policy}`));
});

// ---- Phase 41 (D-46): the rest of SECURITY.md, README and CHANGELOG, each new sentence checked against the code ----

const LAYERS_HEADING = '#### Layers, the policy page and versions';
const PLACES_HEADING = '#### Where AI may run';
const EXPORT_HEADING = '#### Export-controlled content';
const TRUST_LINE_HEADING = '#### The trust line';
const routingSection = sectionOf(SECURITY, LABELS_HEADING);
const changelogOrganizationHeading = "### Your organization's rules";
const changelogOrganizationRelease = CHANGELOG.split(/\n(?=## )/).find((section) =>
  /^## (?:Unreleased|\d+\.\d+\.\d+)\n/.test(section) && section.includes(`\n${changelogOrganizationHeading}\n`));
assert.ok(changelogOrganizationRelease, 'organization rules are documented under Unreleased or a tagged version');
const changelogOrganization = sectionOf(changelogOrganizationRelease, changelogOrganizationHeading);
/** Prose only: inline code is an identifier for administrators (`accredited-device`), not a claim, so the clean-text counters read the words around it. */
const prose = (text: string): string => flat(text).replace(/`[^`]*`/g, ' ');

async function editorTitles(): Promise<{ own: string; organization: string }> {
  const uninstall = installVscodeStub(createVscodeStub());
  try {
    const editor = await import('../services/policyEditor');
    return { own: editor.POLICY_EDITOR_TITLE_OWN, organization: editor.POLICY_EDITOR_TITLE };
  } finally {
    uninstall();
  }
}

test('Phase 41: layers, Reset and the policy page', async () => {
  const { PROPOSAL_FILE_EXTENSION } = await import('../domain/gate/proposal');
  const { ignoredSettingsNotice, widerThanOrganizationText } = await import('../domain/gate/layers');
  const { needsUpdateSentence } = await import('../domain/gate/bundle');
  const titles = await editorTitles();
  const block = sectionOf(SECURITY, LAYERS_HEADING);
  assert.ok(policySection.includes(block), 'inside the policy section');
  const words = flat(block);
  const setting = { key: 'labels.routing.levels.org/Internal', yours: 'any-cloud', allowed: 'local-only', layer: 'personal' } as const;
  for (const phrase of [
    '"Your organization\'s rules"', '"Your rules"', '**SovAI: Policy**', `\`${PROPOSAL_FILE_EXTENSION}\``,
    ignoredSettingsNotice([setting as never]) ?? '', widerThanOrganizationText(setting as never),
    '**Reset touches your own rules only.**', "Your organization's rules, and the files that hold them, stay as they are.",
    'is never reset for you', needsUpdateSentence('0.5.0'),
    'A policy file an earlier version wrote (version 1) is read as it is and never rewritten on its own; the first change you apply writes version 2.',
    'There is no command to leave your organization.',
    '**Apply to my rules**', '**Save a file for your organization**', '**Discard**', '**Wider**', '**Stricter**',
    '**Edit my rules**', '**Apply my draft**', '**Show as stored**', '**Reset my rules**'
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  // The page's own words: each button the text names is the page's.
  for (const label of ['Apply to my Standing Orders', 'Save a file for your organization', 'Discard', 'Edit my Standing Orders', 'Apply my draft', 'Show as stored', 'Reset my Standing Orders', 'Wider', 'Stricter']) {
    assert.ok(POLICY_PAGE.includes(`'${label}'`), `${label} is the page's word`);
  }
  assert.equal(titles.organization, "Your organization's Standing Orders");
  assert.equal(titles.own, 'Your Standing Orders');
});

test('Phase 41: authorizations, each kind with its longest life, and self-signed until your organization signs them', async () => {
  const { AUTHORIZATION_KINDS, MAX_DAYS_BY_KIND, SELF_SIGNED_TEXT } = await import('../domain/gate/authorizations');
  const words = flat(sectionOf(SECURITY, PLACES_HEADING));
  assert.ok(routingSection.includes(sectionOf(SECURITY, PLACES_HEADING)), 'inside the routing section');
  assert.ok(words.includes(`"(${SELF_SIGNED_TEXT})"`), SELF_SIGNED_TEXT);
  for (const kind of AUTHORIZATION_KINDS) {
    const days = MAX_DAYS_BY_KIND[kind];
    assert.ok(words.includes(days === undefined ? `(\`${kind}\`,` : `(\`${kind}\`, at most ${String(days)} days)`), `${kind}: ${String(days)}`);
  }
  assert.ok(words.includes('(`declassify`, with no fixed end)'));
  assert.ok(words.includes('(`export-person`, at most five years'));
  assert.ok(words.includes('Under your organization\'s rules only authorizations signed by a key your organization lists count.'));
});

test('Phase 41: one list of where AI may run, the Protected B rule, residency and the rules that only record', async () => {
  const { ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD } = await import('../domain/gate/routing');
  const { migrationNoticeText } = await import('../gate/organizationStore');
  const block = sectionOf(SECURITY, PLACES_HEADING);
  const words = flat(block);
  const known = new Set<string>([...ROUTE_RULES, ...ROUTE_RULES_NAMED_AHEAD]);
  for (const id of ['route.endpoint-unknown', 'route.endpoint-ceiling', 'route.endpoint-pin', 'route.authorization-missing', 'route.residency', 'route.accredited-device', 'route.passport']) {
    assert.ok(words.includes(`\`${id}\``), id);
    assert.ok(known.has(id), `${id} is a rule the code names`);
  }
  for (const id of ['route.endpoint-unknown', 'route.endpoint-ceiling', 'route.endpoint-pin', 'route.authorization-missing', 'route.residency']) assert.ok((ROUTE_RULES as readonly string[]).includes(id), `${id} refuses`);
  // Phase 74.1 (D-11, D-12): model approvals refuse under mode enforce and only record otherwise.
  assert.ok((ROUTE_RULES as readonly string[]).includes('route.passport'), 'model approvals are a route rule decideRoute reaches');
  const notice = migrationNoticeText([{ host: 'llm.example.test', kind: 'org-plain', lost: [] } as never]) ?? '';
  for (const phrase of [
    notice, '`routing.localHosts`',
    'So Protected B needs a TLS pin or a verified connection plus a Protected B authorization naming that server, for every server that is not this computer.',
    'a place whose region is `unstated` never satisfies such a rule',
    'is not refused unless your organization\'s rules turn on `requireAccreditedDevice`',
    'is recorded (`route.passport`) and sent, and with no `models` section the shipped approvals are used in this report mode',
    'When your organization\'s `models` section says `mode: enforce`, the same request is refused before anything is sent, with the reason.',
    'nothing changes where requests go'
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  assert.match(notice, /^Your policy's local servers are now listed with every other place AI may run, with the same effect as before\.$/);
});

test('Phase 41: private means verified, in the setting\'s own words', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { configuration: unknown } };
  const blocks = (Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration]) as Array<{ properties: Record<string, { enum?: string[]; enumDescriptions?: string[] }> }>;
  const setting = blocks.map((block) => block.properties['nearAi.privacyMode']).find((entry) => entry !== undefined);
  const teeOnly = setting?.enumDescriptions?.[setting.enum?.indexOf('tee-only') ?? -1] ?? '';
  assert.ok(teeOnly.startsWith('Only verified private hardware or this computer'), teeOnly);
  const words = flat(sectionOf(SECURITY, '### Which models are private'));
  assert.ok(words.includes(`"${teeOnly}"`), 'the setting\'s words, whole');
  assert.ok(words.includes('Agent teams and members marked private decide through the same check'));
});

test('Phase 41: the trust line, three parts in TRUST_LINE_TEXT\'s words and trustLine\'s own output', async () => {
  const { TRUST_LINE_TEXT, trustLine } = await import('../domain/gate/trust');
  const { SCALE_PRESETS } = await import('../domain/gate/labels');
  const block = sectionOf(SECURITY, TRUST_LINE_HEADING);
  assert.ok(sectionOf(SECURITY, BADGE_HEADING).includes(block), 'inside the trust badge section');
  const words = flat(block);
  const label = (scale: string, level: string) => ({ scale, level, compartments: [], releasability: [], handling: [] });
  const verified = trustLine({ place: { class: 'nearai-tee', region: 'unstated' }, verification: 'verified-private', allowedBy: [{ kind: 'routing', label: 'org/Internal' }], label: label('org', 'Internal'), wouldRefuse: [] } as never, SCALE_PRESETS);
  const authorized = trustLine({
    place: { class: 'org-plain', region: 'CA', endpointId: 'hq-server' }, verification: 'not-checked', label: label('ca-protected', 'Protected B'), wouldRefuse: [],
    allowedBy: [{ kind: 'routing', label: 'ca-protected/Protected B' }, { kind: 'authorization', authorizationKind: 'protected-b', id: 'pb-2027-01', name: 'Alex Example', expiresAt: '2027-03-31T00:00:00.000Z', selfSigned: true, label: 'ca-protected/Protected B' }]
  } as never, SCALE_PRESETS);
  for (const line of [verified.text, authorized.text]) assert.ok(words.includes(`"${line}"`), line);
  assert.ok(verified.text.split(TRUST_LINE_TEXT.partSeparator).length === 3, 'three parts');
  for (const place of Object.values(TRUST_LINE_TEXT.places)) assert.ok(words.includes(place), place);
  assert.ok(words.includes(TRUST_LINE_TEXT.verified['not-checked']));
  const { TRUST_BADGE_TEXT } = await import('../domain/gate/trustBadge');
  assert.ok(words.includes(`"${TRUST_BADGE_TEXT.allowedNotKept}"`));
});

test('Phase 41: the outbound check keeps its own checks and no longer decides where a request goes', () => {
  const words = flat(sectionOf(SECURITY, '## The outbound check'));
  assert.ok(words.includes('The outbound check no longer decides where a request goes.'));
  assert.ok(words.includes('The outbound check keeps its own checks for credentials, personal data and private-file paths; where a request may go is the route check\'s alone'));
  assert.doesNotMatch(words, /Blocks models NEAR forwards to another provider\./, 'the old step 3 is gone');
});

test('D-62 to D-64: export-controlled content in plain words, the starting rules read from code', async () => {
  const { EXPORT_COMPARTMENT_SHOWN, RESERVED_EXPORT_COMPARTMENTS } = await import('../domain/gate/labels');
  const block = sectionOf(SECURITY, EXPORT_HEADING);
  assert.ok(routingSection.includes(block), 'inside the routing section');
  const words = flat(block);
  assert.deepEqual([...RESERVED_EXPORT_COMPARTMENTS].sort(), ['CGP', 'EAR', 'ITAR']);
  for (const token of RESERVED_EXPORT_COMPARTMENTS) {
    assert.equal(DEFAULT_ROUTING.compartments[token], 'local-only', `the starting rules keep ${token} on this computer`);
    assert.ok(words.includes(EXPORT_COMPARTMENT_SHOWN[token]), EXPORT_COMPARTMENT_SHOWN[token]);
    assert.equal(words.split(`\`${token}\``).length - 1, 1, `${token} as a token once, in code formatting`);
  }
  const shown = `${EXPORT_COMPARTMENT_SHOWN.CGP}, ${EXPORT_COMPARTMENT_SHOWN.ITAR} or ${EXPORT_COMPARTMENT_SHOWN.EAR}`;
  for (const phrase of [
    `Under the starting rules, content marked ${shown} stays on this computer`,
    'A policy someone edited is not changed in place; it gets them through a change on the policy page.',
    'Under your organization\'s rules, your organization decides.',
    'Your organization\'s rules can now carry its export-control decisions: who may see such content and which AI services may receive it. Nothing grants access with them yet',
    'the rule `route.export-control` are shapes that are read and recorded only, and never decide a request',
    'Meeting the Controlled Goods Program or the ITAR is your organization\'s obligation, and your officials decide.'
  ]) assert.ok(words.includes(flat(phrase)), phrase);
  const { ROUTE_RULES } = await import('../domain/gate/routing');
  assert.ok(!(ROUTE_RULES as readonly string[]).includes('route.export-control'), 'never returned in this version, as the text says');
  const readme = flat(readmePolicy);
  assert.ok(readme.includes(`Content marked ${shown} stays on this computer under the starting rules`));
  assert.ok(readme.includes('nothing grants access with them yet'));
});

// W1 (Phase 41 verification): the export entries reach an upgraded install only when unedited starting rules are renewed (bundle.ts renewalPayload and
// isDefaultBundle, held by gateBundle's D-62 tests), so README and CHANGELOG say so as SECURITY.md does, with the renewal window read from code.
test('W1, D-62: SECURITY.md, README and CHANGELOG say an upgraded install gets the export entries when its starting rules are renewed', async () => {
  const { RENEW_WINDOW_DAYS, SELF_SIGNED_LIFETIME_DAYS } = await import('../domain/gate/bundle');
  assert.equal(RENEW_WINDOW_DAYS, 30, 'the docs say the last 30 days');
  assert.equal(SELF_SIGNED_LIFETIME_DAYS, 365);
  const fresh = 'A fresh install, and the renewal of starting rules nobody edited, get these entries';
  const security = flat(sectionOf(SECURITY, EXPORT_HEADING));
  const readme = flat(readmePolicy);
  const exportBullet = flat(changelogOrganization.split('\n- ').find((bullet) => bullet.includes('Controlled goods (Canada)')) ?? '');
  for (const [name, text] of [['SECURITY.md', security], ['README', readme], ['CHANGELOG', exportBullet]] as const) {
    assert.ok(text.includes(fresh), `${name}: ${fresh}`);
    assert.match(text, new RegExp(`whose starting rules nobody edited gets them when its policy is next renewed, in the last ${String(RENEW_WINDOW_DAYS)} days before`), name);
    assert.ok(text.includes('change on the policy page'), `${name}: an edited policy gets them by a change`);
  }
  assert.ok(security.includes('until then those markings are routed by their level'));
});

// WR-04: SECURITY.md describes the issuer key file as scripts/org-issuer.mjs seals it.
test('WR-04: SECURITY.md describes the issuer key file sealing the script uses', () => {
  const script = readFileSync(path.join(ROOT, 'scripts', 'org-issuer.mjs'), 'utf8');
  assert.ok(script.includes("kdf: 'scrypt', N: 2 ** 17, r: 8, p: 1, cipher: 'aes-256-gcm', saltBytes: 16, nonceBytes: 12"), 'the sealing in the script');
  assert.doesNotMatch(script, /aes-256-cbc|privateKeyEncoding/, 'no PKCS#8 PBKDF2 key file is written');
  const block = flat(sectionOf(SECURITY, ORGANIZATION_RULES_HEADING));
  for (const phrase of [
    'The key file is sealed with AES-256-GCM under a key that scrypt derives from the passphrase (N = 2^17, r = 8, p = 1, a random 16-byte salt and 12-byte nonce for each file)',
    'The tool opens a new key file again with its passphrase before it says done, and refuses a key file that is not sealed this way, including an unencrypted key.'
  ]) assert.ok(block.includes(phrase), phrase);
});

test('D-64: no compliance claim in any new text, and the counter has teeth', async () => {
  const { countHits } = await import('./helpers/copyLintScan');
  const claims = (text: string): number => countHits([{ text: prose(text) }], 'SECURITY.md')['SECURITY.md']?.['compliance-claim'] ?? 0;
  assert.equal(claims('NEAR AI is ITAR compliant.'), 1, 'a planted claim is counted');
  assert.equal(claims('This computer is accredited for Protected C.'), 1, 'a planted claim is counted');
  assert.equal(claims('NEAR AI does not make your organization compliant with either.'), 0, 'a negated sentence is allowed');
  for (const [name, text] of newDocsBlocks()) assert.equal(claims(text), 0, name);
});

/** Every block of copy Phase 41 added to SECURITY.md, README and CHANGELOG. */
function newDocsBlocks(): Array<[string, string]> {
  const limitationRows = limitations.split('\n').filter((line) => /twelve words protect|export-control decisions|server does not load|Model approvals, and the rule|self-signed on this computer until|no command to leave/.test(line));
  assert.equal(limitationRows.length, 6, 'the six new Known limitations rows');
  const privacy = flat(sectionOf(SECURITY, '### Which models are private'));
  const outbound = flat(sectionOf(SECURITY, '## The outbound check'));
  return [
    ['organization rules block', sectionOf(SECURITY, ORGANIZATION_RULES_HEADING)],
    ['layers block', sectionOf(SECURITY, LAYERS_HEADING)],
    ['places block', sectionOf(SECURITY, PLACES_HEADING)],
    ['export block', sectionOf(SECURITY, EXPORT_HEADING)],
    ['trust line block', sectionOf(SECURITY, TRUST_LINE_HEADING)],
    ['private paragraph', privacy.slice(privacy.indexOf("The setting's own words"), privacy.indexOf('**Where private models come from.**'))],
    ['outbound check', outbound.slice(outbound.indexOf('3. **TEE-only mode.**'), outbound.indexOf('Earlier turns of a conversation'))],
    ['Known limitations rows', limitationRows.join('\n')],
    ['README policy bullet', readmePolicy],
    ['CHANGELOG organization section', changelogOrganization]
  ];
}

test('Phase 41: Known limitations has a row for each new gap', () => {
  const rows = limitations.split('\n');
  for (const start of [
    "| The twelve words protect your organization's key only when its security contact reads them to you over a channel you trust |",
    "| Your organization's rules can carry export-control decisions, but nothing grants access with them yet, and SovAI does not make your organization compliant with the Controlled Goods Program or the ITAR |",
    "| Your organization's server does not load your organization's rules yet |",
    '| Model approvals, and the rule for work that may run only on an approved computer, record what they would refuse and do not refuse it |',
    '| Authorizations are self-signed on this computer until your organization\'s issuer can sign them |',
    '| There is no command to leave your organization |'
  ]) assert.ok(rows.some((row) => row.startsWith(start)), start);
  assert.ok(flat(limitations).includes("Your organization's officials decide"));
});

test('Phase 41: README and CHANGELOG say the same in plain words', async () => {
  const titles = await editorTitles();
  const readme = flat(readmePolicy);
  for (const phrase of [`"${titles.organization}"`, `**${commandName('nearAi.organization.addRules')}**`, `**${commandName('nearAi.policy.open')}**`, 'twelve words',
    'Protected B sent to a server your policy names as local now needs a TLS pin and a Protected B authorization naming that server.']) {
    assert.ok(readme.includes(phrase), phrase);
  }
  assert.ok(readmePolicy.startsWith('- **Your Standing Orders.**'));
  // The organization rules stay above Fixes when the entry moves into a release.
  assert.ok(changelogOrganizationRelease.indexOf(changelogOrganizationHeading) < changelogOrganizationRelease.indexOf('### Fixes'), 'above Fixes');
  const entry = flat(changelogOrganization);
  // CHANGELOG.md is history: that release named its commands under the NEAR AI category, which later became SovAI (owner, 2026-11-24).
  for (const phrase of [
    'Protected B sent to a server your policy names as local now needs a TLS pin and a Protected B authorization naming that server.',
    "**NEAR AI: Add Your Organization's Rules**", '**NEAR AI: Policy**', '"Your organization\'s rules"', '**Reset my rules**'
  ]) assert.ok(entry.includes(phrase), phrase);
  const exportBullets = changelogOrganization.split('\n- ').filter((bullet) => bullet.includes('Controlled goods (Canada)'));
  assert.equal(exportBullets.length, 1, 'one export bullet');
  assert.match(flat(exportBullets[0] ?? ''), /stays on this computer under the starting rules[^]*later release/);
  for (const line of changelogOrganization.split('\n').filter((text) => text.startsWith('- '))) assert.match(line, /^- \*\*[^*]+\*\*/, `each bullet leads with a bold sentence: ${line.slice(0, 60)}`);
  assert.doesNotMatch(entry, /\b(?:decideRoute|composeLayers|bundleVersion|route\.[a-z-]+|PR #\d+)\b/, 'no internal names');
});

test('README identifies the current editor and reset labels and neither guide lists the hidden palette commands', () => {
  assert.doesNotMatch(SECURITY, LEFT_THE_PALETTE, 'the security guide does not list the hidden commands');
  assert.doesNotMatch(README, LEFT_THE_PALETTE, 'README does not list the hidden commands');
  assert.ok(README.includes(`**${commandName('nearAi.policy.open')}**`));
  assert.ok(README.includes('**Reset my Standing Orders**'));
});

test('Phase 41: the new text is clean: no em-dash, no provider name before organization, no bare team', async () => {
  const { countHits } = await import('./helpers/copyLintScan');
  const hits = (text: string) => countHits([{ text: prose(text) }], 'SECURITY.md')['SECURITY.md'] ?? {};
  assert.equal(hits('Ask the team.')['bare-team'], 1, 'the bare team counter has teeth');
  assert.equal(hits(['Ask', 'NEAR', 'organization.'].join(' '))['provider-organization'], 1, 'the provider counter has teeth');
  for (const [name, text] of newDocsBlocks()) {
    assert.ok(text.length > 100, name);
    assert.ok(!text.includes(EM_DASH), `${name}: no em-dash`);
    const found = hits(text);
    assert.equal(found['provider-organization'] ?? 0, 0, `${name}: never the provider's name before organization`);
    assert.equal(found['bare-team'] ?? 0, 0, `${name}: no bare team`);
    assert.equal(found['em-dash'] ?? 0, 0, name);
  }
});

test('Phase 41 review: SECURITY.md says what the review fixes do (CR-01, WR-01, CR-02, WR-03, WR-05, IN-07)', async () => {
  const { DAMAGED_PIN_TEXT } = await import('../gate/organizationStore');
  const { ENDPOINT_SCHEME_TEXT } = await import('../domain/gate/routing');
  const { isNearCloudEndpoint } = await import('../domain/config');
  const text = flat(SECURITY);
  for (const sentence of [
    "If that record disappears from secret storage while your organization's rules are still on this computer, SovAI does not fall back to your own rules: only reading and planning run until you open your organization's enrolment file again and compare the twelve words.",
    'If the rules file on this computer goes missing, or an older one is put in its place, opening the current rules file or enrolment file again writes it back without changing the key in use.',
    'A place your rules list is reached only over https; a plain http connection to it is refused (`route.endpoint-pin`). This computer is the only exception.',
    "Only NEAR AI Cloud's own host may be listed as NEAR AI private hardware (`nearai-tee`).",
    "Only a model NEAR AI's catalog marks as running in private hardware counts as running in a place your rules list as NEAR AI private hardware; any other model on that host is forwarded to an outside provider, with no stated region, and no authorization naming that place covers it.",
    'A step that only records never refuses, even when its check cannot be made; it is then recorded as one that would refuse.'
  ]) assert.ok(text.includes(sentence), sentence);
  // The code the sentences describe.
  assert.match(DAMAGED_PIN_TEXT, /enrolment file again/);
  assert.match(ENDPOINT_SCHEME_TEXT, /^Nothing was sent\. .*https connections only/);
  assert.equal(isNearCloudEndpoint('https://example.org'), false);
});

// Phase 74.1 (41 D-46, D-27; 74.1-16): "Which models may do what" says what the model approvals do, in the code's own sentences, right after the routing
// section; it names no edition and offers no security officer's switch, which is not yet available (G418).
const MODELS_HEADING = '### Which models may do what';
const MODELS_PAGE = readFileSync(path.join(ROOT, 'docs-site', 'content', 'security', 'models.md'), 'utf8');

test('74.1: SECURITY.md has "Which models may do what" once, right after the routing section and before the sub-agent section', () => {
  assert.equal(SECURITY.split(`\n${MODELS_HEADING}\n`).length - 1, 1);
  const here = SECURITY.indexOf(`\n${MODELS_HEADING}\n`);
  const routing = SECURITY.indexOf(`\n${LABELS_HEADING}\n`);
  assert.ok(routing >= 0 && routing < here, 'after the routing section');
  assert.equal(routing + 1 + routingSection.length, here, 'right after it, with nothing between');
  assert.ok(here < SECURITY.indexOf('\n### Sub-agents nobody is watching\n'));
});

test('74.1: the section carries the research workspace banner and its notice word for word', async () => {
  const { RESEARCH_TEXT } = await import('../domain/gate/researchLane');
  const words = flat(sectionOf(SECURITY, MODELS_HEADING));
  assert.equal(RESEARCH_TEXT.banner, 'Research workspace. Adversary models allowed. No project data.');
  assert.equal(RESEARCH_TEXT.laneNotice, 'This is the research workspace. It cannot open project files, run commands or use tools.');
  assert.ok(words.includes(`"${RESEARCH_TEXT.banner}"`), RESEARCH_TEXT.banner);
  assert.ok(words.includes(`"${RESEARCH_TEXT.laneNotice}"`), RESEARCH_TEXT.laneNotice);
});

test('74.1: the section carries the line text copied out of the research workspace starts with, word for word', async () => {
  const { RESEARCH_TEXT } = await import('../domain/gate/researchLane');
  assert.equal(RESEARCH_TEXT.copyHeader, 'From the research workspace, model {model}, untrusted');
  assert.ok(flat(sectionOf(SECURITY, MODELS_HEADING)).includes(`"${RESEARCH_TEXT.copyHeader}"`));
});

test('74.1: the section carries the different-family sentence as the code builds it', async () => {
  const { sameFamilyText } = await import('../domain/gate/lineage');
  const sentence = sameFamilyText('{model}', '{family}');
  assert.equal(sentence, 'This check was not given to {model}, because it comes from the same family ({family}) as the model it checks, and no approved model of another family is available. A person decides instead.');
  assert.ok(flat(sectionOf(SECURITY, MODELS_HEADING)).includes(`"${sentence}"`));
});

test('74.1: the section carries the report-only notice word for word, and says it cannot be dismissed', async () => {
  const uninstall = installVscodeStub(createVscodeStub());
  try {
    const { REPORT_MODE_TEXT } = await import('../services/reportModeNotice');
    assert.equal(REPORT_MODE_TEXT.noticeOrg, 'Agent work is running outside your organization\'s model policy (report only).');
    const words = flat(sectionOf(SECURITY, MODELS_HEADING));
    assert.ok(words.includes(`"${REPORT_MODE_TEXT.noticeOrg}"`), REPORT_MODE_TEXT.noticeOrg);
    assert.ok(words.includes(`"${REPORT_MODE_TEXT.noticeOwn}"`), REPORT_MODE_TEXT.noticeOwn);
    assert.ok(words.includes('with no way to close it'));
  } finally {
    uninstall();
  }
});

test('74.1: the section quotes a refusal in the refusal form as the code builds it: "Nothing was sent." first, "Who to ask:" last', async () => {
  const { PASSPORT_GAP_TEXT, whoToAsk } = await import('../domain/gate/passportStep');
  const refusal = PASSPORT_GAP_TEXT['not-evaluated']({ model: 'gpt-oss-120b', use: 'T2', whoToAsk: whoToAsk(undefined, true) } as never);
  assert.match(refusal, /^Nothing was sent\. .* Who to ask: your organization's security contact\.$/);
  const words = flat(sectionOf(SECURITY, MODELS_HEADING));
  assert.ok(words.includes(`"${refusal}"`), refusal);
  for (const part of ['"Nothing was sent."', '"Who to ask:"']) assert.ok(words.includes(part), part);
});

test('74.1: exceptions, the commands and the bill of materials are named as the code names them', async () => {
  const { EXCEPTION_TEXT } = await import('../domain/gate/riskAcceptance');
  const words = flat(sectionOf(SECURITY, MODELS_HEADING));
  for (const phrase of [
    `**${commandName('nearAi.models.openResearchWorkspace')}**`, `**${commandName('nearAi.models.exportAiBom')}**`, `**${EXCEPTION_TEXT.ask}**`,
    '"Allowed for chat you review by {name} until {date}"', 'at most 90 days', '`.near-ai/state/ai-bom.cdx.json`', 'CycloneDX 1.6'
  ]) assert.ok(words.includes(phrase), phrase);
  assert.doesNotMatch(words, /self-signed on this computer/, 'an exception has no self-signed form (D-20)');
});

test('74.1: the known limits name their gaps, and nothing in SECURITY.md, README or the docs page offers the switch that has not shipped', () => {
  const section = flat(sectionOf(SECURITY, MODELS_HEADING));
  for (const id of ['G408', 'G410', 'G411', 'G413', 'G414', 'G418', 'G537']) assert.ok(section.includes(id), id);
  for (const [name, text] of [['SECURITY.md', SECURITY], ['README', README], ['models.md', MODELS_PAGE]] as const) {
    const said = flat(text).match(/[^.]*Stop agent work now[^.]*\./g) ?? [];
    assert.ok(said.every((sentence) => /not yet available/.test(sentence)), `${name}: ${said.join(' | ')}`);
  }
});

test('74.1: the docs page says the same for people and assessors, names no edition, links the road to production, and sits after the trust model', async () => {
  const { RESEARCH_TEXT } = await import('../domain/gate/researchLane');
  const page = flat(MODELS_PAGE);
  for (const phrase of [RESEARCH_TEXT.banner, RESEARCH_TEXT.laneNotice, '(./road-to-production.md)', '(./policy.synced.md#which-models-may-do-what)']) assert.ok(page.includes(phrase), phrase);
  assert.doesNotMatch(MODELS_PAGE, /sterling|defence edition/i);
  assert.ok(!MODELS_PAGE.includes(EM_DASH));
  const sidebar = readFileSync(path.join(ROOT, 'docs-site', 'sidebars.js'), 'utf8');
  assert.match(sidebar, /'security\/trust-model', 'security\/models'/);
});

test('74.1: README and CHANGELOG name what 74.1 ships in the glossary words, never bare private, and no edition', () => {
  const unreleased = CHANGELOG.split(/\n(?=## )/).find((section) => section.startsWith('## Unreleased\n')) ?? '';
  for (const [name, text] of [['README', README], ['CHANGELOG', unreleased]] as const) {
    const words = flat(text);
    for (const phrase of ['Approved for', 'Open Research Workspace', 'report only', 'Allowed for chat you review', 'Western defaults', 'Export AI Bill of Materials']) {
      assert.ok(words.includes(phrase), `${name}: ${phrase}`);
    }
  }
  for (const line of unreleased.split('\n').filter((text) => text.startsWith('- '))) assert.doesNotMatch(line, /\b[Pp]rivate\b(?! hardware)/, `no bare private: ${line.slice(0, 80)}`);
  assert.doesNotMatch(unreleased, /Sterling|Defence Edition/);
});

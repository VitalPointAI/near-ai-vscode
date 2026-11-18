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
const readmePolicy = README.slice(README.indexOf('- **Your policy.**'), README.indexOf("- API keys live in VS Code's encrypted"));

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

test('the commands the docs name are the ones package.json contributes, and the failure sentences name the same reset command', () => {
  const reset = commandName('nearAi.policy.reset');
  const show = commandName('nearAi.policy.show');
  assert.equal(reset, 'NEAR AI: Reset Policy to Defaults');
  assert.equal(show, 'NEAR AI: Show Policy');
  for (const text of [policySection, readmePolicy]) {
    assert.ok(flat(text).includes(reset), 'Reset Policy to Defaults');
    assert.ok(flat(text).includes(show), 'Show Policy');
  }
  assert.ok(flat(README).includes(reset) && flat(README).includes(show));
  for (const sentence of Object.values(BUNDLE_FAILURES)) {
    if (sentence.includes('Reset Policy to Defaults')) assert.ok(sentence.includes(reset), sentence);
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
    'Only that command re-signs a policy that failed',
    'keeps the old file beside the new one',
    'records the reset',
    'Nothing in a decision needs the network',
    'before a record is written NEAR AI removes',
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
  assert.deepEqual([setLabel, edit, applyDraft], ['NEAR AI: Set Label', 'NEAR AI: Edit Policy', 'NEAR AI: Apply Policy Draft']);
  const words = flat(policySection);
  for (const phrase of [setLabel, edit, applyDraft, '`.planning/.near-ai/labels.json`, signed with your device key, and travel with the project',
    'anyone who can read the project can read its labels, compartment names included', 'only ever makes a label stricter', 'signed again only after you confirm',
    'or that was deleted, stops agents reading the project', 'through the file tools, searches or a command that names it',
    'Decision records hold the labels involved and stay on this computer', 'Where a labelled chat\'s content may be sent is in']) {
    assert.ok(words.includes(phrase), phrase);
  }
  assert.ok(!policySection.includes(EM_DASH));
  assert.doesNotMatch(policySection, /NEAR organization/);
});

test('README names Set Label, Lower This Chat\'s Label, Edit Policy and Apply Policy Draft, says a chat\'s label decides where its content is sent, and links the policy section', () => {
  const words = flat(readmePolicy);
  for (const id of ['nearAi.label.set', 'nearAi.label.lowerChat', 'nearAi.policy.edit', 'nearAi.policy.applyDraft']) assert.ok(words.includes(commandName(id)), id);
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
    "Reading NEAR AI's own Open-GSD runtime files is judged at the default label",
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
    'Only you lower it, with **NEAR AI: Lower This Chat\'s Label** and a reason that is recorded', 'declassification signed with your device key that they can check',
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
  for (const id of ['nearAi.label.set', 'nearAi.label.lowerChat', 'nearAi.policy.edit']) assert.ok(words.includes(commandName(id)), id);
  const commands = readFileSync(path.join(ROOT, 'src', 'services', 'gateCommands.ts'), 'utf8');
  assert.ok(commands.includes('placeHolder: LABELS_NOT_ACCREDITATION_TEXT'), 'Set Label shows the constant itself');
});

test('PR #87 review: SECURITY.md says how a reopened chat treats its earlier results, and the refusal for them says so truly, with the way out', () => {
  assert.ok(flat(sectionOf(SECURITY, '### Classification labels and routing')).includes(flat(OUTBOUND_REOPENED_DOCS_TEXT)));
  assert.match(OUTBOUND_EARLIER_TEXT, /cannot tell which of its earlier results came from labelled files/);
  assert.match(OUTBOUND_EARLIER_TEXT, /NEAR AI: Lower This Chat's Label/);
  for (const text of [OUTBOUND_REOPENED_DOCS_TEXT, OUTBOUND_EARLIER_TEXT]) {
    assert.ok(!text.includes(EM_DASH));
    assert.doesNotMatch(text, /NEAR organization|Phase \d/);
  }
});

test('PR #87 review round 2: the refusal of a run whose reading could not be checked says so, names the way out, and never claims labelled content was read', () => {
  assert.match(OUTBOUND_UNCHECKED_TEXT, /could not be checked for labelled text/);
  assert.match(OUTBOUND_UNCHECKED_TEXT, /NEAR AI: Lower This Chat's Label/);
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
    'That costs one signature request per answer; an attestation report NEAR AI has already verified for the same signing key is reused for up to ten minutes.',
    `A check that has not finished after ${String(BADGE_CHECK_TIMEOUT_MS / 1000)} seconds shows **Not verified**, saying it could not be checked in time`,
    'if the check finishes later, the badge changes.',
    'The badge is on the lead agent\'s answers only.',
    'each badge\'s details say that helper agents in the run may have used other models, each request routed by the chat\'s label and recorded.',
    'it lifts that stop when the answer now checks out.',
    '**Show full attestation** opens the details in an editor tab',
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
    'the request is sent without the key held instead of being refused, its model request record says it fell back (and nothing about its content), and the answer\'s badge shows **Model verified, connection not proven**.',
    'With no fresh proof the request is sent as before',
    'The badge is on the lead agent\'s answers only.'
  ]) assert.ok(badge.includes(flat(phrase)), phrase);
  assert.ok(flat(policySection).includes('`connectionFallback: "unpinned"`'), 'the record field is named where model request records are described');
  const readme = flat(README);
  assert.ok(readme.includes('A **trust badge** under each cloud answer of the lead agent says'));
  assert.ok(readme.includes('It is on the lead agent\'s answers only; a helper agent\'s answer has none.'));
  assert.ok(readme.includes('At a level that needs an attested cloud a mismatch refuses the request; at other levels it is sent without the key held and the badge says so.'));
  const unreleased = flat(CHANGELOG.slice(CHANGELOG.indexOf('## Unreleased'), CHANGELOG.indexOf('\n## ', CHANGELOG.indexOf('## Unreleased') + 5)));
  assert.ok(unreleased.includes('**Public chats over the proven connection too.**'));
  assert.ok(unreleased.includes('Levels that need an attested cloud still refuse on a mismatch.'));
  for (const text of [badge, unreleased]) { assert.ok(!text.includes(EM_DASH)); assert.doesNotMatch(text, /NEAR organization/); }
});

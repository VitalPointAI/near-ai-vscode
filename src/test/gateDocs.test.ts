// The docs say what the code does (OFFL-02, D-27, D-34): SECURITY.md and README carry the exact strings the code owns (the clearance is self-declared, a
// manifest is a claim, a local server runs with your permissions), name the two commands as the package contributes them, and match the code's numbers.
// The new sections have no em-dash and never say "NEAR organization". Pure: reads the repository's own files, no vscode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT } from '../domain/gate/labels';
import { FLOOR_CANNOT_SEE_TEXT, FLOOR_EFFECTS_CANNOT_SEE_TEXT, namesCredentialStore } from '../domain/gate/floor';
import { classifyCommand, MAX_COMMAND_LENGTH, MAX_NESTING } from '../agent/commandSafety';
import { BUNDLE_FAILURES } from '../domain/gate/bundle';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT } from '../domain/gate/words';
import { MAX_DECISION_LOG_BYTES, MAX_ROTATED_FILES } from '../gate/decisionLog';
import { redactCredentialArguments } from '../domain/redaction';

const ROOT = path.resolve(__dirname, '..', '..');
const SECURITY = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };

const EM_DASH = '—';
const POLICY_HEADING = '### Your policy file and decision records';

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

test('the policy section says what the code does: own storage not the project, own device key (created at activation in every folder), default allows what settings allow, only the command re-signs, no network, records redacted and not synced, labels not used yet', () => {
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
    'does not use them yet'
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

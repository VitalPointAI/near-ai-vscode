// Credential stores and this extension's own folders outside the project, seen in shell commands (GATE-05, D-16). Every check here reads command text and
// resolves paths against a stand-in home folder made under the test run's temporary folder: no command is run, nothing in a real home folder is read, and no
// credential file exists anywhere these tests look.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { floorFactsFor, gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool, readTool, shellReachesCredentialStore } from '../agent/tools';
import { CREDENTIAL_STORES, namesCredentialStore } from '../domain/gate/floor';
import type { GateRuntime } from '../domain/gate/decide';
import { fakeHome } from './helpers/gateFixtures';
import { testGateRuntime } from './helpers/gatedRuns';

const TEMPORARY = path.resolve(tmpdir());
const HOME = fakeHome();
const ROOT = mkdtempSync(path.join(TEMPORARY, 'near-ai-cred-project-'));
const STORAGE = path.join(mkdtempSync(path.join(TEMPORARY, 'near-ai-cred-storage-')), 'globalStorage', 'vitalpoint.near-ai-vscode');
const LOCATIONS = { home: HOME, globalStorage: STORAGE };
const at = (cwd: string = ROOT) => ({ root: ROOT, shell: { workingDirectory: cwd } });

test('the stand-in home is a new folder under this run\'s temporary folder, never the real home', () => {
  assert.ok(HOME.startsWith(`${TEMPORARY}${path.sep}`), HOME);
  if (process.env.TMPDIR) assert.ok(HOME.startsWith(`${path.resolve(process.env.TMPDIR)}${path.sep}`), 'under the TMPDIR the test runner set');
  assert.ok(STORAGE.startsWith(`${TEMPORARY}${path.sep}`));
});

const STORE_COMMANDS = [
  'cat ~/.ssh/id_ed25519', 'cat $HOME/.aws/credentials', 'cat ${HOME}/.azure/accessTokens.json', 'cd ~ && cat .netrc', 'cd && cat .git-credentials',
  'cp ~/.near-credentials/mainnet/x.json /tmp/', 'cat ~/.config/gcloud/application_default_credentials.json', 'secret-tool lookup service x',
  'security find-generic-password -s app -w', 'cat ~/.docker/config.json', 'cat ~/.ss*/id_rsa', 'cat ~/.{ssh,aws}/config', 'cd ~/.aws && cat credentials',
  'pushd ~ && cat .npmrc', `cat ${path.join(HOME, '.kube', 'config')}`, 'cat ~/.gnupg/pubring.kbx'
];
const IDENTITY_COMMANDS = [
  `cat ${path.join(STORAGE, 'gate', 'policy-bundle.json')}`, 'ls ~/.config/Code/User/globalStorage/vitalpoint.near-ai-vscode/identity',
  `cd ${STORAGE} && cat identity/key-history.json`, `cat ${path.join(STORAGE, 'gat*', 'policy-bundle.json')}`
];
const NOT_A_STORE = ['cat ~/.sshrc-notes.md', 'cat docs/.ssh.md', 'ls ~', 'echo hello', '', '   ', 'cat ~/.config/gcloud-notes.txt', 'cat .ssh/config', `ls ${STORAGE}`, `cat ${path.join(STORAGE, 'notes', 'x.json')}`];

test('a command that reaches a credential store is reported, by text and by resolving its words', async () => {
  const missed: string[] = [];
  for (const command of STORE_COMMANDS) if ((await shellReachesCredentialStore(command, at(), LOCATIONS)).credentialStore === undefined) missed.push(command);
  assert.deepEqual(missed, []);
});

test('a shell already in the home folder reaches a store by a bare file name', async () => {
  assert.notEqual((await shellReachesCredentialStore('cat .netrc', at(HOME), LOCATIONS)).credentialStore, undefined);
  assert.notEqual((await shellReachesCredentialStore('cat id_rsa', at(path.join(HOME, '.ssh')), LOCATIONS)).credentialStore, undefined);
  assert.equal((await shellReachesCredentialStore('cat .netrc', at(), LOCATIONS)).credentialStore, undefined, 'the project\'s own .netrc is the settings layer\'s, not the floor\'s');
});

test('a link inside the project that points into a store is followed', async () => {
  mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
  symlinkSync(path.join(HOME, '.ssh'), path.join(ROOT, 'keys'));
  assert.notEqual((await shellReachesCredentialStore('cat keys/id_rsa', at(), LOCATIONS)).credentialStore, undefined);
  assert.notEqual((await shellReachesCredentialStore('ls keys', at(), LOCATIONS)).credentialStore, undefined);
});

test('a command that reaches this extension\'s identity or gate folder is reported as the identity files', async () => {
  const missed: string[] = [];
  for (const command of IDENTITY_COMMANDS) if ((await shellReachesCredentialStore(command, at(), LOCATIONS)).identityFiles === undefined) missed.push(command);
  assert.deepEqual(missed, []);
});

test('look-alikes, the home folder itself and the project\'s own files are not reported', async () => {
  const wrong: string[] = [];
  for (const command of NOT_A_STORE) {
    const reach = await shellReachesCredentialStore(command, at(), LOCATIONS);
    if (reach.credentialStore !== undefined || reach.identityFiles !== undefined) wrong.push(`${command} → ${JSON.stringify(reach)}`);
  }
  assert.deepEqual(wrong, []);
});

// PR #74 review: VS Code's secrets database is reached only where VS Code keeps it. The stand-in global storage sits in a stand-in user-data folder
// (…/globalStorage/vitalpoint.near-ai-vscode), so its secrets database is the folder beside the extension's own; a project file of that name is not one.
test('VS Code\'s secrets database is reached in VS Code\'s storage folders, by path or from the shell\'s folder, and a project file of that name is not', async () => {
  const globalStorage = path.dirname(STORAGE);
  const user = path.dirname(globalStorage);
  for (const [command, cwd] of [
    [`sqlite3 ${path.join(globalStorage, 'state.vscdb')} .dump`, ROOT], ['sqlite3 state.vscdb .dump', globalStorage], ['cp state.vscdb.backup /x', globalStorage],
    [`cd ${globalStorage} && sqlite3 state.vscdb`, ROOT], [`cat ${path.join(user, 'workspaceStorage', 'abc', 'state.vscdb')}`, ROOT]
  ] as const) {
    assert.notEqual((await shellReachesCredentialStore(command, at(cwd), LOCATIONS)).credentialStore, undefined, `${command} (from ${cwd === ROOT ? 'the project' : 'global storage'})`);
  }
  for (const command of ['sqlite3 state.vscdb .dump', 'cat fixtures/state.vscdb', 'cp state.vscdb.backup out/', `sqlite3 ${path.join(ROOT, 'state.vscdb')}`]) {
    assert.equal((await shellReachesCredentialStore(command, at(), LOCATIONS)).credentialStore, undefined, `${command}: the project's own file`);
  }
});

test('floorFactsFor gives the credential-store and identity facts for a shell call, and none for an empty command', async () => {
  for (const command of STORE_COMMANDS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    assert.notEqual(facts.facts.credentialStore, undefined, command);
  }
  for (const command of IDENTITY_COMMANDS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    assert.notEqual(facts.facts.identityFiles, undefined, command);
  }
  for (const command of ['', '  ', 'rm -r']) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    assert.deepEqual(facts.facts, {}, JSON.stringify(command));
    assert.deepEqual(facts.effects, [], JSON.stringify(command));
  }
});

test('in every mode, a command that reaches a credential store or the identity folders is refused by the floor with no card', async () => {
  const cases: Array<[string, string]> = [['cd ~ && cat .netrc', 'floor.credential-store'], ['cat ~/.ss*/id_rsa', 'floor.credential-store'], [`cd ${STORAGE} && cat gate/policy-bundle.json`, 'floor.identity-files']];
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    for (const [command, rule] of cases) {
      const runtime: GateRuntime = { ...testGateRuntime(), locations: LOCATIONS };
      const gated = await gateToolCall(runtime, {
        tool: bashTool, raw: { command }, root: ROOT, callId: `${mode}-${command}`, command, shell: { cwd: ROOT },
        policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
      });
      assert.equal(gated.decision.outcome, 'deny', `${mode} ${command}`);
      assert.equal(gated.decision.rule, rule, `${mode} ${command}`);
      assert.equal(gated.decision.floor, true);
      assert.equal(gated.settings, undefined, `${mode} ${command}: refused before the settings layer is asked`);
    }
  }
});

// PR #74 review round 11: the credential-store check resolves a command word by word, so it has the classifier's own bounds (shared constants). A command
// past them is not resolved at all: the check says it could not read it, and the gate treats the call's effects as unknown (asks with a person, refuses
// with nobody). The text checks still run, so a store the text names is still refused.
test('a command longer than the classifier reads is not resolved word by word: the check says so, and the gate asks', async () => {
  const { MAX_COMMAND_LENGTH, MAX_COMMAND_WORDS } = await import('../agent/commandSafety');
  let resolved = 0;
  const counting = { realpath: async (target: string) => { resolved += 1; return target; } };
  const manyWords = `ls ${Array.from({ length: MAX_COMMAND_WORDS + 5 }, (_, index) => `src/f${index}`).join(' ')}`;
  const longText = `ls src/a # ${'x'.repeat(MAX_COMMAND_LENGTH)}`;
  for (const command of [manyWords, longText]) {
    resolved = 0;
    const reach = await shellReachesCredentialStore(command, at(), LOCATIONS, counting);
    assert.equal(typeof reach.unreadable, 'string', 'it says it could not read the command');
    assert.equal(resolved, 0, 'nothing was resolved');
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    assert.equal(typeof facts.effectsUnknown, 'string');
  }
  // Within the bounds, words are resolved as before.
  resolved = 0;
  await shellReachesCredentialStore('cat src/a.txt notes.md', at(), LOCATIONS, counting);
  assert.ok(resolved > 0);
  // A store the text names is refused whatever the length.
  assert.notEqual((await shellReachesCredentialStore(`cat ~/.ssh/id_rsa ${'a '.repeat(MAX_COMMAND_WORDS)}`, at(), LOCATIONS, counting)).credentialStore, undefined);
  for (const presence of ['person', 'none'] as const) {
    const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
    const gated = await gateToolCall(runtime, {
      tool: bashTool, raw: { command: manyWords }, root: ROOT, callId: `long-${presence}`, command: manyWords, policy: { mode: 'fully-autonomous', emergencyStop: false },
      rules: DEFAULT_RULES, grants: new RunGrants(), shell: { cwd: ROOT }, buildAuto: async () => undefined
    });
    assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', presence);
    assert.equal(gated.decision.rule, 'manifest.effects-unknown');
  }
});

// PR #74 review round 11: VS Code's storage folder names (`globalStorage/`, `workspaceStorage/<id>/`) are matched by name in any VS Code's layout, but a
// path that resolves inside the project is the project's own file, not VS Code's: a project's own `globalStorage/state.vscdb` is not refused. One helper
// decides it for the text check and for the file tools; an escape from the project (`../`) into a folder of that name is still refused.
test('a project\'s own globalStorage/state.vscdb is the project\'s; VS Code\'s real storage and an escape out of the project are refused', async () => {
  const project = mkdtempSync(path.join(TEMPORARY, 'near-ai-cred-own-'));
  mkdirSync(path.join(project, 'globalStorage'), { recursive: true });
  writeFileSync(path.join(project, 'globalStorage', 'state.vscdb'), 'fixture');
  const workspace = { root: project, cwd: project };
  // The text check.
  for (const text of ['sqlite3 globalStorage/state.vscdb .dump', `cat ${path.join(project, 'globalStorage', 'state.vscdb')}`, 'cat ./globalStorage/state.vscdb', 'cat workspaceStorage/abc/state.vscdb']) {
    assert.equal(namesCredentialStore(text, LOCATIONS, workspace), undefined, `${text}: the project's own file`);
  }
  for (const text of ['cat ../globalStorage/state.vscdb', 'cat ~/.config/Code/User/globalStorage/state.vscdb', 'cat /srv/globalStorage/state.vscdb', 'cat "$HOME/x/globalStorage/state.vscdb"']) {
    assert.notEqual(namesCredentialStore(text, LOCATIONS, workspace), undefined, `${text}: outside the project`);
  }
  // Through the gate: a shell call and the Read tool.
  const decideIn = async (tool: typeof bashTool | typeof readTool, raw: Record<string, unknown>, command?: string) => gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool, raw, root: project, callId: `own-${JSON.stringify(raw)}`, ...(command === undefined ? {} : { command }), policy: { mode: 'fully-autonomous', emergencyStop: false },
    rules: DEFAULT_RULES, grants: new RunGrants(), shell: { cwd: project }, buildAuto: async () => undefined
  });
  assert.equal((await decideIn(bashTool, { command: 'cat globalStorage/state.vscdb' }, 'cat globalStorage/state.vscdb')).decision.outcome, 'allow', 'a shell read of the project\'s file');
  assert.equal((await decideIn(readTool, { file_path: 'globalStorage/state.vscdb' })).decision.outcome, 'allow', 'the Read tool on the project\'s file');
  assert.equal((await decideIn(bashTool, { command: 'cat ../globalStorage/state.vscdb' }, 'cat ../globalStorage/state.vscdb')).decision.rule, 'floor.credential-store', 'an escape out of the project');
  assert.equal((await decideIn(readTool, { file_path: '../globalStorage/state.vscdb' })).decision.rule, 'floor.credential-store', 'the Read tool escaping out of the project');
});

// Owner decision after PR #74 (A5): more credential stores in the home folder, and the commands that print a stored token, are refused with no card in every
// mode, like the stores before them. Each is checked against the stand-in home: by text, from the shell's folder after a cd, and through the gate. A
// project's own file of the same name, and the harmless neighbours of each store, are not refused. Nothing is run.
const NEW_STORES: ReadonlyArray<readonly [string, string]> = [
  ['.config/gh', 'cat ~/.config/gh/hosts.yml'], ['.config/gh', 'cat ~/.config/gh/*'], ['.config/gh', 'grep -r . ~/.config/gh'], ['.config/gh', 'cat ~/.config/gh/hosts.y*'], ['.cargo/credentials', 'cat ~/.cargo/credentials'], ['.cargo/credentials.toml', 'cat $HOME/.cargo/credentials.toml'],
  ['.terraform.d/credentials.tfrc.json', 'cat ~/.terraform.d/credentials.tfrc.json'], ['.config/glab-cli', 'cat ~/.config/glab-cli/config.yml'],
  ['.config/hub', 'cat ~/.config/hub'], ['.gem/credentials', 'cat ~/.gem/credentials'], ['.local/share/keyrings', 'ls ~/.local/share/keyrings'],
  ['.yarnrc.yml', 'cat ~/.yarnrc.yml']
];
// Already on the list before, named by the owner: still refused.
const NAMED_BEFORE = ['cat ~/.docker/config.json', 'cat ~/.npmrc', 'cat ~/.pypirc', 'cat ~/.netrc', 'ls ~/.config/gcloud', 'cat ~/.azure/msal_token_cache.json', 'cat ~/.kube/config'];
const STORE_NEIGHBOURS = [
  'cat ~/.cargo/config.toml', 'cat ~/.cargo/credentials-notes.md', 'ls ~/.cargo/bin', 'cat ~/.terraform.d/plugins/x',
  'cat ~/.gem/specs/x', 'cat ~/.yarnrc', 'cat .yarnrc.yml', 'cat .npmrc', 'cat .cargo/credentials.toml', 'cat config/gh/hosts.yml'
];

test('the stores the owner named, and their kin, are refused by text, from the shell\'s folder and through a link; their neighbours and the project\'s own files are not', async () => {
  const wrong: string[] = [];
  for (const [store, command] of NEW_STORES) {
    if (!CREDENTIAL_STORES.includes(store)) wrong.push(`${store} is not on the list`);
    if ((await shellReachesCredentialStore(command, at(), LOCATIONS)).credentialStore === undefined) wrong.push(`${command} is not refused`);
    const folder = path.posix.dirname(store);
    const leaf = path.posix.basename(store);
    const fromFolder = folder === '.' ? `cd ~ && cat ${leaf}` : `cd ~/${folder} && cat ${leaf}`;
    if ((await shellReachesCredentialStore(fromFolder, at(), LOCATIONS)).credentialStore === undefined) wrong.push(`${fromFolder} is not refused`);
    if ((await shellReachesCredentialStore(`cat ${path.join(HOME, store)}`, at(), LOCATIONS)).credentialStore === undefined) wrong.push(`the literal home path of ${store} is not refused`);
  }
  for (const command of NAMED_BEFORE) if ((await shellReachesCredentialStore(command, at(), LOCATIONS)).credentialStore === undefined) wrong.push(`${command} is not refused`);
  for (const command of STORE_NEIGHBOURS) if ((await shellReachesCredentialStore(command, at(), LOCATIONS)).credentialStore !== undefined) wrong.push(`${command} is refused`);
  assert.deepEqual(wrong, []);
});

const PRINTERS = [
  'gh auth token', 'gh auth token --hostname github.example.test', 'gh auth status --show-token', 'gh auth status -t', 'gcloud auth print-access-token', 'gcloud auth print-identity-token',
  'gcloud auth application-default print-access-token', 'gcloud --account bob@example.test auth print-access-token', 'az account get-access-token', 'az acr login -n reg --expose-token',
  'aws configure get aws_secret_access_key', 'aws --profile dev configure get aws_session_token', 'aws configure get profile.dev.aws_access_key_id',
  'aws configure get "$KEY"', 'aws configure get', 'aws configure get --profile region aws_secret_access_key', 'aws configure export-credentials', 'aws sts get-session-token', 'aws sts assume-role --role-arn x --role-session-name y',
  'aws sts get-federation-token --name x', 'aws ecr get-login-password --region us-east-1', 'aws ecr-public get-login-password', 'aws codeartifact get-authorization-token --domain d',
  'npm token list', 'npm token create', 'pnpm token list', 'docker-credential-desktop get', 'docker-credential-pass list', 'echo https://index.docker.io/v1/ | docker-credential-osxkeychain get',
  'bash -c "gh auth token"', 'TOKEN=$(gh auth token)', 'sudo aws sts get-session-token', 'mywrapper gcloud auth print-access-token'
  // (PR #76 review round 3: a printer is found by how the command runs, not by its words anywhere in the text, so `python3 -c "os.system('gh auth token')"`
  // is no longer refused by its text: what a program it starts does is a documented gap of every check here.)
];
const NOT_PRINTERS = ['git commit -m "document npm token list and gh auth token"', 'grep -rn "aws sts get-session-token" docs', 'echo docker-credential-desktop get',
  'aws configure get region', 'aws configure get output --profile dev', 'aws --profile dev configure get sso_start_url', 'gh auth status', 'gh auth login', 'aws configure list', 'aws sts get-caller-identity', 'gcloud auth list', 'az account show', 'npm token revoke abc', 'docker login', 'npm whoami', 'docker credential ls'];

test('the commands that print a stored token are refused with no card; the commands beside them are not', async () => {
  const wrong: string[] = [];
  for (const command of PRINTERS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    if (facts.facts.credentialStore === undefined) wrong.push(`${command} → ${JSON.stringify(facts)}`);
  }
  for (const command of NOT_PRINTERS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    if (facts.facts.credentialStore !== undefined) wrong.push(`${command} is refused: ${facts.facts.credentialStore}`);
  }
  assert.deepEqual(wrong, []);
  assert.match((await floorFactsFor({ command: 'gh auth token', root: ROOT, cwd: ROOT, ...LOCATIONS })).facts.credentialStore ?? '', /gh auth token prints a stored password, key or token/);
});

test('in every mode, with a person and with nobody, a new store and a token printer are refused by the floor before the settings layer is asked', async () => {
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    for (const presence of ['person', 'none'] as const) {
      for (const command of ['cat ~/.config/gh/hosts.yml', 'cat ~/.cargo/credentials.toml', 'gh auth token', 'aws sts get-session-token', 'docker-credential-desktop get']) {
        const runtime: GateRuntime = { ...testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {}), locations: LOCATIONS };
        const gated = await gateToolCall(runtime, {
          tool: bashTool, raw: { command }, root: ROOT, callId: `${mode}-${presence}-${command}`, command, shell: { cwd: ROOT },
          policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
        });
        const where = `${mode}, ${presence}: ${command}`;
        assert.equal(gated.decision.outcome, 'deny', where);
        assert.equal(gated.decision.rule, 'floor.credential-store', where);
        assert.equal(gated.settings, undefined, `${where}: refused before the settings layer is asked`);
      }
    }
  }
  // The Read tool on a new store is refused the same way.
  const read = await gateToolCall({ ...testGateRuntime(), locations: LOCATIONS }, {
    tool: readTool, raw: { file_path: path.join(HOME, '.config', 'gh', 'hosts.yml') }, root: ROOT, callId: 'read-gh', policy: { mode: 'fully-autonomous', emergencyStop: false },
    rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.equal(read.decision.rule, 'floor.credential-store');
});

// PR #76 review: an option before the verb hid a token printer. `npm token --otp 123 list` read `123` as the verb, so the command was only a credential
// change (an ask) and, approved, printed a stored token. A printer is now refused unless the command is positively read as something that prints nothing
// (`npm token revoke`), and an option the rules do not know before the verb never turns a printer into an ask: it is refused too.
const PRINTERS_WITH_OPTIONS = [
  'npm token --otp 123 list', 'npm token --otp=123 create', 'npm token --registry https://registry.example.test list', 'npm token --cidr 10.0.0.0/8 create',
  'npm token --read-only create', 'npm token --json', 'npm --otp 123 token list', 'npm --weird token list', 'npm token --weird x revoke abc', 'npm token $VERB',
  'npm --prefix "$P" token list', 'pnpm token --otp 1 list', 'yarn token --otp 1 list', 'bun token --otp 1 list',
  'gh auth --hostname github.example.test token', 'gh auth -h github.example.test token', 'gh auth token -h github.example.test', 'gh --weird auth token', 'gh auth --weird token',
  'gh auth status --hostname github.example.test -t', 'gh auth -h github.example.test status --show-token', 'gh -R acme/app auth token', 'glab auth --weird token',
  'gcloud auth --verbosity debug print-access-token', 'gcloud auth --weird print-access-token', 'gcloud auth application-default --weird print-access-token',
  'gcloud --weird auth print-identity-token', 'gcloud config --weird config-helper', 'gcloud auth --account=a@example.test print-refresh-token',
  'az account --weird get-access-token', 'az --weird account get-access-token', 'az account get-access-token --resource https://example.test', 'az acr --weird login --expose-token',
  'aws sts --weird get-session-token', 'aws --weird sts get-session-token', 'aws configure --weird get aws_secret_access_key', 'aws configure --profile dev get aws_session_token',
  'aws ecr --weird get-login-password', 'aws codeartifact --weird get-authorization-token --domain d', 'aws sts --region us-east-1 assume-role --role-arn x --role-session-name y',
  'aws configure --weird export-credentials', 'docker-credential-desktop --weird get'
];
const NOT_PRINTERS_WITH_OPTIONS = [
  'npm token revoke abc', 'npm token --otp 123 revoke abc', 'npm token rm abc', 'npm token --otp=1 delete abc', 'npm run token', 'npm run token --silent',
  'gh issue create --title auth --body token', 'gh auth status --hostname github.example.test', 'gh auth login --hostname github.example.test', 'aws sts get-caller-identity --region x'
];

test('a token printer is refused whatever options come before its verb, and only a verb positively read as printing nothing is not', async () => {
  const wrong: string[] = [];
  for (const command of PRINTERS_WITH_OPTIONS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    if (facts.facts.credentialStore === undefined) wrong.push(`${command} → ${JSON.stringify(facts)}`);
  }
  for (const command of NOT_PRINTERS_WITH_OPTIONS) {
    const facts = await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS });
    if (facts.facts.credentialStore !== undefined) wrong.push(`${command} is refused: ${facts.facts.credentialStore}`);
  }
  assert.deepEqual(wrong, []);
  // Revoking a token is a credential change: it asks.
  for (const command of ['npm token revoke abc', 'npm token --otp 123 revoke abc']) {
    assert.notEqual((await floorFactsFor({ command, root: ROOT, cwd: ROOT, ...LOCATIONS })).facts.credentialChange, undefined, command);
  }
  for (const presence of ['person', 'none'] as const) {
    for (const command of ['npm token --otp 123 list', 'gh auth --weird token', 'aws --weird sts get-session-token']) {
      const gated = await gateToolCall({ ...testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {}), locations: LOCATIONS }, {
        tool: bashTool, raw: { command }, root: ROOT, callId: `opt-${presence}-${command}`, command, shell: { cwd: ROOT },
        policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
      });
      assert.equal(gated.decision.outcome, 'deny', `${presence}: ${command}`);
      assert.equal(gated.decision.rule, 'floor.credential-store', `${presence}: ${command}`);
    }
  }
});

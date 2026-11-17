// Credential stores and this extension's own folders outside the project, seen in shell commands (GATE-05, D-16). Every check here reads command text and
// resolves paths against a stand-in home folder made under the test run's temporary folder: no command is run, nothing in a real home folder is read, and no
// credential file exists anywhere these tests look.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { floorFactsFor, gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool, shellReachesCredentialStore } from '../agent/tools';
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

// The floor (GATE-05, D-16, D-17, D-18, D-43, D-44, D-45, D-46): every floor rule in every approval mode and both presences, the path edges, the ordering
// edge, and the credential text check. No test touches a real home folder, runs a command that names a credential store, or reads a key: every command is
// plain text handed to a pure function, and every home folder is built from the temp folder name.
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ActionPolicy, ActionPolicyMode } from '../domain/policy';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateRequest, SettingsLayer } from '../domain/gate/decide';
import {
  CREDENTIAL_STORES, EXTENSION_STORAGE_FOLDERS, EXTENSION_STORAGE_TEXT, FLOOR_CANNOT_SEE_TEXT, FLOOR_RULES, FLOOR_RULE_ORDER, KEYCHAIN_COMMANDS,
  floorFor, isFloorProtectedWrite, namesCredentialStore, namesIdentityFiles
} from '../domain/gate/floor';
import type { FloorRule } from '../domain/gate/floor';
import type { Capability } from '../domain/gate/vocabulary';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'dev-00000000000000000000000000000000', sessionId: 'session-1', agentId: 'agent-1', agentLabel: 'Builder' };
const MODES: readonly ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];
const PRESENCES = ['person', 'none'] as const;
const HOME = path.join(os.tmpdir(), 'gate-floor-fake-home');
const STORAGE = path.join(os.tmpdir(), 'gate-floor-fake-storage', 'extension-data');

function validState(): BundleState {
  const payload = defaultBundlePayload({ issuer: { fingerprint: ACTOR.deviceFingerprint, publicKey: 'A'.repeat(43) }, now: NOW });
  return { state: 'valid', bundle: payload, hash: bundleHash(payload), signer: { fingerprint: ACTOR.deviceFingerprint, publicKey: 'A'.repeat(43) }, expiresAt: payload.expiresAt, renewDue: false };
}

const policyOf = (mode: ActionPolicyMode): ActionPolicy => ({ mode, emergencyStop: false });
const allowsEverything: SettingsLayer = async () => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' });

function requestFor(effects: Capability[], overrides: Partial<GateRequest> = {}): GateRequest {
  return { actor: ACTOR, tool: 'Tool', callId: 'call-1', effects, context: 'interactive', presence: 'person', policy: policyOf('fully-autonomous'), ...overrides };
}

const SHELL: Capability = { verb: 'shell', cwd: 'anywhere' };

// One request that matches exactly one rule each, so the matrix proves the rule and not a neighbour.
const CASES: Readonly<Record<FloorRule, Partial<GateRequest> & { effects: Capability[] }>> = {
  'floor.state-keys': { effects: [{ verb: 'read', paths: ['.near-ai/state/keys/local.key'] }] },
  'floor.credential-store': { effects: [SHELL], command: 'cat ~/.ssh/id_ed25519', tool: 'Bash' },
  'floor.identity-files': { effects: [SHELL], command: `cat ${EXTENSION_STORAGE_TEXT}/identity/key-history.json`, tool: 'Bash' },
  'floor.protected-write': { effects: [{ verb: 'workspaceWrite', paths: ['.git/hooks/pre-commit'] }] },
  'floor.publish': { effects: [{ verb: 'publish', target: 'git-remote' }] },
  'floor.credential-change': { effects: [SHELL], command: 'docker login', tool: 'Bash', floorFacts: { credentialChange: 'docker login signs in or out of a container registry.' } },
  'floor.destroy': { effects: [{ verb: 'destroy', paths: ['build/**'] }] },
  'floor.shared-write': { effects: [{ verb: 'skill.write', scope: 'team' }] }
};

// Owner decision after PR #74: signing in and out is a floor rule of its own (floor.credential-change), so the floor has eight rules.
test('the floor has eight rules in a fixed order, refusals first', () => {
  assert.deepEqual([...FLOOR_RULE_ORDER], [
    'floor.state-keys', 'floor.credential-store', 'floor.identity-files', 'floor.protected-write', 'floor.publish', 'floor.credential-change', 'floor.destroy', 'floor.shared-write'
  ]);
  assert.deepEqual(FLOOR_RULE_ORDER.map((rule) => FLOOR_RULES[rule]), ['refuse', 'refuse', 'refuse', 'ask', 'ask', 'ask', 'ask', 'ask']);
  assert.deepEqual(Object.keys(CASES).sort(), [...FLOOR_RULE_ORDER].sort());
});

test('floor matrix: every rule in every mode and both presences, with no shortcut offered', async () => {
  let cases = 0;
  for (const rule of FLOOR_RULE_ORDER) {
    const shape = CASES[rule];
    assert.equal(floorFor(requestFor(shape.effects, shape))?.rule, rule, `${rule} is matched by its own case`);
    for (const mode of MODES) {
      for (const presence of PRESENCES) {
        const decided = await decide(requestFor(shape.effects, { ...shape, policy: policyOf(mode), presence }), validState(), allowsEverything);
        const where = `${rule} in ${mode} with presence ${presence}`;
        assert.equal(decided.rule, rule, where);
        assert.equal(decided.floor, true, where);
        assert.equal(decided.offerAlwaysAllow, false, where);
        assert.equal(decided.allowGrant, false, where);
        if (FLOOR_RULES[rule] === 'refuse') {
          assert.equal(decided.outcome, 'deny', where);
        } else if (presence === 'person') {
          assert.equal(decided.outcome, 'ask', where);
        } else {
          assert.equal(decided.outcome, 'deny', where);
          assert.match(decided.reason ?? '', /^Nobody is here to approve this, and it always needs a person: /, where);
        }
        cases += 1;
      }
    }
  }
  assert.equal(cases, 64, '8 rules x 4 modes x 2 presences');
});

test('a sub-agent of a person run stays an ask with a person present, never a refusal (D-43)', async () => {
  const sub: ActorRef = { kind: 'sub-agent', deviceFingerprint: ACTOR.deviceFingerprint, sessionId: 'session-1', agentId: 'sub-1' };
  const decided = await decide(requestFor(CASES['floor.publish'].effects, { actor: sub, presence: 'person', context: 'interactive' }), validState(), allowsEverything);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.allowGrant, false);
});

test('a refusal wins over an ask, and the recorded rule is the first in the fixed order', () => {
  const both = floorFor({
    effects: [{ verb: 'workspaceWrite', paths: ['.git/hooks/x'] }, { verb: 'publish', target: 'registry' }, { verb: 'destroy', paths: ['.git/hooks/x'] }],
    command: 'cat ~/.aws/credentials'
  });
  assert.equal(both?.rule, 'floor.credential-store');
  assert.equal(both?.kind, 'refuse');
  const asks = floorFor({ effects: [{ verb: 'publish', target: 'registry' }, { verb: 'destroy', paths: ['.git/hooks/x'] }, { verb: 'skill.write', scope: 'team' }] });
  assert.equal(asks?.rule, 'floor.protected-write', 'a destroy inside .git matches protected-write and destroy; the first in order is recorded');
  const stateAndWrite = floorFor({ effects: [{ verb: 'workspaceWrite', paths: ['.near-ai/state/keys/local.key'] }] });
  assert.equal(stateAndWrite?.rule, 'floor.state-keys');
  for (let index = 0; index < 3; index += 1) {
    assert.equal(floorFor({ effects: [{ verb: 'destroy', paths: ['.git/hooks/x'] }, { verb: 'publish', target: 'registry' }] })?.rule, 'floor.protected-write');
  }
});

test('path boundaries: .git and a folder ending in .git match, .github does not, team.md is exempt and its neighbours are not', () => {
  const protectedPaths = [
    '.git/hooks/pre-commit', 'sub/.git/config', 'vendor/mirror.git/hooks/post-receive', '.planning/.near-ai/settings.json', '.planning/.near-ai/labels.json',
    '.planning/.near-ai/team.md.bak', '.planning/.near-ai/team.md/x', '.near-ai/state/meta.json', '.near-ai/locks/a', './.git/hooks/x', 'a/../.git/hooks/x'
  ];
  for (const candidate of protectedPaths) assert.equal(isFloorProtectedWrite(candidate), true, candidate);
  const open = ['.github/workflows/ci.yml', 'src/.githubrc', 'gitignore.git.md', '.planning/.near-ai/team.md', '.near-ai/scratch/a.txt', '.near-ai/attachments/b.png', 'src/app.ts'];
  for (const candidate of open) assert.equal(isFloorProtectedWrite(candidate), false, candidate);
  assert.equal(floorFor({ effects: [{ verb: 'workspaceWrite', paths: ['.planning/.near-ai/team.md'] }] }), undefined);
  assert.equal(floorFor({ effects: [{ verb: 'workspaceWrite', paths: ['.planning/.near-ai/labels.json'] }] })?.rule, 'floor.protected-write');
});

test('only the project-root team file is exempt: a nested or escaping path to a file with the same tail still asks', () => {
  const asks = [
    'sub/.planning/.near-ai/team.md', 'a/b/.planning/.near-ai/team.md', '../.planning/.near-ai/team.md', 'sub/../../.planning/.near-ai/team.md',
    '.planning/.near-ai/sub/team.md', '.planning/.near-ai/Team.md', '/abs/.planning/.near-ai/team.md', 'x\\.planning\\.near-ai\\team.md'
  ];
  for (const candidate of asks) assert.equal(isFloorProtectedWrite(candidate), true, candidate);
  // Forms that normalize to exactly the root file are that file.
  for (const candidate of ['.planning/.near-ai/team.md', './.planning/.near-ai/team.md', 'sub/../.planning/.near-ai/team.md', '.planning//.near-ai/team.md']) {
    assert.equal(isFloorProtectedWrite(candidate), false, candidate);
  }
  assert.equal(floorFor({ effects: [{ verb: 'workspaceWrite', paths: ['sub/.planning/.near-ai/team.md'] }] })?.rule, 'floor.protected-write');
});

test('a workspace credential-file read is never a floor verdict, and the settings layer keeps asking for it outside fully-autonomous (D-18)', async () => {
  const read: Capability = { verb: 'read', paths: ['.env'] };
  assert.equal(floorFor({ effects: [read] }), undefined);
  assert.equal(floorFor({ effects: [SHELL], command: 'cat .env' }), undefined);
  assert.equal(floorFor({ effects: [{ verb: 'read', paths: ['deploy/id_ed25519'] }] }), undefined);
  const sensitive = 'This file holds credentials.';
  const asks = await decide(requestFor([read], { policy: policyOf('approve-risky'), sensitive, tool: 'Read' }), validState(), allowsEverything);
  assert.equal(asks.outcome, 'ask');
  assert.equal(asks.rule, 'settings.sensitive-read');
  assert.equal(asks.floor, false);
  const quiet = await decide(requestFor([read], { policy: policyOf('fully-autonomous'), sensitive, tool: 'Read' }), validState(), allowsEverything);
  assert.equal(quiet.outcome, 'allow');
  assert.equal(quiet.floor, false);
});

test('the deny list and the emergency stop still win over a floor ask', async () => {
  const denies: SettingsLayer = async () => ({ decision: 'deny', rule: 'settings.deny-list', reason: 'It is on your deny list.' });
  const shape = CASES['floor.publish'];
  const refused = await decide(requestFor(shape.effects), validState(), denies);
  assert.equal(refused.outcome, 'deny');
  assert.equal(refused.rule, 'settings.deny-list');
  assert.equal(refused.floor, false);
  const stopped = await decide(requestFor(CASES['floor.credential-store'].effects, { ...CASES['floor.credential-store'], policy: { mode: 'approve-risky', emergencyStop: true } }), validState(), allowsEverything);
  assert.equal(stopped.rule, 'settings.emergency-stop');
  assert.equal(stopped.outcome, 'deny');
});

test('fully-autonomous means no approval within the grant: a plain command is allowed by the settings layer, and a floor fact still asks', async () => {
  const plain = await decide(requestFor([SHELL], { command: 'npm test', tool: 'Bash' }), validState(), allowsEverything);
  assert.equal(plain.outcome, 'allow');
  assert.equal(plain.rule, 'settings.mode.fully-autonomous');
  assert.equal(plain.floor, false);
  const protectedWrite = await decide(requestFor([SHELL], { command: 'printf x > .git/hooks/post-commit', tool: 'Bash', floorFacts: { protectedWrite: 'That writes into .git.' } }), validState(), allowsEverything);
  assert.equal(protectedWrite.outcome, 'ask');
  assert.equal(protectedWrite.rule, 'floor.protected-write');
});

test('credential stores: the confirmed list is named, and each form of the home folder is matched in text only', () => {
  // Owner decision after PR #74 (A5): the second line was added.
  assert.deepEqual([...CREDENTIAL_STORES], [
    '.near-credentials', '.ssh', '.aws', '.config/gcloud', '.azure', '.docker/config.json', '.netrc', '.git-credentials', '.gnupg', '.kube', '.npmrc', '.pypirc',
    '.near-kb', '.kbkey',
    '.config/gh', '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d/credentials.tfrc.json', '.config/glab-cli', '.config/hub', '.gem/credentials',
    '.local/share/keyrings', '.yarnrc.yml'
  ]);
  const locations = { home: HOME };
  const hits = [
    'cat ~/.ssh/id_ed25519', 'cat $HOME/.aws/credentials', 'cat ${HOME}/.aws/credentials', 'cat "$HOME"/.ssh/config', 'cat "$HOME/.ssh/id_rsa"',
    'cat ~/.near-credentials/mainnet/example.json', `cat ${HOME}/.near-credentials/mainnet/example.json`, `ls ${HOME}/.gnupg`, 'cat ~/.config/gcloud/credentials.db',
    'cat ~/.azure/accessTokens.json', 'cat ~/.docker/config.json', 'cat ~/.netrc', 'cat ~/.git-credentials', 'ls ~/.kube', 'cat ~/.npmrc', 'cat ~/.pypirc',
    'cat ~/.near-kb', 'cat ~/.kbkey', 'cp ~/.ssh/* /tmp/x', 'tar czf x.tgz ~/.ssh', 'sqlite3 ~/.config/Code/User/globalStorage/state.vscdb .dump',
    'cp ~/.config/Code/User/globalStorage/state.vscdb.backup /x',
    'secret-tool lookup service x', 'secret-tool search service x', 'security find-generic-password -s x', 'security  find-internet-password -s x',
    'security dump-keychain', 'security export -k x', 'CAT ~/.SSH/ID_RSA'
  ];
  for (const text of hits) assert.match(namesCredentialStore(text, locations) ?? '', /names a place where passwords, keys or tokens are kept/, text);
  const misses = [
    'cat ~/.sshconfig-notes', 'cat docs/.ssh.md', 'ls ~/projects', 'cat .env', 'git status', 'cat ~/.awsome/readme', 'echo $HOMER/.ssh', 'ls /other/home/.ssh',
    'cat mystate.vscdb', 'security audit', 'secret-tool store x', 'cat ~/.kubernetes', 'cat src/.npmrc.example',
    // PR #74 review: a file named like VS Code's secrets database is only refused where VS Code keeps it (see the test below), not anywhere.
    'sqlite3 /x/state.vscdb .dump', 'cp state.vscdb.backup /x'
  ];
  for (const text of misses) assert.equal(namesCredentialStore(text, locations), undefined, text);
});

// PR #74 review: VS Code's secrets database is refused where VS Code keeps it (its global storage folder, and the user-data folder above it), in any VS
// Code's layout by the folder names, and in this VS Code's by the real folder; a project file that happens to have the same name is not refused.
test('VS Code\'s secrets database is refused only under VS Code\'s storage folders, not as a file name anywhere', () => {
  const user = path.join(os.tmpdir(), 'gate-floor-fake-user-data', 'User');
  const locations = { globalStorage: path.join(user, 'globalStorage', 'vitalpoint.near-ai-vscode') };
  for (const text of [
    'sqlite3 ~/.config/Code/User/globalStorage/state.vscdb .dump', 'cat "$HOME/Library/Application Support/Code/User/globalStorage/state.vscdb"',
    'type C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb', 'cp ~/.vscode-server/data/User/globalStorage/state.vscdb.backup /x',
    'sqlite3 ~/.config/Code/User/workspaceStorage/0a1b2c3d/state.vscdb', 'cat ~/.config/Code/User/GLOBALSTORAGE/STATE.VSCDB',
    `sqlite3 ${path.join(user, 'globalStorage', 'state.vscdb')}`, `cp ${path.join(user, 'workspaceStorage', 'abc', 'state.vscdb.backup')} /x`
  ]) assert.match(namesCredentialStore(text, locations) ?? '', /names a place where passwords, keys or tokens are kept/, text);
  for (const text of [
    'sqlite3 state.vscdb .dump', 'cat fixtures/state.vscdb', 'cp test/data/state.vscdb.backup out/', 'sqlite3 /work/app/state.vscdb', `cat ${path.join(os.tmpdir(), 'state.vscdb')}`,
    'cat ~/.config/Code/User/globalStorage/state.vscdb.notes', 'cat ~/notes/globalStorage-state.vscdb'
  ]) assert.equal(namesCredentialStore(text, locations), undefined, text);
});

test('the text check reads the command and never runs it', () => {
  // The same text with and without a home folder: only the literal home form needs the folder, the portable forms always match.
  assert.ok(namesCredentialStore(`cat ${HOME}/.ssh/id_rsa`, { home: HOME }));
  assert.equal(namesCredentialStore(`cat ${HOME}/.ssh/id_rsa`), undefined);
  assert.ok(namesCredentialStore('cat ~/.ssh/id_rsa'));
  assert.ok(namesCredentialStore(`cat ${HOME.replace(/\//g, '\\')}\\.ssh\\id_rsa`, { home: HOME }), 'backslashes are read as slashes');
  assert.ok(FLOOR_CANNOT_SEE_TEXT.includes('git credential fill'));
  assert.match(FLOOR_CANNOT_SEE_TEXT, /no operating-system sandbox/);
  assert.match(FLOOR_CANNOT_SEE_TEXT, /add-on server/);
  for (const command of KEYCHAIN_COMMANDS) assert.ok(namesCredentialStore(command), command);
});

test('this extension\'s identity and gate folders are refused by their portable and their real names, and other folders there are not', () => {
  assert.deepEqual([...EXTENSION_STORAGE_FOLDERS], ['identity', 'gate']);
  const locations = { globalStorage: STORAGE };
  for (const text of [
    `cat ${EXTENSION_STORAGE_TEXT}/identity/key-history.json`, `ls ${EXTENSION_STORAGE_TEXT}/gate`, `cat ${STORAGE}/identity/key-history.json`,
    `cat ${STORAGE}/gate/bundle.json`, 'cat ~/.config/Code/User/GLOBALSTORAGE/VITALPOINT.NEAR-AI-VSCODE/Identity/x'
  ]) {
    assert.ok(namesIdentityFiles(text, locations), text);
  }
  for (const text of [`cat ${EXTENSION_STORAGE_TEXT}/logs/a.txt`, `cat ${EXTENSION_STORAGE_TEXT}/gateway/a`, `cat ${STORAGE}/other/a`, 'ls globalStorage']) {
    assert.equal(namesIdentityFiles(text, locations), undefined, text);
  }
  assert.equal(floorFor({ effects: [SHELL], command: `cat ${STORAGE}/identity/x` }, { globalStorage: STORAGE })?.rule, 'floor.identity-files');
  assert.equal(floorFor({ effects: [SHELL], command: `cat ${STORAGE}/identity/x` })?.rule, undefined, 'the real folder needs the adapter to name it');
});

test('the shared write, publish and destroy rules come from effects, and the marker from fromActionCapability sets shared-write too (D-45, D-46)', () => {
  assert.equal(floorFor({ effects: [{ verb: 'send', channel: 'email' }] })?.rule, 'floor.publish');
  assert.equal(floorFor({ effects: [{ verb: 'network', hosts: ['example.org'] }] }), undefined, 'a plain network call is not the floor');
  assert.equal(floorFor({ effects: [{ verb: 'skill.write', scope: 'project' }] }), undefined);
  assert.equal(floorFor({ effects: [{ verb: 'workspaceWrite', paths: ['notes/**'] }], floorFacts: { sharedWrite: true } })?.rule, 'floor.shared-write');
  assert.equal(floorFor({ effects: [{ verb: 'read', paths: ['src/**'] }, { verb: 'plan' }] }), undefined);
});

test('the same call always gives the same verdict, whatever else ran between', () => {
  const input = { effects: [{ verb: 'destroy', paths: ['build/**'] }] satisfies Capability[], command: 'rm -r build' };
  const first = JSON.stringify(floorFor(input));
  floorFor({ effects: [{ verb: 'publish', target: 'registry' }] });
  assert.equal(JSON.stringify(floorFor(input)), first);
});

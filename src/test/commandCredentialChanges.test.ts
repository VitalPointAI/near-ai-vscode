// Signing in and out (owner decision after PR #74): a registry or account login, logout or token change rewrites the credentials kept on this computer, so
// it is a floor action of its own, `floor.credential-change`: it asks in every mode, Full auto included, with no "always allow" and no grant for the run,
// and it is refused when nobody is there to answer. It is found wherever the command sits (a script, bash -c, sudo, a chain, a program the rules do not
// know). Nothing here runs a command: the classifier and the gate only read the command's text.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext } from '../agent/commandSafety';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import { FLOOR_RULES, floorFor } from '../domain/gate/floor';
import { testGateRuntime } from './helpers/gatedRuns';

const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev', packageScriptsAt: () => ({ kind: 'found', folder: '/work/app', scripts: {} }) };
const classify = (command: string, scripts?: Record<string, string>) => classifyCommand(command, { ...context, ...(scripts === undefined ? {} : { packageScriptsAt: undefined, packageScripts: scripts }) });

const CHANGES = [
  'npm login', 'npm logout', 'npm adduser', 'npm token revoke abc123', 'npm --registry https://npm.example.test login', 'pnpm login', 'pnpm logout', 'yarn login', 'yarn logout',
  'yarn npm login', 'yarn npm logout', 'bun login', 'npm config set //registry.npmjs.org/:_authToken abc', 'yarn config set npmAuthToken abc', 'pnpm config set _auth abc',
  'cargo login', 'cargo logout', 'cargo login --registry alt', 'cargo +nightly login',
  'docker login', 'docker login registry.example.test -u bob --password-stdin', 'docker logout', 'docker --context prod login', 'podman login quay.io', 'podman logout',
  'buildah login quay.io', 'buildah logout', 'helm registry login registry.example.test', 'helm registry logout registry.example.test',
  'gh auth login', 'gh auth login --with-token', 'gh auth logout', 'gh auth refresh -s repo', 'gh auth setup-git', 'gh auth switch', 'glab auth login', 'glab auth logout',
  'gcloud auth login', 'gcloud auth revoke', 'gcloud auth activate-service-account --key-file k.json', 'gcloud auth application-default login', 'gcloud auth configure-docker',
  'gcloud --account bob@example.test auth login', 'az login', 'az logout', 'az account clear', 'az acr login -n reg',
  'aws configure', 'aws configure set region us-east-1', 'aws configure sso', 'aws --profile dev configure', 'aws sso login', 'aws sso logout', 'aws sso login --profile dev'
];

const NOT_CHANGES = [
  'npm whoami', 'npm publish', 'npm install', 'npm config get registry', 'npm config set fund false', 'docker ps', 'docker push app:1', 'podman images', 'gh auth status',
  'gh pr view 12', 'cargo build', 'cargo publish', 'aws s3 ls', 'aws configure list', 'gcloud auth list', 'gcloud config list', 'az account show', 'helm registry --help',
  'echo npm login', 'git commit -m "docs: say how to npm login"', 'cat docs/aws-sso-login.md'
];

test('every registry or account login, logout and token change is a credential change; its verdict asks in the asking modes', () => {
  const wrong: string[] = [];
  for (const command of CHANGES) {
    const result = classify(command);
    if (result.credentialChange === undefined) wrong.push(`${command} → ${JSON.stringify(result)}`);
    else if (result.verdict === 'safe') wrong.push(`${command} is safe`);
  }
  assert.deepEqual(wrong, []);
});

test('the same commands are found through a script, bash -c, sudo, a chain, a subshell and a program the rules do not know', () => {
  const wrong: string[] = [];
  for (const command of ['npm login', 'docker login', 'gh auth login', 'aws configure', 'cargo logout', 'gcloud auth login', 'az login']) {
    for (const [wrapped, scripts] of [
      ['npm run auth', { auth: command }], [`bash -c '${command}'`, undefined], [`sudo ${command}`, undefined], [`true && ${command}`, undefined], [`(${command})`, undefined],
      [`mywrapper ${command}`, undefined], [`echo "$(${command})"`, undefined]
    ] as const) {
      if (classify(wrapped, scripts).credentialChange === undefined) wrong.push(wrapped);
    }
  }
  assert.deepEqual(wrong, []);
});

test('reads, publishing and a mention in text are not a credential change', () => {
  const wrong = NOT_CHANGES.filter((command) => classify(command).credentialChange !== undefined);
  assert.deepEqual(wrong, []);
  assert.deepEqual(classify('npm publish').effects, [{ verb: 'publish', target: 'registry' }], 'publishing is still publishing');
  assert.deepEqual(classify('cargo login').effects, undefined, 'a login publishes nothing');
});

test('the floor asks about a credential change, after the refusals and protected writes, with its own reason', () => {
  assert.equal(FLOOR_RULES['floor.credential-change'], 'ask');
  const verdict = floorFor({ effects: [{ verb: 'shell', cwd: 'workspace' }], floorFacts: { credentialChange: 'docker login changes a stored login.' } });
  assert.equal(verdict?.rule, 'floor.credential-change');
  assert.equal(verdict?.kind, 'ask');
  assert.match(verdict?.reason ?? '', /docker login changes a stored login\. .*always needs a person/);
  const refusal = floorFor({ effects: [{ verb: 'shell', cwd: 'workspace' }], floorFacts: { credentialChange: 'x', credentialStore: 'y' } });
  assert.equal(refusal?.rule, 'floor.credential-store', 'a refusal still wins');
});

test('through the gate, in every mode: a login asks with no shortcut when a person is there and is refused when nobody is', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-logins-'));
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    for (const presence of ['person', 'none'] as const) {
      for (const command of ['npm login', 'docker login', 'gh auth login', 'aws sso login']) {
        const gated = await gateToolCall(testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {}), {
          tool: bashTool, raw: { command }, root, callId: `${mode}-${presence}-${command}`, command, policy: { mode, emergencyStop: false },
          rules: DEFAULT_RULES, grants: new RunGrants(), shell: { cwd: root }, buildAuto: async () => undefined
        });
        const where = `${mode}, ${presence}: ${command}`;
        assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', where);
        assert.equal(gated.decision.rule, 'floor.credential-change', where);
        assert.equal(gated.decision.floor, true, where);
        assert.equal(gated.decision.offerAlwaysAllow, false, where);
        assert.equal(gated.decision.allowGrant, false, where);
      }
    }
  }
});

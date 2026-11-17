// GitHub writes on the floor (owner decision after PR #74, D-46): `gh pr merge` changes a branch on GitHub, and `gh api` with a writing method (or with a
// field or a body, which make it POST) changes data there, so both are publishing and ask in every mode, Full auto included. `gh pr create` and
// `gh issue comment` stay with the settings layer. The action is found past `-R`/`--repo` wherever they sit, and an option the rules do not know before
// it, or a word the shell decides at run time, makes the effects unknown (the gate asks). Nothing here runs a command.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext, CommandEffect } from '../agent/commandSafety';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import { testGateRuntime } from './helpers/gatedRuns';

const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev', packageScriptsAt: () => ({ kind: 'found', folder: '/work/app', scripts: {} }) };
const classify = (command: string) => classifyCommand(command, context);
const REMOTE: CommandEffect = { verb: 'publish', target: 'git-remote' };
const RELEASE: CommandEffect = { verb: 'publish', target: 'release' };
const tags = (command: string): string => JSON.stringify(classify(command).effects ?? []);

test('gh pr merge (and glab mr merge) is publishing to the remote, wherever -R or --repo sits', () => {
  const wrong: string[] = [];
  for (const command of [
    'gh pr merge 12', 'gh pr merge 12 --squash --delete-branch', 'gh pr merge', 'gh pr merge --auto --rebase 12', 'gh pr -R acme/app merge 12', 'gh pr --repo acme/app merge 12',
    'gh pr --repo=acme/app merge 12', 'gh pr -Racme/app merge 12', 'gh -R acme/app pr merge 12', 'gh --repo acme/app pr merge', 'glab mr merge 3', 'glab mr -R acme/app merge 3'
  ]) if (tags(command) !== JSON.stringify([REMOTE])) wrong.push(`${command} → ${tags(command)}`);
  assert.deepEqual(wrong, []);
  assert.equal(classify('gh pr merge 12').verdict, 'risky', 'its verdict is what it was');
});

test('gh api with a writing method, a field or a body is publishing; a GitHub release endpoint is a release', () => {
  const wrong: string[] = [];
  for (const command of [
    'gh api -X POST repos/acme/app/issues', 'gh api -XPOST repos/acme/app/issues', 'gh api --method=PUT repos/acme/app/topics', 'gh api --method patch repos/acme/app',
    'gh api -X DELETE repos/acme/app/git/refs/heads/x', 'gh api repos/acme/app/issues -f title=x', 'gh api repos/acme/app/issues -F title=x', 'gh api repos/acme/app/issues --field title=x',
    'gh api repos/acme/app/issues --raw-field=title=x', 'gh api repos/acme/app/issues --input body.json', 'gh api -H "Accept: application/json" repos/acme/app/issues -f title=x',
    'gh api --paginate -X POST repos/acme/app/labels', 'gh api -X OPTIONS repos/acme/app', 'gh api graphql -f query="mutation { addStar(input: {}) { clientMutationId } }"',
    'gh api graphql -F query=@query.graphql', 'gh api graphql --input q.json', 'gh api graphql -f query="query { viewer { login } }" -F owner=@who.txt', 'glab api -X POST projects/1/issues',
    'gh -R acme/app api -X POST repos/acme/app/issues'
  ]) if (tags(command) !== JSON.stringify([REMOTE])) wrong.push(`${command} → ${tags(command)}`);
  for (const command of ['gh api -X POST repos/acme/app/releases', 'gh api repos/acme/app/releases -f tag_name=v1', 'gh api --method PATCH repos/acme/app/releases/7']) {
    if (tags(command) !== JSON.stringify([RELEASE])) wrong.push(`${command} → ${tags(command)}`);
  }
  assert.deepEqual(wrong, []);
});

test('gh api reads, gh pr create, gh issue comment and the read-only commands carry no tag', () => {
  const none = [
    'gh api repos/acme/app', 'gh api -X GET repos/acme/app/issues -f per_page=100', 'gh api --method=head repos/acme/app', 'gh api --paginate repos/acme/app/issues --jq .[].title',
    'gh api graphql -f query="query { viewer { login } }"', 'gh api graphql -f query="{ viewer { login } }" -F n=3', 'gh api -H "Accept: x" -q .name repos/acme/app',
    'gh pr create --fill', 'gh issue comment 3 -b hi', 'gh pr view 12', 'gh pr checks 12', 'gh pr list -R acme/app', 'gh release download v1', 'glab mr view 3'
  ];
  const wrong = none.filter((command) => classify(command).effects !== undefined || classify(command).effectsUnknown !== undefined).map((command) => `${command} → ${JSON.stringify(classify(command))}`);
  assert.deepEqual(wrong, []);
});

test('an option the rules do not know before the action, or a method or action decided at run time, makes the effects unknown', () => {
  const wrong: string[] = [];
  for (const command of [
    'gh pr --weird merge 12', 'gh pr -x merge 12', 'gh $GROUP merge 12', 'gh pr $ACTION 12', 'gh api -X $METHOD repos/acme/app', 'gh api --method="$M" repos/acme/app',
    'gh api --brand-new-option repos/acme/app', 'gh api -X', 'gh api -f', 'gh pr -R'
  ]) {
    const result = classify(command);
    if (result.effectsUnknown === undefined) wrong.push(`${command} → ${JSON.stringify(result)}`);
  }
  assert.deepEqual(wrong, []);
});

test('through the gate in Full auto: a merge and an API write ask with no shortcut and are refused with nobody; a pull request and a comment run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-gh-'));
  for (const presence of ['person', 'none'] as const) {
    for (const [command, outcome] of [
      ['gh pr merge 12 --squash', presence === 'person' ? 'ask' : 'deny'], ['gh api repos/acme/app/issues -f title=x', presence === 'person' ? 'ask' : 'deny'],
      ['gh pr create --fill', 'allow'], ['gh issue comment 3 -b hi', 'allow'], ['gh api repos/acme/app', 'allow']
    ] as const) {
      const gated = await gateToolCall(testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {}), {
        tool: bashTool, raw: { command }, root, callId: `${presence}-${command}`, command, policy: { mode: 'fully-autonomous', emergencyStop: false },
        rules: DEFAULT_RULES, grants: new RunGrants(), shell: { cwd: root }, buildAuto: async () => undefined
      });
      assert.equal(gated.decision.outcome, outcome, `${presence}: ${command}`);
      if (outcome !== 'allow') {
        assert.equal(gated.decision.rule, 'floor.publish', `${presence}: ${command}`);
        assert.equal(gated.decision.offerAlwaysAllow, false);
        assert.equal(gated.decision.allowGrant, false);
      }
    }
  }
});

// PR #76 review round 2: with `--` before the group, the group word was read again as the action, so `gh -- pr merge 12` lost its publish tag.
test('`--` anywhere before the action ends the options and keeps every tag', () => {
  const wrong: string[] = [];
  for (const [command, expected] of [
    ['gh -- pr merge 12', [REMOTE]], ['gh pr -- merge 12', [REMOTE]], ['gh pr merge -- 12', [REMOTE]], ['gh -R acme/app pr -- merge 12', [REMOTE]],
    ['glab -- mr merge 3', [REMOTE]], ['glab mr -- merge 3', [REMOTE]], ['gh -- release create v1', [RELEASE]], ['gh release -- create v1', [RELEASE]],
    ['gh -- api -X POST repos/acme/app/issues', [REMOTE]], ['gh -- pr view 12', []], ['gh -- pr create --fill', []]
  ] as const) {
    const got = JSON.stringify(classify(command).effects ?? []);
    if (got !== JSON.stringify(expected)) wrong.push(`${command} → ${got}`);
  }
  for (const command of ['gh -- auth login', 'gh auth -- login']) if (classify(command).credentialChange === undefined) wrong.push(`${command} is not a credential change`);
  for (const command of ['gh -- auth token', 'gh auth -- token']) if (classifyCommand(command, context).printsCredential === undefined) wrong.push(`${command} is not a printer`);
  for (const command of ['gh -- $GROUP merge', 'gh pr -- $ACTION 12']) if (classify(command).effectsUnknown === undefined) wrong.push(`${command} is read as known`);
  assert.deepEqual(wrong, []);
});

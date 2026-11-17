// PR #74 review round 8, refinement: a write whose target the command's text names is read whole and tagged as a write to that place, so Full auto runs a
// routine write inside the project with no card (GATE-06), the floor asks about one into .git/ or .near-ai/, and only a target decided at run time (or
// outside the project and not scratch, or behind an option the rules do not read) leaves the effects unknown. Nothing here runs a command: the classifier
// and the gate only read the text, in a project under the test run's temporary folder.
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

const write = (...paths: string[]): CommandEffect => ({ verb: 'workspaceWrite', paths });

/** Per program: a literal target inside the project and its tags, the same with a target decided at run time, and one into a protected place. */
const ROWS: ReadonlyArray<{ readonly program: string; readonly plain: string; readonly tags: readonly CommandEffect[]; readonly runTime: string; readonly protectedPlace: string }> = [
  { program: 'chmod', plain: 'chmod +x scripts/run.sh', tags: [write('scripts/run.sh')], runTime: 'chmod +x "$F"', protectedPlace: 'chmod +x .git/hooks/pre-commit' },
  { program: 'chown', plain: 'chown 1000:1000 data.txt', tags: [write('data.txt')], runTime: 'chown 1000:1000 "$F"', protectedPlace: 'chown 1000:1000 .near-ai/state/meta.json' },
  { program: 'ln', plain: 'ln -s ../shared/config.json config.json', tags: [write('config.json')], runTime: 'ln -s ../x "$L"', protectedPlace: 'ln -s ../x .git/hooks/pre-commit' },
  { program: 'git rm -f', plain: 'git rm -f old.txt', tags: [write('old.txt')], runTime: 'git rm -f "$F"', protectedPlace: 'git rm -f .near-ai/state/meta.json' },
  { program: 'git mv -f', plain: 'git mv -f a.txt b.txt', tags: [write('a.txt', 'b.txt')], runTime: 'git mv -f a.txt "$B"', protectedPlace: 'git mv -f a.txt .git/info/exclude' },
  { program: 'git diff --output', plain: 'git diff --output=changes.patch', tags: [write('changes.patch')], runTime: 'git diff --output="$O"', protectedPlace: 'git diff --output=.git/hooks/pre-commit' },
  { program: 'git format-patch -o', plain: 'git log -o log.txt', tags: [write('log.txt')], runTime: 'git log -o "$O"', protectedPlace: 'git log -o .git/x' },
  { program: 'rsync', plain: 'rsync -a src/ backup', tags: [write('backup')], runTime: 'rsync -a src/ "$D"', protectedPlace: 'rsync -a hooks/ .git/hooks' },
  { program: 'tsc --outDir', plain: 'tsc --outDir build', tags: [write('build')], runTime: 'tsc --outDir "$O"', protectedPlace: 'tsc --outDir .git/out' },
  { program: 'sort -o', plain: 'sort -o sorted.txt names.txt', tags: [write('sorted.txt')], runTime: 'sort -o "$X" names.txt', protectedPlace: 'sort -o .git/info/exclude names.txt' },
  { program: 'sed -i', plain: "sed -i 's/a/b/' src/*.ts", tags: [write('src/*.ts')], runTime: "sed -i 's/a/b/' \"$F\"", protectedPlace: "sed -i 's/a/b/' .git/config" },
  { program: 'find -fprint', plain: "find src -name '*.ts' -fprint list.txt", tags: [write('list.txt')], runTime: "find src -name '*.ts' -fprint \"$L\"", protectedPlace: "find src -name '*.ts' -fprint .git/x" },
  { program: 'curl -o', plain: 'curl -sS -o page.html https://example.test/', tags: [write('page.html')], runTime: 'curl -sS -o "$O" https://example.test/', protectedPlace: 'curl -sS -o .git/hooks/pre-commit https://example.test/' },
  { program: 'curl -O', plain: 'curl -fsSL -O https://example.test/a.tgz', tags: [write('a.tgz')], runTime: 'curl -fsSL --output-dir "$D" -O https://example.test/a.tgz', protectedPlace: 'curl -fsSL -o .git/hooks/pre-commit -L https://example.test/x' },
  { program: 'wget', plain: 'wget https://example.test/x.tgz', tags: [write('x.tgz')], runTime: 'wget -P "$D" https://example.test/x.tgz', protectedPlace: 'wget -O .git/hooks/pre-commit https://example.test/x' },
  { program: 'awk', plain: 'awk \'{print > "out.txt"}\' in.txt', tags: [write('out.txt')], runTime: 'awk \'{print > f}\' in.txt', protectedPlace: 'awk \'{print > ".git/x"}\' in.txt' }
];

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'near-ai-named-writes-'));
}

const contextIn = (root: string): CommandContext => ({ root, cwd: root, home: '/stand-in/home', temporaryRoots: [], packageScriptsAt: () => ({ kind: 'found', folder: root, scripts: {} }) });

async function decideIn(root: string, command: string, presence: 'person' | 'none') {
  const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
  return gateToolCall(runtime, {
    tool: bashTool, raw: { command }, root, callId: `${presence}-${command}`, command, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    grants: new RunGrants(), shell: { cwd: root, packageScriptsAt: () => ({ kind: 'found', folder: root, scripts: {} }) }, buildAuto: async () => undefined
  });
}

test('a literal target inside the project is a write to that path, read whole', () => {
  const root = project();
  const wrong: string[] = [];
  for (const row of ROWS) {
    const result = classifyCommand(row.plain, contextIn(root));
    if (result.effectsUnknown !== undefined || JSON.stringify(result.effects ?? []) !== JSON.stringify(row.tags)) wrong.push(`${row.plain} → ${JSON.stringify(result)}`);
  }
  assert.deepEqual(wrong, []);
});

test('in Full auto with nobody present, a routine write inside the project runs with no card', async () => {
  const root = project();
  for (const row of ROWS) {
    const gated = await decideIn(root, row.plain, 'none');
    assert.equal(gated.decision.outcome, 'allow', `${row.plain}: ${gated.decision.rule} ${gated.decision.reason ?? ''}`);
  }
});

test('a target decided at run time leaves the effects unknown: it asks with a person and is refused with nobody', async () => {
  const root = project();
  for (const row of ROWS) {
    assert.equal(typeof classifyCommand(row.runTime, contextIn(root)).effectsUnknown, 'string', row.runTime);
    for (const presence of ['person', 'none'] as const) {
      const gated = await decideIn(root, row.runTime, presence);
      assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${presence}: ${row.runTime}`);
      assert.equal(gated.decision.rule, 'manifest.effects-unknown', `${presence}: ${row.runTime}`);
    }
  }
});

test('a target in .git/ or .near-ai/ is a floor ask with a person and refused with nobody', async () => {
  const root = project();
  for (const row of ROWS) {
    for (const presence of ['person', 'none'] as const) {
      const gated = await decideIn(root, row.protectedPlace, presence);
      assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${presence}: ${row.protectedPlace}`);
      assert.equal(gated.decision.rule, 'floor.protected-write', `${presence}: ${row.protectedPlace}`);
    }
  }
});

test('git config: reading a setting runs with no card, setting one writes .git/config and the floor asks', async () => {
  const root = project();
  for (const command of ['git config --get core.pager', 'git config user.name', 'git config --list']) {
    const result = classifyCommand(command, contextIn(root));
    assert.equal(result.effectsUnknown, undefined, command);
    assert.equal((await decideIn(root, command, 'none')).decision.outcome, 'allow', command);
  }
  assert.deepEqual(classifyCommand('git config core.pager cat', contextIn(root)).effects, [write('.git/config')]);
  assert.equal((await decideIn(root, 'git config core.hooksPath hooks', 'person')).decision.rule, 'floor.protected-write');
  assert.deepEqual(classifyCommand('git config --file team.cfg a.b c', contextIn(root)).effects, [write('team.cfg')]);
});

test('rsync --delete is destruction of its destination; env and timeout options are read through to the command they run', () => {
  const root = project();
  assert.deepEqual(classifyCommand('rsync -a --delete src/ backup', contextIn(root)).effects, [{ verb: 'destroy', paths: ['backup'] }]);
  const push: CommandEffect = { verb: 'publish', target: 'git-remote' };
  for (const command of ['env -i git push', 'env -u HOME git push', 'env --unset=HOME git push', 'env -C sub git push', 'timeout -s KILL 5 git push', 'timeout --kill-after=5 10 git push', 'env -S "git push"']) {
    const result = classifyCommand(command, contextIn(root));
    assert.equal(result.effectsUnknown, undefined, command);
    assert.deepEqual(result.effects, [push], command);
    assert.notEqual(result.verdict, 'safe', command);
  }
  assert.equal(typeof classifyCommand('env --frob git push', contextIn(root)).effectsUnknown, 'string', 'an env option the rules do not know');
  // A download that writes no file (to the terminal) writes nothing; one that reads options from elsewhere is not read.
  assert.equal(classifyCommand('curl -fsSL https://example.test/', contextIn(root)).effectsUnknown, undefined);
  assert.equal(classifyCommand('curl -fsSL https://example.test/', contextIn(root)).effects, undefined);
  assert.equal(typeof classifyCommand('curl -K settings.cfg https://example.test/', contextIn(root)).effectsUnknown, 'string');
});

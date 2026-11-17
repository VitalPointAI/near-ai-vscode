// PR #74 review, round 1: the shell classifier's reach has one bound, and past it the floor fails closed. Every path by which the classifier reads a command
// inside another (a wrapper, a script, a substitution, an inline shell) stops at the same depth, and a command it stops reading, or one too long to read at
// all, says its effects are unknown, so the gate asks with a person there and refuses with nobody, in every mode, instead of reading "no effects". A
// classifier or resolver that throws does the same. Nothing here runs a command: the classifier and the gate only read the command's text.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand, MAX_COMMAND_LENGTH, MAX_COMMAND_WORDS, MAX_NESTING } from '../agent/commandSafety';
import type { CommandContext } from '../agent/commandSafety';
import { floorFactsFor, gateToolCall } from '../agent/gateAdapter';
import type { FloorReaders } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import type { GateRuntime } from '../domain/gate/decide';
import { testGateRuntime } from './helpers/gatedRuns';

const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };
const classify = (command: string, extra: Partial<CommandContext> = {}) => classifyCommand(command, { ...context, ...extra });
const PUSHES = (effects: readonly unknown[] | undefined): boolean => (effects ?? []).some((effect) => JSON.stringify(effect) === JSON.stringify({ verb: 'publish', target: 'git-remote' }));

/** A shell word that holds `text` exactly, in single quotes. */
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

interface Kind {
  readonly name: string;
  /** The command with `inner` run inside this kind of wrapper, once. */
  readonly wrap: (inner: string) => string;
  /** How deep the stack test nests it: deep enough to overflow the stack without a bound, unless each level grows the text (then the length cap stops it). */
  readonly many: number;
  /** The command nested `levels` deep, when nesting is not wrapping again (a pipe into xargs nests by naming xargs again after it). */
  readonly nestAs?: (levels: number, inner: string) => string;
}

// Every way the classifier reads a command inside another. Each one recurses, so each must stop at the bound. A kind added to the classifier and not here is
// caught by the source scan below.
const RECURSIVE_KINDS: readonly Kind[] = [
  ...['{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'exec', 'setsid'].map((word) => ({ name: word, wrap: (inner: string) => `${word} ${inner}`, many: 5000 })),
  ...['sudo', 'doas', 'pkexec', 'sudo -u root --'].map((word) => ({ name: word, wrap: (inner: string) => `${word} ${inner}`, many: 5000 })),
  { name: 'xargs', wrap: (inner) => `xargs ${inner}`, many: 5000 },
  { name: 'find -exec', wrap: (inner) => `find . -exec ${inner}`, many: 3000 },
  { name: 'a pipe into xargs', wrap: (inner) => `echo x | xargs ${inner}`, many: 3000, nestAs: (levels, inner) => `echo x | ${'xargs '.repeat(levels)}${inner}` },
  { name: '$(...)', wrap: (inner) => `echo $(${inner})`, many: 5000 },
  { name: 'NAME=$(...)', wrap: (inner) => `out=$(${inner})`, many: 5000 },
  { name: 'eval', wrap: (inner) => `eval ${inner}`, many: 5000 },
  { name: 'bash -c', wrap: (inner) => `bash -c ${quoted(inner)}`, many: 10 },
  { name: 'sh -lc', wrap: (inner) => `sh -lc ${quoted(inner)}`, many: 10 },
  { name: 'su -c', wrap: (inner) => `su -c ${quoted(inner)}`, many: 10 }
];

function nest(kind: Kind, levels: number, inner = 'git push'): string {
  if (kind.nestAs !== undefined) return kind.nestAs(levels, inner);
  let command = inner;
  for (let level = 0; level < levels; level += 1) command = kind.wrap(command);
  return command;
}

test('the classifier has one nesting bound, of four levels, the one the docs name', () => {
  assert.equal(MAX_NESTING, 4);
});

for (const kind of RECURSIVE_KINDS) {
  test(`${kind.name}: read once it shows the push; nested past the bound, or thousands deep, the effects are unknown and nothing throws`, () => {
    const once = classify(kind.wrap('git push'));
    assert.ok(PUSHES(once.effects), `${kind.name} once: the push is seen (${JSON.stringify(once)})`);
    assert.equal(once.effectsUnknown, undefined, `${kind.name} once is read whole`);
    for (const levels of [MAX_NESTING + 2, kind.many]) {
      let result: ReturnType<typeof classifyCommand> | undefined;
      assert.doesNotThrow(() => { result = classify(nest(kind, levels)); }, `${kind.name} x${levels} does not throw`);
      assert.equal(typeof result?.effectsUnknown, 'string', `${kind.name} x${levels}: the effects are unknown, never "none" (${JSON.stringify(result)})`);
      assert.notEqual(result?.verdict, 'safe', `${kind.name} x${levels} is never safe`);
    }
  });
}

test('npm run scripts that run scripts stop at the same bound: a chain past it and a script that runs itself have unknown effects', () => {
  const chain: Record<string, string> = { s9: 'git push' };
  for (let index = 0; index < 9; index += 1) chain[`s${index}`] = `npm run s${index + 1}`;
  const short = classify('npm run s8', { packageScripts: chain });
  assert.ok(PUSHES(short.effects), 'a script that runs one script that pushes is read through');
  assert.equal(short.effectsUnknown, undefined);
  const long = classify('npm run s0', { packageScripts: chain });
  assert.equal(typeof long.effectsUnknown, 'string', 'a chain of ten scripts is past the bound');
  assert.notEqual(long.verdict, 'safe', 'and it is not safe either');
  const itself = classify('npm run loop', { packageScripts: { loop: 'npm run loop' } });
  assert.equal(typeof itself.effectsUnknown, 'string', 'a script that runs itself');
  assert.notEqual(itself.verdict, 'safe');
});

// These are read in a loop, not by recursion, so they have no depth to bound: thousands of them are read through, whole, to the push (were one to recurse
// one level deeper each time, it would stop at the bound here and fail).
test('wrappers the classifier steps over in a loop do not recurse: thousands of them are still read through to the push', () => {
  const commands = [
    ...['time', 'nohup', 'nice', 'command', 'env', 'timeout 5', 'env CI=1'].map((word) => `${`${word} `.repeat(4000)}git push`),
    `${'( '.repeat(4000)}git push${' )'.repeat(4000)}`
  ];
  for (const command of commands) {
    let result: ReturnType<typeof classifyCommand> | undefined;
    assert.doesNotThrow(() => { result = classify(command); }, command.slice(0, 20));
    assert.ok(PUSHES(result?.effects), `${command.slice(0, 20)}... still shows the push`);
    assert.equal(result?.effectsUnknown, undefined, `${command.slice(0, 20)}... is read whole`);
  }
});

test('a command too long, or with too many words, to read is not read: its effects are unknown', () => {
  const long = `git status # ${'x'.repeat(MAX_COMMAND_LENGTH)}`;
  const tooLong = classify(long);
  assert.equal(typeof tooLong.effectsUnknown, 'string');
  assert.equal(tooLong.verdict, 'unknown');
  const many = `ls ${'a '.repeat(MAX_COMMAND_WORDS)}&& git push`;
  assert.ok(many.length < MAX_COMMAND_LENGTH, 'the word cap is its own check');
  const tooMany = classify(many);
  assert.equal(typeof tooMany.effectsUnknown, 'string');
  assert.notEqual(tooMany.verdict, 'safe');
  // Just under both caps is still read whole.
  const fine = classify(`ls ${'a '.repeat(MAX_COMMAND_WORDS - 10)}&& git push`);
  assert.equal(fine.effectsUnknown, undefined);
  assert.ok(PUSHES(fine.effects));
  // A file of 1,500 lines written with a here-document (whose text the lexer reads as words) is still read: the cap is well above what such work needs.
  const heredoc = classify(`cat > notes.md <<'EOF'\n${'the quick brown fox\n'.repeat(1500)}EOF`);
  assert.equal(heredoc.effectsUnknown, undefined);
});

test('a megabyte of command is turned away quickly instead of being read', () => {
  const started = Date.now();
  const result = classify(`echo ${'a '.repeat(500_000)}&& git push`);
  assert.equal(typeof result.effectsUnknown, 'string');
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

// The invariant behind the enumerated kinds: every place the classifier reads a command inside another passes a deeper level, and both entry points check
// the bound before they read anything. A new recursion site that passes the same depth (and could loop) or a new entry point without the check fails here.
test('source: every recursive call in the classifier goes one level deeper, and both entry points check the one bound first', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'commandSafety.ts'), 'utf8');
  const bodies = new Map<string, string>();
  const starts = [...source.matchAll(/^(?:export )?function (\w+)\(/gm)];
  for (const [index, match] of starts.entries()) bodies.set(match[1], source.slice(match.index, starts[index + 1]?.index ?? source.length));
  for (const entry of ['classifyText', 'classifyWords']) {
    const body = bodies.get(entry) ?? '';
    const firstCall = /\b(classify\w+|checkScript|note\w+|beyondReach|tooDeep)\(/.exec(body.slice(body.indexOf('{')));
    assert.equal(firstCall?.[1], 'tooDeep', `${entry} checks the bound before it reads anything`);
  }
  // The only same-level calls: classifyStructure handing each part of the line it was given to classifyWords (classifyText already checked this level),
  // and classifyText handing its own text to classifyStructure.
  const sameLevel: string[] = [];
  for (const [name, body] of bodies) {
    for (const call of body.matchAll(/\b(classifyText|classifyWords|classifyStructure|classifyProgram|classifyPackageManager|classifyNpx|checkScript|noteRunsAs|noteInlineScript)\(([^;]*?)\)(?=[;,)\s]|$)/g)) {
      if (call.index !== undefined && body.slice(Math.max(0, call.index - 9), call.index) === 'function ') continue;
      const args = call[2];
      if (/depth \+ 1\b/.test(args)) continue;
      if (/,\s*0\)?$/.test(args) && name === 'classifyCommand') continue;
      sameLevel.push(`${name} -> ${call[1]}`);
    }
  }
  const allowed = new Set(['classifyText -> classifyStructure', 'classifyStructure -> classifyWords', 'classifyWords -> classifyProgram', 'classifyProgram -> noteRunsAs',
    'classifyProgram -> classifyPackageManager', 'classifyProgram -> classifyNpx', 'classifyProgram -> noteInlineScript', 'classifyPackageManager -> checkScript']);
  const unexpected = [...new Set(sameLevel)].filter((call) => !allowed.has(call));
  assert.deepEqual(unexpected, [], 'a call that does not go deeper, outside the known descents from one level to its parts');
  // Each of the allowed descents ends in a call that does go deeper: none of these functions calls back up the list at the same level.
  for (const name of ['noteRunsAs', 'noteInlineScript', 'classifyNpx', 'checkScript']) {
    const body = bodies.get(name) ?? '';
    for (const call of body.matchAll(/\b(classifyText|classifyWords)\(([^;]*?)\)(?=[;,)\s]|$)/g)) assert.match(call[2], /depth \+ 1\b/, `${name} -> ${call[1]} goes one level deeper`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The gate: unknown command effects ask with a person and are refused with nobody, in every mode, fully-autonomous included.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'near-ai-bounds-'));
}

async function gated(runtime: GateRuntime, root: string, command: string, readers?: FloorReaders) {
  return gateToolCall(runtime, {
    tool: bashTool, raw: { command }, root, callId: `call-${Math.random()}`, command,
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
    shell: { cwd: root }, buildAuto: async () => undefined
  }, readers === undefined ? {} : { floorReaders: readers });
}

test('floorFactsFor says the effects are unknown when the classifier stops reading, and when it or the resolver throws', async () => {
  const root = project();
  const deep = await floorFactsFor({ command: `${'if '.repeat(5000)}git push`, root });
  assert.equal(typeof deep.effectsUnknown, 'string', 'thousands of if words: the push is not read, so the effects are unknown');
  const plain = await floorFactsFor({ command: 'git push', root });
  assert.equal(plain.effectsUnknown, undefined);
  const throwing = await floorFactsFor({ command: 'git status', root }, { classify: () => { throw new RangeError('Maximum call stack size exceeded'); } });
  assert.equal(typeof throwing.effectsUnknown, 'string', 'a classifier that throws');
  assert.deepEqual(throwing.effects, []);
  const lost = await floorFactsFor({ command: 'git status', root }, { reach: async () => { throw new Error('resolver failed'); } });
  assert.equal(typeof lost.effectsUnknown, 'string', 'a credential-store resolver that throws');
});

test('in fully-autonomous a command the classifier cannot read whole asks with a person and is refused with nobody', async () => {
  const root = project();
  for (const command of [`${'if '.repeat(5000)}git push`, `${'sudo '.repeat(5000)}rm -rf src`, nest(RECURSIVE_KINDS.find((kind) => kind.name === 'bash -c')!, 6), `ls ${'a '.repeat(MAX_COMMAND_WORDS)}&& git push`]) {
    for (const presence of ['person', 'none'] as const) {
      const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
      const result = await gated(runtime, root, command);
      assert.equal(result.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${presence}: ${command.slice(0, 40)}`);
      assert.equal(result.decision.rule, 'manifest.effects-unknown');
      assert.equal(result.decision.offerAlwaysAllow, false);
      assert.equal(result.decision.allowGrant, false);
      assert.deepEqual(result.effects, [], 'the call\'s effects are unknown, whatever the manifest said');
    }
  }
});

test('a classifier or resolver that throws makes the call ask with a person and be refused with nobody, never run unasked', async () => {
  const root = project();
  const failures: Array<[string, FloorReaders]> = [
    ['classifier', { classify: () => { throw new RangeError('Maximum call stack size exceeded'); } }],
    ['resolver', { reach: async () => { throw new Error('resolver failed'); } }]
  ];
  for (const [what, readers] of failures) {
    for (const presence of ['person', 'none'] as const) {
      const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
      const result = await gated(runtime, root, 'git status', readers);
      assert.equal(result.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${what}, ${presence}`);
      assert.equal(result.decision.rule, 'manifest.effects-unknown', what);
    }
  }
  // The same command with working readers runs as fully-autonomous always let it.
  const plain = await gated(testGateRuntime({ presence: 'none', context: 'unattended' }), root, 'git status');
  assert.equal(plain.decision.outcome, 'allow');
});

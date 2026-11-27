// PR #74 review round 2: a call's arguments are put in the manifest's shape once. readCallPaths ran the tool's manifestInput, rewrote a trusted-folder read
// in the model's own arguments, and the effects ran manifestInput again over them: for a tool whose manifestInput renames a field, the rewrite landed on a
// name the second pass did not read, so a trusted-folder read became "effects unknown". Every folder here is under the test run's temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateToolCall, readCallPaths } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bindFixtureGate, declareManifest, fromArgument, INTERACTIVE_AND_UNATTENDED, readTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { bundleHash } from '../domain/gate/bundle';
import { testGateRuntime } from './helpers/gatedRuns';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-callargs-')));
const ROOT = path.join(base, 'project');
const TRUSTED = path.join(base, 'trusted-runtime');
mkdirSync(ROOT);
mkdirSync(path.join(TRUSTED, 'docs'), { recursive: true });
writeFileSync(path.join(TRUSTED, 'docs', 'guide.md'), 'guide');

let calls = 0;
/** A read tool whose model-facing field is `file` and whose manifest reads `file_path`: its manifestInput renames one to the other. */
const renaming: AgentTool<{ file: string }> = {
  ...readTool,
  name: 'RenamingRead',
  manifest: declareManifest({ tool: 'RenamingRead', effects: [{ verb: 'read', paths: [fromArgument('file_path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  manifestInput: (raw: Record<string, unknown>) => {
    calls += 1;
    const { file, ...rest } = raw;
    return { ...rest, file_path: file };
  },
  parse: (raw: Record<string, unknown>) => ({ file: String(raw.file) })
} as unknown as AgentTool<{ file: string }>;

test('a renaming tool\'s read in a trusted folder is a known read, and its manifestInput runs once per call', async () => {
  calls = 0;
  const raw = { file: path.join(TRUSTED, 'docs', 'guide.md') };
  const paths = await readCallPaths(renaming, raw, ROOT, [TRUSTED]);
  assert.deepEqual(paths.trustedReads, ['trusted-runtime/docs/guide.md']);
  calls = 0;
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw, root: ROOT, callId: 'c1', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
    readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.equal(calls, 1, 'manifestInput ran once for the whole decision');
  assert.deepEqual(gated.effects, [{ verb: 'read', paths: ['**'] }], 'a known read, not unknown effects');
  assert.equal(gated.decision.outcome, 'allow', `not ${gated.decision.rule}`);
});

// Owner decision after PR #74 (changed deliberately): such a read still has unknown effects, and the gate now refuses it up front as the tool would.
test('a renaming tool\'s read outside the project and every trusted folder has unknown effects and is refused up front', async () => {
  const outside = path.join(base, 'elsewhere.md');
  writeFileSync(outside, 'x');
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw: { file: outside }, root: ROOT, callId: 'c2', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    grants: new RunGrants(), readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.deepEqual(gated.effects, []);
  assert.equal(gated.decision.rule, 'call.outside-workspace');
});

test('a renaming tool\'s read inside the project is the project path', async () => {
  writeFileSync(path.join(ROOT, 'notes.md'), 'n');
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw: { file: path.join(ROOT, 'notes.md') }, root: ROOT, callId: 'c3', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.deepEqual(gated.effects, [{ verb: 'read', paths: ['notes.md'] }]);
});

test('fixture write checks both the original path and the host-derived destination', async () => {
  const pathPolicy = { mode: 'fully-autonomous' as const, emergencyStop: false };
  const agent = { agentId: 'fixture-child', agentLabel: 'Fixture child' };
  const runtime = testGateRuntime({ actor: { kind: 'sub-agent', deviceFingerprint: 'device-test', sessionId: 'test-session', ...agent } });
  const state = runtime.bundleState();
  assert.equal(state.state, 'valid');
  let projections = 0;
  const tool: AgentTool<{ file: string }> = {
    ...renaming,
    name: 'FixtureWrite',
    capability: 'workspaceWrite',
    manifest: declareManifest({ tool: 'FixtureWrite', effects: [{ verb: 'workspaceWrite', paths: [fromArgument('draftPath')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
    manifestInput: (raw) => { projections += 1; return { draftPath: raw.target }; },
  };
  const outside = path.join(base, 'elsewhere.md');
  for (const [target, destination] of [[outside, 'proposal.md'], ['proposal.md', outside]] as const) {
    projections = 0;
    const gate = await gateToolCall(runtime, {
      tool, raw: { target }, root: ROOT, callId: 'fixture-path', policy: pathPolicy, rules: DEFAULT_RULES,
      grants: new RunGrants(), buildAuto: async () => undefined,
      fixtureGate: bindFixtureGate(runtime, () => pathPolicy, {
        policyHash: state.hash, currentActionSettings: () => pathPolicy,
        effect: { verb: 'workspaceWrite', path: destination },
      }, agent),
    });
    assert.equal(gate.decision.rule, 'call.outside-workspace');
    assert.equal(projections, 1);
  }
});

test('a decision names the bundle it evaluated even if the runtime changes while settings run', async () => {
  const runtime = testGateRuntime();
  const initial = runtime.bundleState();
  assert.equal(initial.state, 'valid');
  const replacement = { ...initial.bundle, issuedAt: new Date(Date.parse(initial.bundle.issuedAt) - 1).toISOString() };
  const later = { ...initial, bundle: replacement, hash: bundleHash(replacement) };
  let current = initial;
  const gate = await gateToolCall({ ...runtime, bundleState: () => current }, {
    tool: renaming, raw: { file: 'notes.md' }, root: ROOT, callId: 'runtime-bundle', rules: DEFAULT_RULES, grants: new RunGrants(),
    policy: { mode: 'fully-autonomous', emergencyStop: false },
    buildAuto: async () => { await Promise.resolve(); current = later; return undefined; },
  });
  assert.equal(gate.decision.outcome, 'allow');
  assert.equal(current.hash, later.hash);
  assert.equal(runtime.records.at(-1)?.unmapped.nearAi.bundleHash, initial.hash);
});

// PR #74 review round 4: a call that reads more than one file in a trusted folder names every one in its record, as many as fit, and says how many more.
const twoReads: AgentTool<{ a: string; b: string }> = {
  ...readTool,
  name: 'TwoReads',
  manifest: declareManifest({ tool: 'TwoReads', effects: [{ verb: 'read', paths: [fromArgument('first'), fromArgument('second')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw: Record<string, unknown>) => ({ a: String(raw.first), b: String(raw.second) })
} as unknown as AgentTool<{ a: string; b: string }>;

test('a call reading two trusted-folder files names both in its record, and a list too long to fit says how many more', async () => {
  writeFileSync(path.join(TRUSTED, 'docs', 'notes.md'), 'notes');
  const runtime = testGateRuntime({ presence: 'none', context: 'unattended' });
  const gated = await gateToolCall(runtime, {
    tool: twoReads, raw: { first: path.join(TRUSTED, 'docs', 'guide.md'), second: path.join(TRUSTED, 'docs', 'notes.md') }, root: ROOT, callId: 'two',
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.equal(gated.decision.outcome, 'allow');
  assert.deepEqual(gated.resource, { name: 'trusted-runtime/docs/guide.md, trusted-runtime/docs/notes.md', type: 'file' });
  assert.equal(runtime.records.at(-1)?.resources?.[0]?.name, 'trusted-runtime/docs/guide.md, trusted-runtime/docs/notes.md');
  // Names too long to list together: as many as fit, then how many more.
  const long = `${'n'.repeat(150)}.md`;
  writeFileSync(path.join(TRUSTED, 'docs', long), 'x');
  const both = await gateToolCall(runtime, {
    tool: twoReads, raw: { first: path.join(TRUSTED, 'docs', long), second: path.join(TRUSTED, 'docs', 'notes.md') }, root: ROOT, callId: 'two-long',
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.equal(both.resource?.name, `trusted-runtime/docs/${long} and 1 more`);
  assert.ok((both.resource?.name.length ?? 0) <= 200);
});

test('trustedReadsName: one name is itself, several are listed, and a list past the bound ends with how many more', async () => {
  const { trustedReadsName } = await import('../agent/gateAdapter');
  assert.equal(trustedReadsName(['a/x.md']), 'a/x.md');
  const long = trustedReadsName([`a/${'x'.repeat(400)}.md`]);
  assert.ok(long.startsWith('a/xxx') && !/ and \d+ more$/.test(long), `one over-long name is cut by shownName first, so it fits and carries no count (review round 12 checked): ${long.slice(-30)}`);
  assert.match(trustedReadsName([`a/${'x'.repeat(400)}.md`, 'b/y.md']), / and 1 more$/);
  assert.equal(trustedReadsName(['a/x.md', 'a/y.md', 'b/z.md']), 'a/x.md, a/y.md, b/z.md');
  const many = Array.from({ length: 40 }, (_, index) => `runtime/docs/file-${index}.md`);
  const named = trustedReadsName(many);
  assert.ok(named.length <= 200, named);
  assert.match(named, /^runtime\/docs\/file-0\.md, .* and \d+ more$/);
  const listed = named.replace(/ and \d+ more$/, '').split(', ').length;
  assert.equal(Number(/ and (\d+) more$/.exec(named)?.[1]), 40 - listed, 'the count is what was left out');
  const huge = trustedReadsName([`${'x'.repeat(300)}.md`, 'b.md']);
  assert.ok(huge.length <= 200 && huge.endsWith(' and 1 more'), huge);
});

// PR #74 review round 6: the project's folder and the trusted folders are resolved once per call, not once per path field. A call with two path fields
// and two trusted folders resolves three folders (the project and each trusted folder), not six.
test('readCallPaths resolves the project and the trusted folders once per call, however many path fields it reads', async () => {
  const second = path.join(base, 'second-runtime');
  mkdirSync(second, { recursive: true });
  writeFileSync(path.join(TRUSTED, 'docs', 'notes.md'), 'notes');
  const resolved: string[] = [];
  const realpathOnce = async (folder: string) => { resolved.push(folder); return realpathSync(folder); };
  const paths = await readCallPaths(twoReads, { first: path.join(TRUSTED, 'docs', 'guide.md'), second: path.join(TRUSTED, 'docs', 'notes.md') }, ROOT, [second, TRUSTED], {}, { realpath: realpathOnce });
  assert.deepEqual(paths.trustedReads, ['trusted-runtime/docs/guide.md', 'trusted-runtime/docs/notes.md']);
  assert.equal(resolved.length, 3, `resolved: ${resolved.join(', ')}`);
  assert.deepEqual([...new Set(resolved)].sort(), [ROOT, second, TRUSTED].sort());
  // A call that names no path resolves nothing.
  resolved.length = 0;
  await readCallPaths(twoReads, {}, ROOT, [TRUSTED], {}, { realpath: realpathOnce });
  assert.equal(resolved.length, 0);
});

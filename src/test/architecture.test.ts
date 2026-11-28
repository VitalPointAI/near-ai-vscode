// The architecture test (FND-09, D-45, ADR-001), driven by the layer table of DEVELOPER-STRUCTURE section 1: domain below the engines and hosts,
// below the editor (src/services), below the composition root (src/extension.ts). It scans every non-test source file under src and compares what it
// finds with a checked-in baseline (src/test/architecture-baseline.json) that lists today's violations: a new violation fails, a removed one is a
// baseline line to delete. The baseline may only shrink.
//
// Re-recording the baseline is one step: run this file with NEAR_AI_WRITE_BASELINE=1. The ratchet test then writes the file and fails on purpose, so
// a written baseline is always reviewed as a diff before the next run. The tightness check (no stale line, no frozen size above today's) is enforced
// only with NEAR_AI_BASELINE_TIGHT=1, which the closing plan of a phase sets.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  ARCHITECTURE_RULES,
  FROZEN_ABOVE,
  LAYERS,
  SCALE_PRESETS_ALLOWED,
  WARN_ABOVE,
  baselineText,
  compareWithBaseline,
  findViolations,
  foldersInCycles,
  importsOf,
  layerOf,
  scanArchitecture,
  sourcesUnder,
  unplacedTopLevel,
  type ArchitectureBaseline,
  type BaselineComparison
} from './helpers/architectureScan';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');
const BASELINE_FILE = path.join(SRC, 'test', 'architecture-baseline.json');
const MINIMUM_FILES = 400;
const TIGHT = process.env.NEAR_AI_BASELINE_TIGHT === '1';

function readBaseline(): ArchitectureBaseline {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as ArchitectureBaseline;
}

/** The stale lines and shrunk frozen sizes of a comparison: a failure when the baseline must be tight, diagnostics otherwise. */
function enforceTightness(comparison: BaselineComparison, tight: boolean, report: (message: string) => void): void {
  const loose = [...comparison.stale.map((line) => `stale: ${line}`), ...comparison.shrunk.map((line) => `shrunk: ${line}`)];
  if (tight && loose.length > 0) {
    assert.fail(`the baseline is not tight; delete these lines or lower these sizes (or re-record with NEAR_AI_WRITE_BASELINE=1 and review the diff):\n${loose.join('\n')}`);
  }
  for (const line of loose) report(`baseline can shrink: ${line}`);
}

function planted(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

test('D-45: the layer table names every folder under src', () => {
  const entries = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.name.endsWith('.ts'))
    .map((entry) => entry.name);
  assert.ok(entries.length >= 10, `expected at least 10 entries under src, found ${entries.length}`);
  assert.deepEqual(unplacedTopLevel(entries), [], 'every folder under src (except test) needs a layer in LAYERS: place the new folder first');
  // Teeth: a new folder or a new top-level file with no layer is named.
  assert.deepEqual(unplacedTopLevel(['agent', 'platform', 'test', 'extension.ts', 'other.ts']), ['other.ts', 'platform']);
  assert.equal(LAYERS['extension.ts']?.layer, 'root');
  assert.equal(LAYERS.services?.layer, 'editor');
  for (const engine of ['agent', 'benchmark', 'gate', 'gsd', 'mcp', 'security', 'staff', 'team']) assert.equal(LAYERS[engine]?.layer, 'engine', engine);
  assert.equal(LAYERS.domain?.layer, 'domain');
  assert.equal(layerOf('domain/state/threadView.ts')?.layer, 'domain');
  assert.equal(layerOf('extension.ts')?.layer, 'root');
  assert.equal(layerOf('extension')?.layer, 'root');
  assert.equal(layerOf('platform/node/x.ts'), undefined);
});

test('D-45 upward-import has teeth: domain reaching outside src/domain and an engine reaching the editor are reported, the declared seams are not', () => {
  const found = findViolations(planted({
    'domain/x/planted.ts': [
      "import { ChatPanel } from '../../services/chat';",
      "import { tools } from '../../agent/tools';",
      "import { labelKey } from '../gate/labels';",
      "import type { Thing } from '../../services/chat';"
    ].join('\n'),
    'agent/planted.ts': [
      "import { AuditStore } from '../services/auditStore';",
      "import { labelKey } from '../domain/gate/labels';",
      "import { McpHost } from '../mcp/host';"
    ].join('\n'),
    'gate/planted.ts': [
      "import type { SecretStorageLike } from '../services/auth';",
      "import { withFileLock } from '../services/stateMirrorLock';"
    ].join('\n'),
    'gate/value.ts': "import { loginFlow } from '../services/auth';",
    'team/planted.ts': [
      "import type { SecretStorageLike } from '../services/auth';",
      "import { withFileLock } from '../services/stateMirrorLock';",
      "export { spend } from '../services/spend';"
    ].join('\n'),
    'services/fine.ts': "import { tools } from '../agent/tools';"
  }));
  assert.deepEqual(found.rules['upward-import'], [
    'agent/planted.ts -> services/auditStore',
    'domain/x/planted.ts -> agent/tools',
    'domain/x/planted.ts -> services/chat',
    'gate/value.ts -> services/auth',
    'team/planted.ts -> services/spend'
  ]);
});

test('D-45: an empty scan fails', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-architecture-'));
  try {
    mkdirSync(path.join(root, 'domain'));
    writeFileSync(path.join(root, 'domain', 'one.ts'), 'export const one = 1;\n');
    assert.throws(() => scanArchitecture(root, MINIMUM_FILES), /an empty scan proves nothing/);
    assert.equal(scanArchitecture(root, 1).files, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D-45 vscode-below-editor has teeth: every import form in an engine or domain file is reported, the editor and the composition root are not', () => {
  const forms = ["import * as vscode from 'vscode';", "const lazy = await import('vscode');", "const old = require('vscode');", "import type { Uri } from 'vscode';"];
  for (const form of forms) {
    const found = findViolations(planted({
      'agent/planted.ts': form,
      'gate/planted.ts': form,
      'domain/x/planted.ts': form,
      'services/planted.ts': form,
      'extension.ts': form
    }));
    assert.deepEqual(found.rules['vscode-below-editor'], ['agent/planted.ts -> vscode', 'domain/x/planted.ts -> vscode', 'gate/planted.ts -> vscode'], form);
  }
  const comment = findViolations(planted({ 'agent/note.ts': "// never import * as vscode from 'vscode' here\n * import * as vscode from 'vscode';" }));
  assert.deepEqual(comment.rules['vscode-below-editor'], []);
});

test('D-45 folder-cycle has teeth: every file edge inside a cycle of engine folders is reported, downward and editor edges are not', () => {
  assert.deepEqual(foldersInCycles([
    { file: 'agent/a.ts', target: 'staff/x' },
    { file: 'agent/b.ts', target: 'staff/y' },
    { file: 'staff/c.ts', target: 'agent/z' }
  ]), ['agent/a.ts -> staff', 'agent/b.ts -> staff', 'staff/c.ts -> agent']);
  assert.deepEqual(foldersInCycles([
    { file: 'agent/p.ts', target: 'mcp/q' },
    { file: 'mcp/r.ts', target: 'gsd/s' },
    { file: 'gsd/t.ts', target: 'agent/u' },
    { file: 'agent/d.ts', target: 'domain/x' },
    { file: 'domain/e.ts', target: 'agent/f' },
    { file: 'agent/g.ts', target: 'services/h' },
    { file: 'services/k.ts', target: 'agent/l' },
    { file: 'team/m.ts', target: 'gate/n' },
    { file: 'agent/o.ts', target: 'agent/inner' }
  ]), ['agent/p.ts -> mcp', 'gsd/t.ts -> agent', 'mcp/r.ts -> gsd']);
  // The rule runs over real imports too.
  const found = findViolations(planted({
    'agent/a.ts': "import { x } from '../staff/x';",
    'staff/c.ts': "import { z } from '../agent/z';",
    'gate/one.ts': "import { t } from '../team/t';"
  }));
  assert.deepEqual(found.rules['folder-cycle'], ['agent/a.ts -> staff', 'staff/c.ts -> agent']);
});

test('D-45 scale-presets has teeth: an import of SCALE_PRESETS outside src/domain/gate and the two failed-closed fallbacks is reported', () => {
  const importLine = "import { SCALE_PRESETS, labelKey } from '../domain/gate/labels';";
  const found = findViolations(planted({
    'services/planted.ts': importLine,
    'services/caveat.ts': "import { SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';",
    'services/spaced.ts': "import {\n  labelKey,\n  SCALE_PRESETS\n} from '../domain/gate/labels';",
    'services/namespace.ts': "import * as labels from '../domain/gate/labels';\nconst scales = labels.SCALE_PRESETS;",
    'services/note.ts': '// SCALE_PRESETS is read through the policy, never imported here',
    'domain/gate/x.ts': "import { SCALE_PRESETS } from './labels';",
    'gate/host.ts': importLine,
    'agent/gateLabels.ts': importLine
  }));
  assert.deepEqual(found.rules['scale-presets'], ['services/namespace.ts', 'services/planted.ts', 'services/spaced.ts']);
  assert.deepEqual(Object.keys(SCALE_PRESETS_ALLOWED).sort(), ['agent/gateLabels.ts', 'gate/host.ts']);
  for (const reason of Object.values(SCALE_PRESETS_ALLOWED)) assert.match(reason, /failed-closed fallback: the gate's own presets when no policy can be read/);
});

test('D-45 get-configuration has teeth: a settings read outside services/settings.ts is reported, comments are not', () => {
  const read = "const config = vscode.workspace.getConfiguration('nearAi');";
  const found = findViolations(planted({
    'services/planted.ts': read,
    'services/settings.ts': read,
    'services/comment.ts': "// read through settings.ts, never vscode.workspace.getConfiguration('nearAi')\n * getConfiguration('nearAi') in a block comment\n/* getConfiguration('x') */",
    'extension.ts': read
  }));
  assert.deepEqual(found.rules['get-configuration'], ['extension.ts', 'services/planted.ts']);
});

test('D-45 file sizes: a frozen file may not grow, a new file above 1,200 fails, above 800 is a warning', (t) => {
  assert.equal(FROZEN_ABOVE, 1200);
  assert.equal(WARN_ABOVE, 800);
  const found = findViolations(planted({
    'services/big.ts': 'x\n'.repeat(1001),
    'services/huge.ts': 'x\n'.repeat(1201),
    'services/edge.ts': 'x\n'.repeat(1200),
    'services/mid.ts': 'x\n'.repeat(900),
    'services/small.ts': 'x\n'.repeat(800)
  }));
  assert.equal(found.sizes['services/big.ts'], 1001);
  const comparison = compareWithBaseline(found, { rules: {}, fileSizes: { 'services/big.ts': 1000 } });
  assert.deepEqual(comparison.grown, ['services/big.ts: 1001 lines, frozen at 1000; move the part you change out first']);
  assert.deepEqual(comparison.tooLarge, ['services/huge.ts: 1201 lines, new file above 1,200']);
  assert.deepEqual(comparison.warnings, ['services/edge.ts: 1200 lines, above 800', 'services/mid.ts: 900 lines, above 800']);
  for (const warning of comparison.warnings) t.diagnostic(`warning: ${warning}`);
  const atSize = compareWithBaseline(found, { rules: {}, fileSizes: { 'services/big.ts': 1001, 'services/huge.ts': 1201 } });
  assert.deepEqual([atSize.grown, atSize.tooLarge, atSize.shrunk], [[], [], []]);
});

test('D-45: the repository passes against its baseline for every rule and every frozen size (re-record with NEAR_AI_WRITE_BASELINE=1)', (t) => {
  const found = scanArchitecture(SRC, MINIMUM_FILES);
  assert.deepEqual(found.unplaced, [], 'every source file has a layer');
  if (process.env.NEAR_AI_WRITE_BASELINE === '1') {
    writeFileSync(BASELINE_FILE, baselineText(found));
    assert.fail('baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE');
  }
  const baseline = readBaseline();
  const comparison = compareWithBaseline(found, baseline);
  assert.deepEqual(comparison.added, [], 'new violations: fix them in the code that added them, never by adding a baseline line');
  assert.deepEqual(comparison.grown, [], 'frozen files may not grow');
  assert.deepEqual(comparison.tooLarge, [], 'a file above 1,200 lines that the baseline does not freeze: split it');
  for (const warning of comparison.warnings) t.diagnostic(`warning: ${warning}`);
  const upward = baseline.rules['upward-import'] ?? [];
  assert.ok(upward.includes('domain/auth.ts -> services/nearAiClient'), 'the baseline records the domain/auth.ts leak');
  assert.ok(!upward.some((line) => line.startsWith('domain/state/threadView.ts') || line.startsWith('domain/state/threadCapture.ts')), '41-07 removed the two domain/state leaks');
});

test('D-45: frozen files are exactly the files above 1,200 lines when the baseline was recorded', () => {
  const frozen = readBaseline().fileSizes;
  const files = Object.keys(frozen);
  assert.ok(files.length >= 3, `expected at least 3 frozen files, found ${files.length}`);
  for (const [file, size] of Object.entries(frozen)) assert.ok(Number.isInteger(size) && size > FROZEN_ABOVE, `${file} is frozen at ${size}, not above ${FROZEN_ABOVE}`);
  for (const file of ['services/agentSession.ts', 'services/nearAiClient.ts', 'services/chat.ts']) assert.ok(files.includes(file), `${file} is frozen`);
});

test('D-45: the tightness check fails on a stale line or a lowered size only when the baseline must be tight', () => {
  const found = findViolations(planted({
    'domain/leak.ts': "import { x } from '../services/x';",
    'services/large.ts': 'x\n'.repeat(1300)
  }));
  const comparison = compareWithBaseline(found, {
    rules: { 'upward-import': ['domain/gone.ts -> services/x', 'domain/leak.ts -> services/x'] },
    fileSizes: { 'services/large.ts': 1400, 'services/removed.ts': 1500 }
  });
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.grown, []);
  assert.deepEqual(comparison.stale, ['fileSizes: services/removed.ts', 'upward-import: domain/gone.ts -> services/x']);
  assert.deepEqual(comparison.shrunk, ['services/large.ts: 1300 lines, frozen at 1400']);
  assert.throws(() => enforceTightness(comparison, true, () => undefined), (error: Error) => {
    assert.match(error.message, /stale: upward-import: domain\/gone\.ts -> services\/x/);
    assert.match(error.message, /stale: fileSizes: services\/removed\.ts/);
    assert.match(error.message, /shrunk: services\/large\.ts: 1300 lines, frozen at 1400/);
    return true;
  });
  const reported: string[] = [];
  enforceTightness(comparison, false, (message) => reported.push(message));
  assert.equal(reported.length, 3);
  // A tight baseline passes in both modes.
  const exact = compareWithBaseline(found, { rules: { 'upward-import': ['domain/leak.ts -> services/x'] }, fileSizes: { 'services/large.ts': 1300 } });
  enforceTightness(exact, true, () => assert.fail('nothing to report'));
});

test('D-45: the baseline is tight (enforced at the close of a phase with NEAR_AI_BASELINE_TIGHT=1)', (t) => {
  const comparison = compareWithBaseline(scanArchitecture(SRC, MINIMUM_FILES), readBaseline());
  enforceTightness(comparison, TIGHT, (message) => t.diagnostic(message));
});

test('D-45: the baseline file is sorted and has no duplicate line', () => {
  const text = readFileSync(BASELINE_FILE, 'utf8');
  const baseline = JSON.parse(text) as ArchitectureBaseline;
  assert.deepEqual(Object.keys(baseline).sort(), ['fileSizes', 'rules']);
  assert.deepEqual(Object.keys(baseline.rules), [...ARCHITECTURE_RULES], 'one list per rule, in rule order');
  for (const rule of ARCHITECTURE_RULES) {
    const lines = baseline.rules[rule] ?? [];
    assert.deepEqual(lines, [...lines].sort(), `${rule} is sorted`);
    assert.equal(new Set(lines).size, lines.length, `${rule} has no duplicate line`);
  }
  const files = Object.keys(baseline.fileSizes);
  assert.deepEqual(files, [...files].sort(), 'fileSizes is sorted');
  assert.ok(text.endsWith('}\n') && text.includes('\n  "rules": {'), 'two-space indent and a trailing newline');
});

// ---- 33.2 D-09: no new X25519 wrap after the switch, ever ----

// The two files that may make a wrap themselves: the v1 wrap (cellKeys.ts) and the v2 wrap with the one entry point (cellWrapV2.ts).
const WRAP_MAKERS: ReadonlySet<string> = new Set(['domain/replica/cellKeys.ts', 'domain/replica/cellWrapV2.ts']);
// Key agreement that wraps no cell key, each for its reason: it never reaches a staff replica grant.
const OTHER_KEY_AGREEMENT: Readonly<Record<string, string>> = {
  'domain/exchange/tdf.ts': 'OpenTDF key access for exchange with allies (45.1-02): P-256 ECDH to a partner\'s published key, never a cell key'
};
// Files that call the entry point (wrapForDevice, or grantPages' wrapsFor and earlierEpochGrants over it) and must choose the format with
// wrapPlan.formatFor, except these, each for its reason.
const FORMAT_CHOSEN_ELSEWHERE: Readonly<Record<string, string>> = {
  'domain/replica/cellWrapV2.ts': 'defines the entry point',
  'domain/replica/grantPages.ts': 'takes the format its caller chose',
  'staff/replica/replicaProject.ts': 'the genesis, before any roster: v2 exactly when the project starts switched (wrapV2AtCreation)'
};

const codeOf = (text: string): string => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

/** Every way a source tree breaks the wrap rule (D-09). */
function wrapPathProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of sources) {
    const code = codeOf(text);
    if (!WRAP_MAKERS.has(file) && /\bwrapEpochKey\s*\(/.test(code)) problems.push(`${file}: calls wrapEpochKey outside the wrap modules`);
    if (!WRAP_MAKERS.has(file) && !Object.hasOwn(OTHER_KEY_AGREEMENT, file) && /\bdiffieHellman\s*\(/.test(code)) problems.push(`${file}: does key agreement outside the wrap modules`);
    const wraps = /\b(?:wrapForDevice|wrapsFor|earlierEpochGrants)\s*\(/.test(code);
    if (wraps && !Object.hasOwn(FORMAT_CHOSEN_ELSEWHERE, file) && !/\bformatFor\s*\(/.test(code)) problems.push(`${file}: wraps without wrapPlan.formatFor`);
  }
  // The entry point writes v1 only on its format-1 branch, after the format-2 branch: the caller's formatFor is what keeps v1 out after the switch.
  const entry = codeOf(sources.get('domain/replica/cellWrapV2.ts') ?? '');
  const body = entry.slice(entry.indexOf('export function wrapForDevice'));
  const guard = body.indexOf('input.format === 2');
  const v1 = body.indexOf('wrapEpochKey(');
  if (guard < 0 || v1 < 0 || v1 < guard) problems.push('domain/replica/cellWrapV2.ts: wrapForDevice writes v1 without the format-2 branch first');
  return problems.sort();
}

test('33.2 D-09: no file outside the wrap modules makes an X25519 wrap or agreement, and every wrap path chooses its format with formatFor', () => {
  const sources = sourcesUnder(SRC);
  assert.ok(sources.has('domain/replica/cellWrapV2.ts'));
  assert.deepEqual(wrapPathProblems(sources), []);
});

test('33.2 D-09 has teeth: a planted wrapEpochKey or diffieHellman call, a wrap path without formatFor, and a v1 branch without the guard are reported', () => {
  const sources = sourcesUnder(SRC);
  const entry = sources.get('domain/replica/cellWrapV2.ts') as string;
  const seeded = new Map(sources);
  seeded.set('staff/replica/planted.ts', "import { wrapEpochKey } from '../../domain/replica/cellKeys';\nexport const w = wrapEpochKey({} as never);\n");
  seeded.set('agent/agreed.ts', "import { diffieHellman } from 'node:crypto';\nexport const s = diffieHellman({} as never);\n");
  seeded.set('staff/replica/unchosen.ts', "import { wrapsFor } from '../../domain/replica/grantPages';\nexport const w = wrapsFor({ format: 1 } as never);\n");
  seeded.set('domain/replica/cellWrapV2.ts', entry.replace('input.format === 2', 'false'));
  assert.deepEqual(wrapPathProblems(seeded), [
    'agent/agreed.ts: does key agreement outside the wrap modules',
    'domain/replica/cellWrapV2.ts: wrapForDevice writes v1 without the format-2 branch first',
    'staff/replica/planted.ts: calls wrapEpochKey outside the wrap modules',
    'staff/replica/unchosen.ts: wraps without wrapPlan.formatFor'
  ]);
  // A comment that names the call is not a call.
  const commented = new Map(sources);
  commented.set('staff/replica/notes.ts', '// wrapEpochKey(...) is called only in cellKeys.ts\nexport const n = 1;\n');
  assert.deepEqual(wrapPathProblems(commented), []);
});

// 45.2-14 (CONTEXT D-26, D-31): the inbound adapters and the archive reader read hostile files from outside your organization, so they reach nothing
// but the bytes they were given. Each module kind below is refused under both folders, for the reason beside it.
const NO_IO_FOLDERS = ['domain/exchange/inbound', 'domain/archive'] as const;
const IO_MODULES_REFUSED: Readonly<Record<string, string>> = {
  fs: 'file system: an adapter reads only the bytes it was handed and never writes a partner file anywhere',
  net: 'network: a URI inside an arrival is never dereferenced (request forgery)',
  http: 'network: a URI inside an arrival is never dereferenced (request forgery)',
  https: 'network: a URI inside an arrival is never dereferenced (request forgery)',
  http2: 'network: a URI inside an arrival is never dereferenced (request forgery)',
  dgram: 'network: a URI inside an arrival is never dereferenced (request forgery)',
  undici: "network: Node's own fetch implementation",
  dns: 'DNS: a lookup is a network call and tells a stranger what the arrival names',
  tls: 'TLS: a connection is a network call; key servers are reached only through the backend rewrap port',
  child_process: 'child process: escapes the pure domain and the parser limits',
  worker_threads: 'worker: escapes the pure domain and the parser limits',
  cluster: 'worker: escapes the pure domain and the parser limits'
};
// D-26: a stored form is never signed by your organization, so nothing under the inbound folder names the label binding signer of 45.1-01 (bindLabel)
// or a release key (release-<site>, release-p256-<site>, an org-release signer id). Verifying a sender's binding (verifyLabelBinding) stays allowed.
const NO_RELEASE_SIGNER_FOLDER = 'domain/exchange/inbound';
const RELEASE_SIGNER_NAMES = /\bbindLabel\b|\brelease-p256\b|\brelease-(?:<site>|\$\{)|['"`]org-release:/;
const FETCH_CALL = /(?:^|[^\w.$])fetch[ \t]*\(|\b(?:globalThis|global|window|self)[ \t]*(?:\.[ \t]*fetch\b|\[[ \t]*['"`]fetch['"`])/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** The I/O and release-signer findings under the inbound adapters and the archive reader, as "<file> -> <what>", sorted. Test files are not scanned. */
function inboundIoFindings(sources: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  for (const [file, text] of sources) {
    if (file.endsWith('.test.ts') || !NO_IO_FOLDERS.some((folder) => file.startsWith(`${folder}/`))) continue;
    // Comment lines are blanked (keeping the line count), so a word in a comment is never a finding.
    const code = text.split('\n').map((line) => (isCommentLine(line) ? '' : line)).join('\n');
    for (const ref of importsOf(code)) {
      const module = ref.specifier.replace(/^node:/, '').split('/')[0] ?? '';
      if (Object.prototype.hasOwnProperty.call(IO_MODULES_REFUSED, module)) found.add(`${file} -> ${module}`);
    }
    if (FETCH_CALL.test(code)) found.add(`${file} -> fetch`);
    if (file.startsWith(`${NO_RELEASE_SIGNER_FOLDER}/`) && RELEASE_SIGNER_NAMES.test(code)) found.add(`${file} -> release signer`);
  }
  return [...found].sort();
}

test('D-26, D-31: no inbound adapter or archive reader reaches a disk, the network or a worker, and no inbound adapter names a release signer', () => {
  // Teeth: every import form the vscode-below-editor rule reads, for each kind of module, is reported.
  const forms = (module: string): string[] => [`import * as m from '${module}';`, `const lazy = await import('${module}');`, `const old = require('${module}');`, `import type { X } from '${module}';`, `import '${module}';`, `export { y } from '${module}';`];
  for (const [module, kind] of [['node:fs', 'fs'], ['fs/promises', 'fs'], ['node:https', 'https'], ['http', 'http'], ['node:net', 'net'], ['dns/promises', 'dns'], ['node:tls', 'tls'], ['node:child_process', 'child_process'], ['worker_threads', 'worker_threads'], ['undici', 'undici']] as const) {
    for (const form of forms(module)) {
      const found = inboundIoFindings(planted({
        'domain/exchange/inbound/planted.ts': form,
        'domain/archive/planted.ts': form,
        'domain/exchange/inbound/planted.test.ts': form,
        'domain/exchange/tdf.ts': form,
        'agent/zip.ts': form
      }));
      assert.deepEqual(found, [`domain/archive/planted.ts -> ${kind}`, `domain/exchange/inbound/planted.ts -> ${kind}`], form);
    }
  }
  for (const call of ['const r = await fetch(url);', 'void globalThis.fetch(url);', "globalThis['fetch'](url);", 'return fetch (url)']) {
    assert.deepEqual(inboundIoFindings(planted({ 'domain/exchange/inbound/x.ts': call, 'domain/archive/y.ts': call })), ['domain/archive/y.ts -> fetch', 'domain/exchange/inbound/x.ts -> fetch'], call);
  }
  for (const signer of ["import { bindLabel } from '../labelBinding';", 'const key = `release-p256-${site}`;', 'const key = `release-${site}`;', "const signer = 'org-release:' + site;"]) {
    assert.deepEqual(inboundIoFindings(planted({ 'domain/exchange/inbound/x.ts': signer, 'domain/archive/y.ts': signer })), ['domain/exchange/inbound/x.ts -> release signer'], signer);
  }
  // Comments that name them, the zlib the archive reader uses, a verifier and an adapter's own port names are not findings.
  const fine = inboundIoFindings(planted({
    'domain/archive/zip.ts': "import { crc32, inflateRawSync } from 'node:zlib';\n// never import fs from 'node:fs' or call fetch(url) here\n * const x = require('node:child_process');",
    'domain/exchange/inbound/tdf.ts': "import { verifyLabelBinding } from '../labelBinding';\n/* bindLabel and release-p256-<site> are never named here */\nconst opened = await ports.rewrap(object);\nconst prefetch = sample.prefetched;"
  }));
  assert.deepEqual(fine, []);
  // The repository passes today: the folders hold the archive reader (and later the adapters), and none of them reaches outside.
  const sources = sourcesUnder(SRC);
  assert.ok(sources.has('domain/archive/zip.ts'), 'the archive reader is scanned');
  assert.deepEqual(inboundIoFindings(sources), []);
});

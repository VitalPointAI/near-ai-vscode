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
  LAYERS,
  baselineText,
  compareWithBaseline,
  findViolations,
  layerOf,
  scanArchitecture,
  unplacedTopLevel,
  type ArchitectureBaseline
} from './helpers/architectureScan';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');
const BASELINE_FILE = path.join(SRC, 'test', 'architecture-baseline.json');
const MINIMUM_FILES = 400;
/** The rules the ratchet compares with the baseline today. */
const RATCHET_RULES = ['upward-import'] as const;

function readBaseline(): ArchitectureBaseline {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as ArchitectureBaseline;
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

test('D-45: the repository passes against its baseline (re-record with NEAR_AI_WRITE_BASELINE=1)', () => {
  const found = scanArchitecture(SRC, MINIMUM_FILES);
  assert.deepEqual(found.unplaced, [], 'every source file has a layer');
  if (process.env.NEAR_AI_WRITE_BASELINE === '1') {
    writeFileSync(BASELINE_FILE, baselineText(found));
    assert.fail('baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE');
  }
  const baseline = readBaseline();
  const comparison = compareWithBaseline(found, baseline, RATCHET_RULES);
  assert.deepEqual(comparison.added, [], 'new violations: fix them in the code that added them, never by adding a baseline line');
  const upward = baseline.rules['upward-import'] ?? [];
  assert.ok(upward.includes('domain/auth.ts -> services/nearAiClient'), 'the baseline records the domain/auth.ts leak');
  assert.ok(!upward.some((line) => line.startsWith('domain/state/threadView.ts') || line.startsWith('domain/state/threadCapture.ts')), '41-07 removed the two domain/state leaks');
});

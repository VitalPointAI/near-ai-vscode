// The memory-capped decode worker (D-05 as refined by D-43): bytes from outside the machine are inspected in one reused worker thread with
// resourceLimits and a time limit per job, with the same answer the in-process inspection gives, and a worker that runs out of memory or time costs
// a restart, never the extension host. Probe bytes are built here with a small varuint writer; no large fixture is committed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import {
  applyUpdate, createFoldDoc, createLocalDoc, encodeFullState, inspectState, inspectUpdate, localDelete, localInsert, snapshotOf
} from '../domain/replica/doc';
import type { InspectError, UpdateInspection } from '../domain/replica/doc';
import { DECODE_LIMITS, DecodeHost } from '../staff/replica/decodeHost';
import type { DecodeVerdict } from '../staff/replica/decodeHost';
import { embedUpdate } from './helpers/replicaYjs';

// ---- Probe builders ------------------------------------------------------------------------------------------------------------------------------

function writeVaruint(out: Uint8Array, at: number, value: number): number {
  let rest = value;
  let next = at;
  while (rest > 127) {
    out[next] = 128 | (rest % 128);
    next += 1;
    rest = Math.floor(rest / 128);
  }
  out[next] = rest;
  return next + 1;
}

// One client group of `count` GC structs of length 1, then an empty delete set: 2 bytes per struct.
function gcProbe(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 2 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, count);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, 0);
  for (let index = 0; index < count; index += 1) {
    out[at] = 0;
    out[at + 1] = 1;
    at += 2;
  }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

// One client group of `count` typed-text items of one character each, all under the text root 'body' with no origins, then an empty delete set.
// Honest and allowed, so the skim lets it through and Yjs decodes it item by item: about 9 bytes per item and, at 100,000 items, tens of
// megabytes of heap while it is decoded.
function textItemsProbe(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 9 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, count);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, 0);
  for (let index = 0; index < count; index += 1) {
    // info: string content (ref 4), no origin, no right origin, no parent key; parent info 1 then the root name; then the one-character string.
    out.set([4, 1, 4, 98, 111, 100, 121, 1, 97], at);
    at += 9;
  }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

// The counts a worker verdict carries, from the in-process inspection of the same bytes.
function expected(found: UpdateInspection | { error: InspectError }): DecodeVerdict {
  if ('error' in found) return { ok: false, error: found.error };
  return { ok: true, structs: found.structs.length, deletes: found.deletes.length, clients: found.clients.length };
}

// An honest typed-text update, and one that deletes part of it, from one writer.
function typedUpdates(): { typed: Uint8Array; deleted: Uint8Array; doc: ReturnType<typeof createLocalDoc> } {
  const doc = createLocalDoc(4242);
  const typed = localInsert(doc, 0, 'Situation: the bridge at grid 1234 is open.');
  const deleted = localDelete(doc, 11, 4);
  return { typed, deleted, doc };
}

async function withHost<T>(host: DecodeHost, run: (host: DecodeHost) => Promise<T>): Promise<T> {
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

// ---- Task 1: the real worker gives the in-process answer --------------------------------------------------------------------------------------

test('the limits are the ones D-43 sets', () => {
  assert.deepEqual({ ...DECODE_LIMITS }, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4, timeoutMs: 5000 });
  assert.ok(Object.isFrozen(DECODE_LIMITS));
});

test('an honest update, a delete, a state and a snapshot inspected in the worker equal the in-process inspection', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const { typed, deleted } = typedUpdates();
    const typedVerdict = await host.inspect('update', typed);
    assert.deepEqual(typedVerdict, expected(inspectUpdate(typed)));
    assert.equal(typedVerdict.ok, true);
    assert.ok(typedVerdict.ok && typedVerdict.structs >= 1);

    const deletedVerdict = await host.inspect('update', deleted);
    assert.deepEqual(deletedVerdict, expected(inspectUpdate(deleted)));
    assert.ok(deletedVerdict.ok && deletedVerdict.deletes >= 1);

    const fold = createFoldDoc();
    assert.equal(applyUpdate(fold, typed), true);
    assert.equal(applyUpdate(fold, deleted), true);
    const state = encodeFullState(fold);
    assert.deepEqual(await host.inspect('state', state), expected(inspectState(state)));

    const snapshot = snapshotOf(fold);
    const snapshotVerdict = await host.inspect('snapshot', snapshot);
    assert.deepEqual(snapshotVerdict, { ok: true, structs: 0, deletes: 1, clients: 1 });
  });
});

test('the worker refuses what the in-process checks refuse, with the same reason', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const embed = embedUpdate(77);
    assert.deepEqual(await host.inspect('update', embed), expected(inspectUpdate(embed)));
    assert.deepEqual(await host.inspect('update', embed), { ok: false, error: 'forbidden-content' });
    assert.deepEqual(await host.inspect('update', Uint8Array.of(1, 2, 3)), { ok: false, error: 'malformed' });
    assert.deepEqual(await host.inspect('snapshot', Uint8Array.of(0, 0, 9)), { ok: false, error: 'malformed' });
    assert.deepEqual(await host.inspect('snapshot', new Uint8Array(0)), { ok: false, error: 'malformed' });
    // A kind the worker does not know is damage, not a crash.
    assert.deepEqual(await host.inspect('blob' as never, Uint8Array.of(0, 0)), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('two jobs in a row, and jobs asked at once, reuse one worker and are answered in order', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const { typed, deleted } = typedUpdates();
    assert.equal((await host.inspect('update', typed)).ok, true);
    assert.equal((await host.inspect('update', deleted)).ok, true);
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);

    const answers = await Promise.all([host.inspect('update', typed), host.inspect('update', Uint8Array.of(9)), host.inspect('update', deleted)]);
    assert.deepEqual(answers, [expected(inspectUpdate(typed)), { ok: false, error: 'malformed' }, expected(inspectUpdate(deleted))]);
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('a 4 MB 2,000,000-GC-struct probe and a 120,000-struct probe are refused too-large in the worker, which stays usable', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const huge = gcProbe(2_000_000);
    assert.ok(huge.length > 4_000_000);
    assert.deepEqual(await host.inspect('update', huge), { ok: false, error: 'too-large' });
    assert.deepEqual(await host.inspect('state', huge), { ok: false, error: 'too-large' });
    const many = gcProbe(120_000);
    assert.ok(many.length < 256 * 1024, 'under the byte limit, so the struct count is what refuses it');
    assert.deepEqual(await host.inspect('update', many), { ok: false, error: 'too-large' });
    assert.deepEqual(await host.inspect('state', many), { ok: false, error: 'too-large' });

    const { typed } = typedUpdates();
    assert.deepEqual(await host.inspect('update', typed), expected(inspectUpdate(typed)));
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('close() ends the worker and a later inspect starts a new one', async () => {
  const host = new DecodeHost();
  const { typed } = typedUpdates();
  assert.equal(host.starts, 0, 'the worker starts lazily, on the first job');
  assert.equal((await host.inspect('update', typed)).ok, true);
  await host.close();
  assert.equal(host.starts, 1);
  await host.close();
  assert.equal((await host.inspect('update', typed)).ok, true);
  assert.equal(host.starts, 2);
  assert.equal(host.restarts, 0, 'closing is not a failure');
  // close() waits for a job already asked rather than cutting it off.
  const inFlight = host.inspect('update', typed);
  await host.close();
  assert.equal((await inFlight).ok, true);
  assert.equal(host.restarts, 0);
});

// ---- Task 2: out of memory, timeouts and other failures cost a restart, never the host -----------------------------------------------------------

// A forced collection, so heap numbers are not dominated by garbage still waiting (the pattern in scripts/crdt-spike.mjs).
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;

function settledHeap(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const HOG = path.join(__dirname, 'helpers', 'decodeWorkerHog.js');
const HOG_OOM = Uint8Array.of(1);
const HOG_HANG = Uint8Array.of(2);
const HOG_THROW = Uint8Array.of(3);
const HOG_EXIT = Uint8Array.of(4);
const HOG_BAD_REPLY = Uint8Array.of(5);
const HOG_HEAP_LIMIT = Uint8Array.of(6);
const HOG_OK = Uint8Array.of(0);
const HOG_OK_VERDICT: DecodeVerdict = { ok: true, structs: 0, deletes: 0, clients: 0 };
// Small limits keep the hog cheap: it reaches 16 MB of old generation in well under a second.
const SMALL = { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 };

test('a worker that runs out of memory gives too-large, is restarted, and the test process heap barely moves', async () => {
  await withHost(new DecodeHost({ workerFile: HOG, limits: SMALL }), async (host) => {
    assert.deepEqual(await host.inspect('update', HOG_OK), HOG_OK_VERDICT);
    // Whichever control stops it (resourceLimits, or the host's heap watch where the process flags override resourceLimits), the answer is the same.
    const limit = await host.inspect('update', HOG_HEAP_LIMIT);
    assert.ok(limit.ok && limit.structs > 0);
    const before = settledHeap();
    assert.deepEqual(await host.inspect('update', HOG_OOM), { ok: false, error: 'too-large' });
    const grew = settledHeap() - before;
    assert.ok(grew < 64 * MB, `the test process heap grew ${Math.round(grew / MB)} MB`);
    assert.equal(host.restarts, 1);
    assert.equal(host.lastFailure, 'out-of-memory');
    assert.equal(host.starts, 1, 'the next worker starts lazily');
    // The next job runs on a new worker.
    assert.deepEqual(await host.inspect('update', HOG_OK), HOG_OK_VERDICT);
    assert.equal(host.starts, 2);
    assert.equal(host.restarts, 1);
  });
});

test('a job that hangs past the time limit gives too-large, and the worker is stopped and restarted', async () => {
  await withHost(new DecodeHost({ workerFile: HOG, limits: { ...SMALL, timeoutMs: 300 } }), async (host) => {
    const started = Date.now();
    assert.deepEqual(await host.inspect('update', HOG_HANG), { ok: false, error: 'too-large' });
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 4000, `the hung job was ended after ${took} ms`);
    assert.equal(host.restarts, 1);
    assert.equal(host.lastFailure, 'timeout');
    // A job asked while the hung one was running waits its turn and then gets a fresh worker.
    const [hung, next] = await Promise.all([host.inspect('update', HOG_HANG), host.inspect('update', HOG_OK)]);
    assert.deepEqual(hung, { ok: false, error: 'too-large' });
    assert.deepEqual(next, HOG_OK_VERDICT);
    assert.equal(host.restarts, 2);
    assert.equal(host.starts, 3);
  });
});

test('any other worker failure gives malformed and a restart: an uncaught error, an exit, an unreadable reply', async () => {
  await withHost(new DecodeHost({ workerFile: HOG, limits: SMALL }), async (host) => {
    assert.equal(host.lastFailure, undefined);
    assert.deepEqual(await host.inspect('update', HOG_THROW), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 1);
    assert.equal(host.lastFailure, 'crashed');
    assert.deepEqual(await host.inspect('update', HOG_EXIT), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 2);
    assert.deepEqual(await host.inspect('update', HOG_BAD_REPLY), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 3);
    assert.equal(host.lastFailure, 'crashed');
    assert.deepEqual(await host.inspect('update', HOG_OK), HOG_OK_VERDICT);
    assert.equal(host.restarts, 3);
    assert.equal(host.starts, 4);
  });
});

test('a worker file that cannot be loaded gives malformed for each job and never throws', async () => {
  await withHost(new DecodeHost({ workerFile: path.join(__dirname, 'helpers', 'no-such-decode-worker.js') }), async (host) => {
    assert.deepEqual(await host.inspect('update', HOG_OK), { ok: false, error: 'malformed' });
    assert.deepEqual(await host.inspect('update', HOG_OK), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 2);
  });
});

test('the real worker out of memory on an accepted 100,000-item state gives too-large, and its next job succeeds', async () => {
  const items = textItemsProbe(100_000);
  // In process, the full limits accept it: it is honest and within every cap, only large.
  assert.deepEqual(expected(inspectState(items)), { ok: true, structs: 100_000, deletes: 0, clients: 1 });
  await withHost(new DecodeHost({ limits: SMALL }), async (host) => {
    const before = settledHeap();
    assert.deepEqual(await host.inspect('state', items), { ok: false, error: 'too-large' });
    assert.ok(settledHeap() - before < 64 * MB);
    assert.equal(host.restarts, 1);
    assert.equal(host.lastFailure, 'out-of-memory');
    const { typed } = typedUpdates();
    assert.deepEqual(await host.inspect('update', typed), expected(inspectUpdate(typed)));
    assert.equal(host.restarts, 1);
    assert.equal(host.starts, 2);
  });
  // With the shipped limits the same state passes in the worker.
  await withHost(new DecodeHost(), async (host) => {
    assert.deepEqual(await host.inspect('state', items), { ok: true, structs: 100_000, deletes: 0, clients: 1 });
    assert.equal(host.restarts, 0);
  });
});

// A process started with --max-old-space-size gives every worker that heap limit, whatever resourceLimits says (V8 flags win over a worker's
// constraints). The host's own heap watch must still stop the worker at the cap. Run in a child process so the flag is certainly set.
test('the heap cap holds even when the process was started with --max-old-space-size', () => {
  const host = path.join(__dirname, '..', 'staff', 'replica', 'decodeHost.js');
  const script = [
    `const { DecodeHost } = require(${JSON.stringify(host)});`,
    '(async () => {',
    `  const hog = new DecodeHost({ workerFile: ${JSON.stringify(HOG)}, limits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 } });`,
    '  const limit = await hog.inspect("update", Uint8Array.of(6));',
    '  const verdict = await hog.inspect("update", Uint8Array.of(1));',
    // maxRSS is in kilobytes: the peak memory of the whole child, worker included.
    '  console.log(JSON.stringify({ limit, verdict, failure: hog.lastFailure, restarts: hog.restarts, peakMb: process.resourceUsage().maxRSS / 1024 }));',
    '  await hog.close();',
    '})();'
  ].join('\n');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ['--max-old-space-size=512', '-e', script], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim()) as { limit: DecodeVerdict; verdict: DecodeVerdict; failure: string; restarts: number; peakMb: number };
  assert.ok(result.limit.ok && result.limit.structs >= 400, `the worker's heap limit was ${JSON.stringify(result.limit)}: resourceLimits was not overridden`);
  assert.deepEqual(result.verdict, { ok: false, error: 'too-large' });
  assert.equal(result.failure, 'out-of-memory', 'stopped by the heap watch, not by the time limit');
  assert.equal(result.restarts, 1);
  // Without the heap watch the worker would grow to the process limit (512 MB) before V8 stopped it.
  assert.ok(result.peakMb < 300, `the child peaked at ${Math.round(result.peakMb)} MB`);
});

test('after a hog fails, a host with the real worker still inspects an honest update', async () => {
  await withHost(new DecodeHost({ workerFile: HOG, limits: { ...SMALL, timeoutMs: 300 } }), async (hog) => {
    assert.deepEqual(await hog.inspect('update', HOG_OOM), { ok: false, error: 'too-large' });
    assert.deepEqual(await hog.inspect('update', HOG_HANG), { ok: false, error: 'too-large' });
  });
  await withHost(new DecodeHost(), async (host) => {
    const { typed } = typedUpdates();
    assert.deepEqual(await host.inspect('update', typed), expected(inspectUpdate(typed)));
  });
});

// ---- Boundary: nothing under src/staff/replica reaches the editor API (D-06) ------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STAFF_REPLICA = path.join(REPO_ROOT, 'src', 'staff', 'replica');

// Every static import or re-export, side-effect import, dynamic import() and require() of the editor API module, as "line: text".
const EDITOR_API_FORMS = [
  /^[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?[^;'"]*?\bfrom[ \t]*['"]vscode['"]/gm,
  /^[ \t]*import[ \t]*['"]vscode['"]/gm,
  /(?:^|[^\w.$])(?:import|require)[ \t]*\([ \t]*['"]vscode['"]/gm
];

function editorApiImports(text: string): number[] {
  const lines: number[] = [];
  for (const form of EDITOR_API_FORMS) {
    for (const match of text.matchAll(form)) lines.push(text.slice(0, match.index ?? 0).split('\n').length);
  }
  return lines.sort((a, b) => a - b);
}

function tsFilesUnder(folder: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

test('the editor API scan finds every import form and ignores the words in a comment', () => {
  const planted = [
    "import * as vscode from 'vscode';",
    "import type { Uri } from \"vscode\";",
    "export { window } from 'vscode';",
    "import 'vscode';",
    "const api = require('vscode');",
    "const lazy = await import('vscode');",
    "// this file never imports vscode, see import { x } from 'vscode' in an old version",
    "import * as path from 'node:path';"
  ].join('\n');
  assert.deepEqual(editorApiImports(planted), [1, 2, 3, 4, 5, 6]);
});

test('no file under src/staff/replica imports the editor API', () => {
  const files = tsFilesUnder(STAFF_REPLICA);
  assert.ok(files.some((file) => file.endsWith('decodeWorker.ts')) && files.some((file) => file.endsWith('decodeHost.ts')), 'the scan sees the worker files');
  const problems = files.flatMap((file) => editorApiImports(readFileSync(file, 'utf8')).map((line) => `${path.relative(REPO_ROOT, file)}:${line}`));
  assert.deepEqual(problems, []);
});

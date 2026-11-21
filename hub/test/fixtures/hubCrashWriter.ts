// Copied from relay/test/fixtures/crashWriter.ts and adapted for the hub (D-26, D-28).
import { entryHash, sha256Hex, type EntryHeader } from '@ext/domain/replica/entry';
import { canonicalize } from '@ext/domain/team/canonical';
import { openHubStore } from '../../src/store/hubStore';

// Child process of the hub's kill -9 drill (test/killDrill.test.ts). Each step N puts one sealed blob and then appends a batch of three entries
// of one writer that reference it, through the real store module, and prints `ack N` only after both returned, which is after both COMMITs.
//
// The child never runs more than one step ahead of the parent: it needs one line on stdin (a permit) before it starts each step, and it starts
// with one permit. The parent answers every `ack N` with a permit and kills the child right after the permit that follows the kill point, so the
// child can be anywhere inside step N + 1 (before the blob, inside its file write, between the file and its row, between the blob and the batch,
// inside the batch, after COMMIT but before printing) but never further.
//
// What a step writes is a pure function of N (drillBlob, drillRows), and the drill computes the same values to check what survived. The two
// copies are kept side by side on purpose: the drill must not import this file, whose top level is the writer itself.

const DRILL_PROJECT = sha256Hex(Buffer.from('fictional drill project')).slice(0, 32);
const DRILL_WRITER = sha256Hex(Buffer.from('fictional drill device'));
const SIG = Buffer.alloc(64, 5).toString('base64url');
const BLOB_BYTES = 32 * 1024;

function drillBlob(step: number): { hash: string; bytes: Buffer } {
  const bytes = Buffer.alloc(BLOB_BYTES, `drill blob ${step};`);
  return { hash: sha256Hex(bytes), bytes };
}

function drillRows(step: number, prev: string): Array<{ header: string; body: string; receivedAt: number; hash: string }> {
  const rows = [];
  for (let seq = 3 * (step - 1); seq < 3 * step; seq += 1) {
    const wire = Buffer.from(`drill entry ${seq}`.padEnd(48, '.'));
    const header: EntryHeader = {
      v: 2,
      stream: DRILL_PROJECT,
      writer: DRILL_WRITER,
      seq,
      prev,
      epoch: 1,
      body: { hash: sha256Hex(wire), size: wire.length },
      sig: SIG,
    };
    const hash = entryHash(header);
    rows.push({ header: canonicalize(header), body: wire.toString('base64url'), receivedAt: 1_800_000_000_000 + seq, hash });
    prev = hash;
  }
  return rows;
}

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: hubCrashWriter <state directory>\n');
  process.exit(2);
}

let permits = 1;
let wake: (() => void) | undefined;
process.stdin.on('data', (chunk: Buffer) => {
  for (const byte of chunk) if (byte === 0x0a) permits += 1;
  wake?.();
});

async function takePermit(): Promise<void> {
  while (permits === 0) {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  permits -= 1;
}

const store = await openHubStore(dir);
store.createProject({ project: DRILL_PROJECT, genesisHash: sha256Hex(Buffer.from('fictional drill genesis')), anchor: canonicalize({ lead: 'fictional lead' }), enrolment: 'enr-00000000000000d1', at: 1_800_000_000_000 });

let prev = '0'.repeat(64);
for (let step = 1; ; step += 1) {
  await takePermit();
  const blob = drillBlob(step);
  await store.putBlob(DRILL_PROJECT, blob.hash, blob.bytes, DRILL_WRITER, 1_800_000_000_000 + step);
  const rows = drillRows(step, prev);
  store.commitAppend(DRILL_PROJECT, {
    entries: rows.map(({ header, body, receivedAt }) => ({ header, body, receivedAt })),
    blobRefs: rows.map((row) => ({ entry: row.hash, blob: blob.hash, stream: DRILL_PROJECT })),
    at: 1_800_000_000_000 + step,
  });
  prev = rows[rows.length - 1]!.hash;
  process.stdout.write(`ack ${step}\n`);
}

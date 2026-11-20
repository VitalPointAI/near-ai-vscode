// Test only: a stand-in for src/staff/replica/decodeWorker.ts that misbehaves on request, so staffReplicaWorker.test.ts can show what the decode
// host does when its worker runs out of memory, hangs, throws or exits. Production code never references this file.
//
// It speaks the decode worker's protocol ({ id, kind, bytes } in, { id, ok, ... } out). The first byte of the job says what to do:
//   1 allocate until the worker's heap limit is reached
//   2 hang in a busy loop, so only the host's time limit ends the job
//   3 throw an uncaught error
//   4 exit with code 3
//   5 answer with a reply the host cannot read
//   6 answer ok with this worker's heap limit in megabytes as its struct count, so a test can see whether resourceLimits took effect
//   anything else: answer ok with zero counts
import * as v8 from 'node:v8';
import { parentPort } from 'node:worker_threads';

const port = parentPort;
if (port !== null) {
  port.on('message', (job: { id: number; bytes: Uint8Array }) => {
    const mode = job.bytes[0];
    if (mode === 1) {
      const hoard: unknown[][] = [];
      for (;;) hoard.push(Array.from({ length: 1024 }, (_, index) => ({ index, hoard: hoard.length })));
    }
    if (mode === 2) {
      for (;;) { /* busy: only terminate() ends this */ }
    }
    if (mode === 3) throw new Error('the hog was asked to throw');
    if (mode === 4) process.exit(3);
    if (mode === 5) {
      port.postMessage({ id: job.id, ok: true, structs: -1 });
      return;
    }
    if (mode === 6) {
      port.postMessage({ id: job.id, ok: true, structs: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)), deletes: 0, clients: 0 });
      return;
    }
    port.postMessage({ id: job.id, ok: true, structs: 0, deletes: 0, clients: 0 });
  });
}

// Test only: a stand-in for src/staff/replica/decodeWorker.ts that misbehaves on request, so staffReplicaWorker.test.ts can show what the decode
// host does when its child process runs out of memory, hangs, throws or exits. Production code never references this file.
//
// It speaks the decode worker's protocol over the process's job channel ({ id, kind, bytes } in, { id, ok, ... } out). The first byte of the job
// says what to do:
//   1 allocate in a loop until the process's heap limit is reached
//   9 allocate 512 MB in one synchronous step, then answer ok with the length as its struct count
//   2 hang in a busy loop, so only the host's time limit ends the job
//   3 throw an uncaught error
//   4 exit with code 3
//   5 answer with a reply the host cannot read
//   7 answer ok under another job's id
//   8 answer with a bare string instead of a reply object
//   6 answer ok with this process's V8 heap limit in megabytes as its struct count, so a test can see which limit took effect
//   anything else: answer ok with zero counts
import * as v8 from 'node:v8';

const send = (reply: unknown): void => {
  process.send?.(reply);
};

if (require.main === module && typeof process.send === 'function') {
  process.on('message', (job: { id: number; bytes: Uint8Array }) => {
    const mode = job.bytes[0];
    if (mode === 1) {
      const hoard: unknown[][] = [];
      for (;;) hoard.push(Array.from({ length: 1024 }, (_, index) => ({ index, hoard: hoard.length })));
    }
    if (mode === 9) {
      const big = new Array(64 * 1024 * 1024).fill(1.5);
      send({ id: job.id, ok: true, structs: big.length, deletes: 0, clients: 0 });
      return;
    }
    if (mode === 2) {
      for (;;) { /* busy: only SIGKILL ends this */ }
    }
    if (mode === 3) throw new Error('the hog was asked to throw');
    if (mode === 4) process.exit(3);
    if (mode === 5) {
      send({ id: job.id, ok: true, structs: -1 });
      return;
    }
    if (mode === 7) {
      send({ id: job.id + 1000, ok: true, structs: 0, deletes: 0, clients: 0 });
      return;
    }
    if (mode === 8) {
      send('done');
      return;
    }
    if (mode === 6) {
      send({ id: job.id, ok: true, structs: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)), deletes: 0, clients: 0 });
      return;
    }
    send({ id: job.id, ok: true, structs: 0, deletes: 0, clients: 0 });
  });
}

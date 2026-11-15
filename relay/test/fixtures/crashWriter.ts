import { openSqliteStore } from '../../src/store/sqliteStore';

// Child process of the kill -9 drill. It accepts inbound messages one after another and prints `ack N` only after acceptInbound resolved,
// which is after the transaction committed.
//
// The child never runs more than one message ahead of the parent: it needs one line on stdin (a permit) before it starts each message, and it
// starts with one permit. The parent answers every `ack N` with a permit and kills the child right after the permit that follows the kill
// point, so the child can be anywhere inside message N + 1 (before its transaction, inside it, after COMMIT but before printing `ack N + 1`)
// but never further. Without the permits a fast child would commit hundreds of messages while the parent was still reading the first acks.

//
// With the mode `in-flight` it instead leaves one run running and one waiting for an approval, prints `ready`, and waits to be killed.

const file = process.argv[2];
const mode = process.argv[3] ?? 'accept';
if (!file || (mode !== 'accept' && mode !== 'in-flight')) {
  process.stderr.write('usage: crashWriter <database file> [accept|in-flight]\n');
  process.exit(2);
}

let permits = 1;
let wake: (() => void) | undefined;
process.stdin.on('data', (chunk: Buffer) => {
  for (const byte of chunk) if (byte === 0x0a) permits += 1;
  wake?.();
});

async function takePermit(): Promise<void> {
  while (permits === 0) await new Promise<void>((resolve) => { wake = resolve; });
  permits -= 1;
}

const store = await openSqliteStore(file);
const now = Date.now();
await store.putTenant({ tenantId: 'drill', displayName: 'Drill', status: 'active', createdAt: now, updatedAt: now });

if (mode === 'in-flight') {
  for (const [n, conversationId] of [[1, 'c1'], [2, 'c2']] as const) {
    await store.acceptInbound(
      { tenantId: 'drill', channel: 'teams', conversationId, requesterId: 'r1', dedupeKey: `msg-${n}`, payload: `body ${n}`, receivedAt: now },
      `run-${n}`,
    );
    await store.claimNext('drill', 'teams', conversationId, now + 1);
    await store.transitionRun('drill', `run-${n}`, 'queued', 'running', now + 2);
  }
  await store.transitionRun('drill', 'run-2', 'running', 'waiting-approval', now + 3);
  await store.addApproval({
    tenantId: 'drill',
    approvalId: 'ap-1',
    runId: 'run-2',
    requesterId: 'r1',
    callId: 'call-1',
    tool: 'run_command',
    title: 'Run npm test',
    createdAt: now + 3,
    expiresAt: now + 3_600_000,
  });
  process.stdout.write('ready\n');
  setInterval(() => undefined, 60_000); // keep running until the parent kills this process
} else {
  for (let n = 1; ; n += 1) {
    await takePermit();
    await store.acceptInbound(
      {
        tenantId: 'drill',
        channel: 'teams',
        conversationId: 'c1',
        requesterId: 'r1',
        dedupeKey: `msg-${n}`,
        payload: `body ${n}`,
        receivedAt: Date.now(),
      },
      `run-${n}`,
    );
    process.stdout.write(`ack ${n}\n`);
  }
}

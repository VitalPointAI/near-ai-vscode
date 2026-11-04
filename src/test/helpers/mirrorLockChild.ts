// Fork target for the shared-mirror tests: a second process that takes a coordination mirror's lock and holds it until the parent says release
// (or kills it, to leave the lock of a process that crashed). The file has no .test suffix on purpose so the test glob does not run it as a suite,
// and it only starts when it is the entry point of a forked process.
import { acquireMirrorLock } from '../../team/mirrorProcessLock';

export type LockChildMessage = { type: 'held' } | { type: 'released' } | { type: 'error'; message: string };

function send(message: LockChildMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, () => { resolve(); });
  });
}

async function main(mirrorDir: string): Promise<void> {
  const held = await acquireMirrorLock(mirrorDir, { sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }), random: Math.random });
  process.on('message', (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type !== 'release') return;
    held.release().then(async () => {
      await send({ type: 'released' });
      process.exit(0);
    }, async (error: unknown) => {
      await send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
  });
  await send({ type: 'held' });
}

if (require.main === module) {
  main(process.argv[2] ?? '').catch(async (error: unknown) => {
    await send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}

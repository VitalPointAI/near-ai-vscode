// Fork target for the two-window bundle race test: a second process that runs ensurePolicyBundle on the same global storage folder and the same secret
// store (a JSON file shared through FileSecrets, standing in for one SecretStorage). It reports the state, the hash and the event over IPC. The file has no
// .test suffix on purpose so the test glob does not run it as a suite, and it only starts when it is the entry point of a forked process.
import { ensurePolicyBundle } from '../../gate/bundleStore';
import { FileSecrets } from './keyHistoryChild';

export interface GateBundleChildStart { type: 'start'; globalStorageDir: string; secretsFile: string; now: number }
export type GateBundleChildReply =
  | { type: 'ready' }
  | { type: 'done'; ok: boolean; state: string; hash: string; event: string; message: string };

function send(message: GateBundleChildReply): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, () => { resolve(); });
  });
}

function main(): void {
  let start: GateBundleChildStart | undefined;
  process.on('message', (message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'start') {
      start = message as GateBundleChildStart;
      void send({ type: 'ready' });
      return;
    }
    if (type !== 'go' || start === undefined) return;
    const { globalStorageDir, secretsFile, now } = start;
    ensurePolicyBundle(globalStorageDir, new FileSecrets(secretsFile), { now: () => new Date(now) }).then(
      async (result) => {
        await send({
          type: 'done', ok: true, state: result.state.state, hash: result.state.state === 'valid' ? result.state.hash : '', event: result.event ?? '', message: ''
        });
        process.exit(0);
      },
      async (error: unknown) => {
        await send({ type: 'done', ok: false, state: '', hash: '', event: '', message: error instanceof Error ? error.message : String(error) });
        process.exit(0);
      }
    );
  });
}

if (require.main === module) main();

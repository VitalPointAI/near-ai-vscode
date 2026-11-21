// Fork target for the Start Again crash tests (32-01, D-03): a second process that runs Start Again on one project and is killed with SIGKILL right
// after a named step, the way a crash or a power cut stops it. Secret storage is the JSON file the test process also reads (FileSecrets), standing in
// for the editor's secret storage. The file has no .test suffix on purpose so the test glob does not run it as a suite, and it only starts when it is
// the entry point of a forked process.
//
// Arguments: <store|project> <project root> <secrets file> <signer label (store) | global storage folder (project)> [step]
// With a step it never answers: it is killed there. Without one it sends { type: 'done', result } when Start Again returns.
import { ReplicaProject } from '../../staff/replica/replicaProject';
import { ReplicaStore, START_AGAIN_STEPS, setStartAgainProbe } from '../../staff/replica/store';
import type { StartAgainStep } from '../../staff/replica/store';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { FileSecrets } from './replicaStoreChild';
import { fixedSigner } from './replicaWorld';

export type CrashChildMessage = { type: 'done'; result: unknown } | { type: 'error'; message: string };

/** The time every Start Again in these tests runs at, so the folder set aside has a known name. */
export const CRASH_CHILD_NOW = '2026-11-20T10:00:00.000Z';

const ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

function send(message: CrashChildMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) { resolve(); return; }
    process.send(message, () => { resolve(); });
  });
}

async function main(mode: string, root: string, secretsFile: string, who: string, step: string | undefined): Promise<void> {
  if (step !== undefined && !(START_AGAIN_STEPS as readonly string[]).includes(step)) throw new Error(`no such step: ${step}`);
  setStartAgainProbe((reached: StartAgainStep) => {
    if (reached === step) process.kill(process.pid, 'SIGKILL');
  });
  const secrets = new FileSecrets(secretsFile);
  const now = (): Date => new Date(CRASH_CHILD_NOW);
  let result: unknown;
  if (mode === 'store') {
    const device = fixedSigner(who);
    result = await ReplicaStore.startAgain(root, { secrets, signer: () => Promise.resolve(device.signer), keyStatus: () => Promise.resolve(ACTIVE), now });
  } else if (mode === 'project') {
    result = await ReplicaProject.startHistoryAgain(root, { secrets, globalStorageDir: who, now });
  } else {
    throw new Error(`no such mode: ${mode}`);
  }
  await send({ type: 'done', result });
  process.exit(0);
}

if (require.main === module) {
  const [mode, root, secretsFile, who, step] = process.argv.slice(2);
  main(mode ?? '', root ?? '', secretsFile ?? '', who ?? '', step === '' ? undefined : step).catch(async (error: unknown) => {
    await send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}

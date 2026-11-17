// Fork target for the two-writer label map test: a second process that sets one entry of a project's label map through updateLabelMap, on the same
// global storage folder and the same secret store (a JSON file shared through FileSecrets, standing in for one SecretStorage). It reports over IPC. The
// file has no .test suffix on purpose so the test glob does not run it as a suite, and it only starts when it is the entry point of a forked process.
import { SHIPPED_DEFAULT_LABEL } from '../../domain/gate/bundle';
import { setLabelEntry } from '../../domain/gate/labelMap';
import { SCALE_PRESETS } from '../../domain/gate/labels';
import type { Label } from '../../domain/gate/labels';
import { updateLabelMap } from '../../gate/labelMapStore';
import { FileSecrets } from './keyHistoryChild';

export interface LabelChildStart { type: 'start'; globalStorageDir: string; secretsFile: string; root: string; key: string; label: Label }
export type LabelChildReply = { type: 'ready' } | { type: 'done'; ok: boolean; message: string };

function send(message: LabelChildReply): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, () => { resolve(); });
  });
}

function main(): void {
  let start: LabelChildStart | undefined;
  process.on('message', (message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'start') {
      start = message as LabelChildStart;
      void send({ type: 'ready' });
      return;
    }
    if (type !== 'go' || start === undefined) return;
    const { globalStorageDir, secretsFile, root, key, label } = start;
    updateLabelMap(root, (map) => setLabelEntry(map, key, label), {
      globalStorageDir, secrets: new FileSecrets(secretsFile), scales: SCALE_PRESETS, defaultLabel: SHIPPED_DEFAULT_LABEL
    }).then(
      async () => { await send({ type: 'done', ok: true, message: '' }); process.exit(0); },
      async (error: unknown) => { await send({ type: 'done', ok: false, message: error instanceof Error ? error.message : String(error) }); process.exit(0); }
    );
  });
}

if (require.main === module) main();

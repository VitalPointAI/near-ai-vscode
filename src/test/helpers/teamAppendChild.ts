// Fork target for the concurrency tests: one Node process acting as one team client with its own device key.
// It waits for the parent to bind that key to the owner, appends availability events through TeamLog and reports over IPC.
// The file has no .test suffix on purpose so the test glob does not run it as a suite, and the main handler only starts when
// the file is the entry point of a forked process, so importing its types from a test has no side effects.
import type { GenesisAnchor } from '../../domain/team/types';
import { teamMaterializer } from '../../domain/team/materialize';
import type { TeamState } from '../../domain/team/types';
import { TeamLog } from '../../team/eventLog';
import type { EventIntent } from '../../team/eventLog';
import { GitTransport } from '../../team/gitTransport';
import { createDeviceIdentity } from '../../team/identity';
import { MemorySecrets } from './teamHarness';

export type ParentMessage =
  | { type: 'init'; projectRoot: string; mirrorDir: string; pinFile: string; remote: string; ref: string; anchor: GenesisAnchor; ownerId: string; each: number; maxRetries: number; baseDelayMs: number }
  | { type: 'go' };
export type ChildMessage =
  | { type: 'ready'; fingerprint: string; publicKey: string }
  | { type: 'done'; results: Array<{ ok: boolean; kind?: string; attempts: number }> }
  | { type: 'error'; message: string };

function isParentMessage(value: unknown): value is ParentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'init' || type === 'go';
}

function sendToParent(message: ChildMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('This helper must be started with child_process.fork.'));
      return;
    }
    process.send(message, (error: Error | null) => { if (error === null) resolve(); else reject(error); });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runChild(): Promise<void> {
  let ready: { log: TeamLog; each: number } | undefined;

  const handle = async (message: ParentMessage): Promise<void> => {
    if (message.type === 'init') {
      const secrets = new MemorySecrets();
      // The private key stays in this process; only the public half goes to the parent.
      const identity = await createDeviceIdentity(secrets, message.anchor.teamId);
      const transport = new GitTransport<TeamState>({
        mirrorDir: message.mirrorDir,
        projectRoot: message.projectRoot,
        remote: message.remote,
        ref: message.ref,
        materializer: teamMaterializer(message.anchor),
        pinFile: message.pinFile,
        maxRetries: message.maxRetries,
        baseDelayMs: message.baseDelayMs
      });
      const log = new TeamLog({ anchor: message.anchor, transport, signer: { identity, memberId: message.ownerId } });
      ready = { log, each: message.each };
      await sendToParent({ type: 'ready', fingerprint: identity.fingerprint, publicKey: identity.publicKey });
      return;
    }
    if (ready === undefined) throw new Error('The parent sent go before init.');
    const { log, each } = ready;
    const results: Array<{ ok: boolean; kind?: string; attempts: number }> = [];
    for (let index = 0; index < each; index += 1) {
      const intent: EventIntent = { type: 'member.availability', body: { availability: index % 2 === 0 ? 'available' : 'focus' } };
      const result = await log.append(() => [intent]);
      results.push(result.ok ? { ok: true, attempts: result.attempts } : { ok: false, kind: result.kind, attempts: result.attempts });
    }
    await sendToParent({ type: 'done', results });
    process.exit(0);
  };

  process.on('message', (message: unknown) => {
    if (!isParentMessage(message)) return;
    handle(message).catch(async (error: unknown) => {
      try {
        await sendToParent({ type: 'error', message: describe(error) });
      } finally {
        process.exit(1);
      }
    });
  });
}

if (require.main === module) {
  runChild().catch((error: unknown) => {
    process.stderr.write(`${describe(error)}\n`);
    process.exit(1);
  });
}

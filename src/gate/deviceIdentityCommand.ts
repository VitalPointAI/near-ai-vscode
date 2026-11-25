// Show This Computer's Identity (Phase 71, 71-10; VCRD-06). A single computer's did:key, from its Phase 69 device key unchanged, and the six words
// the person compares in their own session before they bind the computer to themselves (identity-service.ts bindComputer). Nothing secret is
// shown: the did:key is the public key, and the words are derived from it. No vscode import: gateCommands.ts registers the command and shows it.
import { didKeyFromDevice } from '../domain/did/didKey';
import { deviceIdentityWords } from '../domain/did/deviceWords';
import type { SecretStorageLike } from '../services/auth';
import { loadDeviceIdentity } from '../team/identity';

export const SHOW_DEVICE_IDENTITY_COMMAND = 'nearAi.identity.showThisComputer';
export const SHOW_DEVICE_IDENTITY_TITLE = 'Show This Computer\'s Identity';

export const DEVICE_IDENTITY_TEXT = {
  none: 'This computer has no identity yet. It gets one the first time it signs something, for example when you join a shared project.',
  copy: 'Copy Identity',
  copied: 'This computer\'s identity was copied. Paste it where you bind the computer, and compare the six words there.',
} as const;

export interface DeviceIdentityView {
  readonly didKey: string;
  readonly words: readonly string[];
  /** One sentence for the notification: the words to compare, then what to do. */
  readonly message: string;
}

/** The view of this computer's identity, or undefined when the computer has no device key yet (nothing is made here). */
export async function thisComputerIdentity(secrets: SecretStorageLike): Promise<DeviceIdentityView | undefined> {
  const identity = await loadDeviceIdentity(secrets);
  if (identity === undefined) return undefined;
  const didKey = didKeyFromDevice(identity.publicKey);
  const words = deviceIdentityWords(didKey);
  return { didKey, words, message: `This computer's six words: ${words.join(' ')}. Compare them when you bind this computer to yourself.` };
}

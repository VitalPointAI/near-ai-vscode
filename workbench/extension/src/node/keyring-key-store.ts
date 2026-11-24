import { injectable } from '@theia/core/shared/inversify';
import { KeyStoreServiceImpl } from '@theia/core/lib/node/key-store-server.js';
import { SECRET_STORE_TEXT } from '../common/secret-store.js';
import type { KeyringCandidate } from './key-stores.js';

type Keytar = typeof import('keytar');

/**
 * This computer's keyring for a non-container single-machine run (D-18, D-36; T-46-27; research Pattern 2 and C5). It is Theia's own
 * KeyStoreServiceImpl, so the chunking of long passwords on Windows is kept, with one change: Theia's getKeytar() catches any keytar load or
 * probe error and quietly switches to an in-memory provider, so secrets would vanish on restart. This override runs the same probe and,
 * when it fails, throws the keyring-failed sentence instead (with only the error's code as its cause). The workbench image does not build
 * keytar, so inside the image this always fails and the store is "unavailable".
 */
@injectable()
export class KeyringKeyStoreService extends KeyStoreServiceImpl implements KeyringCandidate {
  protected override async getKeytar(): Promise<Keytar> {
    if (this.keytarImplementation) return this.keytarImplementation;
    let keytar: Keytar;
    try {
      keytar = await this.loadKeytar();
      // Theia's own probe: a keytar that loads but cannot reach a keyring daemon throws here.
      await keytar.findCredentials('test-keytar-loads');
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      throw new Error(SECRET_STORE_TEXT.keyringFailed, { cause: { code: typeof code === 'string' ? code : undefined } });
    }
    this.keytarImplementation = keytar;
    return keytar;
  }

  /** Loads keytar; a test replaces this to stand in for a keyring that loads, or one that does not. */
  protected async loadKeytar(): Promise<Keytar> {
    return import('keytar');
  }

  /** Resolves when the keyring loads and answers; rejects with the keyring-failed sentence otherwise. */
  async probe(): Promise<void> {
    await this.getKeytar();
  }
}

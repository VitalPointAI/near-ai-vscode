import { ContainerModule, inject, injectable, type interfaces } from '@theia/core/shared/inversify';
import { KeyStoreService } from '@theia/core/lib/common/key-store.js';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { SECRET_STORE_PATH, SecretStoreService, type SecretStoreStatus } from '../common/secret-store.js';
import { bindBackendService } from './backend-service.js';
import { readHostingConfig } from './hosting-config.js';
import { chooseKeyStore, createDelegatingKeyStore, type KeyringCandidate, type KeyStoreChoice } from './key-stores.js';
import { KeyringKeyStoreService } from './keyring-key-store.js';
import { SessionIdentity } from './session-identity.js';

/**
 * Theia's KeyStoreService, rebound (D-17, D-18, D-36, D-37; research Pattern 2). Core binds KeyStoreServiceImpl, whose keyring loader falls
 * back to memory, and resolves it lazily for its RPC handler, so this rebind is what VSIX SecretStorage (through CredentialsService) and the
 * @theia/ai-mcp OAuth store reach. The store is chosen once, when the backend starts: OpenBao in hosted mode, otherwise this computer's
 * keyring if it loads and answers, otherwise unavailable. A call that arrives before the choice waits for it. The browser can ask which
 * store was chosen through /services/sterling-secret-store, so it can say "Secrets are unavailable" at start (46-07 planning choice 3).
 */
const KeyStoreChooser = Symbol('KeyStoreChooser');

interface Chooser {
  choice(): Promise<KeyStoreChoice>;
}

export interface KeyStoreModuleOptions {
  /** The settings to read; default process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Makes the keyring store; default Theia's KeyStoreServiceImpl with the memory fallback removed. */
  readonly keyring?: () => KeyringCandidate;
  /** One line naming the chosen store kind, never a value. Default console.info. */
  readonly log?: (line: string) => void;
}

/** Asks for the choice while the backend initializes, so the first secret call does not pay for it and the log says what was chosen. */
@injectable()
class KeyStoreChoiceContribution implements BackendApplicationContribution {
  @inject(KeyStoreChooser) protected readonly chooser!: Chooser;

  initialize(): void {
    void this.chooser.choice();
  }
}

export function createKeyStoreModule(options: KeyStoreModuleOptions = {}): ContainerModule {
  const log = options.log ?? ((line: string) => console.info(line));
  return new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(KeyStoreChooser).toDynamicValue((context: interfaces.Context): Chooser => {
      let chosen: Promise<KeyStoreChoice> | undefined;
      return {
        choice() {
          chosen ??= (async () => {
            // The session identity reads the same settings first; an invalid one has already stopped the backend there.
            const identity = context.container.get<SessionIdentity>(SessionIdentity);
            const config = readHostingConfig(options.env ?? process.env);
            const made = await chooseKeyStore(config, { identity, keyring: options.keyring ?? (() => new KeyringKeyStoreService()) });
            log(`Sterling secret store: ${made.kind}`);
            return made;
          })();
          return chosen;
        },
      };
    }).inSingletonScope();
    rebind(KeyStoreService).toDynamicValue((context) => {
      const chooser = context.container.get<Chooser>(KeyStoreChooser);
      return createDelegatingKeyStore(() => chooser.choice());
    }).inSingletonScope();
    bind(KeyStoreChoiceContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(KeyStoreChoiceContribution);
    bindBackendService<SecretStoreService>(bind, SecretStoreService, SECRET_STORE_PATH, (context) => {
      const chooser = context.container.get<Chooser>(KeyStoreChooser);
      return {
        status: async (): Promise<SecretStoreStatus> => {
          const made = await chooser.choice();
          return made.reason === undefined ? { store: made.kind } : { store: made.kind, reason: made.reason };
        },
      };
    });
  });
}

export default createKeyStoreModule();

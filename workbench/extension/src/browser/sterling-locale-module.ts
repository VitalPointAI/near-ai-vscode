import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { type Disposable } from '@theia/core/lib/common/disposable.js';
import { PreferenceProviderProvider, PreferenceService } from '@theia/core/lib/common/preferences/index.js';
import { defaultSterlingLocale, observeSterlingLocale, type SterlingLocale } from './sterling-locale.js';

@injectable()
class SterlingLocaleContribution implements CommandContribution, FrontendApplicationContribution {
  @inject(CommandRegistry) private readonly commands!: CommandRegistry;
  @inject(PreferenceService) private readonly preferences!: PreferenceService;
  @inject(PreferenceProviderProvider) private readonly providers!: PreferenceProviderProvider;

  private locale: SterlingLocale = defaultSterlingLocale;
  private resolveFirstRead!: () => void;
  private readonly firstRead = new Promise<void>(resolve => { this.resolveFirstRead = resolve; });
  private observer?: Disposable;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.locale.readUser' }, {
      execute: async () => { await this.firstRead; return this.locale; }
    });
  }

  onStart(): void {
    this.observer = observeSterlingLocale(this.preferences, this.providers, locale => {
      const changed = locale !== this.locale;
      this.locale = locale;
      this.resolveFirstRead();
      // The plugin host may register after the first read. It also reads on activation and when Studio opens.
      if (changed && this.commands.getCommand('nearAi.refreshStudioLanguage')) {
        void this.commands.executeCommand('nearAi.refreshStudioLanguage').catch(() => undefined);
      }
    });
  }

  onStop(): void {
    this.observer?.dispose();
    this.resolveFirstRead();
  }
}

export default new ContainerModule(bind => {
  bind(SterlingLocaleContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(SterlingLocaleContribution);
  bind(FrontendApplicationContribution).toService(SterlingLocaleContribution);
});

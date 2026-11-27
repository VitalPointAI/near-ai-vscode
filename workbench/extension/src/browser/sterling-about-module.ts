import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-menus.js';
import { AbstractDialog } from '@theia/core/lib/browser/dialogs.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import type { Message } from '@theia/core/lib/browser/widgets/widget.js';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { Disposable } from '@theia/core/lib/common/disposable.js';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu/index.js';
import { PreferenceProviderProvider, PreferenceService } from '@theia/core/lib/common/preferences/index.js';
import { defaultSterlingLocale, observeSterlingLocale, sterlingMessages, type SterlingLocale } from './sterling-locale.js';

const aboutCommandId = 'sterling.about';
const versionCommand = 'nearAi.getSovAiVersion';
const versionLookupTimeoutMs = 5_000;

class AboutSovAiDialog extends AbstractDialog<void> {
  private readonly versionText: HTMLParagraphElement;
  private readonly dismissButton: HTMLButtonElement;

  constructor(private readonly version: string | undefined, locale: SterlingLocale) {
    super({ title: sterlingMessages[locale].aboutTitle });
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-modal', 'true');
    this.versionText = this.node.ownerDocument.createElement('p');
    this.contentNode.append(this.versionText);
    this.dismissButton = this.appendAcceptButton();
    this.setLocale(locale);
  }

  setLocale(locale: SterlingLocale): void {
    const messages = sterlingMessages[locale];
    this.node.lang = locale;
    this.node.setAttribute('aria-label', messages.aboutTitle);
    this.titleNode.textContent = messages.aboutTitle;
    this.versionText.textContent = this.version === undefined
      ? messages.aboutVersionUnavailable
      : messages.aboutVersion.replace('{version}', this.version);
    this.dismissButton.textContent = messages.aboutClose;
  }

  protected override onAfterAttach(message: Message): void {
    super.onAfterAttach(message);
    const view = this.node.ownerDocument.defaultView;
    if (!view) return;

    // Theia's document-level keybindings can consume dialog keys before the footer receives them.
    const dismiss = (event: KeyboardEvent): void => {
      const dismissKey = event.key === 'Escape' || (event.key === 'Enter' && event.target === this.dismissButton);
      if (!dismissKey || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !this.isAttached || !event.composedPath().includes(this.node)) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
    view.addEventListener('keydown', dismiss, true);
    this.toDisposeOnDetach.push(Disposable.create(() => view.removeEventListener('keydown', dismiss, true)));
  }

  get value(): void {
    return undefined;
  }
}

@injectable()
class AboutSovAiContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {
  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(PreferenceProviderProvider)
  protected readonly preferenceProviders!: PreferenceProviderProvider;

  private opening = false;
  private locale: SterlingLocale = defaultSterlingLocale;
  private localeObserver?: Disposable;
  private activeDialog?: AboutSovAiDialog;

  onStart(): void {
    this.localeObserver = observeSterlingLocale(this.preferences, this.preferenceProviders, locale => {
      this.locale = locale;
      this.activeDialog?.setLocale(locale);
    });
  }

  onStop(): void {
    this.localeObserver?.dispose();
  }

  registerCommands(registry: CommandRegistry): void {
    const currentTitle = (): string => sterlingMessages[this.locale].aboutTitle;
    registry.registerCommand({
      id: aboutCommandId,
      get label(): string { return currentTitle(); }
    }, { execute: () => this.open() });
  }

  registerMenus(registry: MenuModelRegistry): void {
    registry.registerMenuAction(CommonMenus.MANAGE_SETTINGS, { commandId: aboutCommandId, order: 'z90' });
    registry.registerMenuAction(CommonMenus.HELP, { commandId: aboutCommandId, order: '8' });
  }

  private async readVersion(): Promise<unknown> {
    if (!this.commands.getCommand(versionCommand)) return undefined;
    let timer: number | undefined;
    const unavailable = new Promise<undefined>(resolve => {
      timer = window.setTimeout(() => resolve(undefined), versionLookupTimeoutMs);
    });
    try {
      return await Promise.race([this.commands.executeCommand<unknown>(versionCommand), unavailable]);
    } catch {
      return undefined;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async open(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    const origin = document.activeElement;
    try {
      const result = await this.readVersion();
      const version = typeof result === 'string' && result.length <= 128 &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(result) ? result : undefined;
      this.activeDialog = new AboutSovAiDialog(version, this.locale);
      await this.activeDialog.open();
    } finally {
      this.activeDialog = undefined;
      this.opening = false;
      // The menu or palette may have detached while resolving the version.
      const target = origin instanceof HTMLElement && origin.isConnected && origin !== document.body ? origin : undefined;
      target?.focus({ preventScroll: true });
      if (!target || document.activeElement !== target) {
        document.querySelector<HTMLButtonElement>('.sterling-rail-shortcuts button')?.focus({ preventScroll: true });
      }
    }
  }
}

export default new ContainerModule(bind => {
  bind(AboutSovAiContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AboutSovAiContribution);
  bind(MenuContribution).toService(AboutSovAiContribution);
  bind(FrontendApplicationContribution).toService(AboutSovAiContribution);
});

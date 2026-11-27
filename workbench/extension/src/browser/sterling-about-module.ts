import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-menus.js';
import { AbstractDialog } from '@theia/core/lib/browser/dialogs.js';
import type { Message } from '@theia/core/lib/browser/widgets/widget.js';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { Disposable } from '@theia/core/lib/common/disposable.js';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu/index.js';
import { nls } from '@theia/core/lib/common/nls.js';

const aboutCommand = { id: 'sterling.about', label: nls.localize('sterling/about/title', 'About SovAI') };
const versionCommand = 'nearAi.getSovAiVersion';
const versionLookupTimeoutMs = 5_000;

class AboutSovAiDialog extends AbstractDialog<void> {
  constructor(version: string | undefined) {
    super({ title: aboutCommand.label });
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-modal', 'true');
    this.node.setAttribute('aria-label', aboutCommand.label);
    const versionText = this.node.ownerDocument.createElement('p');
    versionText.textContent = version === undefined
      ? nls.localize('sterling/about/versionUnavailable', 'Version unavailable')
      : nls.localize('sterling/about/version', 'Version {0}', version);
    this.contentNode.append(versionText);
    this.appendAcceptButton(nls.localize('sterling/about/close', 'Close'));
  }

  protected override onAfterAttach(message: Message): void {
    super.onAfterAttach(message);
    const view = this.node.ownerDocument.defaultView;
    if (!view) return;

    // Theia's document-level keybindings can consume dialog keys before the footer receives them.
    const dismiss = (event: KeyboardEvent): void => {
      const dismissKey = event.key === 'Escape' || (event.key === 'Enter' && event.target === this.acceptButton);
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
class AboutSovAiContribution implements CommandContribution, MenuContribution {
  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  private opening = false;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(aboutCommand, { execute: () => this.open() });
  }

  registerMenus(registry: MenuModelRegistry): void {
    registry.registerMenuAction(CommonMenus.MANAGE_SETTINGS, { commandId: aboutCommand.id, order: 'z90' });
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
      await new AboutSovAiDialog(version).open();
    } finally {
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
});

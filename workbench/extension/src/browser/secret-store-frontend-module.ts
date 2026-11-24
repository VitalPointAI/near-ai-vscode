import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { bindFrontendService } from './frontend-service.js';
import { SECRET_STORE_PATH, SECRET_STORE_TEXT, SecretStoreService } from '../common/secret-store.js';

/**
 * Says so when this workbench has no durable secret store (D-04, D-18, D-36, D-43): at start it asks the backend which store was chosen and,
 * only when it is unavailable, shows the status bar entry "Secrets are unavailable" (the tooltip gives the reason) and one notification with
 * the reason. Nothing shows in hosted mode or with this computer's keyring. Saving a secret then fails visibly in the extension that tried.
 */
const ENTRY_ID = 'sterling-secret-store';

@injectable()
class SecretStoreView implements FrontendApplicationContribution {
  @inject(SecretStoreService) private readonly service!: SecretStoreService;
  @inject(StatusBar) private readonly statusBar!: StatusBar;
  @inject(MessageService) private readonly messages!: MessageService;

  onStart(): void {
    void this.show();
  }

  private async show(): Promise<void> {
    let status;
    try {
      status = await this.service.status();
    } catch {
      return; // the backend did not answer; a failed save still says why
    }
    if (status.store !== 'unavailable') return;
    const reason = status.reason ?? SECRET_STORE_TEXT.noStore;
    await this.statusBar.setElement(ENTRY_ID, {
      text: `$(warning) ${SECRET_STORE_TEXT.unavailable}`,
      tooltip: reason,
      alignment: StatusBarAlignment.LEFT,
      priority: 99,
    });
    void this.messages.warn(`${SECRET_STORE_TEXT.unavailable}. ${reason}`);
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<SecretStoreService>(bind, SecretStoreService, SECRET_STORE_PATH);
  bind(SecretStoreView).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(SecretStoreView);
});

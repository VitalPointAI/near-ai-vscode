import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types.js';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { bindFrontendService } from './frontend-service.js';
import {
  SESSION_IDENTITY_PATH, SESSION_IDENTITY_TEXT, SessionIdentityService, stepUpUrl, type SessionIdentityStatus,
} from '../common/session-identity.js';

/**
 * The person's view of session identity (D-21, D-23, D-24, D-43). In hosted mode a status bar entry shows "Checking your sign-in" while the
 * check runs and "Sign-in check failed" with the reason when it fails, with a notification that offers Retry; nothing shows while active or in
 * local mode. When your organization configured a step-up sign-in, a command sends the person back to the identity provider for a fresh
 * passkey or security key ceremony. The workbench itself never asks for a credential of any kind (D-05).
 */
const ENTRY_ID = 'sterling-session-identity';
const RETRY: Command = { id: 'sterling.session.retry', label: SESSION_IDENTITY_TEXT.retryCommand, category: 'Sterling' };
const CONFIRM: Command = { id: 'sterling.session.confirmWithSecurityKey', label: SESSION_IDENTITY_TEXT.confirm, category: 'Sterling' };
const POLL_WAITING_MS = 5_000;
const POLL_ACTIVE_MS = 60_000;

type Hosted = Extract<SessionIdentityStatus, { mode: 'hosted' }>;

@injectable()
class SessionIdentityView implements FrontendApplicationContribution, CommandContribution {
  @inject(SessionIdentityService) private readonly service!: SessionIdentityService;
  @inject(StatusBar) private readonly statusBar!: StatusBar;
  @inject(MessageService) private readonly messages!: MessageService;

  private current: SessionIdentityStatus | undefined;
  private notified: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  onStart(): void {
    void this.refresh();
  }

  onStop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(RETRY, {
      execute: () => this.retry(),
      isEnabled: () => this.hosted()?.state === 'failed',
      isVisible: () => this.hosted()?.state === 'failed',
    });
    commands.registerCommand(CONFIRM, {
      execute: () => {
        const acr = this.hosted()?.stepUp?.acr;
        if (acr !== undefined) window.location.assign(stepUpUrl(window.location.pathname + window.location.search, acr));
      },
      isEnabled: () => this.hosted()?.stepUp !== undefined,
      isVisible: () => this.hosted()?.stepUp !== undefined,
    });
  }

  private hosted(): Hosted | undefined {
    return this.current?.mode === 'hosted' ? this.current : undefined;
  }

  private async retry(): Promise<void> {
    this.notified = undefined;
    try {
      await this.show(await this.service.retry());
    } catch {
      // The backend did not answer; the next poll shows the state again.
    }
    this.schedule();
  }

  private async refresh(): Promise<void> {
    try {
      await this.show(await this.service.status());
    } catch {
      // The backend did not answer this time; ask again at the next poll.
    }
    this.schedule();
  }

  /** Every 5 s while the check is not active, every 60 s while it is; never again in local mode or once the session has stopped. */
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const status = this.current;
    if (status?.mode === 'local' || (status?.mode === 'hosted' && status.state === 'stopped')) return;
    const wait = status?.mode === 'hosted' && status.state === 'active' ? POLL_ACTIVE_MS : POLL_WAITING_MS;
    this.timer = setTimeout(() => void this.refresh(), wait);
  }

  private async show(status: SessionIdentityStatus): Promise<void> {
    this.current = status;
    if (status.mode === 'local' || status.state === 'active' || status.state === 'stopping' || status.state === 'stopped') {
      this.notified = undefined;
      await this.statusBar.removeElement(ENTRY_ID);
      return;
    }
    if (status.state === 'identity') {
      await this.statusBar.setElement(ENTRY_ID, { text: `$(sync~spin) ${SESSION_IDENTITY_TEXT.checking}`, alignment: StatusBarAlignment.LEFT, priority: 100 });
      return;
    }
    const reason = status.reason ? SESSION_IDENTITY_TEXT.reasons[status.reason] : SESSION_IDENTITY_TEXT.failed;
    await this.statusBar.setElement(ENTRY_ID, {
      text: `$(warning) ${SESSION_IDENTITY_TEXT.failed}`,
      tooltip: reason,
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      command: RETRY.id,
    });
    // One notification per failure, not one per poll.
    const key = status.reason ?? 'failed';
    if (this.notified === key) return;
    this.notified = key;
    void this.messages.warn(`${SESSION_IDENTITY_TEXT.failed}. ${reason}`, SESSION_IDENTITY_TEXT.retry).then((choice) => {
      if (choice === SESSION_IDENTITY_TEXT.retry) void this.retry();
    });
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<SessionIdentityService>(bind, SessionIdentityService, SESSION_IDENTITY_PATH);
  bind(SessionIdentityView).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(SessionIdentityView);
  bind(CommandContribution).toService(SessionIdentityView);
});

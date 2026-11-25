import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { Command, CommandContribution, CommandRegistry, CommandService } from '@theia/core/lib/common/command.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { QuickInputService, type QuickPickItem } from '@theia/core/lib/common/quick-pick-service.js';
import { bindFrontendService } from './frontend-service.js';
import { GUEST_SECRETS_PATH, GUEST_SECRETS_TEXT, GuestSecretsRpc, type EndedGuest } from '../common/guest-secrets.js';

/**
 * Removing ended guests' secrets in the workbench (Phase 47 D-84, owner 2026-11-25). A security officer sees a notice with how many ended
 * guest accounts have secrets past your organization's retention period, every hour while it stays above zero, and the command "Remove ended
 * guests' secrets", which asks for a fresh passkey or security key step-up, lists the ended guests by end date and removes after a confirm.
 * Anyone who is not one of the site's named security officers sees nothing (the backend answers null).
 */
const REMOVE: Command = { id: 'sterling.guests.removeEndedSecrets', label: GUEST_SECRETS_TEXT.command, category: 'Sterling' };
const CONFIRM_COMMAND = 'sterling.session.confirmWithSecurityKey';
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

interface GuestPick extends QuickPickItem {
  readonly guests: readonly EndedGuest[];
}

@injectable()
class GuestSecretsView implements FrontendApplicationContribution, CommandContribution {
  @inject(GuestSecretsRpc) private readonly service!: GuestSecretsRpc;
  @inject(MessageService) private readonly messages!: MessageService;
  @inject(QuickInputService) private readonly quickInput!: QuickInputService;
  @inject(CommandService) private readonly commands!: CommandService;

  private officer = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  onStart(): void {
    this.timer = setTimeout(() => void this.check(), FIRST_CHECK_MS);
  }

  onStop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(REMOVE, { execute: () => this.remove(), isVisible: () => this.officer, isEnabled: () => this.officer });
  }

  /** The notice, again every hour while the count is above zero: it repeats until the officer acts. */
  private async check(): Promise<void> {
    try {
      const result = await this.service.notice();
      if (result.kind === 'ok' && result.value !== null) {
        this.officer = true;
        if (result.value.count > 0) {
          void this.messages.warn(GUEST_SECRETS_TEXT.notice(result.value.count), GUEST_SECRETS_TEXT.command).then((choice) => {
            if (choice === GUEST_SECRETS_TEXT.command) void this.remove();
          });
        }
      }
    } catch {
      // The backend did not answer; the next hourly check asks again.
    }
    this.timer = setTimeout(() => void this.check(), CHECK_EVERY_MS);
  }

  private async remove(): Promise<void> {
    const listed = await this.service.candidates();
    if (listed.kind === 'refused') {
      const choice = await this.messages.warn(listed.reason, ...(listed.fix ? [listed.fix] : []));
      if (choice !== undefined && choice === listed.fix) await this.commands.executeCommand(CONFIRM_COMMAND);
      return;
    }
    if (listed.value.length === 0) { void this.messages.info(GUEST_SECRETS_TEXT.none); return; }
    const picks: GuestPick[] = listed.value.map((guest) => ({ label: guest.record, description: `ended ${guest.endedAt}, kept until ${guest.removeAfter}`, guests: [guest] }));
    if (picks.length > 1) picks.unshift({ label: GUEST_SECRETS_TEXT.all, guests: listed.value });
    const chosen = await this.quickInput.showQuickPick<GuestPick>(picks, { placeholder: GUEST_SECRETS_TEXT.pick });
    if (chosen === undefined) return;
    const confirmed = await new ConfirmDialog({ title: GUEST_SECRETS_TEXT.confirmTitle, msg: GUEST_SECRETS_TEXT.confirmText(chosen.guests.length), ok: GUEST_SECRETS_TEXT.command }).open();
    if (confirmed !== true) return;
    let secrets = 0;
    let guests = 0;
    for (const guest of chosen.guests) {
      const result = await this.service.remove(guest.record);
      if (result.kind === 'refused') { void this.messages.warn(result.reason); break; }
      secrets += result.value.removed;
      guests += 1;
    }
    if (guests > 0) void this.messages.info(GUEST_SECRETS_TEXT.removed(secrets, guests));
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<GuestSecretsRpc>(bind, GuestSecretsRpc, GUEST_SECRETS_PATH);
  bind(GuestSecretsView).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(GuestSecretsView);
  bind(CommandContribution).toService(GuestSecretsView);
});

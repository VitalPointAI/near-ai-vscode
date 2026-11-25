import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common/command.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { QuickInputService, type QuickPickItem } from '@theia/core/lib/common/quick-pick-service.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { bindFrontendService } from '../frontend-service.js';
import { CARD_TEXT } from '../../common/issue-credential-card.js';
import { IDENTITY_SERVICE_PATH, IDENTITY_TEXT, IdentityServiceRpc } from '../../common/identity.js';
import { ISSUER_SERVICE_PATH, IssuerServiceRpc } from '../../common/issuer-service.js';
import { ISSUE_CREDENTIAL_WIDGET_ID, IssueCredentialWidget } from './issue-credential-widget.js';

/**
 * The credentials in the browser (Phase 71, 71-12): the SovAI: Issue Credential command opens the native card, and at the start of a session the
 * person is told in one sentence what arrived in their wallet. Both talk to the backend through RPC only.
 */
const issueCredential: Command = { id: 'sterling.credentials.issue', label: CARD_TEXT.command, category: 'SovAI' };
const reportLost: Command = { id: 'sterling.credentials.reportLostComputer', label: 'Report a Lost Computer', category: 'SovAI' };
const INBOX_WAIT_MS = 15_000;

@injectable()
class IssueCredentialContribution extends AbstractViewContribution<IssueCredentialWidget> {
  @inject(IdentityServiceRpc) private readonly identity!: IdentityServiceRpc;
  @inject(QuickInputService) private readonly quickInput!: QuickInputService;
  @inject(MessageService) private readonly messages!: MessageService;

  constructor() {
    super({ widgetId: ISSUE_CREDENTIAL_WIDGET_ID, widgetName: CARD_TEXT.title, defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(issueCredential, { execute: () => this.openView({ activate: true }) });
    commands.registerCommand(reportLost, { execute: () => this.reportLostComputer() });
  }

  /** D-25: the person picks one of their bound computers; the report goes to your organization's revocation inbox, and an officer revokes it. */
  private async reportLostComputer(): Promise<void> {
    const computers = await this.identity.computers();
    if (computers.kind === 'refused') { void this.messages.warn(computers.reason); return; }
    if (computers.value.length === 0) { void this.messages.info(IDENTITY_TEXT.noComputer); return; }
    const items: Array<QuickPickItem & { slot: number }> = computers.value.map(computer => ({
      slot: computer.slot, label: `Computer ${computer.device.slice(4, 12)}`, description: `bound ${computer.claimedAt.slice(0, 10)}`,
    }));
    const chosen = await this.quickInput.showQuickPick(items, { placeholder: 'Which computer is lost?' });
    if (chosen === undefined) return;
    const answer = await this.identity.reportLostComputer(chosen.slot);
    if (answer.kind === 'refused') void this.messages.warn(answer.reason);
    else void this.messages.info(answer.value.filed ? IDENTITY_TEXT.lostFiled : IDENTITY_TEXT.lostAlready);
  }
}

/** What the inbox pickup moved into the person's wallet at session start, said once. */
@injectable()
class InboxNews implements FrontendApplicationContribution {
  @inject(IdentityServiceRpc) private readonly identity!: IdentityServiceRpc;
  @inject(MessageService) private readonly messages!: MessageService;

  onStart(): void {
    // The backend picks the inbox up once the session is active; ask a little later, once.
    setTimeout(() => void this.tell(), INBOX_WAIT_MS);
  }

  private async tell(): Promise<void> {
    try {
      for (const sentence of await this.identity.inboxNews()) void this.messages.info(sentence);
    } catch {
      // Nothing to tell, or the backend is not reachable yet; the credentials stay where they are either way.
    }
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<IssuerServiceRpc>(bind, IssuerServiceRpc, ISSUER_SERVICE_PATH);
  bindFrontendService<IdentityServiceRpc>(bind, IdentityServiceRpc, IDENTITY_SERVICE_PATH);
  bind(IssueCredentialWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: ISSUE_CREDENTIAL_WIDGET_ID, createWidget: () => context.container.get(IssueCredentialWidget) })).inSingletonScope();
  bindViewContribution(bind, IssueCredentialContribution);
  bind(InboxNews).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(InboxNews);
});

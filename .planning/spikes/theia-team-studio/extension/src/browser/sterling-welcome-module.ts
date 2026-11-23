import { inject, injectable, ContainerModule, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import './sterling-welcome.css';

const welcomeId = 'sterling-get-started';
const chatContainerId = 'plugin-view-container:workbench.view.extension.nearAiSecondaryViewContainer';
const destinations = [
  { label: 'Projects', icon: 'folder-opened', description: 'Set up your project and choose how it works.', command: 'nearAi.projectSetup' },
  { label: 'Teams', icon: 'organization', description: 'Build teams and give each agent a clear role.', command: 'nearAi.manageTeams' },
  { label: 'Activity', icon: 'pulse', description: 'Follow agent runs and review what happened.', command: 'nearAi.openAgentActivity' },
  { label: 'Governance', icon: 'shield', description: 'Review the rules that govern your project.', command: 'nearAi.policy.open' }
];

@injectable()
class SterlingWelcomeWidget extends BaseWidget {
  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  @postConstruct()
  protected initialize(): void {
    this.id = welcomeId;
    this.title.label = 'Get Started';
    this.title.caption = 'Sterling';
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-welcome');
    this.node.innerHTML = `
      <main class="sterling-page">
        <header class="sterling-wordmark"><span aria-hidden="true">S</span> Sterling</header>
        <section class="sterling-hero" aria-labelledby="sterling-title">
          <img class="sterling-hero-image" src="sterling-hero.webp" alt="" decoding="async">
          <div class="sterling-hero-glow" aria-hidden="true"></div>
          <div class="sterling-hero-copy">
            <h1 id="sterling-title">Sovereign AI<br>for real work.</h1>
            <p>Choose where your models run, build agent teams, and govern what they can do.</p>
            <div class="sterling-actions">
              <button type="button" class="sterling-primary" data-command="nearAi.setup">Set up a project <i class="codicon codicon-arrow-right" aria-hidden="true"></i></button>
              <button type="button" class="sterling-secondary" data-command="nearAi.openChat">Open Chat</button>
            </div>
          </div>
        </section>
        <p class="sterling-status" role="status" hidden></p>
        <section class="sterling-destinations" aria-labelledby="sterling-destinations">
          <div class="sterling-section-heading">
            <h2 id="sterling-destinations">Your workspace</h2>
            <button type="button" class="sterling-example" data-command="near-ai.team-studio.preview">Explore a sample team <i class="codicon codicon-arrow-right" aria-hidden="true"></i></button>
          </div>
          <div class="sterling-destination-grid">
            ${destinations.map(({ command, icon, label, description }) => `
              <button type="button" class="sterling-destination" data-command="${command}">
                <i class="sterling-destination-icon codicon codicon-${icon}" aria-hidden="true"></i>
                <strong>${label}</strong>
                <span>${description}</span>
              </button>
            `).join('')}
          </div>
        </section>
      </main>`;
    const status = this.node.querySelector<HTMLElement>('.sterling-status')!;
    this.node.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach(button => {
      button.addEventListener('click', async () => {
        const command = button.dataset.command!;
        status.hidden = true;
        if (!this.commands.getCommand(command)) {
          status.textContent = 'This action is unavailable. Wait for the workbench to finish opening, or explore the sample team.';
          status.hidden = false;
          return;
        }
        try {
          await this.commands.executeCommand(command);
        } catch {
          status.textContent = 'Sterling could not open this view. Try again after the workspace finishes loading.';
          status.hidden = false;
        }
      });
    });
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }
}

@injectable()
class SterlingWelcomeContribution extends AbstractViewContribution<SterlingWelcomeWidget> implements FrontendApplicationContribution {
  constructor() {
    super({ widgetId: welcomeId, widgetName: 'Get Started', defaultWidgetOptions: { area: 'main' } });
  }

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  onStart(app: FrontendApplication): void {
    const { tabBar } = app.shell.rightPanelHandler;
    let openingChat = false;
    let chatOpened = false;
    tabBar.currentChanged.connect(async (_sender, { currentTitle }) => {
      if (currentTitle?.owner.id !== chatContainerId || openingChat || chatOpened) return;
      openingChat = true;
      try {
        // Focusing the view explicitly resolves the VSIX webview on the first rail click.
        await this.commandRegistry.executeCommand('nearAi.openChat');
        chatOpened = true;
      } catch (error) {
        console.warn('Sterling could not initialize the Chat drawer.', error);
      } finally {
        openingChat = false;
      }
    });
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.getStarted', category: 'Sterling', label: 'Get Started' }, {
      execute: () => this.openView({ activate: true })
    });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingWelcomeWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: welcomeId,
    createWidget: () => context.container.get(SterlingWelcomeWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingWelcomeContribution);
  bind(FrontendApplicationContribution).toService(SterlingWelcomeContribution);
});

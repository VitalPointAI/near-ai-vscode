import { inject, injectable, ContainerModule, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { ThemeService } from '@theia/core/lib/browser/theming.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget, Panel } from '@theia/core/lib/browser/widgets/widget.js';
import './sterling-welcome.css';

const welcomeId = 'sterling-get-started';
const edition = {
  label: 'Canadian Defence Edition',
  hero: 'sterling-hero-ca-defence.webp',
  workbenchClass: 'sterling-ca'
};
const railActions = [
  { label: 'Get Started', icon: 'home', command: 'sterling.getStarted' },
  { label: 'Chat', icon: 'comment-discussion', command: 'nearAi.openChat' },
  { label: 'Team Studio', icon: 'organization', command: 'nearAi.manageTeams' },
  { label: 'Compliance', icon: 'shield', command: 'sterling.compliance.open' },
  { label: 'Documentation', icon: 'book', command: 'sterling.documentation.open' }
];
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

  @inject(ThemeService)
  protected readonly themes!: ThemeService;

  @postConstruct()
  protected initialize(): void {
    this.id = welcomeId;
    this.title.label = 'Get Started';
    this.title.caption = `Sterling Sovereign AI (${edition.label})`;
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-welcome');
    this.node.innerHTML = `
      <main class="sterling-page">
        <header class="sterling-wordmark">
          <img width="1600" height="595" alt="Sterling">
          <span class="sterling-edition">${edition.label}</span>
        </header>
        <section class="sterling-hero" aria-labelledby="sterling-title">
          <svg class="sterling-hero-image" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMin slice" aria-hidden="true" focusable="false">
            <image href="${edition.hero}" width="1672" height="941"/>
            <g class="sterling-trails">
              <path pathLength="100" d="M731 189 Q766 167 811 152 M1241 110 Q1303 100 1354 105"/>
              <path pathLength="100" d="M1504 141 C1557 167 1582 216 1538 273"/>
              <path pathLength="100" d="M1556 347 C1611 377 1600 434 1511 493"/>
              <path pathLength="100" d="M1429 559 Q1377 589 1275 615 M762 572 C684 554 611 530 590 486"/>
              <path pathLength="100" d="M582 415 C538 368 580 296 660 236"/>
            </g>
          </svg>
          <div class="sterling-hero-glow" aria-hidden="true"></div>
          <button type="button" class="sterling-motion" aria-label="Pause hero animation" title="Pause hero animation">
            <i class="codicon codicon-debug-pause" aria-hidden="true"></i>
          </button>
          <div class="sterling-hero-copy">
            <h1 id="sterling-title">Sovereign AI<br>for real work.</h1>
            <p>Choose where your models run, build agent teams, and govern what they can do.</p>
            <p class="sterling-domains">Cyber · Space · Land · Sea · Air</p>
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
    const logo = this.node.querySelector<HTMLImageElement>('.sterling-wordmark img')!;
    const updateLogo = (): void => {
      const theme = this.themes.getCurrentTheme().type;
      logo.src = theme === 'dark' || theme === 'hc' ? 'sterling_logo_reverse.png' : 'sterling_logo_color.png';
    };
    updateLogo();
    this.toDispose.push(this.themes.onDidColorThemeChange(updateLogo));

    const hero = this.node.querySelector<HTMLElement>('.sterling-hero')!;
    const motionButton = hero.querySelector<HTMLButtonElement>('.sterling-motion')!;
    motionButton.addEventListener('click', () => {
      const paused = hero.toggleAttribute('data-motion-paused');
      const action = paused ? 'Play hero animation' : 'Pause hero animation';
      motionButton.setAttribute('aria-label', action);
      motionButton.title = action;
      motionButton.firstElementChild!.className = paused ? 'codicon codicon-play' : 'codicon codicon-debug-pause';
    });

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
    app.shell.addClass(edition.workbenchClass);
    const { tabBar } = app.shell.rightPanelHandler;
    if (tabBar.parent instanceof Panel) {
      const shortcuts = document.createElement('nav');
      shortcuts.className = 'sterling-rail-shortcuts';
      shortcuts.setAttribute('aria-label', 'Sterling shortcuts');
      for (const { label, icon, command } of railActions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sterling-rail-shortcut';
        button.title = label;
        button.setAttribute('aria-label', label);
        const glyph = document.createElement('i');
        glyph.className = `codicon codicon-${icon}`;
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
        button.addEventListener('click', () => {
          void this.commandRegistry.executeCommand(command).catch(error => console.warn(`Sterling could not open ${label}.`, error));
        });
        shortcuts.append(button);
      }
      tabBar.parent.insertWidget(0, new BaseWidget({ node: shortcuts }));
      tabBar.addClass('sterling-managed-rail');
    }
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true });
  }

  async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
    // Move the editor's Outline on both fresh and restored layouts.
    const outline = app.shell.getWidgets('right').find(widget => widget.id === 'outline-view');
    if (outline) await app.shell.addWidget(outline, { area: 'left', rank: 500 });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.getStarted', category: 'SovAI', label: 'Get Started' }, {
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

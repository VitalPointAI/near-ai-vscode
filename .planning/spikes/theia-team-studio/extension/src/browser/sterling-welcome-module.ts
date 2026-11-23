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
            <h1 id="sterling-title">Sterling<br>Sovereign AI</h1>
            <p>Choose AI providers, build agent teams, and govern how they work.</p>
            <p class="sterling-domains">Cyber · Space · Land · Sea · Air</p>
            <div class="sterling-actions">
              <button type="button" class="sterling-primary">Explore a sample team <i class="codicon codicon-arrow-right" aria-hidden="true"></i></button>
            </div>
            <p class="sterling-status" role="status" hidden></p>
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
    const exploreTeam = this.node.querySelector<HTMLButtonElement>('.sterling-primary')!;
    exploreTeam.addEventListener('click', async () => {
      status.hidden = true;
      try {
        await this.commands.executeCommand('near-ai.team-studio.preview');
      } catch {
        status.textContent = 'Sterling could not open the sample team. Try opening Team Studio from the command palette.';
        status.hidden = false;
      }
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

  onStart(app: FrontendApplication): void {
    app.shell.addClass(edition.workbenchClass);
    const { tabBar } = app.shell.rightPanelHandler;
    if (!(tabBar.parent instanceof Panel)) return;

    const shortcuts = document.createElement('nav');
    shortcuts.className = 'sterling-rail-shortcuts';
    shortcuts.setAttribute('aria-label', 'Sterling shortcuts');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sterling-rail-shortcut';
    button.title = 'Get Started';
    button.setAttribute('aria-label', 'Get Started');
    const glyph = document.createElement('i');
    glyph.className = 'codicon codicon-home';
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    button.addEventListener('click', () => {
      void this.openView({ activate: true }).catch(error => console.warn('Sterling could not open Get Started.', error));
    });
    shortcuts.append(button);
    tabBar.parent.insertWidget(0, new BaseWidget({ node: shortcuts }));
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true });
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

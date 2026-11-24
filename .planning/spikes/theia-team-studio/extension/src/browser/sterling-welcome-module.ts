import { inject, injectable, ContainerModule, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { ThemeService } from '@theia/core/lib/browser/theming.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget, Panel } from '@theia/core/lib/browser/widgets/widget.js';
import { readActiveWorkArea } from './sterling-work-area-files.js';
import './sterling-welcome.css';

const welcomeId = 'sterling-get-started';
const chatContainerId = 'plugin-view-container:workbench.view.extension.nearAiSecondaryViewContainer';
const edition = {
  label: 'Canadian Defence Edition',
  hero: 'sterling-hero-ca-defence.webp',
  workbenchClass: 'sterling-ca'
};
const railActions: ReadonlyArray<{ label: string; icon: string; command?: string }> = [
  { label: 'Get Started', icon: 'home', command: 'sterling.getStarted' },
  { label: 'Portfolio', icon: 'graph', command: 'sterling.portfolio.open' },
  { label: 'Chat', icon: 'comment-discussion', command: 'nearAi.openChat' },
  { label: 'Team Studio', icon: 'organization', command: 'nearAi.manageTeams' },
  { label: 'Agent Activity', icon: 'pulse', command: 'nearAi.openAgentActivity' },
  { label: 'Governance', icon: 'law', command: 'nearAi.policy.open' },
  { label: 'Data Management', icon: 'database' },
  { label: 'Model Factory', icon: 'circuit-board' },
  { label: 'Compliance', icon: 'shield', command: 'sterling.compliance.open' },
  { label: 'Documentation', icon: 'book', command: 'sterling.documentation.open' }
];

const componentLabels = new Map([
  ['program', 'Program'], ['major-capital', 'Major capital project'], ['minor-capital', 'Minor capital project'],
  ['initiative', 'Initiative'], ['product', 'Product']
]);

const workAreas = [
  { label: 'Capability Development', icon: 'project', description: 'Organize the programs, projects, and products that deliver a capability.', kind: 'capability-development' },
  { label: 'Exercises & Training', icon: 'mortar-board', description: 'Prepare exercises and organize training.', kind: 'training' },
  { label: 'Planning', icon: 'checklist', description: 'Develop strategic, operational, and tactical plans.', kind: 'operations' },
  { label: 'Resource Management', icon: 'layers', description: 'Coordinate people, equipment, and capacity.', kind: 'resources' }
];

@injectable()
class SterlingWelcomeWidget extends BaseWidget {
  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  @inject(ThemeService)
  protected readonly themes!: ThemeService;

  @inject(WorkspaceService)
  protected readonly workspaces!: WorkspaceService;

  @inject(FileService)
  protected readonly files!: FileService;

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
              <button type="button" class="sterling-primary" data-command="nearAi.setup">Set up Sterling <i class="codicon codicon-arrow-right" aria-hidden="true"></i></button>
              <button type="button" class="sterling-secondary" data-command="nearAi.openChat">Open Chat</button>
            </div>
          </div>
        </section>
        <p class="sterling-status" role="status" hidden></p>
        <section class="sterling-destinations" aria-labelledby="sterling-destinations">
          <div class="sterling-section-heading">
            <h2 id="sterling-destinations">Defence work areas</h2>
          </div>
          <p class="sterling-active-area" hidden></p>
          <ul class="sterling-area-components" aria-label="Capability components" hidden></ul>
          <div class="sterling-destination-grid">
            ${workAreas.map(({ kind, icon, label, description }) => `
              <button type="button" class="sterling-destination" data-command="sterling.workAreas.open" data-work-area="${kind}">
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

    const area = this.node.querySelector<HTMLElement>('.sterling-active-area')!;
    const components = this.node.querySelector<HTMLUListElement>('.sterling-area-components')!;
    let areaRequest = 0;
    const showActiveArea = async (): Promise<void> => {
      const request = ++areaRequest;
      const roots = await this.workspaces.roots;
      if (request !== areaRequest || this.isDisposed) return;
      area.hidden = true;
      area.textContent = '';
      components.hidden = true;
      components.replaceChildren();
      if (roots.length !== 1) return;
      const root = roots[0].resource;
      if (root.scheme !== 'file' || root.authority || !/^work-area-[a-f0-9]{16}$/.test(root.path.base)) return;
      try {
        const file = await this.files.read(root.resolve('.planning/.near-ai/work-area.json'), { limits: { size: 32768 }, acceptTextOnly: true });
        const metadata = JSON.parse(file.value);
        if (request !== areaRequest || this.isDisposed || metadata?.version !== 1) return;
        if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 100) return;
        area.textContent = `Open work area: ${metadata.title}`;
        area.hidden = false;
        if (metadata.kind === 'capability-development' && Array.isArray(metadata.components)) {
          for (const component of metadata.components.slice(0, 50)) {
            const label = componentLabels.get(component?.kind);
            if (!label || typeof component.title !== 'string' || !component.title.trim() || component.title.length > 100) continue;
            const item = document.createElement('li');
            item.textContent = `${label} · ${component.title}`;
            components.append(item);
          }
          components.hidden = components.childElementCount === 0;
        }
      } catch {
        // Regular folders and incomplete local records have no work-area title.
      }
    };
    this.toDispose.push(this.workspaces.onWorkspaceChanged(() => void showActiveArea()));
    void showActiveArea();

    const status = this.node.querySelector<HTMLElement>('.sterling-status')!;
    this.node.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach(button => {
      button.addEventListener('click', async () => {
        const command = button.dataset.command!;
        status.hidden = true;
        if (!this.commands.getCommand(command)) {
          status.textContent = 'This action is unavailable while the workbench is opening. Try again in a moment.';
          status.hidden = false;
          return;
        }
        try {
          if (button.dataset.workArea) {
            await this.commands.executeCommand(command, button.dataset.workArea);
          } else {
            await this.commands.executeCommand(command);
          }
        } catch {
          status.textContent = 'Sterling could not open this view. Try again after the workbench finishes loading.';
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
  private chatMotion?: { animation: Animation; opening: boolean };

  constructor() {
    super({ widgetId: welcomeId, widgetName: 'Get Started', defaultWidgetOptions: { area: 'main' } });
  }

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  onStart(app: FrontendApplication): void {
    app.shell.addClass(edition.workbenchClass);
    const { tabBar } = app.shell.rightPanelHandler;
    tabBar.currentChanged.connect((_bar, { previousTitle, currentTitle }) => {
      if (currentTitle?.owner.id === chatContainerId) this.slideChat(true);
      else if (previousTitle?.owner.id === chatContainerId) this.stopChatMotion();
    });
    if (tabBar.parent instanceof Panel) {
      const shortcuts = document.createElement('nav');
      shortcuts.className = 'sterling-rail-shortcuts';
      shortcuts.setAttribute('aria-label', 'Sterling shortcuts');
      for (const { label, icon, command } of railActions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sterling-rail-shortcut';
        button.title = command ? label : `${label} (planned)`;
        button.setAttribute('aria-label', button.title);
        const glyph = document.createElement('i');
        glyph.className = `codicon codicon-${icon}`;
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
        if (command) {
          if (command === 'nearAi.openChat') {
            const syncExpanded = (): void => button.setAttribute('aria-expanded', String(this.chatIsOpen()));
            syncExpanded();
            tabBar.currentChanged.connect(syncExpanded);
            button.addEventListener('click', () => {
              if (this.chatMotion?.opening === false) {
                this.slideChat(true);
                return;
              }
              const action = this.chatIsOpen() ? this.collapseChat() : this.commandRegistry.executeCommand(command);
              void action.catch(error => console.warn('Sterling could not toggle Chat.', error));
            });
          } else {
            button.addEventListener('click', () => {
              void this.commandRegistry.executeCommand(command).catch(error => console.warn(`Sterling could not open ${label}.`, error));
            });
          }
        } else {
          button.setAttribute('aria-disabled', 'true');
        }
        shortcuts.append(button);
      }
      tabBar.parent.insertWidget(0, new BaseWidget({ node: shortcuts }));
      tabBar.addClass('sterling-managed-rail');
    }
  }

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  async initializeLayout(): Promise<void> {
    const [root, ...otherRoots] = await this.workspaceService.roots;
    if (root && !otherRoots.length) {
      const area = await readActiveWorkArea(this.fileService, root.resource);
      if (area) {
        await this.commandRegistry.executeCommand('sterling.workAreas.open', area.kind);
        return;
      }
    }
    await this.openView({ activate: true });
  }

  async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
    // Move the editor's Outline on both fresh and restored layouts.
    const outline = app.shell.getWidgets('right').find(widget => widget.id === 'outline-view');
    if (outline) await app.shell.addWidget(outline, { area: 'left', rank: 500 });
  }

  private chatIsOpen(): boolean {
    return this.shell.rightPanelHandler.tabBar.currentTitle?.owner.id === chatContainerId;
  }

  private stopChatMotion(): void {
    this.chatMotion?.animation.cancel();
    this.chatMotion = undefined;
  }

  private slideChat(opening: boolean): Animation | undefined {
    const drawer = this.shell.rightPanelHandler.dockPanel.parent?.node;
    const shown = { transform: 'translateX(0)', clipPath: 'inset(0 0 0 0)' };
    const retracted = { transform: 'translateX(100%)', clipPath: 'inset(0 100% 0 0)' };
    const current = drawer && this.chatMotion ? getComputedStyle(drawer) : undefined;
    const from = current ? { transform: current.transform, clipPath: current.clipPath }
      : opening ? retracted : shown;
    this.stopChatMotion();
    if (!drawer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    // Clip the moving content so it stays inside the drawer area and clear of the rail.
    const animation = drawer.animate([from, opening ? shown : retracted], {
      duration: opening ? 220 : 180,
      easing: opening ? 'cubic-bezier(.16, 1, .3, 1)' : 'cubic-bezier(.5, 0, .75, 0)',
      fill: 'both'
    });
    this.chatMotion = { animation, opening };
    if (opening) {
      void animation.finished.then(() => {
        if (this.chatMotion?.animation === animation) this.stopChatMotion();
      }, () => {});
    }
    return animation;
  }

  private async collapseChat(): Promise<boolean> {
    if (!this.chatIsOpen()) return false;
    if (this.chatMotion?.opening === false) return true;
    const animation = this.slideChat(false);
    if (animation) {
      const finished = await animation.finished.then(() => true, () => false);
      if (!finished || this.chatMotion?.animation !== animation || !this.chatIsOpen()) return true;
    }
    await this.shell.collapsePanel('right');
    return true;
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.chat.closeDrawer' }, { execute: () => this.collapseChat() });
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

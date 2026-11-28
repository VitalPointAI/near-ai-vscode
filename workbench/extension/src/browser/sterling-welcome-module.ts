import { inject, injectable, ContainerModule, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type { Disposable } from '@theia/core/lib/common/disposable.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { PreferenceContribution, PreferenceProviderProvider, PreferenceService } from '@theia/core/lib/common/preferences/index.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { ThemeService } from '@theia/core/lib/browser/theming.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget, Panel } from '@theia/core/lib/browser/widgets/widget.js';
import { sterlingComplianceCommand } from './sterling-compliance-module.js';
import { sterlingDocumentationCommand } from './sterling-documentation-module.js';
import { defaultSterlingLocale, observeSterlingLocale, sterlingLanguagePreference, sterlingMessages, type SterlingLocale, type SterlingMessage } from './sterling-locale.js';
import { readActiveWorkArea } from './sterling-work-area-files.js';
import './sterling-welcome.css';

const welcomeId = 'sterling-get-started';
const openWelcome = { id: 'sterling.getStarted', category: 'SovAI', label: sterlingMessages[defaultSterlingLocale].started };
/** The extension's Chat container in the right-hand drawer; the rail's Chat shortcut opens and closes it, and its own tab is hidden. */
const chatContainerId = 'plugin-view-container:workbench.view.extension.nearAiSecondaryViewContainer';
const edition = {
  hero: 'sterling-hero-ca-defence.webp',
  workbenchClass: 'sterling-ca'
};

/** The right-hand rail's shortcuts, top to bottom. One with no command is a planned page, shown disabled. */
const railActions: ReadonlyArray<{ readonly label: SterlingMessage; readonly icon: string; readonly command?: string }> = [
  { label: 'started', icon: 'home', command: openWelcome.id },
  { label: 'portfolio', icon: 'graph', command: 'sterling.portfolio.open' },
  { label: 'chat', icon: 'comment-discussion', command: 'nearAi.openChat' },
  { label: 'teamStudio', icon: 'organization', command: 'nearAi.manageTeams' },
  { label: 'agentActivity', icon: 'pulse', command: 'nearAi.openAgentActivity' },
  { label: 'governance', icon: 'law', command: 'nearAi.policy.open' },
  { label: 'dataManagement', icon: 'database' },
  { label: 'modelFactory', icon: 'circuit-board' },
  { label: 'compliance', icon: 'shield', command: sterlingComplianceCommand.id },
  { label: 'documentation', icon: 'book', command: sterlingDocumentationCommand.id }
];

/** Get Started's work-area cards; each opens that work area's own page (sterling-work-areas-module.ts). */
const workAreaCards: ReadonlyArray<{ readonly label: SterlingMessage; readonly icon: string; readonly description: SterlingMessage; readonly kind: string }> = [
  { label: 'capability', icon: 'project', description: 'capabilityDescription', kind: 'capability-development' },
  { label: 'training', icon: 'mortar-board', description: 'trainingDescription', kind: 'training' },
  { label: 'planning', icon: 'checklist', description: 'planningDescription', kind: 'operations' },
  { label: 'resources', icon: 'layers', description: 'resourcesDescription', kind: 'resources' }
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

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(PreferenceProviderProvider)
  protected readonly preferenceProviders!: PreferenceProviderProvider;

  @postConstruct()
  protected initialize(): void {
    this.id = welcomeId;
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-welcome');
    this.node.innerHTML = `
      <main class="sterling-page">
        <header class="sterling-wordmark">
          <img width="1600" height="595" alt="Sterling">
          <span class="sterling-edition" data-welcome-text="edition"></span>
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
          <button type="button" class="sterling-motion">
            <i class="codicon codicon-debug-pause" aria-hidden="true"></i>
          </button>
          <div class="sterling-hero-copy">
            <h1 id="sterling-title">Sterling<br>Sovereign AI</h1>
            <p data-welcome-text="heroDescription"></p>
            <p class="sterling-domains" data-welcome-text="domains"></p>
            <div class="sterling-actions">
              <button type="button" class="sterling-primary" data-command="nearAi.setup"><span data-welcome-text="setup"></span> <i class="codicon codicon-arrow-right" aria-hidden="true"></i></button>
              <button type="button" class="sterling-secondary" data-command="nearAi.openChat" data-welcome-text="openChat"></button>
              <button type="button" class="sterling-secondary" data-command="near-ai.team-studio.preview" data-welcome-text="sampleTeam"></button>
            </div>
          </div>
        </section>
        <p class="sterling-status" role="status" hidden></p>
        <section class="sterling-destinations" aria-labelledby="sterling-destinations">
          <div class="sterling-section-heading">
            <h2 id="sterling-destinations" data-welcome-text="workAreas"></h2>
          </div>
          <p class="sterling-active-area" hidden></p>
          <ul class="sterling-area-components" hidden></ul>
          <div class="sterling-destination-grid">
            ${workAreaCards.map(({ kind, icon, label, description }) => `
              <button type="button" class="sterling-destination" data-command="sterling.workAreas.open" data-work-area="${kind}">
                <i class="sterling-destination-icon codicon codicon-${icon}" aria-hidden="true"></i>
                <strong data-welcome-text="${label}"></strong>
                <span data-welcome-text="${description}"></span>
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
    let copy = sterlingMessages[defaultSterlingLocale];
    const updateMotionName = (): void => {
      const action = hero.hasAttribute('data-motion-paused') ? copy.playMotion : copy.pauseMotion;
      motionButton.setAttribute('aria-label', action);
      motionButton.title = action;
    };
    motionButton.addEventListener('click', () => {
      const paused = hero.toggleAttribute('data-motion-paused');
      updateMotionName();
      motionButton.firstElementChild!.className = paused ? 'codicon codicon-play' : 'codicon codicon-debug-pause';
    });

    // The open work area, when the workspace is one: its title, and for a capability its components. Text only, from the validated record.
    const area = this.node.querySelector<HTMLElement>('.sterling-active-area')!;
    const components = this.node.querySelector<HTMLUListElement>('.sterling-area-components')!;
    let activeTitle: string | undefined;
    const updateActiveTitle = (): void => {
      const title = activeTitle;
      area.textContent = title === undefined ? '' : copy.activeArea.replace('{title}', () => title);
      area.hidden = title === undefined;
    };
    let areaRequest = 0;
    const showActiveArea = async (): Promise<void> => {
      const request = ++areaRequest;
      const roots = await this.workspaces.roots;
      if (request !== areaRequest || this.isDisposed) return;
      activeTitle = undefined;
      updateActiveTitle();
      components.hidden = true;
      components.replaceChildren();
      if (roots.length !== 1) return;
      const record = await readActiveWorkArea(this.files, roots[0].resource);
      if (!record || request !== areaRequest || this.isDisposed) return;
      activeTitle = record.title;
      updateActiveTitle();
      for (const { label, title } of record.components ?? []) {
        const item = document.createElement('li');
        item.textContent = `${label} · ${title}`;
        components.append(item);
      }
      components.hidden = components.childElementCount === 0;
    };
    this.toDispose.push(this.workspaces.onWorkspaceChanged(() => void showActiveArea()));
    void showActiveArea();

    const status = this.node.querySelector<HTMLElement>('.sterling-status')!;
    let notice: 'actionUnavailable' | 'actionFailed' | undefined;
    const showStatus = (message?: typeof notice): void => {
      notice = message;
      status.textContent = notice ? copy[notice] : '';
      status.hidden = notice === undefined;
    };
    this.node.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach(button => {
      button.addEventListener('click', async () => {
        const command = button.dataset.command!;
        showStatus();
        if (!this.commands.getCommand(command)) {
          showStatus('actionUnavailable');
          return;
        }
        try {
          if (button.dataset.workArea) {
            await this.commands.executeCommand(command, button.dataset.workArea);
          } else {
            await this.commands.executeCommand(command);
          }
        } catch {
          showStatus('actionFailed');
        }
      });
    });
    const labelled = this.node.querySelectorAll<HTMLElement>('[data-welcome-text]');
    const applyLocale = (locale: SterlingLocale): void => {
      copy = sterlingMessages[locale];
      this.node.lang = locale;
      this.title.label = copy.started;
      this.title.caption = `Sterling Sovereign AI (${copy.edition})`;
      labelled.forEach(node => { node.textContent = copy[node.dataset.welcomeText as SterlingMessage]; });
      components.setAttribute('aria-label', copy.areaComponents);
      updateMotionName();
      updateActiveTitle();
      if (notice) status.textContent = copy[notice];
    };
    applyLocale(defaultSterlingLocale);
    this.toDispose.push(observeSterlingLocale(this.preferences, this.preferenceProviders, applyLocale));
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }
}

@injectable()
class SterlingWelcomeContribution extends AbstractViewContribution<SterlingWelcomeWidget> implements FrontendApplicationContribution {
  private chatMotion?: { animation: Animation; opening: boolean };
  private localeSubscription?: Disposable;

  constructor() {
    super({ widgetId: welcomeId, widgetName: openWelcome.label, defaultWidgetOptions: { area: 'main' } });
  }

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(PreferenceProviderProvider)
  protected readonly preferenceProviders!: PreferenceProviderProvider;

  onStart(app: FrontendApplication): void {
    app.shell.addClass(edition.workbenchClass);
    const { tabBar } = app.shell.rightPanelHandler;
    tabBar.currentChanged.connect((_bar, { previousTitle, currentTitle }) => {
      if (currentTitle?.owner.id === chatContainerId) this.slideChat(true);
      else if (previousTitle?.owner.id === chatContainerId) this.stopChatMotion();
    });
    if (!(tabBar.parent instanceof Panel)) return;

    const shortcuts = document.createElement('nav');
    shortcuts.className = 'sterling-rail-shortcuts';
    const status = document.createElement('span');
    status.className = 'sterling-rail-status';
    status.setAttribute('role', 'status');

    const buttons: HTMLButtonElement[] = [];
    let copy = sterlingMessages[defaultSterlingLocale];
    let failedShortcut: SterlingMessage | undefined;
    const failureMessage = (label: SterlingMessage): string => copy.shortcutFailed.replace('{label}', copy[label]);
    const openShortcut = async (command: string, label: SterlingMessage): Promise<void> => {
      failedShortcut = undefined;
      status.textContent = '';
      try {
        await this.commandRegistry.executeCommand(command);
      } catch (error) {
        console.warn(`Sterling could not open ${command}.`, error);
        failedShortcut = label;
        const message = failureMessage(label);
        status.textContent = message;
        void this.messages.warn(message);
      }
    };

    for (const { label, icon, command } of railActions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sterling-rail-shortcut';
      buttons.push(button);
      const glyph = document.createElement('i');
      glyph.className = `codicon codicon-${icon}`;
      glyph.setAttribute('aria-hidden', 'true');
      button.append(glyph);
      if (!command) {
        button.setAttribute('aria-disabled', 'true');
      } else if (command === 'nearAi.openChat') {
        const syncExpanded = (): void => button.setAttribute('aria-expanded', String(this.chatIsOpen()));
        syncExpanded();
        tabBar.currentChanged.connect(syncExpanded);
        button.addEventListener('click', () => {
          if (this.chatMotion?.opening === false) {
            this.slideChat(true);
            return;
          }
          if (this.chatIsOpen()) {
            void this.collapseChat().catch(error => console.warn('Sterling could not toggle Chat.', error));
          } else {
            void openShortcut(command, label);
          }
        });
      } else {
        button.addEventListener('click', () => void openShortcut(command, label));
      }
      shortcuts.append(button);
    }
    shortcuts.append(status);
    tabBar.parent.insertWidget(0, new BaseWidget({ node: shortcuts }));
    tabBar.addClass('sterling-managed-rail');
    const applyLocale = (locale: SterlingLocale): void => {
      copy = sterlingMessages[locale];
      openWelcome.label = copy.started;
      shortcuts.lang = locale;
      shortcuts.setAttribute('aria-label', copy.shortcuts);
      railActions.forEach(({ label, command }, index) => {
        const button = buttons[index];
        button.title = command ? copy[label] : copy.planned.replace('{label}', copy[label]);
        button.setAttribute('aria-label', button.title);
      });
      if (failedShortcut) status.textContent = failureMessage(failedShortcut);
    };
    applyLocale(defaultSterlingLocale);
    this.localeSubscription = observeSterlingLocale(this.preferences, this.preferenceProviders, applyLocale);
  }

  onStop(): void { this.localeSubscription?.dispose(); }

  /** A workspace that is one work area opens on that work area's page; anything else opens on Get Started. */
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
    // The right-hand drawer holds Chat, so the editor's Outline moves to the left, on fresh and restored layouts. It moves only once Chat is
    // in the drawer: Theia hides an empty side bar, and the rail of shortcuts with it. Chat arrives after the layout when the plugin starts.
    const moveOutline = async (): Promise<void> => {
      const right = app.shell.getWidgets('right');
      const outline = right.find(widget => widget.id === 'outline-view');
      if (outline && right.some(widget => widget.id === chatContainerId)) await app.shell.addWidget(outline, { area: 'left', rank: 500 });
    };
    app.shell.onDidAddWidget(widget => {
      if (widget.id === chatContainerId || widget.id === 'outline-view') {
        void moveOutline().catch(error => console.warn('Sterling could not move the Outline.', error));
      }
    });
    await moveOutline();
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
    commands.registerCommand(openWelcome, {
      execute: () => this.openView({ activate: true })
    });
  }
}

export default new ContainerModule(bind => {
  bind(PreferenceContribution).toConstantValue(sterlingLanguagePreference);
  bind(SterlingWelcomeWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: welcomeId,
    createWidget: () => context.container.get(SterlingWelcomeWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingWelcomeContribution);
  bind(FrontendApplicationContribution).toService(SterlingWelcomeContribution);
});

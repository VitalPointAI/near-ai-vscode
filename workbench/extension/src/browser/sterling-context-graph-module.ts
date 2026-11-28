import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { PreferenceProviderProvider, PreferenceService } from '@theia/core/lib/common/preferences/index.js';
import { sterlingDocumentationCommand } from './sterling-documentation-module.js';
import { defaultSterlingLocale, observeSterlingLocale, sterlingMessages, type SterlingLocale } from './sterling-locale.js';
import './sterling-portfolio.css';

const widgetId = 'sterling-context-graph';
export const sterlingContextGraphCommand = {
  id: 'sterling.contextGraph.open', category: 'SovAI', label: sterlingMessages[defaultSterlingLocale].contextGraph
};

@injectable()
class SterlingContextGraphWidget extends BaseWidget {
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(PreferenceProviderProvider) protected readonly preferenceProviders!: PreferenceProviderProvider;

  private readonly heading = document.createElement('h1');
  private readonly description = document.createElement('p');
  private readonly status = document.createElement('p');
  private readonly documentation = document.createElement('button');
  private locale: SterlingLocale = defaultSterlingLocale;

  @postConstruct()
  protected initialize(): void {
    this.id = widgetId;
    this.title.closable = true;
    this.addClass('sterling-portfolio');

    const page = document.createElement('main');
    page.className = 'sterling-portfolio-page';
    this.heading.id = `${widgetId}-heading`;
    this.heading.tabIndex = -1;
    page.setAttribute('aria-labelledby', this.heading.id);
    this.description.className = 'sterling-portfolio-guidance';

    const unavailable = document.createElement('div');
    unavailable.className = 'sterling-portfolio-source';
    this.status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'sterling-portfolio-buttons';
    this.documentation.type = 'button';
    this.documentation.addEventListener('click', () => {
      void this.commands.executeCommand(sterlingDocumentationCommand.id).catch(() => {
        const copy = sterlingMessages[this.locale];
        void this.messages.warn(copy.shortcutFailed.replace('{label}', copy.documentation));
      });
    });
    actions.append(this.documentation);
    unavailable.append(this.status, actions);
    page.append(this.heading, this.description, unavailable);
    this.node.append(page);

    this.applyLocale(defaultSterlingLocale);
    this.toDispose.push(observeSterlingLocale(this.preferences, this.preferenceProviders, locale => this.applyLocale(locale)));
  }

  protected override onActivateRequest(): void {
    this.heading.focus();
  }

  private applyLocale(locale: SterlingLocale): void {
    this.locale = locale;
    const copy = sterlingMessages[locale];
    this.node.lang = locale;
    this.title.label = copy.contextGraph;
    this.title.caption = copy.contextGraph;
    this.heading.textContent = copy.contextGraph;
    this.description.textContent = copy.contextGraphDescription;
    this.status.textContent = copy.contextGraphUnavailable;
    this.documentation.textContent = copy.contextGraphDocumentation;
  }
}

@injectable()
class SterlingContextGraphContribution extends AbstractViewContribution<SterlingContextGraphWidget> {
  constructor() {
    super({ widgetId, widgetName: sterlingContextGraphCommand.label, defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(sterlingContextGraphCommand, { execute: () => this.openView({ activate: true }) });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingContextGraphWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId,
    createWidget: () => context.container.get(SterlingContextGraphWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingContextGraphContribution);
});

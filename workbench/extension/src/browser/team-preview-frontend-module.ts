import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common/command.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { bindFrontendService } from './frontend-service.js';
import { TEAM_PREVIEW_PATH, TeamPreviewService, type TeamPreviewResult } from '../common/team-preview.js';
import './team-preview.css';

const widgetId = 'near-ai-team-studio-preview';
const openTeamStudio: Command = { id: 'near-ai.team-studio.preview', label: 'Open Team Studio Preview', category: 'SovAI' };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

@injectable()
class TeamPreviewWidget extends BaseWidget {
  @inject(TeamPreviewService)
  private readonly service!: TeamPreviewService;

  private readonly projects = element('select', 'near-project-select');
  private readonly body = element('section', 'near-team-body');
  private request = 0;

  @postConstruct()
  protected init(): void {
    this.id = widgetId;
    this.node.tabIndex = -1;
    this.title.label = 'Team Studio';
    this.title.caption = 'Team Studio Preview';
    this.title.closable = true;
    this.addClass('near-team-preview');
    const shell = element('main', 'near-team-shell');
    const header = element('header', 'near-team-header');
    const label = element('label', 'near-project-field');
    label.append(element('span', undefined, 'Sample'), this.projects);
    header.append(element('h1', undefined, 'Team Studio'), label);
    shell.append(header, this.body);
    this.node.append(shell);
    this.projects.disabled = true;
    this.projects.addEventListener('change', () => void this.showProject());
    void this.loadProjects();
  }

  protected override onActivateRequest(): void {
    if (this.projects.disabled) this.node.focus();
    else this.projects.focus();
  }

  private async loadProjects(): Promise<void> {
    this.showMessage('Loading samples…');
    try {
      const projects = await this.service.listProjects();
      for (const project of projects) {
        const option = element('option', undefined, project.title);
        option.value = project.id;
        this.projects.append(option);
      }
      if (!projects.length) { this.showMessage('No samples are available.'); return; }
      this.projects.disabled = false;
      await this.showProject();
    } catch {
      this.showMessage('Team Studio could not load the samples.');
    }
  }

  private async showProject(): Promise<void> {
    const request = ++this.request;
    this.showMessage('Loading agent team…');
    try {
      const result = await this.service.readProject(this.projects.value);
      if (request !== this.request || this.isDisposed) return;
      if (result.kind === 'ready') this.showTeam(result.team);
      else this.showMessage(result.message);
    } catch {
      if (request === this.request && !this.isDisposed) this.showMessage('Team Studio could not read this sample.');
    }
  }

  private showMessage(message: string): void {
    const status = element('p', 'near-team-status', message);
    status.setAttribute('role', 'status');
    this.body.replaceChildren(status);
  }

  private showTeam(team: Extract<TeamPreviewResult, { kind: 'ready' }>['team']): void {
    const overview = element('div', 'near-team-overview');
    overview.append(element('h2', undefined, team.name));
    if (team.description) overview.append(element('p', undefined, team.description));
    const columns = element('div', 'near-team-columns');
    const roster = element('section', 'near-team-card near-team-roster');
    const detail = element('section', 'near-team-card near-team-detail');
    detail.setAttribute('aria-live', 'polite');
    roster.append(element('h3', undefined, 'Members'));
    const buttons = team.members.map((member) => {
      const button = element('button', 'near-team-member');
      button.type = 'button';
      button.append(element('strong', undefined, member.name));
      if (member.role) button.append(element('span', undefined, member.role));
      return button;
    });
    const select = (index: number): void => {
      const member = team.members[index];
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
      const items = [element('h3', undefined, member.name)];
      detail.replaceChildren(...items);
      if (member.role) detail.append(element('p', 'near-member-role', member.role));
      if (member.reportsTo) detail.append(element('p', 'near-member-reports', `Reports to ${member.reportsTo}`));
      if (member.instructions) detail.append(element('h4', undefined, 'Instructions'), element('p', 'near-member-instructions', member.instructions));
    };
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => select(index));
      roster.append(button);
    });
    if (buttons.length) select(0);
    else detail.append(element('p', undefined, 'This agent team has no members.'));
    columns.append(roster, detail);
    this.body.replaceChildren(overview, columns);
  }
}

@injectable()
class TeamPreviewContribution extends AbstractViewContribution<TeamPreviewWidget> {
  constructor() {
    super({ widgetId, widgetName: 'Team Studio', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(openTeamStudio, { execute: () => this.openView({ activate: true }) });
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<TeamPreviewService>(bind, TeamPreviewService, TEAM_PREVIEW_PATH);
  bind(TeamPreviewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: widgetId, createWidget: () => context.container.get(TeamPreviewWidget) })).inSingletonScope();
  bindViewContribution(bind, TeamPreviewContribution);
});

import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type URI from '@theia/core/lib/common/uri.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { FileOperationError, FileOperationResult } from '@theia/filesystem/lib/common/files.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service.js';
import {
  orderedPortfolioNodes, parsePortfolioSnapshot, portfolioLevels, portfolioSnapshotDirectory, portfolioSnapshotLimit, portfolioSnapshotName,
  portfolioStatuses, portfolioStatusLabels
} from '../common/sterling-portfolio.js';
import type { PortfolioNode, PortfolioSnapshot } from '../common/sterling-portfolio.js';
import './sterling-portfolio.css';

const widgetId = 'sterling-portfolio';
const disconnected = 'No local portfolio snapshot is loaded.';
const statuses = [...portfolioStatuses, 'unreported'] as const;
const pageSize = 100;
const pollSeconds = 5;
const formatTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function option(text: string, value = text): HTMLOptionElement {
  const result = element('option', text);
  result.value = value;
  return result;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element('label', text);
  label.append(control);
  return label;
}

function time(iso: string): HTMLTimeElement {
  const result = element('time', formatTime.format(new Date(iso)));
  result.dateTime = iso;
  result.title = iso;
  return result;
}

function badge(node: PortfolioNode): HTMLElement {
  const result = element('span', node.status ? portfolioStatusLabels[node.status] : 'Not reported', 'sterling-portfolio-badge');
  result.dataset.status = node.status ?? 'unreported';
  return result;
}

@injectable()
class SterlingPortfolio extends BaseWidget {
  @inject(WorkspaceService)
  protected readonly workspaces!: WorkspaceService;
  @inject(WorkspaceTrustService)
  protected readonly trust!: WorkspaceTrustService;
  @inject(FileService)
  protected readonly files!: FileService;

  private readonly source = element('select');
  private readonly load = element('button', 'Load snapshot');
  private readonly refresh = element('button', 'Refresh');
  private readonly disconnect = element('button', 'Disconnect');
  private readonly status = element('p', disconnected, 'sterling-portfolio-message');
  private readonly guidance = element('p', 'Choose a trusted workspace folder with an approved local portfolio export.', 'sterling-portfolio-guidance');
  private readonly provenance = element('dl', undefined, 'sterling-portfolio-provenance');
  private readonly report = element('section');
  private readonly overview = element('div', undefined, 'sterling-portfolio-levels');
  private readonly level = element('select');
  private readonly state = element('select');
  private readonly search = element('input');
  private readonly resultCount = element('p', undefined, 'sterling-portfolio-guidance');
  private readonly list = element('ul', undefined, 'sterling-portfolio-list');
  private readonly details = element('section', undefined, 'sterling-portfolio-detail');
  private readonly more = element('button', 'Show more');
  private roots: URI[] = [];
  private trusted = false;
  private sourceRoot?: URI;
  private sourceUri?: URI;
  private sourceEtag?: string;
  private readTask?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private revision = 0;
  private workspaceRevision = 0;
  private ordered: PortfolioNode[] = [];
  private index = new Map<string, PortfolioNode>();
  private selectedId?: string;
  private visible = pageSize;

  @postConstruct()
  protected initialize(): void {
    this.id = widgetId;
    this.title.label = 'Portfolio Room';
    this.title.caption = 'DND/CAF Portfolio Room';
    this.title.closable = true;
    this.addClass('sterling-portfolio');
    this.node.tabIndex = -1;
    const page = element('main', undefined, 'sterling-portfolio-page');
    const header = element('header');
    header.append(element('p', 'DND / CAF · L0–L5', 'sterling-portfolio-eyebrow'), element('h1', 'Portfolio Room'));

    const sourcePanel = element('section', undefined, 'sterling-portfolio-source');
    sourcePanel.append(element('h2', 'Local reporting snapshot'), this.guidance);
    const controls = element('div', undefined, 'sterling-portfolio-source-controls');
    const buttons = element('div', undefined, 'sterling-portfolio-buttons');
    buttons.append(this.load, this.refresh, this.disconnect);
    controls.append(labelled('Workspace folder', this.source), buttons);
    this.status.setAttribute('role', 'status');
    sourcePanel.append(controls, this.status, this.provenance);

    this.level.append(option('All levels', ''), ...portfolioLevels.map(level => option(level)));
    this.state.append(option('All statuses', ''), ...statuses.map(status =>
      option(status === 'unreported' ? 'Not reported' : portfolioStatusLabels[status], status)));
    this.search.type = 'search';
    this.search.placeholder = 'Name or ID';
    const filters = element('div', undefined, 'sterling-portfolio-filters');
    filters.append(labelled('Search hierarchy', this.search), labelled('Level', this.level), labelled('Reported status', this.state));
    const layout = element('div', undefined, 'sterling-portfolio-layout');
    const hierarchy = element('section');
    hierarchy.append(element('h2', 'Reporting hierarchy'), this.resultCount, this.list, this.more);
    layout.append(hierarchy, this.details);
    this.report.append(this.overview, filters, layout);
    page.append(header, sourcePanel, this.report);
    this.node.append(page);

    for (const button of [this.load, this.refresh, this.disconnect, this.more]) button.type = 'button';
    this.load.addEventListener('click', () => this.connect());
    this.refresh.addEventListener('click', () => void this.readSnapshot());
    this.disconnect.addEventListener('click', () => this.clearConnection());
    this.source.addEventListener('change', () => this.clearConnection());
    for (const filter of [this.level, this.state, this.search]) {
      filter.addEventListener('input', () => this.applyFilters());
    }
    this.more.addEventListener('click', () => { this.visible += pageSize; this.renderResults(); });

    this.toDispose.push(this.workspaces.onWorkspaceChanged(() => void this.setRoots()));
    this.toDispose.push(this.trust.onDidChangeWorkspaceTrust(value => this.setTrust(value)));
    this.toDispose.push(this.onDidChangeVisibility(visible => {
      this.updatePoll();
      if (visible) void this.readSnapshot(true);
    }));
    this.toDispose.push({ dispose: () => this.releaseSource() });
    void this.setRoots();
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }

  private async setRoots(): Promise<void> {
    const revision = ++this.workspaceRevision;
    this.trusted = false;
    this.roots = this.workspaces.tryGetRoots().filter(root =>
      root.isDirectory && !root.isSymbolicLink && root.resource.scheme === 'file' && !root.resource.authority).map(root => root.resource);
    const previous = this.source.value;
    this.source.replaceChildren(...this.roots.map(root => option(root.path.base || root.path.toString(), root.toString())));
    if (this.roots.some(root => root.toString() === previous)) this.source.value = previous;
    this.clearConnection();
    const trusted = await this.trust.getWorkspaceTrust().catch(() => false);
    if (!this.isDisposed && revision === this.workspaceRevision) this.setTrust(trusted);
  }

  private setTrust(value: boolean): void {
    this.trusted = value;
    if (!value) this.clearConnection();
    else this.renderControls();
  }

  private releaseSource(): void {
    this.revision += 1;
    this.sourceRoot = undefined;
    this.sourceUri = undefined;
    this.sourceEtag = undefined;
    this.readTask = undefined;
    this.updatePoll();
  }

  private clearConnection(): void {
    this.releaseSource();
    this.setSnapshot(undefined);
    this.level.value = '';
    this.state.value = '';
    this.search.value = '';
    this.status.textContent = disconnected;
    this.status.classList.remove('is-warning');
    this.renderControls();
  }

  private renderControls(): void {
    this.source.disabled = !this.trusted || this.roots.length === 0;
    this.load.disabled = this.source.disabled;
    this.refresh.hidden = !this.sourceUri;
    this.disconnect.hidden = !this.sourceUri;
    this.load.hidden = Boolean(this.sourceUri);
    this.guidance.textContent = !this.roots.length ? 'Open a local workspace folder to load an approved export.'
      : !this.trusted ? 'Portfolio imports are disabled in Restricted Mode.'
        : `Choose a workspace folder containing ${portfolioSnapshotDirectory}/${portfolioSnapshotName}. Load only approved non-sensitive exports.`;
  }

  private connect(): void {
    const root = this.roots.find(uri => uri.toString() === this.source.value);
    if (!this.trusted || !root) return;
    this.clearConnection();
    this.sourceRoot = root;
    this.sourceUri = root.resolve(portfolioSnapshotDirectory).resolve(portfolioSnapshotName);
    this.renderControls();
    this.updatePoll();
    void this.readSnapshot();
  }

  private updatePoll(): void {
    clearInterval(this.poll);
    this.poll = this.sourceUri && this.isVisible
      ? setInterval(() => void this.readSnapshot(true), pollSeconds * 1000)
      : undefined;
  }

  private async readSnapshot(skipUnchanged = false): Promise<void> {
    if (this.readTask) return this.readTask;
    const task = this.readCurrentSource(skipUnchanged);
    this.readTask = task;
    try { await task; } finally {
      if (this.readTask === task) this.readTask = undefined;
    }
  }

  private async readCurrentSource(skipUnchanged: boolean): Promise<void> {
    const uri = this.sourceUri;
    const root = this.sourceRoot;
    if (!this.trusted || !uri || !root) return;
    const directories = [root, root.resolve('.planning'), uri.parent];
    const revision = ++this.revision;
    const current = (): boolean => !this.isDisposed && revision === this.revision && this.trusted;
    const localDirectories = async (): Promise<boolean> => {
      for (const directory of directories) {
        const info = await this.files.resolve(directory);
        if (!current() || !info.isDirectory || info.isSymbolicLink) return false;
      }
      return true;
    };
    try {
      if (!await localDirectories()) {
        if (current()) this.reportProblem('Choose a local folder whose snapshot path uses regular directories.');
        return;
      }
      const file = await this.files.resolve(uri, { resolveMetadata: true });
      if (!current()) return;
      if (!file.isFile || file.isSymbolicLink || file.size > portfolioSnapshotLimit) {
        this.reportProblem('Use a regular workspace file no larger than 512 KB.');
        return;
      }
      if (skipUnchanged && this.sourceEtag === file.etag) return;
      const content = await this.files.read(uri, { limits: { size: portfolioSnapshotLimit } });
      if (!await localDirectories()) {
        if (current()) this.reportProblem('The snapshot folder changed while being read. Refresh to try again.');
        return;
      }
      const readFile = await this.files.resolve(uri, { resolveMetadata: true });
      if (!current()) return;
      if (!readFile.isFile || readFile.isSymbolicLink || file.etag !== readFile.etag) {
        this.reportProblem('The snapshot changed while being read. Refresh to try again.');
        return;
      }
      const snapshot = parsePortfolioSnapshot(content.value);
      if (!snapshot) {
        this.reportProblem('The file does not contain a valid Portfolio Room snapshot.');
        return;
      }
      this.sourceEtag = readFile.etag;
      this.setSnapshot(snapshot);
      this.status.textContent = `Local snapshot loaded. The view checks this file every ${pollSeconds} seconds while open.`;
      this.status.classList.remove('is-warning');
    } catch (error) {
      if (!current()) return;
      const missing = error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
      this.reportProblem(missing ? `No ${portfolioSnapshotDirectory}/${portfolioSnapshotName} in the selected workspace.` : 'The snapshot could not be read.');
    }
  }

  private reportProblem(text: string): void {
    this.sourceEtag = undefined;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.setSnapshot(undefined);
    this.status.classList.add('is-warning');
  }

  private setSnapshot(snapshot: PortfolioSnapshot | undefined): void {
    this.ordered = snapshot ? orderedPortfolioNodes(snapshot.nodes) : [];
    this.index = new Map(this.ordered.map(node => [node.id, node]));
    this.provenance.replaceChildren();
    if (snapshot) {
      const field = (title: string, value: HTMLElement | string): HTMLElement => {
        const entry = element('div');
        const data = element('dd');
        data.append(value);
        entry.append(element('dt', title), data);
        return entry;
      };
      this.provenance.append(
        field('Reported source', snapshot.source),
        field('Export generated', time(snapshot.generatedAt)),
        field('Read locally', time(new Date().toISOString()))
      );
    }
    this.report.hidden = !snapshot;
    if (snapshot) this.applyFilters();
    else {
      this.selectedId = undefined;
      this.overview.replaceChildren();
      this.list.replaceChildren();
      this.details.replaceChildren();
      this.resultCount.textContent = '';
    }
  }

  private applyFilters(): void {
    this.visible = pageSize;
    this.renderOverview();
    this.renderResults();
  }

  private renderOverview(): void {
    const counts = new Map(portfolioLevels.map(level => [level, 0]));
    for (const node of this.ordered) counts.set(node.level, counts.get(node.level)! + 1);
    this.overview.replaceChildren(...portfolioLevels.map(level => {
      const button = element('button', undefined, 'sterling-portfolio-level');
      button.type = 'button';
      const count = counts.get(level)!;
      button.append(element('span', level), element('strong', String(count)));
      button.setAttribute('aria-label', `${level}, ${count} ${count === 1 ? 'entry' : 'entries'}`);
      button.setAttribute('aria-pressed', String(this.level.value === level));
      button.addEventListener('click', () => {
        this.level.value = this.level.value === level ? '' : level;
        this.applyFilters();
        (this.overview.children[portfolioLevels.indexOf(level)] as HTMLElement).focus();
      });
      return button;
    }));
  }

  private renderResults(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    const filtered = this.ordered.filter(node =>
      (!this.level.value || node.level === this.level.value)
      && (!this.state.value || (node.status ?? 'unreported') === this.state.value)
      && (!query || `${node.name} ${node.id}`.toLocaleLowerCase().includes(query)));
    const rows = filtered.slice(0, this.visible);
    this.resultCount.textContent = filtered.length
      ? `Showing ${rows.length} of ${filtered.length} entries`
      : (this.ordered.length ? 'No entries match the filters.' : 'The export contains no entries.');
    this.more.hidden = filtered.length <= this.visible;
    if (!rows.some(node => node.id === this.selectedId)) this.selectedId = rows[0]?.id;
    this.list.replaceChildren(...rows.map(node => {
      const row = element('li');
      const select = element('button', undefined, 'sterling-portfolio-row');
      select.type = 'button';
      select.style.setProperty('--portfolio-level-depth', String(portfolioLevels.indexOf(node.level)));
      select.dataset.id = node.id;
      select.setAttribute('aria-pressed', String(node.id === this.selectedId));
      select.append(element('span', node.level, 'sterling-portfolio-node-level'), element('span', node.name, 'sterling-portfolio-node-name'), badge(node));
      select.addEventListener('click', () => {
        this.selectedId = node.id;
        this.list.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === select)));
        this.renderDetails();
      });
      row.append(select);
      return row;
    }));
    this.renderDetails();
  }

  private renderDetails(): void {
    const node = this.selectedId ? this.index.get(this.selectedId) : undefined;
    this.details.hidden = !node;
    if (!node) { this.details.replaceChildren(); return; }
    const parents = [];
    let parent = node.parentId ? this.index.get(node.parentId) : undefined;
    while (parent) {
      parents.unshift(parent.name);
      parent = parent.parentId ? this.index.get(parent.parentId) : undefined;
    }
    const when = element('p', 'Status as of ', 'sterling-portfolio-guidance');
    when.append(node.asOf ? time(node.asOf) : 'Not reported');
    this.details.replaceChildren(element('p', node.level, 'sterling-portfolio-eyebrow'), element('h2', node.name));
    if (parents.length) this.details.append(element('p', parents.join(' › '), 'sterling-portfolio-guidance'));
    this.details.append(badge(node), when);
    if (node.reason) this.details.append(element('p', node.reason));
  }
}

@injectable()
class SterlingPortfolioContribution extends AbstractViewContribution<SterlingPortfolio> {
  constructor() {
    super({ widgetId, widgetName: 'Portfolio Room', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.portfolio.open', category: 'SovAI', label: 'Portfolio Room' }, {
      execute: async () => { await this.openView({ activate: true }); }
    });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingPortfolio).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId,
    createWidget: () => context.container.get(SterlingPortfolio)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingPortfolioContribution);
});

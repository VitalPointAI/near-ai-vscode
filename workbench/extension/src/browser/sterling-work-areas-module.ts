import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import URI from '@theia/core/lib/common/uri.js';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell.js';
import { WidgetFactory, WidgetManager } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import type { FileStat } from '@theia/filesystem/lib/common/files.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service.js';
import { workAreaKind, type WorkAreaKind, type WorkAreaResourceRef } from '../common/sterling-work-areas.js';
import { listWorkAreas, verifyWorkArea, type LocalWorkArea } from './sterling-work-area-files.js';
import { linkWorkAreaResource } from './sterling-work-area-resource-links.js';
import { mountShareSection } from './staff/share-part.js';
import './sterling-work-areas.css';

const factoryId = 'sterling-work-areas';
const openCommand = 'sterling.workAreas.open';
const createCommand = 'sterling.workAreas.create';
const inventory = { label: 'Open resource inventory', command: 'sterling.resources.open' };

interface Shortcut {
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly currentProject?: true;
}

interface AreaPage {
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly create: string;
  readonly shortcuts: readonly Shortcut[];
}

const pages: Record<WorkAreaKind, AreaPage> = {
  'capability-development': {
    title: 'Capability Development',
    description: 'Organize the programs, projects, and products that deliver a capability.',
    image: 'sterling-area-capability.webp',
    create: 'Create capability',
    shortcuts: [
      { label: 'Current project setup', command: 'nearAi.projectSetup', currentProject: true },
      { label: 'Open Portfolio Room', command: 'sterling.portfolio.open' }
    ]
  },
  training: {
    title: 'Exercises & Training',
    description: 'Prepare exercises and organize training.',
    image: 'sterling-area-training.webp',
    create: 'Create training work area',
    shortcuts: [
      { label: 'Set up a staff team', command: 'nearAi.setUpStaffTeam' },
      { label: 'Open Staff Room', command: 'nearAi.openStaffRoom', currentProject: true }
    ]
  },
  // Keep the stored work-area kind so existing records open in Planning.
  operations: {
    title: 'Planning',
    description: 'Develop strategic, operational, and tactical plans. Use outcomes and lessons learned to inform future plans and courses of action.',
    image: 'sterling-area-planning.webp',
    create: 'Create planning work area',
    shortcuts: [
      { label: 'Open Staff Room', command: 'nearAi.openStaffRoom', args: ['war-room'], currentProject: true },
      { label: 'Open Agent Activity', command: 'nearAi.openAgentActivity', currentProject: true }
    ]
  },
  resources: {
    title: 'Resource Management',
    description: 'Coordinate people, equipment, and capacity.',
    image: 'sterling-area-resources.webp',
    create: 'Create resource work area',
    shortcuts: []
  }
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text: string, className: string, action: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', () => action(node));
  return node;
}

@injectable()
class WorkAreaLanding extends BaseWidget {
  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  @inject(WorkspaceService)
  protected readonly workspaces!: WorkspaceService;

  @inject(FileService)
  protected readonly files!: FileService;

  @inject(WorkspaceTrustService)
  protected readonly trust!: WorkspaceTrustService;

  private kind!: WorkAreaKind;
  private readonly source = element('select');
  private readonly records = element('ul', undefined, 'sterling-area-records');
  private readonly status = element('p', undefined, 'sterling-area-status');
  private readonly feedback = element('p', undefined, 'sterling-area-feedback');
  private roots: FileStat[] = [];
  private revision = 0;

  initialize(kind: WorkAreaKind): void {
    this.kind = kind;
    const config = pages[kind];
    this.id = `sterling-area-${kind}`;
    this.title.label = config.title;
    this.title.caption = config.title;
    this.title.closable = true;
    this.addClass('sterling-area');
    this.node.tabIndex = -1;

    const main = element('main', undefined, 'sterling-area-page');
    const back = button('Get Started', 'sterling-area-back', () => void this.run('sterling.getStarted'));
    const arrow = element('i', undefined, 'codicon codicon-arrow-left');
    arrow.setAttribute('aria-hidden', 'true');
    back.prepend(arrow);

    const hero = element('header', undefined, 'sterling-area-hero');
    const image = element('img', undefined, 'sterling-area-art');
    image.src = config.image;
    image.alt = '';
    hero.append(image);
    const copy = element('div', undefined, 'sterling-area-hero-copy');
    const actions = element('div', undefined, 'sterling-area-actions');
    const create = button(config.create, 'sterling-area-primary', control => void this.create(control));
    create.dataset.action = 'create-work-area';
    const openInventory = button(inventory.label, 'sterling-area-action', () => void this.run(inventory.command));
    openInventory.dataset.action = 'open-resource-inventory';
    actions.append(...(kind === 'resources' ? [openInventory, create] : [create, openInventory]));
    copy.append(element('h1', config.title), element('p', config.description), actions);
    hero.append(copy);

    const shortcuts = element('nav', undefined, 'sterling-area-shortcuts');
    shortcuts.setAttribute('aria-label', 'Work area tools');
    for (const action of config.shortcuts) {
      shortcuts.append(button(action.label, 'sterling-area-action', () => void this.runShortcut(action)));
    }
    this.feedback.setAttribute('role', 'status');
    this.feedback.hidden = true;

    const local = element('section', undefined, 'sterling-area-local');
    const header = element('header', undefined, 'sterling-area-local-header');
    const title = element('h2', 'Local work areas');
    title.id = `${this.id}-local`;
    local.setAttribute('aria-labelledby', title.id);
    const tools = element('div', undefined, 'sterling-area-tools');
    const label = element('label', 'Work-area folder');
    label.append(this.source);
    tools.append(label, button('Refresh', 'sterling-area-action', () => void this.load()));
    header.append(title, tools);
    this.status.setAttribute('role', 'status');
    local.append(header, this.status, this.records);
    main.append(back, hero, this.feedback);
    if (config.shortcuts.length) main.append(shortcuts);
    main.append(local);
    if (kind === 'training' || kind === 'operations') { const share = mountShareSection(main); if (share) this.toDispose.push(share); }
    this.node.append(main);

    this.source.addEventListener('change', () => { void this.load(); });
    this.toDispose.push(this.workspaces.onWorkspaceChanged(roots => this.updateRoots(roots)));
    void this.workspaces.roots.then(roots => this.updateRoots(roots));
  }

  private updateRoots(roots: FileStat[]): void {
    if (this.isDisposed) return;
    const selected = this.source.value;
    this.roots = roots.filter(root => root.resource.scheme === 'file' && !root.resource.authority && root.isDirectory && !root.isSymbolicLink);
    this.source.replaceChildren(...this.roots.map(root => {
      const name = this.workspaces.getConfiguredRootName(root.resource) ?? root.resource.path.base ?? root.name;
      const option = element('option', name);
      option.value = root.resource.toString();
      option.title = root.resource.path.toString();
      return option;
    }));
    if (this.roots.some(root => root.resource.toString() === selected)) this.source.value = selected;
    this.source.disabled = this.roots.length < 2;
    void this.load();
  }

  private async load(): Promise<void> {
    const token = ++this.revision;
    const value = this.source.value;
    const root = this.roots.find(item => item.resource.toString() === value)?.resource;
    this.records.replaceChildren();
    if (!root) {
      this.status.textContent = 'Open a local folder to see its work areas.';
      return;
    }
    this.status.textContent = 'Looking for local work areas…';
    const current = () => !this.isDisposed && this.revision === token && this.source.value === value;
    try {
      const { entries, limited } = await listWorkAreas(this.files, root, this.kind, current);
      if (!current()) return;
      const empty = 'No work areas of this type in the selected folder.';
      const limit = ' Checked the first 64 work-area folders.';
      this.status.textContent = (entries.length ? '' : empty) + (limited ? limit : '');
      this.records.replaceChildren(...entries.map(area => this.item(root, area)));
    } catch {
      if (current()) this.status.textContent = 'The selected folder could not be read.';
    }
  }

  private item(root: URI, area: LocalWorkArea): HTMLElement {
    const item = element('li', undefined, 'sterling-area-record-item');
    const current = root.isEqual(area.uri);
    const open = button('', 'sterling-area-record', control => void this.openExisting(root, area, control));
    open.disabled = current;
    const title = element('strong', area.title);
    const indicator = element('span', current ? 'Open work area' : 'Open', 'sterling-area-record-open');
    open.append(title, indicator);
    if (area.detail) open.append(element('span', area.detail, 'sterling-area-record-detail'));
    const link = button('Link a resource', 'sterling-area-action sterling-area-link', control => void this.pickResource(root, area, control));
    link.setAttribute('aria-label', `Link a resource to ${area.title}`);
    item.append(open, link);
    if (area.resourceRefs?.length) {
      const references = element('ul', undefined, 'sterling-area-references');
      references.setAttribute('aria-label', 'Linked resource references');
      for (const { sourceId, resourceId } of area.resourceRefs) {
        const reference = element('li');
        reference.append(element('code', `resource:${sourceId}/${resourceId}`));
        references.append(reference);
      }
      item.append(references);
    }
    return item;
  }

  private isSelected(root: URI): boolean {
    return !this.isDisposed && this.source.value === root.toString() &&
      this.workspaces.tryGetRoots().some(item => item.resource.isEqual(root));
  }

  private async pickResource(root: URI, area: LocalWorkArea, control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    this.feedback.hidden = true;
    try {
      if (!await this.trust.getWorkspaceTrust() || !this.isSelected(root)) {
        this.showFeedback('Open a trusted work-area folder to link resources.');
        return;
      }
      await this.commands.executeCommand(inventory.command, {
        rootUri: root.toString(),
        onSelect: async (ref: WorkAreaResourceRef) => {
          if (!this.isSelected(root) || !await verifyWorkArea(this.files, root, area) ||
            !await this.trust.getWorkspaceTrust() || !this.isSelected(root)) {
            throw new Error('The selected folder or work area changed. Open the resource picker again.');
          }
          await linkWorkAreaResource(this.files, root, area.uri, ref);
          if (this.isSelected(root)) void this.load();
        }
      });
    } catch {
      this.showFeedback('Sterling could not open the resource picker.');
    } finally {
      control.disabled = false;
    }
  }

  private async openExisting(root: URI, area: LocalWorkArea, control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    this.feedback.hidden = true;
    try {
      if (!await verifyWorkArea(this.files, root, area) || !this.isSelected(root)) {
        this.showFeedback('That work area changed. Refresh the list and try again.');
        return;
      }
      this.workspaces.open(area.uri, { preserveWindow: true });
    } catch {
      this.showFeedback('Sterling could not open this work area.');
    } finally {
      control.disabled = false;
    }
  }

  private async create(control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    this.feedback.hidden = true;
    try {
      const result = await this.commands.executeCommand<{ uri: string } | undefined>(createCommand, this.kind);
      if (result?.uri) {
        const folder = new URI(result.uri);
        if (folder.scheme !== 'file' || folder.authority) throw new Error('Invalid work area URI');
        this.workspaces.open(folder, { preserveWindow: true });
      }
    } catch {
      this.showFeedback('Sterling could not create or open this work area.');
    } finally {
      control.disabled = false;
    }
  }

  private async runShortcut(shortcut: Shortcut): Promise<void> {
    if (shortcut.currentProject && this.workspaces.tryGetRoots()[0]?.resource.toString() !== this.source.value) {
      this.showFeedback('Open the intended work area before using this tool.');
      return;
    }
    await this.run(shortcut.command, ...(shortcut.args ?? []));
  }

  private async run(command: string, ...args: string[]): Promise<void> {
    this.feedback.hidden = true;
    try {
      await this.commands.executeCommand(command, ...args);
    } catch {
      this.showFeedback('This tool is unavailable in the current workbench.');
    }
  }

  private showFeedback(text: string): void {
    this.feedback.textContent = text;
    this.feedback.hidden = false;
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }
}

@injectable()
class WorkAreaContribution implements CommandContribution {
  @inject(WidgetManager)
  protected readonly widgets!: WidgetManager;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand({ id: openCommand }, {
      execute: async (value: unknown) => {
        const kind = workAreaKind(value);
        if (!kind) return;
        const widget = await this.widgets.getOrCreateWidget<WorkAreaLanding>(factoryId, { kind });
        if (!widget.isAttached) await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
      }
    });
  }
}

export default new ContainerModule(bind => {
  bind(WorkAreaLanding).toSelf();
  bind(WorkAreaContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(WorkAreaContribution);
  bind(WidgetFactory).toDynamicValue(context => ({
    id: factoryId,
    createWidget: (options: { kind?: unknown } | undefined) => {
      const kind = workAreaKind(options?.kind);
      if (!kind) throw new Error('Unknown work area');
      const widget = context.container.get(WorkAreaLanding);
      widget.initialize(kind);
      return widget;
    }
  })).inSingletonScope();
});

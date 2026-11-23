import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type URI from '@theia/core/lib/common/uri.js';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { FileOperationError, FileOperationResult } from '@theia/filesystem/lib/common/files.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service.js';
import {
  inventoryDirectory, inventoryFileName, inventoryReference, inventorySizeLimit, inventoryStatuses, parseInventorySnapshot
} from '../common/sterling-resource-inventory.js';
import type { InventoryLinkRequest, InventoryRecord, InventorySnapshot } from '../common/sterling-resource-inventory.js';
import './sterling-portfolio.css';
import './sterling-resource-inventory.css';

const widgetId = 'sterling-resource-inventory';
const snapshotPath = `${inventoryDirectory}/${inventoryFileName}`;
const pollSeconds = 5;
const pageSize = 100;
const notReported = 'Not reported';
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const quantityFormatter = new Intl.NumberFormat();

interface Connection {
  root: URI;
  file: URI;
  etag?: string;
  readTask?: Promise<void>;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function button(text: string): HTMLButtonElement {
  const result = node('button', text);
  result.type = 'button';
  return result;
}

function option(text: string, value: string): HTMLOptionElement {
  const result = node('option', text);
  result.value = value;
  return result;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const result = node('label', text);
  result.append(control);
  return result;
}

function date(iso: string): HTMLTimeElement {
  const result = node('time', formatter.format(new Date(iso)));
  result.dateTime = iso;
  result.title = iso;
  return result;
}

function field(label: string, value: string | HTMLElement): HTMLElement {
  const result = node('div');
  const content = node('dd');
  content.append(value);
  result.append(node('dt', label), content);
  return result;
}

function quantity(record: InventoryRecord): string {
  if (record.quantity === undefined) return notReported;
  const formatted = quantityFormatter.format(record.quantity);
  return record.unit ? `${formatted} ${record.unit}` : formatted;
}

@injectable()
class SterlingResourceInventory extends BaseWidget {
  @inject(WorkspaceService) protected readonly workspaces!: WorkspaceService;
  @inject(WorkspaceTrustService) protected readonly trust!: WorkspaceTrustService;
  @inject(FileService) protected readonly files!: FileService;
  @inject(ClipboardService) protected readonly clipboard!: ClipboardService;

  private readonly folder = node('select');
  private readonly load = button('Load snapshot');
  private readonly refresh = button('Refresh');
  private readonly disconnect = button('Disconnect');
  private readonly guidance = node('p', undefined, 'sterling-portfolio-guidance');
  private readonly status = node('p', undefined, 'sterling-portfolio-message');
  private readonly provenance = node('dl', undefined, 'sterling-portfolio-provenance');
  private readonly content = node('section');
  private readonly search = node('input');
  private readonly category = node('select');
  private readonly state = node('select');
  private readonly results = node('p', undefined, 'sterling-portfolio-guidance');
  private readonly list = node('ul', undefined, 'sterling-portfolio-list');
  private readonly details = node('section', undefined, 'sterling-resource-detail');
  private readonly more = button('Show more');
  private readonly linkFeedback = node('p', undefined, 'sterling-portfolio-guidance');
  private roots: URI[] = [];
  private trusted = false;
  private workspaceRevision = 0;
  private connection?: Connection;
  private timer?: ReturnType<typeof setInterval>;
  private snapshot?: InventorySnapshot;
  private ordered: InventoryRecord[] = [];
  private selected?: string;
  private linkRequest?: InventoryLinkRequest;
  private linkAction?: object;
  private visible = pageSize;

  @postConstruct()
  protected initialize(): void {
    this.id = widgetId;
    this.title.label = 'Resource Inventory';
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-portfolio');
    this.addClass('sterling-resource-inventory');
    const page = node('main', undefined, 'sterling-portfolio-page');
    const heading = node('header');
    heading.append(node('h1', 'Resource Inventory'));

    const source = node('section', undefined, 'sterling-portfolio-source');
    const tools = node('div', undefined, 'sterling-portfolio-source-controls');
    const actions = node('div', undefined, 'sterling-portfolio-buttons');
    actions.append(this.load, this.refresh, this.disconnect);
    tools.append(labelled('Workspace folder', this.folder), actions);
    this.status.setAttribute('role', 'status');
    this.linkFeedback.setAttribute('role', 'status');
    source.append(node('h2', 'Local inventory snapshot'), this.guidance, tools, this.status, this.linkFeedback, this.provenance);

    const filters = node('div', undefined, 'sterling-portfolio-filters');
    this.search.type = 'search';
    this.search.placeholder = 'Name, ID, DID, stock number or policy';
    this.state.append(option('All statuses', ''), ...Object.entries(inventoryStatuses).map(([id, label]) => option(label, id)),
      option(notReported, 'unreported'));
    filters.append(labelled('Search resources', this.search), labelled('Category', this.category), labelled('Reported status', this.state));
    const layout = node('div', undefined, 'sterling-portfolio-layout');
    const records = node('section');
    records.append(node('h2', 'Resources'), this.results, this.list, this.more);
    layout.append(records, this.details);
    this.content.append(filters, layout);
    page.append(heading, source, this.content);
    this.node.append(page);

    this.load.addEventListener('click', () => this.connect());
    this.refresh.addEventListener('click', () => void this.read(false));
    this.disconnect.addEventListener('click', () => this.clear());
    this.folder.addEventListener('change', () => this.clear());
    for (const control of [this.search, this.category, this.state]) {
      control.addEventListener('input', () => { this.visible = pageSize; this.renderResults(); });
    }
    this.more.addEventListener('click', () => { this.visible += pageSize; this.renderResults(); });
    this.toDispose.push(this.workspaces.onWorkspaceChanged(() => void this.resetWorkspace()));
    this.toDispose.push(this.trust.onDidChangeWorkspaceTrust(trusted => this.setTrust(trusted)));
    this.toDispose.push(this.onDidChangeVisibility(visible => {
      this.updatePoll();
      if (visible) void this.read(true);
    }));
    this.toDispose.push({ dispose: () => this.clear() });
    void this.resetWorkspace();
  }

  protected override onActivateRequest(): void { this.node.focus(); }

  private async resetWorkspace(): Promise<void> {
    const revision = ++this.workspaceRevision;
    this.trusted = false;
    this.roots = this.workspaces.tryGetRoots().filter(root =>
      root.isDirectory && !root.isSymbolicLink && root.resource.scheme === 'file' && !root.resource.authority).map(root => root.resource);
    this.renderFolders();
    this.clear();
    const trusted = await this.trust.getWorkspaceTrust().catch(() => false);
    if (!this.isDisposed && this.workspaceRevision === revision) this.setTrust(trusted);
  }

  public setLinkRequest(request?: InventoryLinkRequest): void {
    if (request === this.linkRequest) return;
    this.linkRequest = request;
    this.renderFolders();
    this.clear();
  }

  private allowedRoots(): URI[] {
    const requestedRoot = this.linkRequest?.rootUri;
    return requestedRoot ? this.roots.filter(root => root.toString() === requestedRoot) : this.roots;
  }

  private renderFolders(): void {
    const previous = this.folder.value;
    const eligible = this.allowedRoots();
    this.folder.replaceChildren(...eligible.map(root => option(root.path.base || root.path.toString(), root.toString())));
    if (eligible.some(root => root.toString() === previous)) this.folder.value = previous;
  }

  private setTrust(trusted: boolean): void {
    this.trusted = trusted;
    if (trusted) this.renderSource();
    else this.clear();
  }

  private clear(): void {
    this.connection = undefined;
    this.linkAction = undefined;
    this.linkFeedback.textContent = '';
    this.updatePoll();
    this.search.value = '';
    this.state.value = '';
    this.setSnapshot(undefined);
    this.status.textContent = 'No resource inventory snapshot is loaded.';
    this.status.classList.remove('is-warning');
    this.renderSource();
  }

  private connect(): void {
    const root = this.allowedRoots().find(candidate => candidate.toString() === this.folder.value);
    if (!root || !this.trusted) return;
    this.clear();
    this.connection = { root, file: root.resolve(inventoryDirectory).resolve(inventoryFileName) };
    this.renderSource();
    this.updatePoll();
    void this.read(false);
  }

  private renderSource(): void {
    const roots = this.allowedRoots();
    this.load.disabled = !this.trusted || !roots.length;
    this.folder.disabled = this.load.disabled || Boolean(this.linkRequest);
    this.load.hidden = Boolean(this.connection);
    this.refresh.hidden = this.disconnect.hidden = !this.connection;
    if (this.linkRequest && !roots.length) {
      this.guidance.textContent = 'Open the work-area folder again to link a resource from its inventory.';
    } else if (!roots.length) {
      this.guidance.textContent = 'Open a local workspace folder to load an approved export.';
    } else if (!this.trusted) {
      this.guidance.textContent = 'Resource Inventory imports are disabled in Restricted Mode.';
    } else {
      const action = this.linkRequest ? 'Load the work-area snapshot to select a resource.' : 'Quantity and status come from the file.';
      this.guidance.textContent = `Load an approved non-sensitive export from ${snapshotPath}. ${action}`;
    }
  }

  private updatePoll(): void {
    clearInterval(this.timer);
    this.timer = this.connection && this.isVisible ? setInterval(() => void this.read(true), pollSeconds * 1000) : undefined;
  }

  private async read(skipUnchanged: boolean): Promise<void> {
    const source = this.connection;
    if (!source || !this.trusted) return;
    if (source.readTask) return source.readTask;
    const task = this.readCurrentSource(source, skipUnchanged);
    source.readTask = task;
    try { await task; } finally {
      if (source.readTask === task) source.readTask = undefined;
    }
  }

  private async readCurrentSource(source: Connection, skipUnchanged: boolean): Promise<void> {
    const current = (): boolean => !this.isDisposed && this.trusted && this.connection === source;
    const localPath = async (): Promise<boolean> => {
      for (const parent of [source.root, source.root.resolve('.planning'), source.file.parent]) {
        const stat = await this.files.resolve(parent);
        if (!current() || !stat.isDirectory || stat.isSymbolicLink) return false;
      }
      return true;
    };
    const fail = (text: string): void => {
      if (!current()) return;
      source.etag = undefined;
      this.setSnapshot(undefined);
      if (this.status.textContent !== text) this.status.textContent = text;
      this.status.classList.add('is-warning');
    };
    try {
      if (!await localPath()) { fail('The snapshot path must use regular workspace directories.'); return; }
      if (!current()) return;
      const before = await this.files.resolve(source.file, { resolveMetadata: true });
      if (!current()) return;
      if (!before.isFile || before.isSymbolicLink || before.size > inventorySizeLimit) {
        fail('Use a regular workspace file no larger than 512 KB.');
        return;
      }
      if (skipUnchanged && source.etag === before.etag) return;
      const content = await this.files.read(source.file, { limits: { size: inventorySizeLimit } });
      if (!await localPath()) { fail('The snapshot directory changed during the read.'); return; }
      const after = await this.files.resolve(source.file, { resolveMetadata: true });
      if (!current()) return;
      if (!after.isFile || after.isSymbolicLink || after.etag !== before.etag || content.etag !== after.etag) {
        fail('The snapshot changed while being read. Refresh to try again.');
        return;
      }
      const snapshot = parseInventorySnapshot(content.value);
      if (!snapshot) { fail('The file does not contain a valid resource inventory snapshot.'); return; }
      source.etag = after.etag;
      this.setSnapshot(snapshot);
      this.status.textContent = `Local snapshot loaded. Changes are checked every ${pollSeconds} seconds while visible.`;
      this.status.classList.remove('is-warning');
    } catch (error) {
      const missing = error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
      fail(missing ? `No ${snapshotPath} in the selected workspace.` : 'The snapshot could not be read.');
    }
  }

  private setSnapshot(snapshot: InventorySnapshot | undefined): void {
    this.snapshot = snapshot;
    this.content.hidden = !snapshot;
    const selectedCategory = this.category.value;
    this.ordered = snapshot ? [...snapshot.resources].sort((a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : [];
    const categories = [...new Set(this.ordered.map(record => record.category))];
    this.category.replaceChildren(option('All categories', ''), ...categories.map(category => option(category, category)));
    if (categories.includes(selectedCategory)) this.category.value = selectedCategory;
    this.provenance.replaceChildren();
    if (snapshot) {
      this.provenance.append(field('Reported source', snapshot.source), field('Export generated', date(snapshot.generatedAt)),
        field('Read locally', date(new Date().toISOString())));
      this.renderResults();
    } else {
      this.selected = undefined;
      this.list.replaceChildren();
      this.details.replaceChildren();
      this.results.textContent = '';
      this.visible = pageSize;
    }
  }

  private renderResults(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const query = this.search.value.trim().toLocaleLowerCase();
    const matches = this.ordered.filter(record =>
      (!this.category.value || record.category === this.category.value) &&
      (!this.state.value || (record.status ?? 'unreported') === this.state.value) &&
      (!query || [record.name, record.id, record.assetDid, record.stockNumber, record.usagePolicyRef, record.description, record.imageRef]
        .some(value => value?.toLocaleLowerCase().includes(query))));
    const displayed = matches.slice(0, this.visible);
    this.more.hidden = matches.length <= this.visible;
    this.results.textContent = matches.length ? `Showing ${displayed.length} of ${matches.length} records` :
      snapshot.resources.length ? 'No records match the filters.' : 'The export contains no records.';
    const chosen = displayed.find(record => inventoryReference(snapshot, record) === this.selected) ?? displayed[0];
    this.selected = chosen && inventoryReference(snapshot, chosen);
    this.list.replaceChildren(...displayed.map(record => {
      const row = node('li');
      const select = button(record.name);
      select.className = 'sterling-resource-row';
      select.append(node('small', record.category), node('span', record.status ? inventoryStatuses[record.status] : notReported, 'sterling-resource-state'));
      select.setAttribute('aria-pressed', String(inventoryReference(snapshot, record) === this.selected));
      select.addEventListener('click', () => {
        this.selected = inventoryReference(snapshot, record);
        this.list.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === select)));
        this.renderDetails(snapshot, record);
      });
      row.append(select);
      return row;
    }));
    this.renderDetails(snapshot, chosen);
  }

  private renderDetails(snapshot: InventorySnapshot, record?: InventoryRecord): void {
    this.details.hidden = !record;
    this.details.replaceChildren();
    if (!record) return;
    const reference = inventoryReference(snapshot, record);
    const data = node('dl', undefined, 'sterling-resource-fields');
    data.append(field('Category', record.category), field('Reported status', record.status ? inventoryStatuses[record.status] : notReported),
      field('Reported quantity', quantity(record)), field('Record as of', record.asOf ? date(record.asOf) : notReported));
    const reported = [
      ['Reported asset DID', record.assetDid],
      ['Reported policy reference', record.usagePolicyRef],
      ['Reported catalogue stock number', record.stockNumber],
      ['Reported description', record.description],
      ['Reported image reference', record.imageRef]
    ] as const;
    for (const [label, value] of reported) {
      if (value !== undefined) data.append(field(label, value));
    }
    const input = node('input');
    input.readOnly = true;
    input.value = reference;
    const controls = node('div', undefined, 'sterling-portfolio-buttons');
    const copy = button('Copy reference');
    const feedback = node('span', undefined, 'sterling-portfolio-guidance');
    feedback.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      let written = false;
      const listener = this.clipboard.onDidWriteText?.(value => { if (value === reference) written = true; });
      try { await this.clipboard.writeText(reference); } catch { /* Select the reference for manual copying below. */ }
      finally { listener?.dispose(); }
      if (!feedback.isConnected) return;
      if (written) feedback.textContent = 'Reference copied.';
      else {
        input.focus();
        input.select();
        feedback.textContent = 'Select and copy the reference.';
      }
    });
    controls.append(copy);
    if (this.linkRequest) {
      const link = button('Link resource');
      link.disabled = Boolean(this.linkAction);
      link.addEventListener('click', () => void this.linkRecord(snapshot, record));
      controls.append(link);
    }
    controls.append(feedback);
    this.details.append(node('h2', record.name), data, labelled('Resource reference', input), controls);
  }

  private async linkRecord(snapshot: InventorySnapshot, record: InventoryRecord): Promise<void> {
    const request = this.linkRequest;
    const connection = this.connection;
    const reference = inventoryReference(snapshot, record);
    if (!request || !connection || this.linkAction || !this.trusted
      || this.snapshot !== snapshot || this.selected !== reference || connection.root.toString() !== request.rootUri) return;
    const action = {};
    this.linkAction = action;
    const current = (): boolean => this.linkAction === action && !this.isDisposed && this.trusted &&
      this.linkRequest === request && this.connection === connection;
    this.renderDetails(snapshot, record);
    this.linkFeedback.textContent = 'Checking the selected resource…';
    try {
      await this.read(false);
      if (!current()) return;
      if (this.snapshot?.sourceId !== snapshot.sourceId || !this.snapshot.resources.some(candidate => candidate.id === record.id)
        || this.selected !== reference) {
        this.linkFeedback.textContent = 'The selected resource changed. Select a record to try again.';
        return;
      }
      await request.onSelect({ sourceId: snapshot.sourceId, resourceId: record.id });
      if (current()) this.linkFeedback.textContent = 'Resource linked.';
    } catch {
      if (current()) this.linkFeedback.textContent = 'The resource could not be linked. Your selection remains available.';
    } finally {
      if (current()) {
        this.linkAction = undefined;
        const active = this.snapshot;
        if (active) this.renderDetails(active, active.resources.find(item => inventoryReference(active, item) === this.selected));
      }
    }
  }
}

@injectable()
class ResourceInventoryContribution extends AbstractViewContribution<SterlingResourceInventory> {
  constructor() {
    super({ widgetId, widgetName: 'Resource Inventory', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.resources.open', category: 'SovAI', label: 'Resource Inventory' }, {
      execute: async (request?: InventoryLinkRequest) => {
        if (request !== undefined && (!request || typeof request.rootUri !== 'string' || !request.rootUri
          || typeof request.onSelect !== 'function')) throw new Error('The inventory link request is invalid.');
        const view = await this.openView({ activate: true });
        view.setLinkRequest(request);
      }
    });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingResourceInventory).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId, createWidget: () => context.container.get(SterlingResourceInventory)
  })).inSingletonScope();
  bindViewContribution(bind, ResourceInventoryContribution);
});

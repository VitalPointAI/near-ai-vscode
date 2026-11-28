import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import type URI from '@theia/core/lib/common/uri.js';
import { AbstractDialog, ConfirmDialog } from '@theia/core/lib/browser/dialogs.js';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { FileOperationError, FileOperationResult } from '@theia/filesystem/lib/common/files.js';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service.js';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service.js';
import {
  infrastructureCategories, inventoryDirectory, inventoryFileName, inventoryImageSizeLimit, inventoryMediaDirectory, inventoryReference,
  inventorySizeLimit, inventoryStatuses, parseInfrastructureReport, parseInventorySnapshot, readInventoryOnce
} from '../common/sterling-resource-inventory.js';
import type { InfrastructureRecord, InfrastructureReport, InventoryLinkRequest, InventoryRecord, InventorySnapshot } from '../common/sterling-resource-inventory.js';
import { saveResourceCatalogue } from './sterling-resource-catalogue.js';
import type { PresentedCatalogue } from './sterling-resource-catalogue.js';
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
  presentedCatalogue?: PresentedCatalogue;
  readTask?: Promise<void>;
}

type DisplaySnapshot = InventorySnapshot | InfrastructureReport;
type DisplayRecord = InventoryRecord & Pick<InfrastructureRecord, 'owner' | 'capability' | 'capacity' | 'capacityUnit'>;
type InventoryReadResult = { error: string } | { snapshot: DisplaySnapshot; content: PresentedCatalogue };

function infrastructure(snapshot: DisplaySnapshot): snapshot is InfrastructureReport {
  return 'kind' in snapshot;
}

function recordKey(snapshot: DisplaySnapshot, record: DisplayRecord): string {
  return infrastructure(snapshot) ? `${snapshot.sourceId}/${record.id}` : inventoryReference(snapshot, record);
}

function categoryText(snapshot: DisplaySnapshot, category: string): string {
  return infrastructure(snapshot) ? infrastructureCategories[category as InfrastructureRecord['category']] : category;
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

class CatalogueRecordDialog extends AbstractDialog<InventoryRecord> {
  private readonly inputs = {
    name: node('input'), category: node('input'), lifecycle: node('input'),
    sourceRef: node('input'), stockNumber: node('input'), imageRef: node('input'),
    description: node('textarea'), reviewNote: node('textarea')
  };

  constructor(private readonly record: InventoryRecord) {
    super({ title: record.name ? 'Edit catalogue entry' : 'Add catalogue entry' });
    const form = node('div', undefined, 'sterling-resource-edit');
    const labels = {
      name: 'Name', category: 'Category', lifecycle: 'Public evidence', sourceRef: 'Evidence source',
      stockNumber: 'NATO stock number', imageRef: 'Image reference', description: 'Description', reviewNote: 'Review note'
    };
    for (const key of Object.keys(this.inputs) as (keyof typeof this.inputs)[]) {
      const input = this.inputs[key];
      input.value = record[key] ?? '';
      this.addAction(input, () => void this.validate(), 'input');
      form.append(labelled(labels[key], input));
    }
    this.contentNode.append(form);
    this.appendCloseButton('Cancel');
    this.appendAcceptButton('Save entry');
  }

  get value(): InventoryRecord {
    const { name, category, lifecycle, sourceRef, stockNumber, imageRef, description, reviewNote } = this.inputs;
    return {
      ...this.record,
      name: name.value.trim(), category: category.value.trim(), lifecycle: lifecycle.value.trim(),
      sourceRef: sourceRef.value.trim(), stockNumber: stockNumber.value.trim() || undefined,
      imageRef: imageRef.value.trim() || undefined, description: description.value.trim() || undefined,
      reviewNote: reviewNote.value.trim() || undefined
    };
  }

  protected override isValid(value: InventoryRecord): string {
    if (!value.name || !value.category || !value.lifecycle || !value.sourceRef) {
      return 'Enter a name, category, public evidence label, and evidence source.';
    }
    if (value.stockNumber && !/^(?:\d{13}|\d{4}-\d{2}-\d{3}-\d{4})$/.test(value.stockNumber)) {
      return 'Enter a 13-digit NATO stock number or leave it blank.';
    }
    return '';
  }
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
  private readonly sourceFolder = labelled('Inventory folder', this.folder);
  private readonly refresh = button('Refresh');
  private readonly guidance = node('p', undefined, 'sterling-portfolio-guidance');
  private readonly status = node('p', undefined, 'sterling-portfolio-message');
  private readonly provenance = node('dl', undefined, 'sterling-portfolio-provenance');
  private readonly content = node('section');
  private readonly search = node('input');
  private readonly category = node('select');
  private readonly state = node('select');
  private readonly stateFilter = labelled('Reported status', this.state);
  private readonly add = button('Add catalogue entry');
  private readonly archived = node('input');
  private readonly archivedFilter = labelled('Show archived entries', this.archived);
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
  private snapshot?: DisplaySnapshot;
  private ordered: DisplayRecord[] = [];
  private selected?: string;
  private linkRequest?: InventoryLinkRequest;
  private linkAction?: object;
  private editingCatalogue = false;
  private imageUrl?: string;
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
    actions.append(this.refresh);
    tools.append(this.sourceFolder, actions);
    this.status.setAttribute('role', 'status');
    this.linkFeedback.setAttribute('role', 'status');
    source.append(node('h2', 'Inventory source'), this.guidance, tools, this.status, this.linkFeedback, this.provenance);

    const filters = node('div', undefined, 'sterling-portfolio-filters');
    this.search.type = 'search';
    this.search.placeholder = 'Name, ID, DID, stock number or policy';
    this.state.append(option('All statuses', ''), ...Object.entries(inventoryStatuses).map(([id, label]) => option(label, id)),
      option(notReported, 'unreported'));
    this.archived.type = 'checkbox';
    filters.append(labelled('Search resources', this.search), labelled('Category', this.category),
      this.stateFilter, this.archivedFilter);
    const layout = node('div', undefined, 'sterling-portfolio-layout');
    const records = node('section');
    records.append(node('h2', 'Resources'), this.add, this.results, this.list, this.more);
    layout.append(records, this.details);
    this.content.append(filters, layout);
    page.append(heading, source, this.content);
    this.node.append(page);

    this.refresh.addEventListener('click', () => void this.read(false));
    this.folder.addEventListener('change', () => this.connect());
    this.add.addEventListener('click', () => void this.editCatalogue());
    for (const control of [this.search, this.category, this.state, this.archived]) {
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
    this.connect();
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
    if (trusted) this.connect();
    else this.clear();
  }

  private clear(): void {
    this.connection = undefined;
    this.linkAction = undefined;
    this.linkFeedback.textContent = '';
    this.updatePoll();
    this.search.value = '';
    this.archived.checked = false;
    this.state.value = '';
    this.setSnapshot(undefined);
    this.status.textContent = '';
    this.status.classList.remove('is-warning');
    this.renderSource();
  }

  private connect(): void {
    const root = this.allowedRoots().find(candidate => candidate.toString() === this.folder.value);
    this.clear();
    if (!root || !this.trusted || this.isDisposed) return;
    this.status.textContent = 'Reading inventory…';
    this.connection = { root, file: root.resolve(inventoryDirectory).resolve(inventoryFileName) };
    this.renderSource();
    this.updatePoll();
    void this.read(false);
  }

  private renderSource(): void {
    const roots = this.allowedRoots();
    this.sourceFolder.hidden = roots.length < 2;
    this.folder.disabled = !this.trusted;
    this.refresh.hidden = !this.connection;
    if (this.linkRequest && !roots.length) {
      this.guidance.textContent = 'Open the work-area folder again to link a resource from its inventory.';
    } else if (!roots.length) {
      this.guidance.textContent = 'Open a workspace folder to view its inventory.';
    } else if (!this.trusted) {
      this.guidance.textContent = 'Trust this workspace to view its inventory.';
    } else {
      this.guidance.textContent = '';
    }
  }

  private updatePoll(): void {
    clearInterval(this.timer);
    this.timer = this.connection && this.isVisible ? setInterval(() => void this.read(true), pollSeconds * 1000) : undefined;
  }

  private async read(skipUnchanged: boolean, fresh = false, stillLinking = (): boolean => true): Promise<void> {
    const source = this.connection;
    if (!source) return;
    const current = (): boolean => !this.isDisposed && this.trusted && this.connection === source && stillLinking();
    await readInventoryOnce(source, current, () => this.readCurrentSource(source, skipUnchanged, current),
      result => this.presentRead(source, result), fresh);
  }

  private async hasRegularSnapshotParents(source: Connection): Promise<boolean> {
    for (const parent of [source.root, source.root.resolve('.planning'), source.file.parent]) {
      const stat = await this.files.resolve(parent);
      if (!this.trusted || this.connection !== source || !stat.isDirectory || stat.isSymbolicLink) return false;
    }
    return true;
  }

  private async readCurrentSource(
    source: Connection, skipUnchanged: boolean, current: () => boolean
  ): Promise<InventoryReadResult | undefined> {
    try {
      if (!await this.hasRegularSnapshotParents(source)) return { error: 'The snapshot path must use regular workspace directories.' };
      if (!current()) return;
      const before = await this.files.resolve(source.file, { resolveMetadata: true });
      if (!current()) return;
      if (!before.isFile || before.isSymbolicLink || before.size > inventorySizeLimit) {
        return { error: 'Use a regular workspace file no larger than 512 KB.' };
      }
      if (skipUnchanged && source.etag === before.etag) return;
      const content = await this.files.read(source.file, { limits: { size: inventorySizeLimit } });
      if (!await this.hasRegularSnapshotParents(source)) return { error: 'The snapshot directory changed during the read.' };
      const after = await this.files.resolve(source.file, { resolveMetadata: true });
      if (!current()) return;
      if (!after.isFile || after.isSymbolicLink || after.etag !== before.etag || content.etag !== after.etag) {
        return { error: 'The snapshot changed while being read. Refresh to try again.' };
      }
      const snapshot = parseInventorySnapshot(content.value) ?? parseInfrastructureReport(content.value);
      return snapshot ? { snapshot, content } : { error: 'The file does not contain a valid resource inventory snapshot.' };
    } catch (error) {
      const missing = error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
      return { error: missing ? `No ${snapshotPath} in the selected workspace.` : 'The snapshot could not be read.' };
    }
  }

  private presentRead(source: Connection, result: InventoryReadResult | undefined): void {
    if (!result) return;
    if ('error' in result) {
      source.etag = undefined;
      source.presentedCatalogue = undefined;
      this.setSnapshot(undefined);
      if (this.status.textContent !== result.error) this.status.textContent = result.error;
      this.status.classList.add('is-warning');
      return;
    }
    const { snapshot, content } = result;
    const cannotLink = infrastructure(snapshot) && Boolean(this.linkRequest);
    source.etag = content.etag;
    source.presentedCatalogue = !infrastructure(snapshot) && snapshot.catalogueOnly ? content : undefined;
    this.setSnapshot(cannotLink ? undefined : snapshot);
    if (infrastructure(snapshot)) {
      this.status.textContent = cannotLink
        ? 'Infrastructure planning reports cannot be linked.'
        : 'Local infrastructure planning report. Availability and permissions have not been verified.';
    } else {
      this.status.textContent = snapshot.catalogueOnly
        ? 'Provisional public catalogue. DND verification is pending. Records represent equipment types.'
        : `Local inventory. Checks for changes every ${pollSeconds} seconds while visible.`;
    }
    this.status.classList.remove('is-warning');
  }

  private setSnapshot(snapshot: DisplaySnapshot | undefined): void {
    this.snapshot = snapshot;
    const infrastructureReport = Boolean(snapshot && infrastructure(snapshot));
    const catalogue = Boolean(snapshot && !infrastructure(snapshot) && snapshot.catalogueOnly);
    this.add.hidden = !catalogue || Boolean(this.linkRequest);
    this.archivedFilter.hidden = !catalogue;
    this.stateFilter.hidden = infrastructureReport;
    this.search.placeholder = infrastructureReport ? 'Name, ID, owner or capability' : 'Name, ID, DID, stock number or policy';
    this.add.disabled = this.editingCatalogue;
    this.content.hidden = !snapshot;
    const selectedCategory = this.category.value;
    this.ordered = snapshot ? [...snapshot.resources].sort((a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : [];
    const categories = [...new Set(this.ordered.map(record => record.category))];
    this.category.replaceChildren(option('All categories', ''), ...categories.map(category => option(snapshot ? categoryText(snapshot, category) : category, category)));
    if (categories.includes(selectedCategory)) this.category.value = selectedCategory;
    this.provenance.replaceChildren();
    if (snapshot) {
      this.state.disabled = catalogue || infrastructureReport;
      if (this.state.disabled) this.state.value = '';
      this.provenance.append(field('Reported source', snapshot.source), field('Export generated', date(snapshot.generatedAt)),
        field('Read locally', date(new Date().toISOString())));
      this.renderResults();
    } else {
      this.selected = undefined;
      this.list.replaceChildren();
      this.releaseImage();
      this.details.replaceChildren();
      this.results.textContent = '';
      this.visible = pageSize;
    }
  }

  private renderResults(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const infrastructureReport = infrastructure(snapshot);
    const query = this.search.value.trim().toLocaleLowerCase();
    const matches = this.ordered.filter(record =>
      (!record.archived || this.archived.checked) &&
      (!this.category.value || record.category === this.category.value) &&
      (!this.state.value || (record.status ?? 'unreported') === this.state.value) &&
      (!query || [record.name, record.id, record.assetDid, record.stockNumber, record.usagePolicyRef, record.description,
        record.imageRef, record.lifecycle, record.reviewNote, record.owner, record.capability]
        .some(value => value?.toLocaleLowerCase().includes(query))));
    const displayed = matches.slice(0, this.visible);
    this.more.hidden = matches.length <= this.visible;
    this.results.textContent = matches.length ? `Showing ${displayed.length} of ${matches.length} records` :
      snapshot.resources.length ? 'No records match the filters.' : 'The export contains no records.';
    const chosen = displayed.find(record => recordKey(snapshot, record) === this.selected) ?? displayed[0];
    this.selected = chosen && recordKey(snapshot, chosen);
    this.list.replaceChildren(...displayed.map(record => {
      const row = node('li');
      const select = button(record.name);
      select.className = 'sterling-resource-row';
      const reportedStatus = record.status ? inventoryStatuses[record.status] : notReported;
      const catalogueStatus = record.archived ? 'Archived' : record.lifecycle;
      select.append(node('small', categoryText(snapshot, record.category)));
      if (!infrastructureReport) {
        select.append(node('span', snapshot.catalogueOnly ? catalogueStatus : reportedStatus, 'sterling-resource-state'));
      }
      select.setAttribute('aria-pressed', String(recordKey(snapshot, record) === this.selected));
      select.addEventListener('click', () => {
        if (this.snapshot !== snapshot) return;
        this.selected = recordKey(snapshot, record);
        this.list.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === select)));
        this.renderDetails(snapshot, record);
      });
      row.append(select);
      return row;
    }));
    this.renderDetails(snapshot, chosen);
  }

  private releaseImage(): void {
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = undefined;
  }

  private async renderStoredImage(figure: HTMLElement, record: InventoryRecord, digest: string): Promise<void> {
    const source = this.connection;
    if (!source) return;
    const current = () => this.connection === source && this.trusted && figure.isConnected && !this.isDisposed;
    const folder = source.file.parent.resolve(inventoryMediaDirectory);
    const file = folder.resolve(digest);
    try {
      if (!await this.hasRegularSnapshotParents(source) || !current()) return;
      const parent = await this.files.resolve(folder, { resolveMetadata: true });
      if (!current() || !parent.isDirectory || parent.isSymbolicLink) throw new Error();
      const before = await this.files.resolve(file, { resolveMetadata: true });
      if (!current() || !before.isFile || before.isSymbolicLink || before.size > inventoryImageSizeLimit) throw new Error();
      const content = await this.files.readFile(file, { limits: { size: inventoryImageSizeLimit } });
      const after = await this.files.resolve(file, { resolveMetadata: true });
      const afterParent = await this.files.resolve(folder, { resolveMetadata: true });
      if (!await this.hasRegularSnapshotParents(source) || !current()) return;
      if (!after.isFile || after.isSymbolicLink || after.etag !== before.etag || content.etag !== after.etag
        || !afterParent.isDirectory || afterParent.isSymbolicLink || afterParent.etag !== parent.etag) throw new Error();
      const bytes = Uint8Array.from(content.value.buffer);
      const startsWith = (header: number[], offset = 0) => header.every((byte, index) => bytes[offset + index] === byte);
      let type: string;
      if (startsWith([255, 216, 255])) type = 'image/jpeg';
      else if (startsWith([137, 80, 78, 71, 13, 10, 26, 10])) type = 'image/png';
      else if (startsWith([82, 73, 70, 70]) && startsWith([87, 69, 66, 80], 8)) type = 'image/webp';
      else throw new Error();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      if (Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') !== digest) throw new Error();
      if (!current()) return;
      const image = node('img');
      image.alt = `Reference image of ${record.name}`;
      image.addEventListener('error', () => {
        if (!current()) return;
        this.releaseImage();
        figure.textContent = 'Stored image could not be displayed.';
      }, { once: true });
      this.imageUrl = URL.createObjectURL(new Blob([bytes], { type }));
      image.src = this.imageUrl;
      const caption = node('figcaption', 'Stored reference image');
      figure.replaceChildren(image, caption);
    } catch {
      if (current()) figure.textContent = 'Stored image unavailable.';
    }
  }

  private renderDetails(snapshot: DisplaySnapshot, record?: DisplayRecord): void {
    this.releaseImage();
    this.details.hidden = !record;
    this.details.replaceChildren();
    if (!record) return;
    if (infrastructure(snapshot)) {
      const data = node('dl', undefined, 'sterling-resource-fields');
      const capacity = record.capacity === undefined
        ? 'Unknown' : `${quantityFormatter.format(record.capacity)} ${record.capacityUnit}`;
      data.append(field('Category', categoryText(snapshot, record.category)), field('Reported owner', record.owner ?? notReported),
        field('Reported capability', record.capability ?? notReported), field('Reported capacity', capacity),
        field('Record as of', record.asOf ? date(record.asOf) : notReported));
      this.details.append(node('h2', record.name), data);
      return;
    }
    const reference = inventoryReference(snapshot, record);
    const data = node('dl', undefined, 'sterling-resource-fields');
    data.append(field('Category', record.category));
    if (snapshot.catalogueOnly) {
      data.append(field('Public evidence', record.lifecycle ?? notReported),
        field('NATO stock number', record.stockNumber ?? 'Pending item-level verification'));
    } else {
      data.append(field('Reported status', record.status ? inventoryStatuses[record.status] : notReported),
        field('Reported quantity', quantity(record)), field('Record as of', record.asOf ? date(record.asOf) : notReported));
    }
    const reported = [
      ['Reported asset DID', record.assetDid],
      ['Reported policy reference', record.usagePolicyRef],
      ['Reported catalogue stock number', snapshot.catalogueOnly ? undefined : record.stockNumber],
      ['Reported description', record.description],
      ['Image source', record.imageRef],
      ['Evidence source', record.sourceRef],
      ['Review note', record.reviewNote]
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
    if (snapshot.catalogueOnly && !this.linkRequest) {
      const edit = button('Edit entry');
      const archive = button(record.archived ? 'Restore entry' : 'Archive entry');
      edit.disabled = archive.disabled = this.editingCatalogue;
      edit.addEventListener('click', () => void this.editCatalogue(record));
      archive.addEventListener('click', () => void this.editCatalogue(record, true));
      controls.append(edit, archive);
    }
    if (this.linkRequest && !snapshot.catalogueOnly) {
      const link = button('Link resource');
      link.disabled = Boolean(this.linkAction);
      link.addEventListener('click', () => void this.linkRecord(snapshot, record));
      controls.append(link);
    }
    controls.append(feedback);
    this.details.append(node('h2', record.name));
    if (record.imageDigest) {
      const figure = node('figure', 'Loading stored image…', 'sterling-resource-image');
      this.details.append(figure);
      void this.renderStoredImage(figure, record, record.imageDigest);
    }
    this.details.append(data, labelled('Resource reference', input), controls);
  }

  private async editCatalogue(record?: InventoryRecord, toggleArchive = false): Promise<void> {
    const source = this.connection;
    const presented = source?.presentedCatalogue;
    const snapshot = this.snapshot;
    if (!source || !presented || !snapshot || infrastructure(snapshot) || !snapshot.catalogueOnly
      || this.linkRequest || this.editingCatalogue) return;
    const current = () => this.trusted && this.connection === source && !this.linkRequest && !this.isDisposed;
    this.editingCatalogue = true;
    this.add.disabled = true;
    this.renderResults();
    try {
      let updated: InventoryRecord | undefined;
      if (record && toggleArchive) {
        const action = record.archived ? 'Restore entry' : 'Archive entry';
        const confirmed = await new ConfirmDialog({ title: action, ok: action, msg: record.name }).open();
        if (confirmed) updated = { ...record, archived: record.archived ? undefined : true };
      } else {
        const draft = record ?? { id: `candidate-${crypto.randomUUID()}`, name: '', category: '', lifecycle: 'Lifecycle needs review' };
        updated = await new CatalogueRecordDialog(draft).open();
      }
      if (!updated || !current()) return;
      const parsed = await saveResourceCatalogue(this.files, source.file, presented,
        () => this.hasRegularSnapshotParents(source), current, updated, record);
      if (!current()) return;
      this.selected = inventoryReference(parsed, updated);
      await this.read(false);
      this.linkFeedback.textContent = 'Catalogue entry saved.';
    } catch (error) {
      if (!current()) return;
      this.linkFeedback.textContent = error instanceof FileOperationError
        ? 'The catalogue could not be saved. Refresh it and try again.'
        : error instanceof Error ? error.message : 'The catalogue could not be saved.';
    } finally {
      this.editingCatalogue = false;
      this.add.disabled = false;
      this.renderResults();
    }
  }

  private async linkRecord(snapshot: InventorySnapshot, record: InventoryRecord): Promise<void> {
    const request = this.linkRequest;
    const connection = this.connection;
    const reference = inventoryReference(snapshot, record);
    if (!request || !connection || snapshot.catalogueOnly || this.linkAction || !this.trusted
      || this.snapshot !== snapshot || this.selected !== reference || connection.root.toString() !== request.rootUri) return;
    const action = {};
    this.linkAction = action;
    const current = (): boolean => this.linkAction === action && !this.isDisposed && this.trusted &&
      this.linkRequest === request && this.connection === connection;
    this.renderDetails(snapshot, record);
    this.linkFeedback.textContent = 'Checking the selected resource…';
    try {
      await this.read(false, true, current);
      if (!current()) return;
      const active = this.snapshot;
      if (!active || infrastructure(active) || active.sourceId !== snapshot.sourceId || active.catalogueOnly
        || !active.resources.some(candidate => candidate.id === record.id)
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
        if (active) this.renderDetails(active, active.resources.find(item => recordKey(active, item) === this.selected));
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

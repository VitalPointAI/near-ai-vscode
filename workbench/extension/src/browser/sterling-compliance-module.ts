import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import URI from '@theia/core/lib/common/uri.js';
import { FileDownloadService } from '@theia/filesystem/lib/common/download/file-download.js';
import { refreshRecordMatches } from '../common/sterling-evidence.js';
import './sterling-compliance.css';

const widgetId = 'sterling-compliance';
export const sterlingComplianceCommand = { id: 'sterling.compliance.open', category: 'SovAI', label: 'Open Compliance' };
const stateWords = {
  met: 'Met',
  'partly-met': 'Partly met',
  'not-met': 'Not met',
  stale: 'Stale',
  'not-applicable': 'Not applicable',
  'your-organizations-responsibility': 'Your organization’s responsibility'
} as const;
type State = keyof typeof stateWords;
const states = Object.keys(stateWords) as State[];
const attentionStates = ['not-met', 'partly-met', 'stale'] as const;
const attentionLabels = { 'not-met': 'Not met', 'partly-met': 'Partly met', stale: 'Stale evidence' };
const priority: Record<State, number> = {
  'not-met': 0, 'partly-met': 1, stale: 2, met: 3, 'your-organizations-responsibility': 4, 'not-applicable': 5
};
const pageSize = 24;

type Evidence = { rule: string; collectedAt?: string; commit?: string; passed?: boolean; runUrl?: string };
type Component = { component: string; responsibility: string; state: State; statement?: string; reasonText?: string; evidence?: Evidence[] };
type Control = { control: string; label: string; title: string; level: string; state: State; reasonText: string; components: Component[]; textFile?: string; gap?: string };
type Level = { id: string; title: string; claim: boolean };
type Gap = { id: string; title: string; remediation: string; ownerRole: string; state: string };
const sourceLabels = { main: 'Main branch', scheduled: 'Scheduled collection', release: 'Release', local: 'Local collection' } as const;
type SourceKind = keyof typeof sourceLabels;
type RefreshRecord = { source: string; commit: string; fetchedAt: string; manifest: 'verified'; attestation: string };
const attestationWords: Record<string, string> = { verified: 'verified', none: 'none for daily and merge bundles by design', 'not-checked': 'not checked' };
const responsibilityWords: Record<string, string> = {
  product: 'Product', shared: 'Shared', 'your-organization': 'Your organization', inherited: 'Inherited', 'not-applicable': 'Not applicable'
};
type Dashboard = { schemaVersion: 1; generatedAt: string; commit: string; source: {kind: SourceKind; ref: string}; levels: Level[]; rows: Control[]; gaps?: Gap[]; textIndex?: {file: string}[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => typeof value[key] === 'string');
}

function optionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => value[key] === undefined || typeof value[key] === 'string');
}

function itemList(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

function isState(value: unknown): value is State {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(stateWords, value);
}

function isEvidence(value: unknown): boolean {
  return record(value) && typeof value.rule === 'string'
    && optionalStrings(value, ['collectedAt', 'commit', 'runUrl'])
    && (value.passed === undefined || typeof value.passed === 'boolean');
}

function isComponent(value: unknown): boolean {
  return record(value) && allStrings(value, ['component', 'responsibility']) && isState(value.state)
    && optionalStrings(value, ['statement', 'reasonText'])
    && (value.evidence === undefined || itemList(value.evidence, isEvidence));
}

function isControl(value: unknown): boolean {
  return record(value) && allStrings(value, ['control', 'label', 'title', 'level', 'reasonText'])
    && optionalStrings(value, ['textFile', 'gap']) && isState(value.state) && itemList(value.components, isComponent);
}

function isDashboard(value: unknown): value is Dashboard {
  return record(value) && value.schemaVersion === 1 && allStrings(value, ['generatedAt', 'commit'])
    && typeof value.commit === 'string' && value.commit.trim().length > 0
    && record(value.source) && allStrings(value.source, ['kind', 'ref'])
    && typeof value.source.kind === 'string' && Object.prototype.hasOwnProperty.call(sourceLabels, value.source.kind)
    && itemList(value.levels, level => record(level) && allStrings(level, ['id', 'title']) && typeof level.claim === 'boolean')
    && itemList(value.rows, isControl)
    && (value.gaps === undefined || itemList(value.gaps, gap => record(gap) && allStrings(gap, ['id', 'title', 'remediation', 'ownerRole', 'state'])))
    && (value.textIndex === undefined || itemList(value.textIndex, entry => record(entry) && typeof entry.file === 'string'));
}

// compliance:refresh writes refresh.json beside the dashboard only after the bundle's manifest hashes check out.
function isRefreshRecord(value: unknown, dashboard: Dashboard): value is RefreshRecord {
  return refreshRecordMatches(value, dashboard.commit);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function chooseOption(text: string, value: string): HTMLOptionElement {
  const option = element('option', text);
  option.value = value;
  return option;
}

function badge(state: State): HTMLElement {
  const label = element('span', stateWords[state], 'sterling-evidence-badge');
  label.dataset.state = state;
  return label;
}

function countStates(rows: Control[]): Record<State, number> {
  const counts: Record<State, number> = {met: 0, 'partly-met': 0, 'not-met': 0, stale: 0, 'not-applicable': 0, 'your-organizations-responsibility': 0};
  for (const row of rows) counts[row.state]++;
  return counts;
}

function chartSummary(total: number, counts: Record<State, number>): string {
  const statuses = states.filter(state => counts[state]).map(state => `${counts[state]} ${stateWords[state]}`);
  return [`${total} control entries`, ...statuses].join(', ');
}

function chartFill(total: number, counts: Record<State, number>): string {
  if (!total) return 'var(--sterling-chart-track)';
  const segments = states.filter(state => counts[state]);
  if (segments.length === 1) return `var(--sterling-state-${segments[0]})`;
  let start = 0;
  return `conic-gradient(${segments.map(state => {
    const end = start + counts[state];
    const segment = `var(--sterling-state-${state}) ${start / total * 100}% ${end / total * 100}%`;
    start = end;
    return segment;
  }).join(', ')})`;
}

function externalLink(text: string, value: string | undefined, githubOnly = false): HTMLAnchorElement | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || (githubOnly && url.hostname !== 'github.com')) return undefined;
  const link = element('a', text);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function controlTextUrl(dashboard: Dashboard, control: Control): URL | undefined {
  const file = control.textFile;
  return file && /^text\/[a-z0-9][a-z0-9-]*\/[a-z0-9]+\.json$/.test(file)
    && dashboard.textIndex?.some(entry => entry.file === file) ? new URL(`compliance/${file}`, document.baseURI) : undefined;
}

@injectable()
class SterlingComplianceWidget extends BaseWidget {
  private readonly body = element('div');
  private refreshRequest?: AbortController;
  private textRequest?: AbortController;
  private filters = { level: '', state: '', query: '' };

  @postConstruct()
  protected init(): void {
    this.id = widgetId;
    this.title.label = 'Compliance';
    this.title.caption = 'Compliance evidence dashboard';
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-compliance');
    const page = element('main', undefined, 'sterling-compliance-page');
    const header = element('header', undefined, 'sterling-compliance-heading');
    const title = element('div');
    title.append(element('h1', 'Compliance'), element('p', 'Published evidence. Authorization is your organization’s decision.'));
    const refresh = element('button', 'Reload bundle', 'sterling-evidence-action');
    refresh.type = 'button';
    refresh.addEventListener('click', () => void this.load());
    header.append(title, refresh);
    page.append(header, this.body);
    this.node.append(page);
    this.toDispose.push({ dispose: () => { this.refreshRequest?.abort(); this.textRequest?.abort(); } });
    void this.load();
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }

  private showStatus(message: string): void {
    const status = element('p', message, 'sterling-evidence-message');
    status.setAttribute('role', 'status');
    this.body.replaceChildren(status);
  }

  private async load(): Promise<void> {
    this.refreshRequest?.abort();
    this.textRequest?.abort();
    const request = new AbortController();
    this.refreshRequest = request;
    this.showStatus('Loading published evidence…');
    try {
      const response = await fetch(new URL('compliance/dashboard.json', document.baseURI), { signal: request.signal, cache: 'no-store', mode: 'same-origin', redirect: 'error' });
      if (request.signal.aborted) return;
      if (!response.ok) {
        this.showStatus(response.status === 404
          ? 'This workbench carries no evidence. Mount the public dashboard projection, then reload.'
          : 'The public evidence bundle could not be loaded. Try reloading.');
        return;
      }
      const data: unknown = await response.json().catch(() => undefined);
      if (request.signal.aborted) return;
      if (!isDashboard(data)) {
        this.showStatus('The public evidence bundle is invalid or uses an unsupported schema.');
        return;
      }
      const verification = await fetch(new URL('compliance/refresh.json', document.baseURI), { signal: request.signal, cache: 'no-store', mode: 'same-origin', redirect: 'error' });
      const refreshRecord: unknown = verification.ok ? await verification.json().catch(() => undefined) : undefined;
      if (request.signal.aborted) return;
      // Show no states from a bundle that compliance:refresh has not hash-verified.
      if (!isRefreshRecord(refreshRecord, data)) {
        this.showStatus('This evidence bundle has no matching verification record, so no states are shown. Write the projection with compliance:refresh, then reload.');
        return;
      }
      this.showDashboard(data, refreshRecord);
    } catch {
      if (!request.signal.aborted) this.showStatus('The public evidence bundle could not be loaded. Try reloading.');
    }
  }

  private showDashboard(dashboard: Dashboard, verified: RefreshRecord): void {
    const generated = Date.parse(dashboard.generatedAt);
    const metadata = element('p', `${sourceLabels[dashboard.source.kind]} · Bundle generated ${Number.isFinite(generated) ? dashboard.generatedAt : 'at an unknown time'} · Commit ${dashboard.commit.slice(0, 12)}`, 'sterling-evidence-meta');
    const verification = element('p', `Manifest verified · Signature: ${attestationWords[verified.attestation] ?? verified.attestation} · Fetched ${verified.fetchedAt} from ${verified.source}`, 'sterling-evidence-meta');
    const notice = element('p', 'This evidence bundle is older than 24 hours or has an invalid generation time. Check collection times before relying on it.', 'sterling-evidence-message');
    const age = Date.now() - generated;
    notice.hidden = age >= 0 && age <= 86_400_000;

    const filters = element('div', undefined, 'sterling-evidence-filters');
    const levelSelect = element('select');
    levelSelect.append(chooseOption('All coverage levels', ''));
    for (const level of dashboard.levels) levelSelect.append(chooseOption(level.title, level.id));
    levelSelect.value = dashboard.levels.some(level => level.id === this.filters.level) ? this.filters.level : '';
    const stateSelect = element('select');
    stateSelect.append(chooseOption('All states', ''), ...states.map(state => chooseOption(stateWords[state], state)));
    stateSelect.value = this.filters.state;
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'ID or control name';
    search.value = this.filters.query;
    for (const [label, input] of [['Coverage level', levelSelect], ['Evidence state', stateSelect], ['Search controls', search]] as const) {
      const field = element('label', label);
      field.append(input);
      filters.append(field);
    }
    const clear = element('button', 'Clear filters', 'sterling-evidence-action');
    clear.type = 'button';
    filters.append(clear);

    const attention = element('section', undefined, 'sterling-evidence-attention');
    attention.setAttribute('aria-label', 'Needs attention');
    const warningGrid = element('div', undefined, 'sterling-evidence-warning-grid');
    attention.append(element('h2', 'Needs attention'), warningGrid);
    const warningButtons = attentionStates.map(state => {
      const button = element('button', undefined, 'sterling-evidence-warning');
      button.type = 'button';
      button.dataset.state = state;
      const icon = element('i', undefined, `codicon codicon-${state === 'stale' ? 'history' : 'warning'}`);
      icon.setAttribute('aria-hidden', 'true');
      const count = element('strong');
      button.append(icon, element('span', attentionLabels[state]), count);
      button.addEventListener('click', () => toggleState(state));
      warningGrid.append(button);
      return { state, button, count };
    });

    const visuals = element('div', undefined, 'sterling-evidence-visuals');
    const statusChart = element('section', undefined, 'sterling-evidence-chart');
    const statusBody = element('div', undefined, 'sterling-evidence-status-body');
    const donut = element('div', undefined, 'sterling-evidence-donut');
    donut.setAttribute('role', 'img');
    const center = element('div', undefined, 'sterling-evidence-donut-center');
    center.setAttribute('aria-hidden', 'true');
    const centerCount = element('strong');
    center.append(centerCount, element('span', 'Control entries'));
    donut.append(center);
    const legend = element('div', undefined, 'sterling-evidence-legend');
    const legendButtons = states.map(state => {
      const button = element('button', undefined, 'sterling-evidence-legend-item');
      button.type = 'button';
      const swatch = element('span', undefined, 'sterling-evidence-swatch');
      swatch.dataset.state = state;
      swatch.setAttribute('aria-hidden', 'true');
      const count = element('strong');
      button.append(swatch, element('span', stateWords[state]), count);
      button.addEventListener('click', () => toggleState(state));
      legend.append(button);
      return { state, button, count };
    });
    statusBody.append(donut, legend);
    statusChart.append(element('h2', 'Control status'), element('p', 'Select a status to filter', 'sterling-evidence-chart-label'), statusBody);
    const levelsChart = element('section', undefined, 'sterling-evidence-chart');
    const levelChart = element('ul', undefined, 'sterling-evidence-level-chart');
    levelsChart.append(element('h2', 'Coverage by level'), element('p', 'Select a level to filter', 'sterling-evidence-chart-label'), levelChart);
    const levelButtons = dashboard.levels.map(level => {
      const item = element('li');
      const button = element('button', undefined, 'sterling-evidence-level-row');
      button.type = 'button';
      const name = element('span', level.title, 'sterling-evidence-level-label');
      if (!level.claim) name.append(element('small', 'No coverage claim'));
      const bar = element('span', undefined, 'sterling-evidence-level-bar');
      bar.setAttribute('aria-hidden', 'true');
      const total = element('strong', undefined, 'sterling-evidence-level-total');
      button.append(name, bar, total);
      button.addEventListener('click', () => {
        levelSelect.value = levelSelect.value === level.id ? '' : level.id;
        render();
      });
      item.append(button);
      levelChart.append(item);
      return { level, button, bar, total };
    });
    visuals.append(statusChart, levelsChart);

    const results = element('section', undefined, 'sterling-evidence-results');
    const detail = element('aside', undefined, 'sterling-evidence-detail');
    detail.id = `${widgetId}-detail`;
    detail.tabIndex = -1;
    detail.hidden = true;
    const columns = element('div', undefined, 'sterling-evidence-columns');
    columns.append(results, detail);

    const toggleState = (state: State): void => {
      stateSelect.value = stateSelect.value === state ? '' : state;
      render();
    };

    const render = (): void => {
      this.filters = { level: levelSelect.value, state: stateSelect.value, query: search.value };
      clear.disabled = !this.filters.level && !this.filters.state && !this.filters.query;
      this.textRequest?.abort();
      detail.hidden = true;
      detail.replaceChildren();
      const level = dashboard.levels.find(item => item.id === this.filters.level);
      const levelRows = level ? dashboard.rows.filter(row => row.level === level.id) : dashboard.rows;
      const query = this.filters.query.trim().toLowerCase();
      const searched = dashboard.rows.filter(row => `${row.control} ${row.label} ${row.title}`.toLowerCase().includes(query));
      const scoped = level ? searched.filter(row => row.level === level.id) : searched;
      const state = this.filters.state;
      const matching = scoped.filter(row => !state || row.state === state)
        .sort((left, right) => priority[left.state] - priority[right.state]);
      const available = countStates(scoped);
      const statusCounts = countStates(matching);
      let hasWarnings = false;
      for (const warning of warningButtons) {
        const count = available[warning.state];
        warning.button.hidden = count === 0;
        warning.button.setAttribute('aria-pressed', String(state === warning.state));
        warning.count.textContent = String(count);
        hasWarnings ||= count > 0;
      }
      attention.hidden = !hasWarnings;
      donut.style.background = chartFill(matching.length, statusCounts);
      donut.setAttribute('aria-label', chartSummary(matching.length, statusCounts));
      centerCount.textContent = String(matching.length);
      for (const entry of legendButtons) {
        entry.count.textContent = String(available[entry.state]);
        entry.button.setAttribute('aria-pressed', String(state === entry.state));
      }
      for (const entry of levelButtons) {
        const rows = searched.filter(row => row.level === entry.level.id && (!state || row.state === state));
        const counts = countStates(rows);
        entry.total.textContent = String(rows.length);
        entry.button.setAttribute('aria-pressed', String(level?.id === entry.level.id));
        entry.button.setAttribute('aria-label', `${entry.level.title}${entry.level.claim ? '' : ', no coverage claim'}, ${chartSummary(rows.length, counts)}`);
        entry.bar.replaceChildren();
        for (const item of states) {
          if (!counts[item]) continue;
          const segment = element('span', undefined, 'sterling-evidence-segment');
          segment.dataset.state = item;
          segment.style.flexGrow = String(counts[item]);
          segment.title = `${stateWords[item]}: ${counts[item]}`;
          entry.bar.append(segment);
        }
      }
      const count = element('p', `${matching.length} of ${levelRows.length} control entries`, 'sterling-evidence-meta');
      count.setAttribute('role', 'status');
      const title = element('div', undefined, 'sterling-evidence-results-title');
      title.append(element('h2', 'Controls'), count);
      if (level && !level.claim) title.append(element('span', 'No coverage claim', 'sterling-evidence-no-claim'));
      results.replaceChildren(title);
      if (!matching.length) {
        results.append(element('p', dashboard.rows.length ? 'No controls match these filters.' : 'The bundle has no control entries.', 'sterling-evidence-message'));
        return;
      }
      const list = element('ul', undefined, 'sterling-evidence-controls');
      const more = element('button', 'Show more controls', 'sterling-evidence-action');
      more.type = 'button';
      const appendPage = (focus: boolean): void => {
        const offset = list.children.length;
        for (const control of matching.slice(offset, offset + pageSize)) {
          const item = element('li');
          const button = element('button');
          button.type = 'button';
          button.dataset.state = control.state;
          button.setAttribute('aria-expanded', 'false');
          button.setAttribute('aria-controls', detail.id);
          button.append(element('strong', `${control.label} · ${control.title}`), badge(control.state));
          button.addEventListener('click', () => this.showControl(dashboard, control, detail, button));
          item.append(button);
          list.append(item);
        }
        more.hidden = list.children.length >= matching.length;
        if (focus) list.children[offset]?.querySelector('button')?.focus();
      };
      more.addEventListener('click', () => appendPage(true));
      results.append(list, more);
      appendPage(false);
    };

    levelSelect.addEventListener('change', render);
    stateSelect.addEventListener('change', render);
    search.addEventListener('input', render);
    clear.addEventListener('click', () => {
      levelSelect.value = '';
      stateSelect.value = '';
      search.value = '';
      render();
      search.focus();
    });
    this.body.replaceChildren(metadata, verification, notice, attention, filters, visuals, columns);
    render();
  }

  private showControl(dashboard: Dashboard, control: Control, detail: HTMLElement, opener: HTMLButtonElement): void {
    this.textRequest?.abort();
    this.body.querySelector('.sterling-evidence-controls [aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-expanded', 'true');
    const close = element('button', 'Close details', 'sterling-evidence-action');
    close.type = 'button';
    const closeDetail = (): void => {
      this.textRequest?.abort();
      detail.hidden = true;
      detail.replaceChildren();
      opener.setAttribute('aria-expanded', 'false');
      opener.focus();
    };
    close.addEventListener('click', closeDetail);
    detail.onkeydown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); closeDetail(); }
    };
    const heading = element('h2', `${control.label} · ${control.title}`);
    const official = element('details');
    official.append(element('summary', 'Official control text'));
    const prose = element('div', 'Loading official text…');
    official.append(prose);
    const gap = dashboard.gaps?.find(item => item.id === control.gap);
    detail.replaceChildren(close, heading, badge(control.state), element('p', control.reasonText));
    for (const component of control.components) {
      const block = element('section', undefined, 'sterling-evidence-component');
      block.append(element('h3', component.component), element('p', `Responsibility: ${responsibilityWords[component.responsibility] ?? component.responsibility}`), badge(component.state));
      if (component.statement || component.reasonText) block.append(element('p', component.statement ?? component.reasonText));
      const evidence = element('ul');
      for (const item of component.evidence ?? []) {
        const line = element('li', [item.rule, item.passed === undefined ? undefined : item.passed ? 'Passed' : 'Did not pass', item.collectedAt, item.commit?.slice(0, 12)].filter(Boolean).join(' · '));
        const link = externalLink('CI run', item.runUrl, true);
        if (link) line.append(' ', link);
        evidence.append(line);
      }
      block.append(element('h4', 'Evidence'), evidence.childElementCount ? evidence : element('p', 'No published evidence for this component.'));
      detail.append(block);
    }
    if (!control.components.length) detail.append(element('p', 'No product statements or evidence published for this control.'));
    if (gap) detail.append(element('h3', `${gap.id} · ${gap.title}`), element('p', gap.remediation), element('p', `Owner: ${gap.ownerRole} · ${gap.state}`));
    detail.append(official);
    detail.setAttribute('aria-label', `Details for ${control.label}`);
    detail.hidden = false;
    detail.focus();
    void this.loadOfficialText(dashboard, control, prose);
  }

  private async loadOfficialText(dashboard: Dashboard, control: Control, prose: HTMLElement): Promise<void> {
    const unavailable = 'Official text is not present in the published bundle.';
    const url = controlTextUrl(dashboard, control);
    if (!url) { prose.textContent = unavailable; return; }
    const request = new AbortController();
    this.textRequest = request;
    try {
      const response = await fetch(url, { signal: request.signal, mode: 'same-origin', redirect: 'error' });
      const value: unknown = response.ok ? await response.json() : undefined;
      if (request.signal.aborted) return;
      const official = record(value) && Array.isArray(value.controls)
        ? value.controls.find((item: unknown) => record(item) && item.id === control.control) as unknown
        : undefined;
      if (!record(official) || !Array.isArray(official.parts)) { prose.textContent = unavailable; return; }
      const parts = official.parts.filter((item: unknown): item is {lang: string; prose: string} => record(item) && allStrings(item, ['lang', 'prose']));
      if (!parts.length) { prose.textContent = unavailable; return; }
      prose.replaceChildren();
      if (record(value) && record(value.attribution)) {
        const { source, url: sourceUrl, notice } = value.attribution;
        if (typeof source === 'string') {
          const link = externalLink(source, typeof sourceUrl === 'string' ? sourceUrl : undefined);
          const attribution = element('p');
          attribution.append(link ?? source);
          prose.append(attribution);
        }
        if (typeof notice === 'string') prose.append(element('p', notice));
      }
      const french = element('details');
      french.lang = 'fr';
      french.append(element('summary', 'Français'));
      for (const part of parts) (part.lang === 'fr' ? french : prose).append(element('p', part.prose, 'sterling-evidence-official-text'));
      if (french.childElementCount > 1) prose.append(french);
    } catch {
      if (!request.signal.aborted) prose.textContent = unavailable;
    }
  }
}

@injectable()
class SterlingComplianceContribution extends AbstractViewContribution<SterlingComplianceWidget> {
  @inject(FileDownloadService)
  protected readonly downloadService!: FileDownloadService;

  constructor() {
    super({ widgetId, widgetName: 'Compliance', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(sterlingComplianceCommand, {
      execute: () => this.openView({ activate: true })
    });
    // SovAI: Generate SA&A Package… saves its ZIP where the workbench runs; this sends that one file to the person's browser (port of 4b96f4ad).
    commands.registerCommand({ id: 'sterling.compliance.downloadPackage' }, {
      execute: async (savedUri: string) => {
        const uri = new URI(savedUri);
        if (uri.scheme !== 'file' || uri.authority || !/\.zip$/i.test(uri.path.base)) throw new Error('Choose a saved SA&A ZIP file.');
        await this.downloadService.download([uri]);
      }
    });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingComplianceWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId,
    createWidget: () => context.container.get(SterlingComplianceWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingComplianceContribution);
});

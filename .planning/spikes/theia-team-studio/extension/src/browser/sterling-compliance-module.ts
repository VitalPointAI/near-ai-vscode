import { ContainerModule, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import './sterling-compliance.css';

const widgetId = 'sterling-compliance';
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

type Evidence = { rule: string; collectedAt?: string; commit?: string; passed?: boolean; runUrl?: string };
type Component = { component: string; responsibility: string; state: State; statement?: string; reasonText?: string; evidence?: Evidence[] };
type Control = { control: string; label: string; title: string; level: string; state: State; reasonText: string; components: Component[]; textFile?: string; gap?: string };
type Level = { id: string; title: string; claim: boolean };
type Gap = { id: string; title: string; remediation: string; ownerRole: string; state: string };
type Dashboard = { schemaVersion: number; generatedAt: string; commit: string; levels: Level[]; rows: Control[]; gaps?: Gap[]; textIndex?: {file: string}[] };

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
    && itemList(value.levels, level => record(level) && allStrings(level, ['id', 'title']) && typeof level.claim === 'boolean')
    && itemList(value.rows, isControl)
    && (value.gaps === undefined || itemList(value.gaps, gap => record(gap) && allStrings(gap, ['id', 'title', 'remediation', 'ownerRole', 'state'])))
    && (value.textIndex === undefined || itemList(value.textIndex, entry => record(entry) && typeof entry.file === 'string'));
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
    title.append(element('h1', 'Compliance'), element('p', 'Review coverage, gaps, and the evidence supporting each control. Your organization determines whether the evidence is sufficient for authorization.'));
    const refresh = element('button', 'Refresh evidence', 'sterling-evidence-action');
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
      const response = await fetch(new URL('compliance/dashboard.json', document.baseURI), { signal: request.signal, cache: 'no-store' });
      if (request.signal.aborted) return;
      if (!response.ok) {
        this.showStatus(response.status === 404
          ? 'No public evidence bundle is available in this workbench. Publish or mount a verified bundle, then refresh.'
          : 'The public evidence bundle could not be loaded. Try refreshing.');
        return;
      }
      const data: unknown = await response.json().catch(() => undefined);
      if (request.signal.aborted) return;
      if (!isDashboard(data)) {
        this.showStatus('The public evidence bundle is invalid or uses an unsupported schema.');
        return;
      }
      this.showDashboard(data);
    } catch {
      if (!request.signal.aborted) this.showStatus('The public evidence bundle could not be loaded. Try refreshing.');
    }
  }

  private showDashboard(dashboard: Dashboard): void {
    const generated = Date.parse(dashboard.generatedAt);
    const metadata = element('p', `Bundle generated ${Number.isFinite(generated) ? dashboard.generatedAt : 'at an unknown time'} · Commit ${dashboard.commit.slice(0, 12)}`, 'sterling-evidence-meta');
    const notice = element('p', 'This evidence bundle is older than 24 hours or its generation time is unavailable. Check collection times before relying on it.', 'sterling-evidence-message');
    notice.hidden = Number.isFinite(generated) && Date.now() - generated <= 86_400_000;

    const filters = element('div', undefined, 'sterling-evidence-filters');
    const levelSelect = element('select');
    for (const level of dashboard.levels) levelSelect.append(chooseOption(level.title, level.id));
    if (!dashboard.levels.length) levelSelect.append(chooseOption('No coverage levels', ''));
    const stateSelect = element('select');
    stateSelect.append(chooseOption('All states', ''), ...states.map(state => chooseOption(stateWords[state], state)));
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'ID or control name';
    for (const [label, input] of [['Coverage level', levelSelect], ['Evidence state', stateSelect], ['Search controls', search]] as const) {
      const field = element('label', label);
      field.append(input);
      filters.append(field);
    }

    const coverage = element('div');
    const results = element('section', undefined, 'sterling-evidence-results');
    const detail = element('aside', undefined, 'sterling-evidence-detail');
    detail.id = `${widgetId}-detail`;
    detail.tabIndex = -1;
    detail.hidden = true;
    const columns = element('div', undefined, 'sterling-evidence-columns');
    columns.append(results, detail);
    const render = (): void => {
      this.textRequest?.abort();
      detail.hidden = true;
      detail.replaceChildren();
      const level = dashboard.levels.find(item => item.id === levelSelect.value);
      const levelRows = dashboard.rows.filter(row => row.level === level?.id);
      const query = search.value.trim().toLowerCase();
      const matching = levelRows.filter(row => (!stateSelect.value || row.state === stateSelect.value)
        && (!query || `${row.label} ${row.title}`.toLowerCase().includes(query)));
      const metrics = element('ul', undefined, 'sterling-evidence-metrics');
      const counts: Record<State, number> = {met: 0, 'partly-met': 0, 'not-met': 0, stale: 0, 'not-applicable': 0, 'your-organizations-responsibility': 0};
      levelRows.forEach(row => counts[row.state]++);
      for (const state of states) {
        const metric = element('li');
        metric.append(element('strong', String(counts[state])), badge(state));
        metrics.append(metric);
      }
      coverage.replaceChildren(metrics);
      if (level && !level.claim) coverage.append(element('p', `The bundle records no coverage claim for ${level.title}.`, 'sterling-evidence-message'));
      const count = element('p', `${matching.length} of ${levelRows.length} controls`, 'sterling-evidence-meta');
      count.setAttribute('role', 'status');
      results.replaceChildren(element('h2', level?.title ?? 'Controls'), count);
      if (!matching.length) {
        results.append(element('p', 'No controls match these filters.', 'sterling-evidence-message'));
        return;
      }
      const list = element('ul', undefined, 'sterling-evidence-controls');
      for (const control of matching) {
        const item = element('li');
        const button = element('button');
        button.type = 'button';
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', detail.id);
        button.append(element('strong', `${control.label} · ${control.title}`), badge(control.state), element('span', control.reasonText, 'sterling-evidence-reason'));
        button.addEventListener('click', () => this.showControl(dashboard, control, detail, button));
        item.append(button);
        list.append(item);
      }
      results.append(list);
    };

    levelSelect.addEventListener('change', render);
    stateSelect.addEventListener('change', render);
    search.addEventListener('input', render);
    this.body.replaceChildren(metadata, notice, filters, coverage, columns);
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
      block.append(element('h3', component.component), element('p', `Responsibility: ${component.responsibility}`), badge(component.state));
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
      const response = await fetch(url, { signal: request.signal });
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
  constructor() {
    super({ widgetId, widgetName: 'Compliance', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: 'sterling.compliance.open', category: 'SovAI', label: 'Open Compliance' }, {
      execute: () => this.openView({ activate: true })
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

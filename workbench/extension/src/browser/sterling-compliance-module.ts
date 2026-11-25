import { ContainerModule, inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import URI from '@theia/core/lib/common/uri.js';
import { FileDownloadService } from '@theia/filesystem/lib/common/download/file-download.js';
import {
  ageWords, attentionCounts, cellFacts, changeAnnouncement, COMPLIANCE_TEXT, componentLines, displayCounts, EVIDENCE_SERVICE_PATH, fillText, filterCells, formatTime,
  nextViewState, notices, projectionCard, releaseCard, siteCard, SterlingEvidenceService, viewCells,
  type Card, type DisplayState, type EvidenceRow, type EvidenceSnapshot, type PauseState, type SourceFilter, type ViewContext, type ViewFilters
} from '../common/compliance-evidence.js';
import { bindFrontendService } from './frontend-service.js';
import './sterling-compliance.css';

// The Compliance view (48.2-10), built to the approved 48.2-UI-SPEC: release evidence, then your site's evidence, then the published
// projection, each as a lifted card; every control cell with its source, as-of time, freshness and verification, from the backend's live
// evidence service. The browser computes no state, freshness or verification (D-01, D-18): it shows the view model, holds it while paused
// (freshness then reads Unknown, D-25) and sets every piece of evidence text with textContent (T-48.2-26).

const widgetId = 'sterling-compliance';
export const sterlingComplianceCommand = { id: 'sterling.compliance.open', category: 'SovAI', label: 'Open Compliance' };
const T = COMPLIANCE_TEXT;
const DISPLAY_STATES: readonly DisplayState[] = ['met', 'partly-met', 'not-met', 'stale', 'not-verified', 'not-applicable', 'your-organizations-responsibility'];
const PRIORITY: Readonly<Record<DisplayState, number>> = { 'not-met': 0, 'partly-met': 1, stale: 2, 'not-verified': 3, met: 4, 'your-organizations-responsibility': 5, 'not-applicable': 6 };
const PAGE_SIZE = 24;
const RETRY_MS = [2_000, 5_000, 10_000];
const RETRY_STEADY_MS = 30_000;
const ANNOUNCE_WINDOW_MS = 60_000;
const DEFAULT_FILTERS: ViewFilters = { level: '', state: '', freshness: '', source: 'layered', query: '' };
const CONTROL_TEXT_FILE = /^text\/[a-z0-9][a-z0-9-]*\/[a-z0-9]+\.json$/;
type Connection = 'connecting' | 'live' | 'lost' | 'held';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function icon(name: string | undefined): HTMLElement {
  const node = element('i', undefined, `codicon codicon-${name ?? 'blank'}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function timeNode(iso: string, text: string, now: number): HTMLTimeElement {
  const node = element('time', text);
  node.dateTime = iso;
  node.title = `${formatTime(iso)} (${ageWords(iso, now)})`;
  return node;
}
function button(text: string, className = 'sterling-evidence-action', codicon?: string): HTMLButtonElement {
  const node = element('button', undefined, className);
  node.type = 'button';
  if (codicon) node.append(icon(codicon));
  node.append(element('span', text));
  return node;
}
function chooseOption(text: string, value: string): HTMLOptionElement {
  const option = element('option', text);
  option.value = value;
  return option;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function badgeNode(state: DisplayState): HTMLElement {
  const label = element('span', T.stateWords[state], 'sterling-evidence-badge');
  label.dataset.state = state;
  if (state === 'stale') label.title = T.staleTitle;
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
const cellKey = (row: EvidenceRow): string => `${row.level}/${row.control}`;

function chartFill(total: number, counts: Readonly<Record<DisplayState, number>>): string {
  if (!total) return 'var(--sterling-chart-track)';
  const segments = DISPLAY_STATES.filter((state) => counts[state]);
  if (segments.length === 1) return `var(--sterling-state-${segments[0]})`;
  let start = 0;
  return `conic-gradient(${segments.map((state) => {
    const end = start + counts[state];
    const segment = `var(--sterling-state-${state}) ${start / total * 100}% ${end / total * 100}%`;
    start = end;
    return segment;
  }).join(', ')})`;
}
function chartSummary(total: number, counts: Readonly<Record<DisplayState, number>>): string {
  return [`${total} control entries`, ...DISPLAY_STATES.filter((state) => counts[state]).map((state) => `${counts[state]} ${T.stateWords[state]}`)].join(', ');
}

@injectable()
class SterlingComplianceWidget extends BaseWidget {
  @inject(SterlingEvidenceService) protected readonly evidence!: SterlingEvidenceService;

  private readonly body = element('div', undefined, 'sterling-compliance-body');
  private readonly announcer = element('p', undefined, 'sterling-evidence-announcer sterling-evidence-sr-only');
  private readonly liveIndicator = element('p', undefined, 'sterling-evidence-live');
  private readonly headerButtons = element('div', undefined, 'sterling-evidence-header-actions');
  private snapshot?: EvidenceSnapshot;
  private shownSnapshot?: EvidenceSnapshot;
  private connection: Connection = 'connecting';
  private lastAnswer?: number;
  private state = { filters: DEFAULT_FILTERS, shown: PAGE_SIZE } as { filters: ViewFilters; openKey?: string; shown: number };
  private openChecks = false;
  private polling = false;
  private stopped = false;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private ageTimer?: ReturnType<typeof setInterval>;
  private textRequest = 0;
  private announceQueue: string[] = [];
  private lastAnnounced = 0;
  private announceTimer?: ReturnType<typeof setTimeout>;

  @postConstruct()
  protected init(): void {
    this.id = widgetId;
    this.title.label = T.title;
    this.title.caption = T.caption;
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-compliance');
    const page = element('main', undefined, 'sterling-compliance-page');
    const header = element('header', undefined, 'sterling-compliance-heading');
    const heading = element('div');
    heading.append(element('h1', T.title), element('p', T.lead, 'sterling-evidence-lead'));
    const side = element('div', undefined, 'sterling-evidence-header-side');
    this.announcer.setAttribute('role', 'status');
    this.announcer.setAttribute('aria-live', 'polite');
    side.append(this.liveIndicator, this.headerButtons);
    header.append(heading, side);
    page.append(header, this.body, this.announcer);
    this.node.append(page);
    this.renderHeader();
    this.body.replaceChildren(element('p', T.statusLoading, 'sterling-evidence-meta'));
    this.ageTimer = setInterval(() => this.renderLive(), 15_000);
    this.toDispose.push({ dispose: () => this.stop() });
    void this.start();
  }

  protected override onActivateRequest(): void {
    this.node.focus();
  }

  private stop(): void {
    this.stopped = true;
    this.polling = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ageTimer) clearInterval(this.ageTimer);
    if (this.announceTimer) clearTimeout(this.announceTimer);
  }

  private isHeld(): boolean {
    return this.connection === 'held';
  }

  private context(): ViewContext {
    const pause: PauseState = this.connection === 'lost' ? 'lost' : this.connection === 'held' ? 'held' : 'live';
    const release = this.shownSnapshot?.release;
    return { now: Date.now(), pause, clock: release !== undefined && 'clock' in release && release.clock === 'clock-behind-build' };
  }

  // ---- The connection machine: Connecting, Live, Paused (lost), Paused by you (UI-SPEC "Live updates") ----

  private async start(): Promise<void> {
    try {
      const snapshot = await this.evidence.getEvidence();
      if (this.stopped) return;
      this.accept(snapshot);
      this.setConnection('live');
      void this.poll();
    } catch {
      if (this.stopped) return;
      this.renderHeader();
      const message = element('div', undefined, 'sterling-evidence-notice sterling-evidence-card');
      message.dataset.tone = 'error';
      message.append(icon('error'), element('span', T.errorLoad));
      this.body.replaceChildren(message);
      this.scheduleRetry();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    while (this.polling && !this.stopped && this.connection === 'live') {
      try {
        const snapshot = await this.evidence.waitForEvidence(this.snapshot?.revision ?? 0);
        if (this.stopped || this.connection !== 'live') break;
        this.accept(snapshot);
      } catch {
        if (this.stopped || this.connection !== 'live') break;
        this.polling = false;
        this.setConnection('lost');
        this.scheduleRetry();
        return;
      }
    }
    this.polling = false;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = RETRY_MS[this.retry] ?? RETRY_STEADY_MS;
    this.retry += 1;
    this.retryTimer = setTimeout(() => void this.checkNow(true), delay);
  }

  private async checkNow(fromRetry = false): Promise<void> {
    if (this.connection === 'held' || this.stopped) return;
    const check = this.headerButtons.querySelector<HTMLButtonElement>('[data-action="check"]');
    check?.setAttribute('aria-disabled', 'true');
    try {
      const snapshot = await this.evidence.getEvidence();
      if (this.stopped || this.isHeld()) return;
      this.retry = 0;
      const wasLost = this.connection !== 'live';
      this.accept(snapshot);
      if (wasLost) {
        this.setConnection('live');
        void this.poll();
      }
    } catch {
      if (this.stopped) return;
      if (this.connection === 'live') this.setConnection('lost');
      if (fromRetry || this.connection === 'lost' || this.connection === 'connecting') this.scheduleRetry();
    } finally {
      check?.removeAttribute('aria-disabled');
    }
  }

  private setConnection(next: Connection): void {
    const previous = this.connection;
    this.connection = next;
    if (previous !== next) {
      if (next === 'lost') this.announce(T.announcePaused, true);
      else if (next === 'held') this.announce(T.announceHeld, true);
      else if (next === 'live' && (previous === 'lost' || previous === 'held')) this.announce(T.announceResumed, true);
    }
    this.renderHeader();
    this.render();
  }

  private pause(): void {
    this.polling = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setConnection('held');
    this.headerButtons.querySelector<HTMLButtonElement>('[data-action="resume"]')?.focus();
  }

  private async resume(): Promise<void> {
    this.setConnection('connecting');
    this.headerButtons.querySelector<HTMLButtonElement>('[data-action="check"]')?.focus();
    await this.checkNow();
    if (this.connection === 'connecting') this.setConnection('lost');
  }

  /** Takes a new answer: held values stay while paused by the person; otherwise the view re-renders in place. */
  private accept(snapshot: EvidenceSnapshot): void {
    this.lastAnswer = Date.now();
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (this.connection === 'held') return;
    if (previous && previous.revision !== snapshot.revision) {
      const change = changeAnnouncement(previous, snapshot);
      if (change) this.announce(change);
    }
    this.shownSnapshot = snapshot;
    this.state = { ...nextViewState(this.state, snapshot) };
    this.renderLive();
    this.render();
  }

  // ---- Announcements: one persistent polite region, at most once a minute, except paused and resumed ----

  private announce(text: string, now = false): void {
    if (now || !this.isVisible) {
      if (now) this.announcer.textContent = text;
      return;
    }
    this.announceQueue.push(text);
    const wait = Math.max(0, this.lastAnnounced + ANNOUNCE_WINDOW_MS - Date.now());
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.lastAnnounced = Date.now();
      this.announcer.textContent = [...new Set(this.announceQueue)].join(' ');
      this.announceQueue = [];
    }, wait);
  }

  // ---- Header ----

  private renderLive(): void {
    const answer = this.lastAnswer;
    const node = this.liveIndicator;
    node.replaceChildren();
    const at = answer ? new Date(answer).toISOString() : undefined;
    if (this.connection === 'connecting' || !at) node.append(icon('broadcast'), T.liveConnecting);
    else if (this.connection === 'live') {
      node.append(icon('broadcast'));
      const age = ageWords(at, Date.now());
      node.append(age === T.justNow ? T.liveNow : fillText(T.liveAge, { age }));
    } else {
      node.append(icon(this.connection === 'held' ? 'debug-pause' : 'debug-disconnect'));
      const [before, after] = (this.connection === 'held' ? T.liveHeld : T.livePaused).split('{time}');
      node.append(before ?? '', timeNode(at, formatTime(at), Date.now()), after ?? '');
    }
  }

  private renderHeader(): void {
    const buttons: HTMLButtonElement[] = [];
    if (this.connection === 'live') {
      const pause = button(T.actionPause, 'sterling-evidence-action', 'debug-pause');
      pause.dataset.action = 'pause';
      pause.addEventListener('click', () => this.pause());
      buttons.push(pause);
    }
    if (this.connection === 'held') {
      const resume = button(T.actionResume, 'sterling-evidence-action', 'debug-continue');
      resume.dataset.action = 'resume';
      resume.addEventListener('click', () => void this.resume());
      buttons.push(resume);
    } else {
      const check = button(T.actionCheck, 'sterling-evidence-action', 'refresh');
      check.dataset.action = 'check';
      check.addEventListener('click', () => { if (check.getAttribute('aria-disabled') !== 'true') void this.checkNow(); });
      buttons.push(check);
    }
    const focused = this.headerButtons.contains(document.activeElement);
    this.headerButtons.replaceChildren(...buttons);
    if (focused) buttons[0]?.focus();
    this.renderLive();
  }

  // ---- The page ----

  private render(): void {
    const snapshot = this.shownSnapshot;
    if (!snapshot) return;
    const searchFocused = document.activeElement?.closest?.('.sterling-evidence-filters input[type="search"]') !== null && this.body.contains(document.activeElement);
    const anchor = this.scrollAnchor();
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const context = this.context();
    const blocks: HTMLElement[] = [];
    const noticeNodes = notices(snapshot, context).map(({ tone, text }) => {
      const node = element('div', undefined, 'sterling-evidence-notice sterling-evidence-card');
      node.dataset.tone = tone;
      node.append(icon(tone === 'error' ? 'error' : text === T.noticePaused ? 'debug-disconnect' : text.startsWith('This computer') ? 'watch' : 'warning'), element('span', text));
      return node;
    });
    if (noticeNodes.length) {
      const list = element('div', undefined, 'sterling-evidence-notices');
      list.append(...noticeNodes);
      blocks.push(list);
    }
    blocks.push(this.renderSources(snapshot, context));
    const release = snapshot.release;
    const cells = viewCells(snapshot, this.state.filters.source);
    const noControlEvidence = (release.verification === 'verified' || release.verification === 'not-verified') && release.bundle === 'none' && this.state.filters.source !== 'projection';
    if (noControlEvidence || cells.length === 0 && this.state.filters.source !== 'projection') {
      const controls = element('section', undefined, 'sterling-evidence-results');
      const title = element('h2', T.controlsTitle);
      title.tabIndex = -1;
      const message = noControlEvidence ? T.controlsNoControlEvidence
        : release.verification === 'none' && !snapshot.projection ? T.controlsNoEvidence : T.controlsNoneVerified;
      controls.append(title, element('p', message, 'sterling-evidence-meta'));
      blocks.push(controls);
      this.body.replaceChildren(...blocks);
      this.restore(anchor, focusKey, searchFocused);
      return;
    }
    const scoped = filterCells(cells, { ...this.state.filters, state: '', freshness: '', level: '' }, context);
    const levels = snapshot.release.verification === 'verified' || snapshot.release.verification === 'not-verified'
      ? (this.state.filters.source === 'projection' && snapshot.projection?.verification === 'not-verified' ? snapshot.projection.levels : snapshot.release.levels)
      : snapshot.projection?.verification === 'not-verified' ? snapshot.projection.levels : [];
    blocks.push(this.renderAttention(scoped, context));
    blocks.push(this.renderFilters(snapshot, levels, context));
    blocks.push(this.renderCharts(cells, levels, context));
    blocks.push(this.renderControls(cells, context));
    this.body.replaceChildren(...blocks);
    this.restore(anchor, focusKey, searchFocused);
  }

  /** The key and offset of the first row in view, to keep the viewport still across a re-render. */
  private scrollAnchor(): { key: string; offset: number } | undefined {
    const top = this.node.getBoundingClientRect().top;
    for (const row of Array.from(this.body.querySelectorAll<HTMLElement>('[data-key]'))) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { key: row.dataset.key!, offset: box.top - top };
    }
    return undefined;
  }

  private restore(anchor: { key: string; offset: number } | undefined, focusKey: string | undefined, searchFocused: boolean): void {
    if (anchor) {
      const row = this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor.key)}"]`);
      if (row) this.node.scrollTop += row.getBoundingClientRect().top - this.node.getBoundingClientRect().top - anchor.offset;
    }
    if (searchFocused) this.body.querySelector<HTMLInputElement>('.sterling-evidence-filters input[type="search"]')?.focus();
    else if (focusKey) {
      const target = this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
        ?? this.body.querySelector<HTMLElement>('.sterling-evidence-results h2');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  private renderCard(card: Card, context: ViewContext): HTMLElement {
    const node = element('section', undefined, 'sterling-evidence-source sterling-evidence-card');
    node.dataset.layer = card.layer;
    const title = element('div', undefined, 'sterling-evidence-source-title');
    const heading = element('h3');
    heading.append(icon(card.icon), element('span', card.title));
    title.append(heading);
    if (card.badge) {
      const verification = element('span', undefined, 'sterling-evidence-verification');
      verification.dataset.verification = card.badge.verification;
      verification.append(icon(card.badge.icon), element('span', card.badge.words));
      title.append(verification);
    }
    node.append(title);
    if (card.facts.length) {
      const list = element('dl', undefined, 'sterling-evidence-source-facts');
      for (const fact of card.facts) {
        const dd = element('dd', undefined, fact.mono ? 'sterling-evidence-mono' : undefined);
        if (fact.datetime) {
          const [head, ...rest] = fact.dd.split(formatTime(fact.datetime));
          dd.append(head ?? '', timeNode(fact.datetime, formatTime(fact.datetime), context.now), rest.join(formatTime(fact.datetime)));
        } else dd.textContent = fact.dd;
        list.append(element('dt', fact.dt), dd);
      }
      node.append(list);
    }
    for (const message of card.messages) node.append(element('p', message, 'sterling-evidence-source-message'));
    if (card.command) node.append(element('p', card.command.intro), this.commandBlock(card.command.lines, T.commandLabel), element('p', card.command.after, 'sterling-evidence-meta'));
    if (card.layer === 'release' && card.checks) {
      const toggle = button(this.openChecks ? T.checksHide : T.checksShow);
      toggle.setAttribute('aria-expanded', String(this.openChecks));
      const panel = element('div', undefined, 'sterling-evidence-checks');
      panel.id = `${widgetId}-checks`;
      toggle.setAttribute('aria-controls', panel.id);
      panel.hidden = !this.openChecks;
      for (const line of card.checks) {
        panel.append(element('p', line.text));
        if (line.command) panel.append(this.commandBlock(line.command, line.text));
      }
      toggle.addEventListener('click', () => {
        this.openChecks = !this.openChecks;
        panel.hidden = !this.openChecks;
        toggle.setAttribute('aria-expanded', String(this.openChecks));
        toggle.querySelector('span')!.textContent = this.openChecks ? T.checksHide : T.checksShow;
      });
      node.append(toggle, panel);
    }
    if (card.layer === 'projection' && card.badge?.verification === 'not-verified') {
      const show = button(T.projectionShow);
      show.addEventListener('click', () => this.setFilters({ ...this.state.filters, source: 'projection' }));
      node.append(show);
    }
    return node;
  }

  private commandBlock(lines: readonly string[], label: string): HTMLElement {
    const wrap = element('div', undefined, 'sterling-evidence-command-wrap');
    const block = element('pre', lines.join('\n'), 'sterling-evidence-command');
    block.tabIndex = 0;
    block.setAttribute('role', 'region');
    block.setAttribute('aria-label', label);
    const copy = button(T.copyButton, 'sterling-evidence-action', 'copy');
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
        copy.querySelector('span')!.textContent = T.copyDone;
        this.announce(T.announceCopied, true);
        setTimeout(() => { copy.querySelector('span')!.textContent = T.copyButton; }, 4_000);
      }, () => {
        copy.querySelector('span')!.textContent = T.copyRefused;
        const range = document.createRange();
        range.selectNodeContents(block);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      });
    });
    wrap.append(block, copy);
    return wrap;
  }

  private renderSources(snapshot: EvidenceSnapshot, context: ViewContext): HTMLElement {
    const section = element('section', undefined, 'sterling-evidence-sources-section');
    section.append(element('h2', T.sourcesTitle));
    const grid = element('div', undefined, 'sterling-evidence-sources');
    const release = releaseCard(snapshot, context);
    const projection = projectionCard(snapshot, context);
    grid.append(this.renderCard(release, context), this.renderCard(siteCard(snapshot, context), context), ...(projection ? [this.renderCard(projection, context)] : []));
    section.append(grid);
    if (release.onlyLine) section.append(element('p', release.onlyLine, 'sterling-evidence-only-line'));
    const help = element('details', undefined, 'sterling-evidence-help');
    help.append(element('summary', T.helpTitle));
    const table = element('table');
    table.append(element('caption', T.helpTitle));
    const head = element('tr');
    for (const column of T.helpCols) { const th = element('th', column); th.scope = 'col'; head.append(th); }
    const thead = element('thead');
    thead.append(head);
    const tbody = element('tbody');
    for (const [source, asOf, how] of T.helpRows) {
      const tr = element('tr');
      const th = element('th', source);
      th.scope = 'row';
      tr.append(th, element('td', asOf), element('td', how));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    help.append(table);
    section.append(help);
    return section;
  }

  private renderAttention(cells: readonly EvidenceRow[], context: ViewContext): HTMLElement {
    const counts = attentionCounts(cells, context) as Record<string, number | undefined>;
    const card = element('section', undefined, 'sterling-evidence-attention sterling-evidence-card');
    card.setAttribute('aria-label', T.attentionTitle);
    const grid = element('div', undefined, 'sterling-evidence-warning-grid');
    card.append(element('h3', T.attentionTitle), grid);
    let any = false;
    for (const key of Object.keys(T.attention) as (keyof typeof T.attention)[]) {
      const count = counts[key];
      if (count === undefined || count === 0) continue;
      any = true;
      const freshnessKey = key === 'out-of-date';
      const pressed = freshnessKey ? this.state.filters.freshness === key : this.state.filters.state === key;
      const item = element('button', undefined, 'sterling-evidence-warning');
      item.type = 'button';
      item.dataset.state = key === 'out-of-date' ? 'stale' : key;
      item.setAttribute('aria-pressed', String(pressed));
      item.append(icon(key === 'stale' || key === 'out-of-date' ? 'history' : key === 'not-verified' ? 'unverified' : 'warning'), element('span', T.attention[key]), element('strong', String(count)));
      item.addEventListener('click', () => this.setFilters(freshnessKey
        ? { ...this.state.filters, freshness: pressed ? '' : key, state: '' }
        : { ...this.state.filters, state: pressed ? '' : key }));
      grid.append(item);
    }
    card.hidden = !any;
    return card;
  }

  private setFilters(filters: ViewFilters, announce = true): void {
    this.state = { ...this.state, filters, shown: PAGE_SIZE };
    this.render();
    if (announce) {
      const count = this.body.querySelector('.sterling-evidence-count')?.textContent;
      if (count) this.announce(count, true);
    }
  }

  private renderFilters(snapshot: EvidenceSnapshot, levels: readonly { id: string; title: string }[], context: ViewContext): HTMLElement {
    const filters = element('div', undefined, 'sterling-evidence-filters');
    const current = this.state.filters;
    const select = (label: string, options: [string, string][], value: string, onChange: (value: string) => void, disabled = false, help?: string): void => {
      const field = element('label', undefined, 'sterling-evidence-field');
      field.append(element('span', label));
      const input = element('select');
      input.append(...options.map(([text, optionValue]) => chooseOption(text, optionValue)));
      input.value = options.some(([, optionValue]) => optionValue === value) ? value : options[0]![1];
      input.disabled = disabled;
      input.addEventListener('change', () => onChange(input.value));
      field.append(input);
      if (help) {
        const note = element('span', help, 'sterling-evidence-meta');
        note.id = `${widgetId}-freshness-help`;
        input.setAttribute('aria-describedby', note.id);
        field.append(note);
      }
      filters.append(field);
    };
    select(T.filterLevel, [[T.filterLevelAll, ''], ...levels.map(({ id, title }) => [title, id] as [string, string])], current.level, (level) => this.setFilters({ ...current, level }));
    select(T.filterState, [[T.filterStateAll, ''], ...DISPLAY_STATES.map((state) => [T.stateWords[state], state] as [string, string])], current.state, (state) => this.setFilters({ ...current, state }));
    const paused = context.pause !== 'live';
    select(T.filterFreshness, [[T.filterFreshnessAll, ''], ...(['current', 'ageing', 'out-of-date', 'unknown', 'none'] as const).map((value) => [T.freshness[value], value] as [string, string])],
      current.freshness, (freshness) => this.setFilters({ ...current, freshness }), paused, paused ? T.filterFreshnessPaused : undefined);
    const sources = (Object.keys(T.filterSourceOptions) as SourceFilter[]).filter((value) => value !== 'projection' || snapshot.projection?.verification === 'not-verified');
    select(T.filterSource, sources.map((value) => [T.filterSourceOptions[value], value]), current.source, (source) => this.setFilters({ ...current, source: source as SourceFilter }));
    const field = element('label', undefined, 'sterling-evidence-field');
    field.append(element('span', T.filterSearch));
    const search = element('input');
    search.type = 'search';
    search.placeholder = T.filterSearchPlaceholder;
    search.value = current.query;
    search.addEventListener('input', () => { this.state = { ...this.state, filters: { ...this.state.filters, query: search.value }, shown: PAGE_SIZE }; this.render(); });
    field.append(search);
    filters.append(field);
    const clear = button(T.filterClear);
    clear.disabled = JSON.stringify(current) === JSON.stringify(DEFAULT_FILTERS);
    clear.addEventListener('click', () => {
      this.setFilters(DEFAULT_FILTERS);
      this.body.querySelector<HTMLInputElement>('.sterling-evidence-filters input[type="search"]')?.focus();
    });
    filters.append(clear);
    return filters;
  }

  private renderCharts(cells: readonly EvidenceRow[], levels: readonly { id: string; title: string; claim: boolean }[], context: ViewContext): HTMLElement {
    const filters = this.state.filters;
    const scoped = filterCells(cells, filters, context);
    const counts = displayCounts(scoped);
    const visuals = element('div', undefined, 'sterling-evidence-visuals');
    // Control status: the donut and its legend.
    const status = element('section', undefined, 'sterling-evidence-chart sterling-evidence-card');
    const bodyNode = element('div', undefined, 'sterling-evidence-status-body');
    const donut = element('div', undefined, 'sterling-evidence-donut');
    donut.setAttribute('role', 'img');
    donut.setAttribute('aria-label', chartSummary(scoped.length, counts));
    donut.style.background = chartFill(scoped.length, counts);
    const centre = element('div', undefined, 'sterling-evidence-donut-center');
    centre.setAttribute('aria-hidden', 'true');
    centre.append(element('strong', String(scoped.length)), element('span', T.chartCentre));
    donut.append(centre);
    const legend = element('div', undefined, 'sterling-evidence-legend');
    const available = displayCounts(filterCells(cells, { ...filters, state: '' }, context));
    for (const state of DISPLAY_STATES) {
      const item = element('button', undefined, 'sterling-evidence-legend-item');
      item.type = 'button';
      item.setAttribute('aria-pressed', String(filters.state === state));
      if (state === 'stale') item.title = T.staleTitle;
      const swatch = element('span', undefined, 'sterling-evidence-swatch');
      swatch.dataset.state = state;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, element('span', T.stateWords[state]), element('strong', String(available[state])));
      item.addEventListener('click', () => this.setFilters({ ...filters, state: filters.state === state ? '' : state }));
      legend.append(item);
    }
    bodyNode.append(donut, legend);
    status.append(element('h3', T.chartStatus), element('p', T.chartStatusHint, 'sterling-evidence-meta'), bodyNode);
    // Summary across levels: a real table; counts follow every filter but the level.
    const summary = element('section', undefined, 'sterling-evidence-summary sterling-evidence-card');
    const region = element('div', undefined, 'sterling-evidence-summary-region');
    const table = element('table');
    const caption = element('caption', T.summaryCaption);
    caption.id = `${widgetId}-summary-caption`;
    region.setAttribute('role', 'region');
    region.tabIndex = 0;
    region.setAttribute('aria-labelledby', caption.id);
    table.append(caption);
    const thead = element('thead');
    const headRow = element('tr');
    for (const column of T.summaryCols) { const th = element('th', column); th.scope = 'col'; headRow.append(th); }
    thead.append(headRow);
    const tbody = element('tbody');
    const unaware = filterCells(cells, { ...filters, level: '' }, context);
    const paused = context.pause !== 'live';
    const unknownCell = (): HTMLTableCellElement => {
      const td = element('td');
      const dash = element('span', '–');
      dash.setAttribute('aria-hidden', 'true');
      td.append(dash, element('span', context.pause === 'lost' ? T.freshnessPaused : T.freshnessHeld, 'sterling-evidence-sr-only'));
      return td;
    };
    const rowFor = (title: string, rows: readonly EvidenceRow[], level?: { id: string; claim: boolean }): HTMLTableRowElement => {
      const tr = element('tr');
      const th = element('th');
      th.scope = 'row';
      if (level) {
        const levelButton = element('button', undefined, 'sterling-evidence-level-row');
        levelButton.type = 'button';
        levelButton.setAttribute('aria-pressed', String(filters.level === level.id));
        levelButton.append(element('span', title, 'sterling-evidence-level-label'));
        if (!level.claim) levelButton.append(element('small', T.summaryNoClaim, 'sterling-evidence-meta'));
        const bar = element('span', undefined, 'sterling-evidence-level-bar');
        bar.setAttribute('aria-hidden', 'true');
        const levelCounts = displayCounts(rows);
        for (const state of DISPLAY_STATES) {
          if (!levelCounts[state]) continue;
          const segment = element('span', undefined, 'sterling-evidence-segment');
          segment.dataset.state = state;
          segment.style.flexGrow = String(levelCounts[state]);
          bar.append(segment);
        }
        levelButton.append(bar);
        levelButton.addEventListener('click', () => this.setFilters({ ...filters, level: filters.level === level.id ? '' : level.id }));
        th.append(levelButton);
      } else th.textContent = title;
      const c = displayCounts(rows);
      tr.append(th, element('td', String(rows.length)), element('td', String(c.met)), element('td', String(c['not-met'] + c['partly-met'] + c.stale)), element('td', String(c['not-verified'])));
      if (paused) tr.append(unknownCell(), unknownCell());
      else tr.append(element('td', String(rows.filter(({ freshness }) => freshness === 'ageing').length)), element('td', String(rows.filter(({ freshness }) => freshness === 'out-of-date').length)));
      return tr;
    };
    for (const level of levels) tbody.append(rowFor(level.title, unaware.filter((row) => row.level === level.id), level));
    const tfoot = element('tfoot');
    tfoot.append(rowFor(T.summaryTotal, unaware));
    table.append(thead, tbody, tfoot);
    region.append(table);
    summary.append(element('h3', T.summaryCaption), element('p', T.summaryHint, 'sterling-evidence-meta'), region);
    visuals.append(status, summary);
    return visuals;
  }

  private renderControls(cells: readonly EvidenceRow[], context: ViewContext): HTMLElement {
    const columns = element('div', undefined, 'sterling-evidence-columns');
    const results = element('section', undefined, 'sterling-evidence-results');
    const detail = element('aside', undefined, 'sterling-evidence-detail sterling-evidence-card');
    detail.id = `${widgetId}-detail`;
    detail.tabIndex = -1;
    detail.hidden = true;
    const matching = [...filterCells(cells, this.state.filters, context)].sort((a, b) => PRIORITY[a.displayState] - PRIORITY[b.displayState]);
    const title = element('div', undefined, 'sterling-evidence-results-title');
    const heading = element('h2', T.controlsTitle);
    heading.tabIndex = -1;
    title.append(heading, element('p', fillText(T.controlsCount, { shown: matching.length, total: cells.length }), 'sterling-evidence-meta sterling-evidence-count'));
    results.append(title);
    if (!matching.length) {
      const empty = element('p', T.controlsNoMatch, 'sterling-evidence-meta');
      const clear = button(T.filterClear);
      clear.addEventListener('click', () => this.setFilters(DEFAULT_FILTERS));
      empty.append(' ', clear);
      results.append(empty);
    } else {
      const list = element('ul', undefined, 'sterling-evidence-controls');
      for (const row of matching.slice(0, this.state.shown)) list.append(this.renderRow(row, detail, context));
      results.append(list);
      if (matching.length > this.state.shown) {
        const more = button(T.controlsMore);
        more.addEventListener('click', () => {
          const first = this.state.shown;
          this.state = { ...this.state, shown: this.state.shown + PAGE_SIZE };
          this.render();
          this.body.querySelectorAll<HTMLElement>('.sterling-evidence-controls > li > button')[first]?.focus();
        });
        results.append(more);
      }
    }
    columns.append(results, detail);
    const open = this.state.openKey ? cells.find((row) => cellKey(row) === this.state.openKey) : undefined;
    if (open) this.fillDetail(open, detail, context, !matching.includes(open));
    return columns;
  }

  private renderRow(row: EvidenceRow, detail: HTMLElement, context: ViewContext): HTMLElement {
    const item = element('li');
    const facts = cellFacts(row, context);
    const control = element('button');
    control.type = 'button';
    control.dataset.key = cellKey(row);
    control.dataset.state = row.displayState;
    control.setAttribute('aria-label', facts.label);
    control.setAttribute('aria-expanded', String(this.state.openKey === cellKey(row)));
    control.setAttribute('aria-controls', detail.id);
    const line = element('div', undefined, 'sterling-evidence-facts');
    const fact = (name: string, value: { icon?: string; words: string } | undefined, data?: Record<string, string>): void => {
      if (!value) return;
      const node = element('span', undefined, `sterling-evidence-fact sterling-evidence-${name}`);
      for (const [key, dataValue] of Object.entries(data ?? {})) node.dataset[key] = dataValue;
      node.append(icon(value.icon), element('span', value.words));
      line.append(node);
    };
    if (facts.noComponentApplies) line.append(element('span', facts.noComponentApplies, 'sterling-evidence-fact'));
    else {
      fact('source', facts.source);
      fact('asof', facts.asOf);
      fact('freshness', facts.freshness, { freshness: facts.freshness.value });
      fact('verification', facts.verification, { verification: facts.verification.value });
      fact('count', facts.count);
    }
    control.append(element('strong', `${row.label} · ${row.title}`), badgeNode(row.displayState), line);
    control.addEventListener('click', () => {
      this.state = { ...this.state, openKey: cellKey(row) };
      this.render();
      this.body.querySelector<HTMLElement>('.sterling-evidence-detail')?.focus();
    });
    item.append(control);
    return item;
  }

  private fillDetail(row: EvidenceRow, detail: HTMLElement, context: ViewContext, noLongerMatches: boolean): void {
    const close = button(T.detailClose);
    const closeDetail = (): void => {
      this.state = { ...this.state, openKey: undefined };
      this.render();
      this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(cellKey(row))}"]`)?.focus();
    };
    close.addEventListener('click', closeDetail);
    detail.onkeydown = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeDetail(); } };
    const facts = cellFacts(row, context);
    const children: HTMLElement[] = [close];
    if (noLongerMatches) children.push(element('p', T.detailNoLongerMatches, 'sterling-evidence-meta'));
    children.push(element('h2', `${row.label} · ${row.title}`), badgeNode(row.displayState));
    if (row.displayState === 'not-verified') children.push(element('p', fillText(T.wouldBe, { state: T.stateWords[row.state] }), 'sterling-evidence-meta'));
    children.push(element('p', row.reasonText));
    const list = element('dl', undefined, 'sterling-evidence-source-facts');
    const add = (dt: string, dd: string | undefined): void => { if (dd) list.append(element('dt', dt), element('dd', dd)); };
    add(T.detailDt.source, facts.source.words);
    add(T.detailDt.asOf, facts.asOf?.words);
    add(T.detailDt.freshness, facts.freshness.words);
    add(T.detailDt.verification, facts.verification.words);
    add(T.detailDt.evidence, facts.count?.words);
    children.push(list);
    if (row.sources.length === 1 && row.sources[0] === 'reference-site') children.push(element('p', T.referenceSite, 'sterling-evidence-meta'));
    for (const component of row.components) {
      const block = element('section', undefined, 'sterling-evidence-component');
      block.append(element('h3', component.component), element('p', fillText(T.detailResponsibility, { words: T.responsibilityWords[component.responsibility] ?? component.responsibility })),
        badgeNode(row.verification === 'verified' ? component.state : 'not-verified'));
      const lines = componentLines(component);
      if (lines.applicability) block.append(element('p', lines.applicability));
      if (lines.reason) block.append(element('p', lines.reason));
      if (component.statement || component.reasonText) block.append(element('p', component.statement ?? component.reasonText));
      if (!lines.showFacts) {
        block.append(element('p', lines.factsNone ?? T.applicabilityFactsNone, 'sterling-evidence-meta'));
      } else {
        const evidence = element('ul');
        for (const result of component.evidence) {
          const freshness = cellFacts({ ...row, freshness: result.freshness }, context).freshness.words;
          const text = [result.rule, result.passed ? T.detailPassed : T.detailNotPassed, T.source[result.source], fillText(T.asOf, { time: formatTime(result.collectedAt) }),
            freshness, T.verification[row.verification], result.commit?.slice(0, 12)].filter(Boolean).join(' · ');
          const lineNode = element('li', text);
          const link = externalLink(T.ciRun, result.runUrl, true);
          if (link) lineNode.append(' ', link);
          evidence.append(lineNode);
        }
        block.append(element('h4', T.detailEvidence), evidence.childElementCount ? evidence : element('p', T.detailNoEvidence, 'sterling-evidence-meta'));
      }
      children.push(block);
    }
    if (!row.components.length) children.push(element('p', T.detailNoStatements, 'sterling-evidence-meta'));
    const official = element('details');
    official.append(element('summary', T.detailOfficial));
    const prose = element('div', T.detailOfficialLoading);
    official.append(prose);
    children.push(official);
    detail.replaceChildren(...children);
    detail.setAttribute('aria-label', fillText(T.detailDetailsFor, { label: row.label }));
    detail.hidden = false;
    void this.loadOfficialText(row, prose);
  }

  private async loadOfficialText(row: EvidenceRow, prose: HTMLElement): Promise<void> {
    const request = ++this.textRequest;
    const file = row.textFile;
    if (!file || !CONTROL_TEXT_FILE.test(file)) { prose.textContent = T.detailOfficialMissing; return; }
    try {
      const answer = await this.evidence.getControlText(file);
      if (request !== this.textRequest) return;
      const value = answer.kind === 'ready' ? answer.text : undefined;
      const control = record(value) && Array.isArray(value.controls) ? value.controls.find((item: unknown) => record(item) && item.id === row.control) as unknown : undefined;
      if (!record(control) || !Array.isArray(control.parts)) { prose.textContent = T.detailOfficialMissing; return; }
      const parts = control.parts.filter((item: unknown): item is { lang: string; prose: string } => record(item) && typeof item.lang === 'string' && typeof item.prose === 'string');
      if (!parts.length) { prose.textContent = T.detailOfficialMissing; return; }
      prose.replaceChildren();
      if (record(value) && record(value.attribution)) {
        const { source, url, notice } = value.attribution;
        if (typeof source === 'string') {
          const attribution = element('p');
          attribution.append(externalLink(source, typeof url === 'string' ? url : undefined) ?? source);
          prose.append(attribution);
        }
        if (typeof notice === 'string') prose.append(element('p', notice));
      }
      const french = element('details');
      french.lang = 'fr';
      french.append(element('summary', T.french));
      for (const part of parts) (part.lang === 'fr' ? french : prose).append(element('p', part.prose, 'sterling-evidence-official-text'));
      if (french.childElementCount > 1) prose.append(french);
    } catch {
      if (request === this.textRequest) prose.textContent = T.detailOfficialMissing;
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
  bindFrontendService<SterlingEvidenceService>(bind, SterlingEvidenceService, EVIDENCE_SERVICE_PATH);
  bind(SterlingComplianceWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId,
    createWidget: () => context.container.get(SterlingComplianceWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingComplianceContribution);
});

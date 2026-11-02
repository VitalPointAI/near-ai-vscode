// Team Board client core (62-UI-SPEC): one script draws the compact list (under 520 px) and the kanban (520 px and over) from the host's model.
// Plain browser JavaScript in an IIFE, no framework and no build step. Every text node is set with textContent and every attribute with setAttribute,
// so no title, reason or name is ever parsed as markup. The page never decides permissions: it shows the moves and refusals the model gives and sends
// requests; the host checks everything again. The feature scripts (menu, drag, detail, form) plug in through window.NearAiBoard.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BREAKPOINT = 520;
  const CELL_CAP = 30;
  const LATER = ['claimed', 'in-progress', 'in-review', 'integrating'];
  const GROUPS_OPEN = ['backlog', 'ready'];
  const GROUP_BY = ['member', 'phase', 'milestone', 'none'];
  const GROUP_LABELS = { member: 'Member', phase: 'Phase', milestone: 'Milestone', none: 'None' };
  const COLUMN_ICONS = { backlog: 'circle-outline', ready: 'play-circle', claimed: 'person', 'in-progress': 'sync', 'in-review': 'eye', integrating: 'git-merge', done: 'pass', cancelled: 'circle-slash' };
  const T = {
    title: 'Team Board', loading: 'Loading the Team Board...', slow: 'This is taking longer than usual. The team remote may be slow.', tryAgain: 'Try again', showDetails: 'Show details',
    errorHead: 'The Team Board could not be loaded', emptyHead: 'No work on the board yet', emptyOwner: 'Import your plans from the project roadmap, or add an item yourself.',
    emptyDev: 'A lead has not imported the plans yet. You can add a bug, chore or spike yourself.', emptyView: 'A lead has not imported the plans yet. Cards show up here when they do.',
    noCards: 'No cards here.', noMatch: 'No cards match these filters', clearBody: 'Clear the filters to see every card.', mineBody: 'Nothing is yours yet. Cards you create or claim show up here.',
    clear: 'Clear filters', importPlans: 'Import plans', newItem: 'New item', openBoard: 'Open Team Board', moveTo: 'Move to...', dismiss: 'Dismiss message', filters: 'Filters',
    paused: 'The team log changed in a way the board cannot trust, so the board is paused. Run "NEAR AI: Verify Team Log" to find out why.',
    notTrusted: 'The team log did not pass its checks, so the board is paused. Run "NEAR AI: Verify Team Log" to find out why.',
    removed: 'You were removed from this team. You can still look at the board but not change it.',
    hintMove: 'Press Enter to open details. Press M to move this card.', hintOpen: 'Press Enter to open details.'
  };
  const ICONS = (function () {
    const o = (x, y, r) => 'M' + (x - r) + ' ' + y + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0';
    return {
      'circle-outline': [o(8, 8, 5.5)], 'play-circle': [o(8, 8, 5.5), 'M6.5 5.5L10.5 8L6.5 10.5Z'], person: [o(8, 5, 2.5), 'M3 13.5C3 10.5 5 9 8 9C11 9 13 10.5 13 13.5'],
      sync: ['M12.5 6A5 5 0 0 0 4 5', 'M3.5 10A5 5 0 0 0 12 11', 'M12.5 2.5V6H9', 'M3.5 13.5V10H7'], eye: ['M1.5 8C3.5 4.5 12.5 4.5 14.5 8C12.5 11.5 3.5 11.5 1.5 8Z', o(8, 8, 1.8)],
      'git-merge': [o(4, 3.5, 1.5), o(4, 12.5, 1.5), o(12, 8, 1.5), 'M4 5V11', 'M4 8H10.5'], pass: [o(8, 8, 5.5), 'M5.5 8L7.5 10L10.5 6.5'], 'circle-slash': [o(8, 8, 5.5), 'M4.2 11.8L11.8 4.2'],
      lock: ['M3.5 7.5H12.5V13.5H3.5Z', 'M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0V7.5'], 'debug-pause': ['M5.5 3.5V12.5', 'M10.5 3.5V12.5'], info: [o(8, 8, 5.5), 'M8 7.5V11', 'M8 5.2V5.3'],
      link: ['M6.5 9.5L9.5 6.5', 'M7 5L8 4a2.5 2.5 0 0 1 3.5 3.5L10.5 8.5', 'M9 11L8 12a2.5 2.5 0 0 1-3.5-3.5L5.5 7.5'], clock: [o(8, 8, 5.5), 'M8 4.5V8L10.5 9.5'],
      'arrow-swap': ['M2.5 5.5H12.5', 'M10 3L12.5 5.5L10 8', 'M13.5 10.5H3.5', 'M6 8L3.5 10.5L6 13'], 'chevron-right': ['M6 3.5L10.5 8L6 12.5'], 'chevron-down': ['M3.5 6L8 10.5L12.5 6'],
      error: [o(8, 8, 5.5), 'M5.8 5.8L10.2 10.2', 'M10.2 5.8L5.8 10.2'], warning: ['M8 2L14.5 13.5H1.5Z', 'M8 6.5V9.5', 'M8 11.5V11.6'], filter: ['M2 3H14L9.5 8.5V13L6.5 11.5V8.5Z'],
      add: ['M8 3V13', 'M3 8H13'], 'link-external': ['M9 2.5H13.5V7', 'M13.5 2.5L7.5 8.5', 'M11.5 9.5V13.5H2.5V4.5H6.5'], close: ['M3.5 3.5L12.5 12.5', 'M12.5 3.5L3.5 12.5'],
      'arrow-left': ['M13 8H3', 'M7 4L3 8L7 12'], organization: [o(8, 5, 2), 'M3.5 13.5V12a2.5 2.5 0 0 1 2.5-2.5H10a2.5 2.5 0 0 1 2.5 2.5V13.5']
    };
  })();

  // ---- state kept across reloads (D-15) -----------------------------------------------------------------------------------------------------
  const saved = vscode.getState() || {};
  const ui = {
    groupBy: GROUP_BY.indexOf(saved.groupBy) >= 0 ? saved.groupBy : 'member',
    filters: Object.assign({ mine: false, ready: false, blocked: false, requirement: '', phase: '' }, saved.filters || {}),
    collapsedColumns: saved.collapsedColumns || {}, collapsedLanes: saved.collapsedLanes || {}, openGroups: saved.openGroups || {},
    selected: typeof saved.selected === 'string' ? saved.selected : '', milestone: typeof saved.milestone === 'string' ? saved.milestone : '', filtersOpen: saved.filtersOpen === true
  };
  // The item form's unsent draft (form.js) lives in the same stored state: the page may acquire the VS Code API only once, so the form borrows it here.
  let formDraft = saved.draft && typeof saved.draft === 'object' ? saved.draft : undefined;
  const persist = () => vscode.setState({ groupBy: ui.groupBy, filters: ui.filters, collapsedColumns: ui.collapsedColumns, collapsedLanes: ui.collapsedLanes, openGroups: ui.openGroups, selected: ui.selected, milestone: ui.milestone, filtersOpen: ui.filtersOpen, ...(formDraft ? { draft: formDraft } : {}) });

  // ---- runtime state (not persisted) ---------------------------------------------------------------------------------------------------------
  let model;
  let layout = (window.innerWidth || 800) < BREAKPOINT ? 'list' : 'kanban';
  let loadError = '';
  let notice = '';
  let slow = false;
  let dirty = false;
  let slowTimer;
  let colFocus = 0;
  const pending = {};
  const refusals = {};
  const active = {};
  const showAll = new Set();
  const cardEls = new Map();
  const parts = new Map();
  const sigs = new Map();
  const laneEls = new Map();
  const cellEls = new Map();
  const groupEls = new Map();
  const headEls = new Map();
  const moreEls = new Map();
  const bannerEls = new Map();
  const renderListeners = [];
  const messageListeners = {};
  let menuOpener, detailOpener, formOpener;

  // ---- small helpers -------------------------------------------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const attr = (n, k, v) => { if (v === null || v === undefined || v === false) { if (n.getAttribute(k) !== null) n.removeAttribute(k); } else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, String(v)); };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['class', 'icon'], ['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true'], ['focusable', 'false'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
    for (const d of ICONS[name] || []) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
    return svg;
  }
  const iconText = (cls, name, text) => { const s = el('span', cls); s.append(icon(name), el('span', 'label', text)); return s; };
  function button(cls, label, onClick, name) {
    const b = el('button', cls);
    b.setAttribute('type', 'button');
    if (name) b.appendChild(icon(name));
    if (label) b.appendChild(el('span', 'label', label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  /** Puts exactly these nodes, in this order, into the parent. Nodes already there are kept (so focus survives), others are moved or removed. */
  function place(parent, nodes) {
    let i = 0;
    for (const n of nodes) { const cur = parent.children[i]; if (cur !== n) parent.insertBefore(n, cur || null); i += 1; }
    while (parent.children.length > nodes.length) parent.children[parent.children.length - 1].remove();
  }
  const post = (message) => vscode.postMessage(message);
  let liveTimer;
  function announce(text) {
    const live = $('live');
    if (!text || !live) return;
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 100);
  }
  const labelOf = (c) => (c.kind === 'plan' ? 'plan ' + c.displayId : c.displayId);

  // ---- the model, seen through the milestone and the filters -------------------------------------------------------------------------------
  function milestoneId() {
    if (!model) return 'all';
    return ui.milestone === 'all' || model.milestones.some((m) => m.id === ui.milestone) ? ui.milestone : model.selectedMilestone;
  }
  const inMilestone = (c) => { const sel = milestoneId(); return sel === 'all' || c.milestoneId === sel || c.milestoneId === undefined; };
  function matches(c) {
    const f = ui.filters;
    const req = f.requirement.trim().toLowerCase();
    return (!f.mine || c.mine) && (!f.ready || c.column === 'ready') && (!f.blocked || !!c.blocked) && (!req || c.requirements.some((r) => r.toLowerCase() === req)) && (!f.phase || c.phaseId === f.phase);
  }
  const filtersOn = () => { const f = ui.filters; return (f.mine ? 1 : 0) + (f.ready ? 1 : 0) + (f.blocked ? 1 : 0) + (f.requirement.trim() ? 1 : 0) + (f.phase ? 1 : 0); };
  const cardsInMilestone = () => (model ? model.cards.filter(inMilestone) : []);
  const shownCards = () => cardsInMilestone().filter(matches);
  const statusKind = () => (model ? model.status.kind : 'live');
  const isDown = () => ['offline', 'paused', 'removed'].indexOf(statusKind()) >= 0;
  function clock(v) {
    if (!v) return 'earlier';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---- the page skeleton -----------------------------------------------------------------------------------------------------------------------
  const root = $('root');
  const tb = el('header'); tb.id = 'toolbar';
  const bannerEl = el('div'); bannerEl.id = 'banner';
  const board = el('main'); board.id = 'board';
  const detailEl = el('aside'); detailEl.id = 'detail'; detailEl.hidden = true; detailEl.setAttribute('aria-label', 'Card detail');
  const hints = el('div', 'sr-only');
  const hintMove = el('span', '', T.hintMove); hintMove.id = 'hint-move';
  const hintOpen = el('span', '', T.hintOpen); hintOpen.id = 'hint-open';
  hints.append(hintMove, hintOpen);
  const views = { kanban: el('div', 'board-scroll'), list: el('div', 'groups') };
  const heads = el('div', 'colheads');
  const lanesEl = el('div', 'lanes');
  views.kanban.setAttribute('role', 'region'); views.kanban.setAttribute('aria-label', 'Team Board columns');
  heads.setAttribute('role', 'toolbar'); heads.setAttribute('aria-label', 'Columns');
  views.kanban.append(heads, lanesEl);

  // Toolbar controls are built once and updated in place, so typing in the requirement box never loses focus.
  const titleRow = el('div', 'row title-row');
  const h1 = el('h1', 'title', T.title);
  const chip = el('span', 'status-chip');
  titleRow.append(h1, chip);
  const actions = el('div', 'row actions');
  const openBtn = button('secondary', T.openBoard, () => post({ type: 'open-board' }), 'link-external');
  const importBtn = button('secondary', T.importPlans, () => { if (importBtn.getAttribute('aria-disabled') !== 'true') post({ type: 'import-plans' }); }, 'sync');
  const newBtn = button('primary', T.newItem, () => { if (newBtn.getAttribute('aria-disabled') !== 'true') api.openForm(); }, 'add');
  actions.append(openBtn, importBtn, newBtn);
  const controls = el('div', 'controls');
  const summary = el('p', 'summary-line');
  const msWrap = el('div', 'field');
  const msLabel = el('label', '', 'Milestone'); msLabel.setAttribute('for', 'ms-select');
  const msSelect = el('select'); msSelect.id = 'ms-select';
  msSelect.addEventListener('change', () => { ui.milestone = msSelect.value; persist(); render(); });
  msWrap.append(msLabel, msSelect);
  const msSummary = el('div', 'ms-summary');
  const msText = el('span', 'ms-text');
  const msBar = progressBar();
  msSummary.append(msText, msBar.box);
  const groupWrap = el('div', 'field group-by');
  const groupLabel = el('span', 'label', 'Group by');
  const seg = el('div', 'segmented'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Group by');
  const radios = GROUP_BY.map((key) => {
    const r = button('', GROUP_LABELS[key], () => setGroupBy(key));
    r.setAttribute('role', 'radio'); r.dataset.group = key;
    return r;
  });
  seg.append(...radios);
  seg.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = GROUP_BY[(GROUP_BY.indexOf(ui.groupBy) + step + GROUP_BY.length) % GROUP_BY.length];
    setGroupBy(next);
    radios[GROUP_BY.indexOf(next)].focus();
  });
  groupWrap.append(groupLabel, seg);
  const filtersBtn = button('secondary', T.filters, () => { ui.filtersOpen = !ui.filtersOpen; persist(); render(); }, 'filter');
  filtersBtn.setAttribute('aria-controls', 'filters');
  const filtersEl = el('div', 'filters'); filtersEl.id = 'filters';
  const chips = { mine: chipButton('mine', 'Mine', 'Cards you created or hold'), ready: chipButton('ready', 'Ready'), blocked: chipButton('blocked', 'Blocked') };
  const phaseWrap = el('div', 'field');
  const phaseLabel = el('label', '', 'Phase'); phaseLabel.setAttribute('for', 'phase-select');
  const phaseSelect = el('select'); phaseSelect.id = 'phase-select';
  phaseSelect.addEventListener('change', () => api.setFilter('phase', phaseSelect.value));
  phaseWrap.append(phaseLabel, phaseSelect);
  const reqWrap = el('div', 'field');
  const reqLabel = el('label', '', 'Requirement'); reqLabel.setAttribute('for', 'req-input');
  const reqInput = el('input'); reqInput.id = 'req-input'; reqInput.setAttribute('type', 'text'); reqInput.setAttribute('placeholder', 'BOARD-01'); reqInput.setAttribute('list', 'req-list');
  const reqList = el('datalist'); reqList.id = 'req-list';
  reqInput.addEventListener('input', () => api.setFilter('requirement', reqInput.value));
  reqWrap.append(reqLabel, reqInput, reqList);
  const clearBtn = button('link', T.clear, () => clearFilters());
  filtersEl.append(chips.mine, chips.ready, chips.blocked, phaseWrap, reqWrap, clearBtn);
  controls.append(summary, msWrap, msSummary, groupWrap, filtersBtn, filtersEl);
  tb.append(titleRow, controls, actions);
  root.append(tb, bannerEl, board, detailEl, hints);

  function chipButton(name, label, title) {
    const b = button('chip', label, () => api.setFilter(name, !ui.filters[name]));
    if (title) b.setAttribute('title', title);
    return b;
  }
  function progressBar() {
    const box = el('div', 'progress');
    box.setAttribute('role', 'progressbar'); box.setAttribute('aria-valuemin', '0'); box.setAttribute('aria-valuemax', '100');
    const fill = el('span', 'bar');
    box.appendChild(fill);
    return { box, fill };
  }
  function setProgress(bar, progress, label) {
    const pct = progress ? progress.percent : 0;
    bar.fill.style.setProperty('width', pct + '%');
    attr(bar.box, 'aria-valuenow', pct);
    attr(bar.box, 'aria-label', label);
  }
  function setGroupBy(key) { ui.groupBy = key; persist(); render(); }
  function clearFilters() {
    ui.filters = { mine: false, ready: false, blocked: false, requirement: '', phase: '' };
    persist(); render(); scheduleFilterAnnounce();
  }
  let filterTimer;
  function scheduleFilterAnnounce() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { if (model) announce('Showing ' + shownCards().length + ' of ' + cardsInMilestone().length + ' cards.'); }, 500);
  }

  // ---- layout ------------------------------------------------------------------------------------------------------------------------------------
  function applyLayout() {
    root.setAttribute('data-layout', layout);
    if (layout === 'list') { place(tb, [titleRow, actions, bannerEl, controls]); place(root, [tb, board, detailEl, hints]); } else { place(tb, [titleRow, controls, actions]); place(root, [tb, bannerEl, board, detailEl, hints]); }
  }
  function setLayout(width) {
    const next = width < BREAKPOINT ? 'list' : 'kanban';
    if (next === layout) return;
    layout = next;
    render();
  }

  // ---- toolbar -----------------------------------------------------------------------------------------------------------------------------------
  function roleOf() { return model && model.viewer.role; }
  function renderToolbar() {
    const has = !!model;
    const empty = has && model.cards.length === 0;
    attr(chip, 'hidden', has ? null : '');
    if (has) {
      const k = model.status.kind;
      const readOnly = (k === 'live' || k === 'syncing') && (roleOf() === 'observer' || roleOf() === 'reviewer' || !roleOf());
      const word = readOnly ? 'Read only' : { live: 'Live', syncing: 'Syncing...', offline: 'Offline', paused: 'Paused', removed: 'Read only' }[k] || 'Live';
      const name = readOnly ? 'info' : { live: 'pass', syncing: 'sync', offline: 'warning', paused: 'warning', removed: 'info' }[k] || 'pass';
      chip.replaceChildren(icon(name), el('span', 'label', word));
      chip.className = 'status-chip status-' + (readOnly ? 'readonly' : k);
    }
    actions.hidden = !has || empty;
    controls.hidden = !has || empty;
    openBtn.hidden = layout !== 'list';
    if (!has || empty) return;
    const v = model.viewer;
    const down = isDown();
    const canAdd = ['owner', 'lead', 'developer'].indexOf(v.role) >= 0;
    const explain = v.readOnlyReason || '';
    importBtn.hidden = !(v.canImport || (down && (v.role === 'owner' || v.role === 'lead')));
    attr(importBtn, 'aria-disabled', v.canImport && !down ? null : 'true'); attr(importBtn, 'title', v.canImport && !down ? null : explain);
    newBtn.hidden = !(v.canCreate || (down && canAdd));
    attr(newBtn, 'aria-disabled', v.canCreate && !down ? null : 'true'); attr(newBtn, 'title', v.canCreate && !down ? null : explain);
    // summary line and milestone picker
    const all = cardsInMilestone();
    const ready = all.filter((c) => c.column === 'ready').length;
    setText(summary, plural(all.length, 'card', 'cards') + ' · ' + ready + ' ready · ' + all.filter((c) => c.blocked).length + ' blocked');
    const sel = milestoneId();
    msWrap.hidden = model.milestones.length === 0;
    const wanted = model.milestones.map((m) => [m.id, m.title]).concat([['all', 'All milestones']]);
    syncOptions(msSelect, wanted, sel);
    const m = model.milestones.find((x) => x.id === sel);
    msSummary.hidden = layout !== 'kanban' || !m;
    if (m) { setText(msText, m.title + ': ' + m.progress.text); setProgress(msBar, m.progress, m.title + ' progress'); msBar.box.hidden = m.progress.total === 0; }
    // group by (kanban only)
    groupWrap.hidden = layout !== 'kanban';
    radios.forEach((r) => { const on = r.dataset.group === ui.groupBy; attr(r, 'aria-checked', on ? 'true' : 'false'); attr(r, 'tabindex', on ? 0 : -1); });
    // filters
    filtersBtn.hidden = layout !== 'list';
    const n = filtersOn();
    const label = filtersBtn.querySelector('.label');
    setText(label, n ? T.filters + ' (' + n + ')' : T.filters);
    attr(filtersBtn, 'aria-expanded', ui.filtersOpen ? 'true' : 'false');
    filtersEl.hidden = layout === 'list' && !ui.filtersOpen;
    for (const key of Object.keys(chips)) attr(chips[key], 'aria-pressed', ui.filters[key] ? 'true' : 'false');
    syncOptions(phaseSelect, [['', 'All phases']].concat(model.phases.map((p) => [p.id, p.title])), ui.filters.phase);
    if (reqInput.value !== ui.filters.requirement) reqInput.value = ui.filters.requirement;
    place(reqList, model.requirements.map((r) => { const o = el('option'); o.setAttribute('value', r); return o; }));
    clearBtn.hidden = n === 0;
  }
  function syncOptions(select, pairs, value) {
    const sig = JSON.stringify(pairs);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      place(select, pairs.map(([v, t]) => { const o = el('option', '', t); o.setAttribute('value', v); return o; }));
    }
    select.value = value;
    for (const o of select.children) o.selected = o.getAttribute('value') === value;
  }

  // ---- banners -------------------------------------------------------------------------------------------------------------------------------------
  const errorBody = (reason) => reason.replace(/[.\s]+$/, '') + '. Nothing was changed. Try again, or show details in the NEAR AI Team output.';
  function bannerList() {
    const out = [];
    const retry = [T.tryAgain, () => retryLoad()];
    if (loadError && model) out.push({ key: 'error', role: 'alert', icon: 'error', text: T.errorHead + '. ' + errorBody(loadError), actions: [retry, [T.showDetails, () => post({ type: 'show-details' })]] });
    if (model) {
      const s = model.status;
      if (s.kind === 'offline') out.push({ key: 'offline', role: 'status', icon: 'warning', text: 'You are offline. The board shows the last update at ' + clock(s.lastUpdated) + '. Cards cannot be moved or added until the connection returns.', actions: [retry] });
      else if (s.kind === 'paused') out.push({ key: 'paused', role: 'alert', icon: 'warning', text: /did not pass|not trusted/i.test(s.text || '') ? T.notTrusted : T.paused });
      else if (s.kind === 'removed') out.push({ key: 'removed', role: 'status', icon: 'info', text: T.removed });
      else if (model.viewer.readOnlyReason) out.push({ key: 'readonly', role: 'status', icon: 'info', text: model.viewer.readOnlyReason });
    }
    if (notice) out.push({ key: 'notice', role: 'status', icon: 'info', text: notice, dismiss: true });
    return out;
  }
  function renderBanners() {
    const list = bannerList();
    const used = new Set(list.map((b) => b.key));
    for (const [k, node] of bannerEls) if (!used.has(k)) { node.remove(); bannerEls.delete(k); }
    place(bannerEl, list.map((b) => {
      let node = bannerEls.get(b.key);
      if (!node) {
        node = el('div', 'banner banner-' + b.key);
        node.setAttribute('role', b.role);
        node.append(icon(b.icon), el('span', 'banner-text'));
        for (const [label, fn] of b.actions || []) node.appendChild(button('link', label, fn));
        if (b.dismiss) { const d = button('icon dismiss-banner', '', () => { notice = ''; render(); }, 'close'); d.setAttribute('aria-label', T.dismiss); d.setAttribute('title', T.dismiss); node.appendChild(d); }
        bannerEls.set(b.key, node);
      }
      setText(node.children[1], b.text);
      return node;
    }));
  }
  function retryLoad() {
    post({ type: 'retry' });
    slow = false;
    startSlowTimer();
  }
  function startSlowTimer() {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { if (!model) { slow = true; render(); } }, 10000);
  }

  // ---- main content ------------------------------------------------------------------------------------------------------------------------------
  function stateView(cls, head, body, buttons, role) {
    const box = el('div', 'state ' + cls);
    if (role) box.setAttribute('role', role);
    if (head) box.appendChild(el(cls === 'loading' ? 'p' : 'h2', 'state-head', head));
    if (body) box.appendChild(el('p', 'state-body', body));
    for (const b of buttons || []) box.appendChild(b);
    return box;
  }
  function renderMain() {
    if (!model) {
      if (loadError) place(board, [stateView('error', T.errorHead, errorBody(loadError), [button('primary', T.tryAgain, retryLoad), button('secondary', T.showDetails, () => post({ type: 'show-details' }))], 'alert')]);
      else if (slow) place(board, [stateView('loading', T.slow, '', [button('primary', T.tryAgain, retryLoad)], 'status')]);
      else place(board, [stateView('loading', T.loading, '', [], 'status')]);
      return;
    }
    const v = model.viewer;
    if (model.cards.length === 0) {
      const lead = v.role === 'owner' || v.role === 'lead';
      const dev = v.role === 'developer';
      const down = isDown();
      let cta;
      if (lead) { cta = button('primary', T.importPlans, () => { if (!down) post({ type: 'import-plans' }); }, 'sync'); if (down || !v.canImport) cta.setAttribute('aria-disabled', 'true'); }
      else if (dev) { cta = button('primary', T.newItem, () => { if (!down) api.openForm(); }, 'add'); if (down || !v.canCreate) cta.setAttribute('aria-disabled', 'true'); }
      place(board, [stateView('empty', T.emptyHead, lead ? T.emptyOwner : dev ? T.emptyDev : T.emptyView, cta ? [cta] : [])]);
      return;
    }
    const total = cardsInMilestone();
    const shown = total.filter(matches);
    if (total.length > 0 && shown.length === 0) {
      place(board, [stateView('filtered', T.noMatch, ui.filters.mine ? T.mineBody : T.clearBody, [button('link', T.clear, clearFilters)])]);
      return;
    }
    if (layout === 'kanban') { renderKanban(shown); place(board, [views.kanban]); } else { renderList(shown); place(board, [views.list]); }
  }

  // Cards ---------------------------------------------------------------------------------------------------------------------------------------
  function cardEl(c) {
    let li = cardEls.get(c.id);
    if (!li) {
      li = el('li', 'card');
      li.setAttribute('data-id', c.id);
      const main = el('button', 'card-main'); main.setAttribute('type', 'button');
      const mv = el('button', 'move-btn icon'); mv.setAttribute('type', 'button');
      mv.setAttribute('aria-haspopup', 'menu'); mv.setAttribute('aria-controls', 'menu'); mv.setAttribute('aria-expanded', 'false');
      const msg = el('div', 'card-msg');
      li.append(main, mv, msg);
      main.addEventListener('click', () => { ui.selected = c.id; persist(); render(); api.openDetail(c.id, main); });
      mv.addEventListener('click', () => { if (mv.getAttribute('aria-disabled') !== 'true') api.openMenu(c.id, mv); });
      cardEls.set(c.id, li);
      parts.set(c.id, { main, mv, msg });
    }
    updateCard(c, li);
    return li;
  }
  function badge(name, word, cls) { return iconText('badge ' + cls, name, word); }
  function updateCard(c, li) {
    const p = parts.get(c.id);
    const down = isDown();
    const mvVisible = c.moves.length > 0 && (model.viewer.role === 'owner' || model.viewer.role === 'lead') && (down || model.viewer.canWrite);
    const sig = JSON.stringify([c, ui.selected === c.id, pending[c.id], refusals[c.id], mvVisible, down, model.viewer.readOnlyReason]);
    if (sigs.get(c.id) === sig) return;
    sigs.set(c.id, sig);
    const meta = el('span', 'card-meta');
    if (c.blocked) meta.appendChild(badge('lock', 'Blocked', 'badge-blocked'));
    if (c.held) meta.appendChild(badge('debug-pause', 'On hold', 'badge-hold'));
    if (c.doneInGsd) meta.appendChild(badge('info', 'Done in GSD, confirm', 'badge-info'));
    if (c.column === 'cancelled') meta.appendChild(badge('circle-slash', 'Cancelled', 'badge-cancelled'));
    if (c.dependencyCount > 0) meta.appendChild(iconText('meta-item', 'link', plural(c.dependencyCount, 'dependency', 'dependencies')));
    meta.appendChild(el('span', 'meta-item', c.estimateText));
    meta.appendChild(iconText('meta-item', 'clock', c.ageText));
    if (c.createdByName) meta.appendChild(el('span', 'meta-item', 'Created by ' + c.createdByName));
    const top = el('span', 'card-top');
    top.append(iconText('state', COLUMN_ICONS[c.column] || 'circle-outline', c.stateLabel), el('span', 'did', c.displayId));
    const titleNode = el('span', 'card-title', c.title);
    titleNode.setAttribute('title', c.title);
    p.main.replaceChildren(top, titleNode, meta);
    attr(p.main, 'aria-label', c.a11yLabel);
    attr(p.main, 'aria-describedby', c.moves.length > 0 ? 'hint-move' : 'hint-open');
    attr(p.main, 'aria-current', ui.selected === c.id ? 'true' : null);
    li.className = 'card' + (ui.selected === c.id ? ' selected' : '') + (c.column === 'cancelled' ? ' cancelled' : '') + (c.column === 'done' ? ' done' : '') + (pending[c.id] ? ' pending' : '') + (c.blocked ? ' is-blocked' : '');
    li.setAttribute('data-column', c.column);
    attr(li, 'aria-busy', pending[c.id] ? 'true' : null);
    p.mv.hidden = !mvVisible;
    p.mv.replaceChildren(icon('arrow-swap'), el('span', 'label move-text', T.moveTo));
    attr(p.mv, 'aria-label', 'Move to... ' + labelOf(c) + ', ' + c.title);
    attr(p.mv, 'aria-disabled', down ? 'true' : null);
    attr(p.mv, 'title', down ? model.viewer.readOnlyReason || 'Cards cannot be moved right now.' : T.moveTo);
    if (pending[c.id]) p.msg.replaceChildren(el('span', 'pending-line', pending[c.id]));
    else if (refusals[c.id]) {
      const dismiss = button('icon dismiss', '', () => api.clearRefusal(c.id), 'close');
      dismiss.setAttribute('aria-label', T.dismiss); dismiss.setAttribute('title', T.dismiss);
      p.msg.replaceChildren(icon('error'), el('span', 'refusal-line', refusals[c.id]), dismiss);
    } else p.msg.replaceChildren();
    p.msg.hidden = !pending[c.id] && !refusals[c.id];
  }
  function cardList(cards, key, label) {
    const limit = showAll.has(key) ? cards.length : CELL_CAP;
    const nodes = cards.slice(0, limit).map(cardEl);
    if (cards.length > limit) {
      let li = moreEls.get(key);
      if (!li) { li = el('li', 'more'); li.appendChild(button('link', '', () => { showAll.add(key); render(); })); moreEls.set(key, li); }
      setText(li.firstChild, 'Show all ' + cards.length);
      attr(li.firstChild, 'aria-label', 'Show all ' + cards.length + ' cards in ' + label);
      nodes.push(li);
    }
    return nodes;
  }

  // Kanban ----------------------------------------------------------------------------------------------------------------------------------------
  function renderKanban(shown) {
    const cols = model.columns;
    if (colFocus >= cols.length) colFocus = 0;
    place(heads, cols.map((c, i) => headEl(c, shown.filter((x) => x.column === c.key).length, i)));
    const sel = milestoneId();
    const lanes = (model.lanes[ui.groupBy] || []).filter((l) => {
      if (ui.groupBy === 'phase' && l.milestoneId && sel !== 'all' && l.milestoneId !== sel) return false;
      if (ui.groupBy === 'milestone' && sel !== 'all' && l.key !== sel && l.key !== 'board') return false;
      return l.key !== 'board' || shown.some((c) => c.lane[ui.groupBy] === 'board');
    });
    const usedLanes = new Set();
    const usedCells = new Set();
    const nodes = lanes.map((l) => {
      const mine = ui.groupBy === 'none' ? shown : shown.filter((c) => c.lane[ui.groupBy] === l.key);
      return laneEl(l, mine, usedLanes, usedCells);
    });
    for (const [k, n] of laneEls) if (!usedLanes.has(k)) { n.el.remove(); laneEls.delete(k); }
    for (const [k, n] of cellEls) if (!usedCells.has(k)) cellEls.delete(k);
    place(lanesEl, nodes);
  }
  function headEl(c, count, index) {
    let h = headEls.get(c.key);
    if (!h) {
      const box = el('div', 'column'); box.setAttribute('data-column', c.key);
      const b = el('button', 'col-btn'); b.setAttribute('type', 'button');
      b.addEventListener('click', () => { ui.collapsedColumns[c.key] = !ui.collapsedColumns[c.key]; persist(); render(); });
      b.addEventListener('focus', () => { colFocus = headNodes().indexOf(b); });
      box.append(b, el('span', 'caption'));
      h = { box, b };
      headEls.set(c.key, h);
    }
    const collapsed = !!ui.collapsedColumns[c.key];
    h.box.className = 'column' + (collapsed ? ' collapsed' : '');
    h.b.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-down'), icon(COLUMN_ICONS[c.key]), el('span', 'col-name', c.label), el('span', 'col-count', String(count)));
    attr(h.b, 'aria-expanded', collapsed ? 'false' : 'true');
    attr(h.b, 'aria-label', c.label + ' column, ' + plural(count, 'card', 'cards') + ', ' + (collapsed ? 'collapsed' : 'expanded') + '. Press to ' + (collapsed ? 'expand' : 'collapse') + '.');
    attr(h.b, 'tabindex', index === colFocus ? 0 : -1);
    setText(h.box.children[1], c.caption || '');
    h.box.children[1].hidden = !c.caption || collapsed;
    return h.box;
  }
  const headNodes = () => heads.querySelectorAll('.col-btn');
  heads.addEventListener('keydown', (e) => {
    const list = headNodes();
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined || next < 0 || next >= list.length) return;
    e.preventDefault();
    colFocus = next;
    list.forEach((b, i) => attr(b, 'tabindex', i === next ? 0 : -1));
    list[next].focus();
  });
  function laneEl(lane, laneCards, usedLanes, usedCells) {
    const key = ui.groupBy + '|' + lane.key;
    usedLanes.add(key);
    let l = laneEls.get(key);
    if (!l) {
      const section = el('section', 'lane'); section.setAttribute('data-lane', lane.key); section.setAttribute('data-gkey', key);
      const titleBox = el('h2', 'lane-title'); titleBox.id = 'lane-' + laneEls.size + '-' + lane.key.replace(/[^\w-]/g, '_');
      const head = el('button', 'lane-head'); head.setAttribute('type', 'button');
      titleBox.appendChild(head);
      const prog = progressBar();
      const progText = el('span', 'progress-text');
      const progBox = el('div', 'lane-progress'); progBox.append(prog.box, progText);
      const grid = el('div', 'lane-grid');
      head.addEventListener('click', () => { const k = ui.groupBy + ':' + lane.key; const cur = k in ui.collapsedLanes ? ui.collapsedLanes[k] : lane.collapsedByDefault; ui.collapsedLanes[k] = !cur; persist(); render(); });
      l = { el: section, titleBox, head, prog, progText, progBox, grid };
      laneEls.set(key, l);
    }
    const stored = ui.groupBy + ':' + lane.key;
    const collapsed = stored in ui.collapsedLanes ? ui.collapsedLanes[stored] : lane.collapsedByDefault;
    const noHead = ui.groupBy === 'none';
    attr(l.el, 'aria-labelledby', noHead ? null : l.titleBox.id);
    attr(l.el, 'aria-label', noHead ? lane.label : null);
    l.head.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-down'), el('span', 'lane-label', lane.label), el('span', 'lane-count', '(' + laneCards.length + ')'));
    attr(l.head, 'aria-expanded', collapsed ? 'false' : 'true');
    const showProgress = !noHead && lane.progress;
    if (showProgress) {
      setProgress(l.prog, lane.progress, lane.label + ' progress');
      l.prog.box.hidden = lane.progress.total === 0;
      setText(l.progText, lane.progress.text);
    }
    l.grid.hidden = collapsed;
    place(l.grid, model.columns.map((col) => cellEl(lane, col, laneCards.filter((c) => c.column === col.key), usedCells)));
    place(l.el, [].concat(noHead ? [] : [l.titleBox], showProgress ? [l.progBox] : [], [l.grid]));
    return l.el;
  }
  function cellEl(lane, col, cards, usedCells) {
    const collapsedCol = !!ui.collapsedColumns[col.key];
    const kind = collapsedCol ? 'x' : cards.length === 0 ? 'e' : 'f';
    const key = ui.groupBy + '|' + lane.key + '|' + col.key + '|' + kind;
    usedCells.add(key);
    let node = cellEls.get(key);
    if (!node) {
      node = el(kind === 'f' ? 'ul' : 'div', 'cell' + (kind === 'x' ? ' collapsed' : ''));
      node.setAttribute('data-column', col.key); node.setAttribute('data-lane', lane.key);
      cellEls.set(key, node);
    }
    if (kind === 'x') setText(node, plural(cards.length, 'card', 'cards') + ', column collapsed');
    else if (kind === 'e') { if (!node.children.length) node.appendChild(el('span', 'sr-only', 'No cards')); } else {
      attr(node, 'aria-label', lane.label + ', ' + col.label);
      place(node, cardList(cards, ui.groupBy + '|' + lane.key + '|' + col.key, lane.label + ', ' + col.label));
    }
    return node;
  }

  // List ------------------------------------------------------------------------------------------------------------------------------------------
  function renderList(shown) {
    const used = new Set();
    const nodes = model.columns.map((col) => {
      const cards = shown.filter((c) => c.column === col.key);
      let g = groupEls.get(col.key);
      if (!g) {
        const section = el('section', 'group'); section.setAttribute('data-column', col.key); section.setAttribute('data-gkey', 'list|' + col.key);
        const h = el('h2', 'group-title');
        const head = el('button', 'group-head'); head.setAttribute('type', 'button'); head.setAttribute('aria-controls', 'group-' + col.key);
        h.appendChild(head);
        const body = el('div', 'group-body'); body.id = 'group-' + col.key;
        const rows = el('ul', 'rows'); rows.setAttribute('aria-label', col.label);
        const none = el('p', 'empty-line', T.noCards);
        const caption = el('p', 'caption', col.caption || '');
        head.addEventListener('click', () => { const open = col.key in ui.openGroups ? ui.openGroups[col.key] : GROUPS_OPEN.indexOf(col.key) >= 0; ui.openGroups[col.key] = !open; persist(); render(); });
        section.append(h, body);
        g = { section, head, body, rows, none, caption };
        groupEls.set(col.key, g);
      }
      used.add(col.key);
      const open = col.key in ui.openGroups ? ui.openGroups[col.key] : GROUPS_OPEN.indexOf(col.key) >= 0;
      g.head.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'), icon(COLUMN_ICONS[col.key]), el('span', 'group-name', col.label), el('span', 'group-count', '(' + cards.length + ')'));
      attr(g.head, 'aria-expanded', open ? 'true' : 'false');
      g.body.hidden = !open;
      if (cards.length === 0) place(g.body, LATER.indexOf(col.key) >= 0 && col.caption ? [g.none, g.caption] : [g.none]);
      else { place(g.rows, cardList(cards, 'list|' + col.key, col.label)); place(g.body, [g.rows]); }
      return g.section;
    });
    for (const k of [...groupEls.keys()]) if (!used.has(k)) groupEls.delete(k);
    place(views.list, nodes);
  }

  // ---- roving focus and the keyboard model -----------------------------------------------------------------------------------------------
  function applyRoving() {
    const containers = layout === 'kanban' ? views.kanban.querySelectorAll('.lane') : views.list.querySelectorAll('.group');
    for (const group of containers) {
      const cards = group.querySelectorAll('.card');
      const gkey = group.getAttribute('data-gkey');
      const ids = cards.map((c) => c.getAttribute('data-id'));
      if (ids.indexOf(active[gkey]) < 0) active[gkey] = ids[0];
      for (const li of cards) {
        const on = li.getAttribute('data-id') === active[gkey];
        const p = parts.get(li.getAttribute('data-id'));
        attr(p.main, 'tabindex', on ? 0 : -1);
        attr(p.mv, 'tabindex', on ? 0 : -1);
        const d = li.querySelector('.dismiss');
        if (d) attr(d, 'tabindex', on ? 0 : -1);
      }
    }
  }
  function focusEl(li) {
    if (!li) return false;
    const id = li.getAttribute('data-id');
    const group = li.closest('.lane') || li.closest('.group');
    if (group) active[group.getAttribute('data-gkey')] = id;
    applyRoving();
    parts.get(id).main.focus();
    return true;
  }
  board.addEventListener('focusin', (e) => {
    const li = e.target && e.target.closest ? e.target.closest('.card') : null;
    const group = li && (li.closest('.lane') || li.closest('.group'));
    if (group && active[group.getAttribute('data-gkey')] !== li.getAttribute('data-id')) { active[group.getAttribute('data-gkey')] = li.getAttribute('data-id'); applyRoving(); }
  });
  board.addEventListener('keydown', (e) => {
    const target = e.target;
    const li = target && target.closest ? target.closest('.card') : null;
    if (!li || e.altKey || e.metaKey) return;
    const id = li.getAttribute('data-id');
    const c = cardData(id);
    const menuKey = (!e.ctrlKey && (e.key === 'M' || e.key === 'm')) || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu';
    if (menuKey) {
      if (c && c.moves.length > 0 && !(isDown())) { e.preventDefault(); const p = parts.get(id); api.openMenu(id, p.mv.hidden ? p.main : p.mv); }
      return;
    }
    if (target.classList.contains('card-main') === false) return;
    const next = navTarget(li, e.key, e.ctrlKey);
    if (next === undefined) return;
    e.preventDefault();
    if (next) focusEl(next);
  });
  /** The card to focus for an arrow or Home or End key; null when there is nowhere to go, undefined when the key is not navigation. */
  function navTarget(li, key, ctrl) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return undefined;
    if (layout === 'list') {
      const rows = li.closest('.group').querySelectorAll('.card');
      const at = rows.indexOf(li);
      return { ArrowDown: rows[at + 1], ArrowUp: rows[at - 1], Home: rows[0], End: rows[rows.length - 1] }[key] || null;
    }
    const lane = li.closest('.lane');
    const grid = lane.querySelectorAll('ul.cell').map((cell) => cell.querySelectorAll('.card')).filter((cards) => cards.length > 0);
    const col = grid.findIndex((cards) => cards.indexOf(li) >= 0);
    const row = grid[col].indexOf(li);
    if (ctrl && key === 'Home') return grid[0][0];
    if (ctrl && key === 'End') return grid[grid.length - 1][grid[grid.length - 1].length - 1];
    switch (key) {
      case 'ArrowDown': return grid[col][row + 1] || null;
      case 'ArrowUp': return grid[col][row - 1] || null;
      case 'Home': return grid[col][0];
      case 'End': return grid[col][grid[col].length - 1];
      case 'ArrowRight': return col + 1 < grid.length ? grid[col + 1][Math.min(row, grid[col + 1].length - 1)] : null;
      default: return col > 0 ? grid[col - 1][Math.min(row, grid[col - 1].length - 1)] : null;
    }
  }

  // ---- rendering and live updates ------------------------------------------------------------------------------------------------------------
  function render() {
    if (document.visibilityState === 'hidden') { dirty = true; return; }
    dirty = false;
    const a = document.activeElement;
    const was = a && a !== document.body && a.closest ? a.closest('.card') : null;
    const info = was ? { id: was.getAttribute('data-id'), part: a.classList.contains('move-btn') ? 'mv' : a.classList.contains('dismiss') ? 'dismiss' : 'main' } : null;
    applyLayout();
    renderToolbar();
    renderBanners();
    renderMain();
    if (model) { for (const id of [...cardEls.keys()]) if (!model.cards.some((c) => c.id === id)) { cardEls.get(id).remove(); cardEls.delete(id); parts.delete(id); sigs.delete(id); } }
    applyRoving();
    if (info && (document.activeElement === document.body || !document.activeElement.isConnected)) {
      const p = parts.get(info.id);
      const li = cardEls.get(info.id);
      if (p && li && li.isConnected) { const target = info.part === 'mv' && !p.mv.hidden ? p.mv : info.part === 'dismiss' && li.querySelector('.dismiss') ? li.querySelector('.dismiss') : p.main; target.focus(); }
    }
    for (const fn of renderListeners.slice()) fn();
  }
  const stateWord = (c) => c.stateLabel;
  function ownText(prev, c) {
    const l = labelOf(c);
    if (c.column === 'cancelled' && prev.column !== 'cancelled') return 'Cancelled ' + l + '.';
    if ((prev.column === 'done' || prev.column === 'cancelled') && c.column === 'backlog') return 'Reopened ' + l + ' in Backlog.';
    if (!prev.blocked && c.blocked) return 'Blocked ' + l + '.';
    if (prev.blocked && !c.blocked) return 'Unblocked ' + l + '.';
    if (!prev.held && c.held) return 'Put ' + l + ' on hold.';
    if (prev.held && !c.held && c.column !== 'done') return 'Released the hold on ' + l + '.';
    return 'Moved ' + l + ' to ' + stateWord(c) + '.';
  }
  function remoteText(prev, c) {
    const n = c.displayId;
    if (!prev) return n + ' was added';
    if (!prev.blocked && c.blocked) return c.blocked.byName + ' blocked ' + n;
    if (prev.blocked && !c.blocked) return n + ' was unblocked';
    if (!prev.held && c.held) return n + ' was put on hold';
    if (prev.held && !c.held && c.column !== 'done') return 'the hold on ' + n + ' was released';
    if (prev.column !== c.column) return n + ' moved to ' + stateWord(c);
    return '';
  }
  const changeKey = (c) => JSON.stringify([c.column, !!c.blocked, c.held]);
  let queued = [];
  let cooling = false;
  let changeTimer;
  let coolTimer;
  function queueChanges(list) {
    queued = queued.concat(list);
    if (!queued.length || changeTimer || cooling) return;
    changeTimer = setTimeout(flushChanges, 500);
  }
  function flushChanges() {
    changeTimer = undefined;
    if (!queued.length) return;
    const list = queued;
    queued = [];
    const named = list.slice(0, 3);
    const rest = list.length - named.length;
    const body = named.length > 1 && rest === 0 ? named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1] : named.join(', ') + (rest > 0 ? ', and ' + rest + ' more' : '');
    announce(plural(list.length, 'change', 'changes') + ' from your team: ' + body + '.');
    cooling = true;
    coolTimer = setTimeout(() => { cooling = false; if (queued.length) flushChanges(); }, 5000);
  }
  let outlineTimers = [];
  let first = true;
  function onState(m) {
    const next = m.model;
    if (typeof m.error === 'string' && m.error) loadError = m.error;
    else if (next) loadError = '';
    if (next) {
      const prev = model;
      model = next;
      const own = [];
      const remote = [];
      const changed = [];
      const remoteIds = [];
      const before = new Map((prev ? prev.cards : []).map((c) => [c.id, c]));
      for (const c of next.cards) {
        const old = before.get(c.id);
        if (old && JSON.stringify(old) !== JSON.stringify(c)) delete refusals[c.id];
        if (old && changeKey(old) !== changeKey(c)) {
          if (pending[c.id]) { delete pending[c.id]; own.push(ownText(old, c)); changed.push(c.id); } else { remote.push(remoteText(old, c)); remoteIds.push(c.id); }
        } else if (!old && prev) { remote.push(remoteText(undefined, c)); remoteIds.push(c.id); }
      }
      if (first) {
        first = false;
        const all = cardsInMilestone();
        announce('Team Board loaded. ' + plural(all.length, 'card', 'cards') + ', ' + all.filter((c) => c.column === 'ready').length + ' ready.');
      } else if (own.length) announce(own[own.length - 1]);
      if (remote.length) queueChanges(remote);
      render();
      for (const id of remoteIds) outline(id);
      if (own.length) {
        const id = changed[changed.length - 1];
        const a = document.activeElement;
        const li = cardEls.get(id);
        if (li && (a === document.body || li.contains(a))) focusEl(li);
      }
    } else render();
    clearTimeout(slowTimer);
    slow = false;
  }
  function outline(id) {
    const li = cardEls.get(id);
    if (!li || pending[id]) return;
    li.className = li.className.replace(/\s*\bchanged\b/, '') + ' changed';
    outlineTimers.push(setTimeout(() => { li.className = li.className.replace(/\s*\bchanged\b/, ''); }, 3000));
  }

  // ---- the client API for the feature scripts ----------------------------------------------------------------------------------------------
  const cardData = (id) => (model ? model.cards.find((c) => c.id === id) : undefined);
  function refreshCard(id) {
    const c = cardData(id);
    if (c && cardEls.has(id)) { updateCard(c, cardEls.get(id)); applyRoving(); }
  }
  const api = {
    post, announce, icon, layout: () => layout, model: () => model, cardData, cardElement: (id) => cardEls.get(id),
    focusCard: (id) => { const li = cardEls.get(id); return !!li && li.isConnected && focusEl(li); },
    setPending(id, text) { delete refusals[id]; pending[id] = text; refreshCard(id); },
    showRefusal(id, columnLabel, reason) {
      delete pending[id];
      refusals[id] = reason;
      const c = cardData(id);
      refreshCard(id);
      announce("Can't move " + (c ? labelOf(c) : id) + (columnLabel ? ' to ' + columnLabel : '') + '. ' + reason);
    },
    clearRefusal(id) { delete refusals[id]; refreshCard(id); },
    setFilter(name, value) {
      if (name === 'requirement' || name === 'phase') ui.filters[name] = String(value || '');
      else if (name === 'mine' || name === 'ready' || name === 'blocked') ui.filters[name] = !!value;
      else return;
      persist(); render(); scheduleFilterAnnounce();
    },
    onRender(fn) { renderListeners.push(fn); },
    onMessage(type, fn) { (messageListeners[type] = messageListeners[type] || []).push(fn); },
    registerMenu(open) { menuOpener = open; },
    openMenu(id, opener) { if (menuOpener) menuOpener(id, opener); },
    registerDetail(open) { detailOpener = open; },
    openDetail(id, opener) { if (detailOpener) detailOpener(id, opener); },
    registerForm(open) { formOpener = open; },
    openForm(itemId) { if (formOpener) formOpener(itemId); },
    drawer: () => detailEl,
    getDraft: () => (formDraft ? JSON.parse(JSON.stringify(formDraft)) : undefined),
    setDraft(draft) { formDraft = draft && typeof draft === 'object' ? JSON.parse(JSON.stringify(draft)) : undefined; persist(); }
  };
  window.NearAiBoard = api;

  // ---- messages from the host ----------------------------------------------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'state': onState(m); break;
      case 'host-request': if (m.payload && typeof m.payload === 'object') post(m.payload); break;
      case 'notice': if (typeof m.text === 'string' && m.text) { notice = m.text; render(); announce(m.text); } break;
      case 'refused': if (m.reason === '' && typeof m.itemId === 'string') { delete pending[m.itemId]; refreshCard(m.itemId); } break;
      default: break;
    }
    for (const fn of (messageListeners[m.type] || []).slice()) fn(m);
  });
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState !== 'hidden';
    post({ type: 'visible', value: visible });
    if (visible && dirty) render();
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver((entries) => { const e = entries[entries.length - 1]; if (e && e.contentRect) setLayout(e.contentRect.width); }).observe(root);

  render();
  startSlowTimer();
  post({ type: 'ready' });
})();

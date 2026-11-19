// The Staff Room (UX concept 5 and 8 to 10; owner direction 2026-11-18; WP-ROOM): one room for a staff run. The war room for the full staff, and a
// workspace per section (J2 here; J5, J3 and J4 arrive in drop 2), all sharing one map, the product ledger, the gold human-decisions panel and one clock.
//
// The host sends the whole picture (src/domain/staff/staffRoom.ts) and the hand-offs the newest events stand for. This page only lays it out and
// animates: violet is agent work, gold is a person's decision and nothing else, green is a delivered product. Movement means something (a hand-off, a
// symbol placed, an axis committed, an agent working); none of it happens under the system's reduced-motion setting or the page's Calm toggle, and every
// change is also in words. A decision button sends the product and the version hash the person saw; the host runs the person-only staff command, which
// asks who they are, confirms in a modal dialog and signs. The page never shows a decision until the ledger records it. Every text goes in with textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = Object.assign({ calm: false, theme: 'auto', workspace: 'war-room', follow: true, j2tab: 'threat', keys: true }, (vscode.getState && vscode.getState()) || {});
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const EASE = { std: 'cubic-bezier(.2,0,0,1)', travel: 'cubic-bezier(.45,0,.2,1)', exit: 'cubic-bezier(.3,0,1,1)', settle: 'cubic-bezier(.34,1.4,.64,1)' };
  const MAX_TRACERS = 6, MAX_QUEUE = 12;
  const WORKSPACES = ['war-room', 'j2', 'j5', 'j3', 'j4'];
  const BUILT = ['war-room', 'j2'];
  const J2_TABS = [['threat', 'Threat'], ['pirs', 'PIRs'], ['collection', 'Collection'], ['sources', 'Sources'], ['watches', 'Watches']];
  const GLYPH = {
    'war-room': 'M8 2v3M8 11v3M2 8h3M11 8h3M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z',
    command: 'M8 2v3M8 11v3M2 8h3M11 8h3M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z',
    j2: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4a2 2 0 0 0 0-4z',
    j5: 'M8 1.5l1.8 4.7L14.5 8l-4.7 1.8L8 14.5l-1.8-4.7L1.5 8l4.7-1.8z',
    j3: 'M2.5 12l5.5-4.5 5.5 4.5M2.5 8l5.5-4.5 5.5 4.5',
    j4: 'M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6',
    other: 'M3 3h10v10H3z'
  };
  const TOKEN_BADGE = { done: 'M5 8.5l2 2 4-4.5', needs: 'M8 4.5v4M8 11v.5', waiting: 'M6.5 5v6M9.5 5v6', failed: 'M5.5 5.5l5 5M10.5 5.5l-5 5', stopped: 'M5.5 5.5h5v5h-5z' };

  let model;
  let lastMapJson = '';
  let first = true;
  let map;
  const nodes = {};
  const pods = new Map();
  const tokens = new Map();
  const ledgerRows = new Map();
  let seenLedger = new Map();
  let seenDecisions = new Set();
  let liveTracers = 0;
  const tracerQueue = [];
  const typing = new Map();
  let popAnchor = null;
  let clockTimer;
  let clockBase = { at: 0, received: 0 };
  let announceQueue = [];
  let announceTimer;
  let noticeTimer;

  const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  /** Whether anything may move: not under reduced motion, not in Calm, not while the panel is hidden. */
  const motion = () => !saved.calm && !(reducedQuery && reducedQuery.matches) && !document.hidden;
  function anim(node, frames, options) {
    if (!motion() || !node || typeof node.animate !== 'function') return null;
    return node.animate(frames, Object.assign({ easing: EASE.std }, options));
  }
  function save() { if (vscode.setState) vscode.setState(saved); }

  // ---------- builders ----------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function sv(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    if (attrs) for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.append(node);
    return node;
  }
  function glyph(d, cls) {
    const svg = sv('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', class: 'glyph ' + (cls || '') });
    sv('path', { d }, svg);
    return svg;
  }
  function button(text, cls, onClick, attrs) {
    const node = el('button', 'btn ' + (cls || ''), text);
    node.type = 'button';
    if (attrs) for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  const two = (n) => String(n).padStart(2, '0');
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function dtg(ms) { const d = new Date(ms); return two(d.getUTCDate()) + two(d.getUTCHours()) + two(d.getUTCMinutes()) + 'Z ' + MONTHS[d.getUTCMonth()] + ' ' + two(d.getUTCFullYear() % 100); }
  function shortTime(iso) { const ms = Date.parse(iso); if (!Number.isFinite(ms)) return ''; const d = new Date(ms); return two(d.getUTCHours()) + two(d.getUTCMinutes()) + 'Z'; }
  function inWords(ms) {
    const minutes = Math.round(Math.abs(ms) / 60000);
    const text = minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + two(minutes % 60) + ' min';
    return ms >= 0 ? 'in ' + text : text + ' ago';
  }
  const titleCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  // ---------- announcements ----------
  function announce(text, urgent) {
    if (urgent) { const node = $('alert'); if (node) { node.textContent = ''; node.textContent = text; } return; }
    announceQueue.push(text);
    if (announceTimer) return;
    announceTimer = setTimeout(() => { announceTimer = undefined; const node = $('announce'); if (node) node.textContent = announceQueue.splice(0, 4).join(' '); announceQueue = []; }, 900);
  }

  // ---------- the skeleton, built once ----------
  function skeleton() {
    const app = $('app');
    app.replaceChildren();
    const banner = () => { const b = el('div', 'cls', 'UNCLASSIFIED // EXERCISE // FICTIONAL DATA'); b.setAttribute('role', 'note'); return b; };
    nodes.bannerTop = banner();
    const header = el('header', 'top');
    const brand = el('div', 'brand');
    const mark = sv('svg', { viewBox: '0 0 24 24', class: 'brand-mark', 'aria-hidden': 'true', focusable: 'false' });
    sv('path', { d: 'M12 2l9 5v10l-9 5-9-5V7z', class: 'mark-hex' }, mark);
    sv('path', { d: 'M8 15V9l8 6V9', class: 'mark-n' }, mark);
    const brandText = el('span', 'brand-t');
    brandText.append(document.createTextNode('NEAR AI '), el('b', '', 'Staff Room'));
    brand.append(mark, brandText);
    const op = el('div', 'op');
    nodes.opName = el('span', 'op-name', 'Staff Room');
    nodes.opName.setAttribute('data-must-read', '');
    nodes.opSub = el('span', 'op-sub', '');
    op.append(nodes.opName, nodes.opSub);
    const clock = el('div', 'clock');
    clock.setAttribute('role', 'timer');
    clock.setAttribute('aria-label', 'Exercise clock');
    nodes.clockNow = el('span', 'now mono', '');
    nodes.clockNext = el('span', 'due', '');
    clock.append(nodes.clockNow, nodes.clockNext);
    nodes.runPick = el('label', 'runpick');
    nodes.runPick.hidden = true;
    nodes.runSelect = el('select');
    nodes.runSelect.addEventListener('change', () => vscode.postMessage({ type: 'select-run', run: nodes.runSelect.value }));
    nodes.runPick.append(el('span', 'faint', 'Run'), nodes.runSelect);
    const actions = el('div', 'hdr-actions');
    actions.append(button('Team Live', 'ghost', () => vscode.postMessage({ type: 'open', target: 'team-live' }), { title: 'Open Team Live for this run' }));
    header.append(brand, op, clock, el('div', 'spacer'), nodes.runPick, actions);

    const railWrap = el('nav', 'railwrap');
    railWrap.setAttribute('aria-label', 'Planning process');
    nodes.rail = el('ol', 'rail');
    nodes.railSide = el('div', 'railside');
    nodes.profile = el('span', 'profile', '');
    nodes.profile.setAttribute('data-must-read', '');
    nodes.railSide.append(nodes.profile);
    railWrap.append(nodes.rail, nodes.railSide);

    nodes.squads = el('section', 'squads');
    nodes.squads.setAttribute('aria-label', 'Staff sections and their agents');

    const switcher = el('div', 'switcher');
    nodes.tabs = el('div', 'tabs');
    nodes.tabs.setAttribute('role', 'tablist');
    nodes.tabs.setAttribute('aria-label', 'Workspaces');
    nodes.tabButtons = new Map();
    for (const id of WORKSPACES) {
      const tab = el('button', 'tab ws-' + id);
      tab.type = 'button';
      tab.id = 'tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'pane-' + id);
      tab.dataset.ws = id;
      tab.append(glyph(GLYPH[id] || GLYPH.other), el('span', 'tab-l', ''), el('span', 'tab-tag', ''), el('span', 'tdot'));
      tab.children[3].setAttribute('aria-hidden', 'true');
      tab.addEventListener('click', () => switchTo(id, true));
      tab.addEventListener('keydown', onTabKey);
      nodes.tabButtons.set(id, tab);
      nodes.tabs.append(tab);
    }
    nodes.tabInk = el('span', 'tab-ink');
    nodes.tabInk.setAttribute('aria-hidden', 'true');
    nodes.tabs.append(nodes.tabInk);
    nodes.follow = button('Follow the action', 'follow', () => setFollow(!saved.follow), { 'aria-pressed': 'true', 'aria-keyshortcuts': 'F', title: 'The view goes where the work is. Choosing a workspace turns it off.' });
    switcher.append(nodes.tabs, nodes.follow);

    const work = el('div', 'work');
    const stage = el('main', 'stage');
    stage.setAttribute('aria-label', 'Workspace');
    nodes.panes = new Map();
    for (const id of WORKSPACES) {
      const pane = el('section', 'pane pane-' + id);
      pane.id = 'pane-' + id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', 'tab-' + id);
      nodes.panes.set(id, pane);
      stage.append(pane);
    }
    buildWarRoom(nodes.panes.get('war-room'));
    buildJ2(nodes.panes.get('j2'));
    for (const id of ['j5', 'j3', 'j4']) nodes.panes.get(id).append(el('div', 'coming'));
    const feed = el('aside', 'feed');
    feed.setAttribute('aria-label', 'Decisions and products');
    const decide = el('section', 'decide');
    decide.setAttribute('aria-labelledby', 'dec-title');
    const decideHead = el('div', 'decide-h');
    const decideTitle = el('h2', '', 'Human decisions');
    decideTitle.id = 'dec-title';
    nodes.decCount = el('span', 'n', '0');
    decideHead.append(glyph('M8 2a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5zM3 14c0-3 2.2-5 5-5s5 2 5 5'), decideTitle, nodes.decCount);
    nodes.decideHead = decideHead;
    nodes.decList = el('ul', 'decide-list');
    nodes.decList.setAttribute('aria-label', 'Waiting for a named person');
    decide.append(decideHead, nodes.decList, el('p', 'fine', 'Only a named person decides. Each button opens a signed confirmation in VS Code; agents cannot reach it.'));
    const ledger = el('section', 'ledger');
    ledger.setAttribute('aria-labelledby', 'led-title');
    const ledgerHead = el('div', 'ledger-h');
    const ledgerTitle = el('h2', '', 'Product ledger');
    ledgerTitle.id = 'led-title';
    nodes.ledCount = el('span', 'c', '');
    ledgerHead.append(ledgerTitle, nodes.ledCount);
    nodes.ledgerHead = ledgerHead;
    nodes.ledger = el('ol', 'ledger-list');
    ledger.append(ledgerHead, nodes.ledger);
    feed.append(decide, ledger);
    work.append(stage, feed);

    const status = el('footer', 'status');
    const label = el('span', 'stat');
    label.append(el('span', 'chip cls', 'UNCLASSIFIED'), document.createTextNode(' Exercise data only · clearance self-declared'));
    nodes.statusProfile = el('span', 'stat faint', '');
    const controls = el('div', 'ctl');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'View');
    nodes.calm = button('Calm', '', () => setCalm(!saved.calm), { 'aria-pressed': 'false', 'aria-keyshortcuts': 'C', title: 'Calm: nothing moves; every change still shows in words (C)' });
    nodes.theme = button('Theme: auto', '', cycleTheme, { 'aria-keyshortcuts': 'T', title: 'Theme: auto (follows VS Code), Night, Day, High contrast (T)' });
    nodes.help = button('Keys ?', '', openHelp, { 'aria-keyshortcuts': 'Shift+?', 'aria-haspopup': 'dialog' });
    controls.append(nodes.calm, nodes.theme, nodes.help);
    status.append(label, el('span', 'stat', 'Gates enforced by the extension'), el('span', 'stat', 'Every version recorded'), nodes.statusProfile, controls);

    nodes.bannerBottom = banner();
    nodes.empty = el('div', 'roomempty');
    nodes.empty.hidden = true;
    app.append(nodes.bannerTop, header, railWrap, nodes.squads, switcher, nodes.empty, work, status, nodes.bannerBottom);

    nodes.fx = sv('svg', { class: 'fx', 'aria-hidden': 'true', focusable: 'false' });
    app.append(nodes.fx);
    nodes.pop = el('div', 'pop');
    nodes.pop.hidden = true;
    nodes.pop.setAttribute('role', 'dialog');
    nodes.pop.setAttribute('aria-modal', 'false');
    app.append(nodes.pop);
    nodes.helpDialog = el('div', 'dialog');
    nodes.helpDialog.hidden = true;
    nodes.helpDialog.setAttribute('role', 'dialog');
    nodes.helpDialog.setAttribute('aria-modal', 'true');
    nodes.helpDialog.setAttribute('aria-label', 'Keyboard');
    app.append(nodes.helpDialog);
    nodes.notice = el('div', 'toast');
    nodes.notice.hidden = true;
    nodes.notice.setAttribute('role', 'status');
    app.append(nodes.notice);

    map = window.NearAiStaffMap.create(nodes.warMapSlot, {
      motion,
      onSelect: (unit, anchor) => openUnitCard(unit, anchor),
      onEmptyAction: () => vscode.postMessage({ type: 'open', target: 'load-scenario' }),
      hiddenLayers: saved.hiddenLayers || [],
      onLayers: (hidden) => { saved.hiddenLayers = hidden; save(); },
      onTable: (on) => { saved.table = on; save(); },
      cop: { resources: copResources() }
    });
    if (saved.table) map.showTable(true);
  }

  function buildWarRoom(pane) {
    const grid = el('div', 'wr');
    nodes.warMapSlot = el('div', 'mapslot');
    const side = el('section', 'wr-side');
    side.setAttribute('aria-labelledby', 'act-title');
    const head = el('h3', 'kicker', 'What the staff is doing');
    head.id = 'act-title';
    nodes.activity = el('ol', 'activity');
    nodes.activity.setAttribute('aria-label', 'Staff activity, newest first');
    side.append(head, nodes.activity);
    grid.append(nodes.warMapSlot, side);
    pane.append(grid);
  }

  function buildJ2(pane) {
    const grid = el('div', 'j2grid');
    nodes.j2MapSlot = el('div', 'mapslot');
    const side = el('section', 'j2side');
    side.setAttribute('aria-label', 'J2 threat picture');
    nodes.j2Problems = el('div', 'problems');
    nodes.j2Tabs = el('div', 'subtabs');
    nodes.j2Tabs.setAttribute('role', 'tablist');
    nodes.j2Tabs.setAttribute('aria-label', 'J2 registers and products');
    nodes.j2TabButtons = new Map();
    nodes.j2Panels = new Map();
    const panels = el('div', 'subpanels');
    for (const [id, label] of J2_TABS) {
      const tab = el('button', 'subtab');
      tab.type = 'button';
      tab.id = 'j2tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'j2panel-' + id);
      tab.append(el('span', '', label), el('span', 'count mono', ''));
      tab.addEventListener('click', () => showJ2Tab(id, true));
      tab.addEventListener('keydown', (event) => roving(event, [...nodes.j2TabButtons.values()], (next) => showJ2Tab(next.id.slice(6), true)));
      nodes.j2TabButtons.set(id, tab);
      nodes.j2Tabs.append(tab);
      const panel = el('div', 'subpanel');
      panel.id = 'j2panel-' + id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'j2tab-' + id);
      nodes.j2Panels.set(id, panel);
      panels.append(panel);
    }
    side.append(nodes.j2Problems, nodes.j2Tabs, panels);
    grid.append(nodes.j2MapSlot, side);
    pane.append(grid);
  }

  // ---------- workspaces ----------
  function switchTo(id, byUser) {
    if (!WORKSPACES.includes(id)) return;
    if (byUser && saved.follow) setFollow(false);
    const changed = saved.workspace !== id;
    saved.workspace = id;
    save();
    for (const [key, tab] of nodes.tabButtons) {
      const on = key === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on) tab.classList.remove('live');
    }
    for (const [key, pane] of nodes.panes) pane.hidden = key !== id;
    // The one map moves to the workspace on screen.
    const slot = id === 'j2' ? nodes.j2MapSlot : nodes.warMapSlot;
    if (map && map.element.parentNode !== slot) slot.append(map.element);
    if (map && model && changed) { lastMapJson = ''; drawMap(false); }
    moveInk();
    const pane = nodes.panes.get(id);
    if (changed && pane) anim(pane, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220 });
    if (byUser) announce((labelOf(id)) + ' workspace.');
  }
  function moveInk() {
    const tab = nodes.tabButtons.get(saved.workspace);
    if (!tab || !nodes.tabInk) return;
    const left = tab.offsetLeft || 0, width = tab.offsetWidth || 0;
    const to = 'translateX(' + left + 'px) scaleX(' + Math.max(0.01, width / 100) + ')';
    const from = nodes.tabInk.style.transform || to;
    nodes.tabInk.style.transform = to;
    anim(nodes.tabInk, [{ transform: from }, { transform: to }], { duration: 260 });
  }
  function labelOf(id) {
    if (id === 'war-room') return 'War room';
    const squad = model && model.squads.find((entry) => entry.section === id);
    return squad ? squad.name : id.toUpperCase();
  }
  function setFollow(on) {
    saved.follow = Boolean(on);
    save();
    nodes.follow.setAttribute('aria-pressed', saved.follow ? 'true' : 'false');
    if (saved.follow) for (const tab of nodes.tabButtons.values()) tab.classList.remove('live');
  }
  function onTabKey(event) { roving(event, [...nodes.tabButtons.values()], (next) => switchTo(next.dataset.ws, true)); }
  /** Arrow keys move along a row of controls (a roving tab stop); Home and End go to the ends. */
  function roving(event, list, choose) {
    const index = list.indexOf(event.currentTarget || event.target);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = list[(index + 1) % list.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    if (!next) return;
    event.preventDefault();
    for (const item of list) item.tabIndex = item === next ? 0 : -1;
    next.focus();
    if (choose) choose(next);
  }

  // ---------- themes and calm ----------
  function autoTheme() {
    const body = document.body && document.body.classList;
    if (body && (body.contains('vscode-high-contrast') || body.contains('vscode-high-contrast-light'))) return 'hc';
    if (body && body.contains('vscode-light')) return 'day';
    return 'night';
  }
  function applyTheme() {
    const theme = saved.theme === 'auto' ? autoTheme() : saved.theme;
    const app = $('app');
    for (const name of ['night', 'day', 'hc']) app.classList.toggle(name, name === theme);
    app.classList.toggle('calm', Boolean(saved.calm));
    setText(nodes.theme, 'Theme: ' + ({ auto: 'auto', night: 'Night', day: 'Day', hc: 'High contrast' }[saved.theme]));
    nodes.calm.setAttribute('aria-pressed', saved.calm ? 'true' : 'false');
    if (map && map.setTheme) map.setTheme();
  }
  function cycleTheme() {
    const order = ['auto', 'night', 'day', 'hc'];
    saved.theme = order[(order.indexOf(saved.theme) + 1) % order.length];
    save();
    applyTheme();
    announce('Theme: ' + nodes.theme.textContent.slice(7) + '.');
  }
  function setCalm(on) {
    saved.calm = Boolean(on);
    save();
    applyTheme();
    if (saved.calm) for (const animation of (document.getAnimations ? document.getAnimations() : [])) animation.finish && animation.finish();
    announce(saved.calm ? 'Calm on: nothing moves.' : 'Calm off.');
  }

  /** The webview addresses of the COP map's vendored files, which the host writes into the page (src/staff/copMapWebview.ts copMapResources). */
  function copResources() {
    try {
      const raw = $('app') && $('app').dataset ? $('app').dataset.copResources : undefined;
      const parsed = raw ? JSON.parse(raw) : undefined;
      if (!parsed || typeof parsed !== 'object') return undefined;
      const out = {};
      for (const key of ['maplibre', 'worker', 'milsymbol']) if (typeof parsed[key] === 'string') out[key] = parsed[key];
      return out;
    } catch (error) { return undefined; }
  }

  // ---------- validation of what the host sends ----------
  const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArr = Array.isArray;
  /** The host's picture, checked for shape before anything is drawn: a message that does not fit is ignored. */
  function validModel(m) {
    return isObj(m) && m.v === 1 && typeof m.now === 'number' && isObj(m.operation) && isObj(m.profile) && isObj(m.clock) && typeof m.clock.at === 'string'
      && isArr(m.rail) && isArr(m.squads) && isArr(m.ledger) && isArr(m.decisions) && isObj(m.map) && isArr(m.map.units) && isArr(m.map.layers)
      && isObj(m.j2) && isArr(m.j2.pirs) && isArr(m.j2.collection) && isArr(m.j2.sources) && isArr(m.j2.watches) && isArr(m.j2.ecoas) && isArr(m.activity) && isArr(m.runs) && isObj(m.coming)
      && m.decisions.every((d) => isObj(d) && typeof d.product === 'string' && typeof d.hash === 'string' && (d.kind === 'decide' || d.kind === 'release'))
      && m.ledger.every((row) => isObj(row) && typeof row.product === 'string' && isArr(row.history));
  }
  /** The COP picture's shape (src/domain/staff/cop/picture.ts, version 1); the map component checks it again before drawing. */
  const validPicture = (p) => isObj(p) && p.version === 1 && typeof p.marking === 'string' && isArr(p.layers) && isArr(p.features) && isArr(p.ecoas) && isObj(p.budget)
    && (p.frame === undefined || (isObj(p.frame) && isArr(p.frame.bounds) && p.frame.bounds.length === 4 && p.frame.bounds.every((n) => typeof n === 'number')));
  const validCue = (cue) => isObj(cue) && ['task', 'prod', 'human'].includes(cue.kind) && typeof cue.from === 'string' && typeof cue.to === 'string' && typeof cue.label === 'string' && WORKSPACES.includes(cue.workspace);

  // ---------- drawing the picture ----------
  function render(next, cues) {
    const previous = model;
    model = next;
    nodes.empty.hidden = true;
    setText(nodes.opName, model.operation.title + (model.operation.hq ? ' · ' + model.operation.hq : ''));
    setText(nodes.opSub, model.operation.region + (model.operation.scenario ? ' (fictional)' : ''));
    setText(nodes.bannerTop, model.operation.marking);
    setText(nodes.bannerBottom, model.operation.marking);
    setText(nodes.profile, model.profile.name + ' · ' + model.profile.process + ' · ' + model.profile.level);
    setText(nodes.statusProfile, 'Doctrine: ' + model.profile.name + ', ' + model.profile.level + ' level');
    clockBase = { at: Date.parse(model.clock.at), received: Date.now() };
    tick();
    renderRuns();
    renderRail();
    renderSquads();
    renderTabs();
    renderDecisions(previous);
    renderLedger(previous);
    renderActivity(previous);
    renderJ2();
    renderComing();
    drawMap(first);
    if (first) wakeUp();
    first = false;
    for (const cue of (cues || []).filter(validCue).slice(0, MAX_TRACERS)) handoff(cue);
  }

  function tick() {
    if (!model) return;
    const now = clockBase.at + (Date.now() - clockBase.received);
    setText(nodes.clockNow, dtg(now));
    const next = model.clock.next;
    setText(nodes.clockNext, next ? next.label + ' · ' + next.dtg + ' · ' + inWords(Date.parse(next.at) - now) : 'No decision deadline set');
  }

  function renderRuns() {
    nodes.runPick.hidden = model.runs.length < 2;
    nodes.runSelect.replaceChildren();
    for (const run of model.runs) {
      const option = el('option', '', run.id + ' · last ' + shortTime(run.lastAt));
      option.value = run.id;
      if (run.id === model.run) option.selected = true;
      nodes.runSelect.append(option);
    }
  }

  function renderRail() {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.step : undefined;
    nodes.rail.replaceChildren();
    const items = [];
    for (const step of model.rail) {
      const li = el('li', 'step s-' + step.status + (step.human ? ' human' : ''));
      li.dataset.step = String(step.step);
      li.tabIndex = -1;
      li.setAttribute('aria-label', 'Step ' + step.step + ', ' + step.name + ': ' + step.statusText + (step.sections.length ? '. Sections: ' + step.sections.map((s) => s.code + (s.working ? ' working' : '')).join(', ') : '') + (step.human ? '. A person decides this step.' : ''));
      const top = el('div', 'st-top');
      top.append(el('span', 'sn mono', 'STEP ' + step.step));
      if (step.human) { const dia = el('span', 'dia', '◆'); dia.title = 'A named person decides'; dia.setAttribute('aria-hidden', 'true'); top.append(dia); }
      const secs = el('span', 'secs');
      for (const s of step.sections) secs.append(el('span', 'sec' + (s.working ? ' on' : ''), s.code));
      top.append(secs);
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, step.progress)) + ')';
      bar.append(fill);
      li.append(top, el('span', 'sl', step.name), el('span', 'ss', step.statusText), bar);
      li.addEventListener('keydown', (event) => roving(event, items));
      items.push(li);
      nodes.rail.append(li);
    }
    const current = items.find((li) => li.dataset.step === focused) || items.find((li) => /s-(now|waiting)/.test(li.className)) || items[0];
    if (current) current.tabIndex = 0;
    if (focused && current && current.dataset.step === focused) current.focus();
  }

  function renderSquads() {
    const focusedToken = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.token : undefined;
    nodes.squads.replaceChildren();
    pods.clear();
    tokens.clear();
    const allTokens = [];
    for (const squad of model.squads) {
      const pod = el('article', 'pod' + (squad.active ? ' active' : ''));
      pod.dataset.section = squad.section;
      pod.setAttribute('aria-label', squad.name + ', ' + squad.tag + '. ' + squad.summary);
      const tag = el('span', 'nest t-' + squad.tag, 'team · ' + squad.tag);
      const head = el('div', 'pod-h');
      head.append(glyph(GLYPH[squad.section] || GLYPH.other), el('b', '', squad.name));
      const person = el('span', 'person', squad.person || squad.lead);
      person.title = squad.person ? 'The named person who decided for this section' : 'A named person leads and decides';
      head.append(person);
      const toks = el('div', 'toks');
      toks.setAttribute('role', 'group');
      toks.setAttribute('aria-label', squad.name + ' agents');
      if (!squad.members.length) toks.append(el('span', 'faint idle', 'No agents tasked yet'));
      for (const member of squad.members) {
        const token = memberToken(squad, member);
        token.addEventListener('keydown', (event) => roving(event, allTokens));
        allTokens.push(token);
        toks.append(token);
        tokens.set(squad.section + ':' + member.id, token);
      }
      const callout = el('div', 'callout' + (squad.members.some((m) => m.state === 'needs') ? ' h' : ''));
      pod.append(tag, head, toks, callout);
      typeInto(callout, squad.section, squad.summary);
      pods.set(squad.section, pod);
      nodes.squads.append(pod);
    }
    const current = allTokens.find((token) => token.dataset.token === focusedToken) || allTokens[0];
    if (current) { current.tabIndex = 0; if (focusedToken && current.dataset.token === focusedToken) current.focus(); }
  }

  function memberToken(squad, member) {
    const token = el('button', 'tok s-' + member.state);
    token.type = 'button';
    token.tabIndex = -1;
    token.dataset.token = squad.section + ':' + member.id;
    token.setAttribute('aria-label', member.id + ', ' + member.stateText + ': ' + member.task);
    const svg = sv('svg', { viewBox: '0 0 36 36', 'aria-hidden': 'true', focusable: 'false' });
    sv('circle', { class: 'disc', cx: 18, cy: 18, r: 14 }, svg);
    sv('path', { class: 'ring', d: 'M18 2.5a15.5 15.5 0 0 1 15.5 15.5' }, svg);
    const abbr = sv('text', { class: 'abbr', x: 18, y: 18.5 }, svg);
    abbr.textContent = member.abbr;
    if (TOKEN_BADGE[member.state]) {
      const badge = sv('g', { class: 'badge b-' + member.state, transform: 'translate(22 0)' }, svg);
      sv('circle', { cx: 8, cy: 8, r: 7 }, badge);
      sv('path', { d: TOKEN_BADGE[member.state] }, badge);
    }
    token.append(svg, el('span', 'tl', member.id));
    token.addEventListener('click', () => openAgentCard(squad, member, token));
    return token;
  }

  /** The status line types in at about 100 characters a second; under reduced motion or Calm it appears whole. */
  function typeInto(node, key, text) {
    const running = typing.get(key);
    if (running) clearInterval(running);
    typing.delete(key);
    if (!motion() || !text) { node.textContent = text; return; }
    let shown = 0;
    node.textContent = '';
    const timer = setInterval(() => {
      // A re-render can replace the node; stop rather than keep writing into a detached one.
      if (!node.isConnected) { clearInterval(timer); if (typing.get(key) === timer) typing.delete(key); return; }
      shown = Math.min(text.length, shown + 3);
      node.textContent = text.slice(0, shown);
      if (shown >= text.length) { clearInterval(timer); typing.delete(key); }
    }, 30);
    typing.set(key, timer);
  }

  function renderTabs() {
    for (const [id, tab] of nodes.tabButtons) {
      setText(tab.children[1], labelOf(id));
      const tag = tab.children[2];
      if (BUILT.includes(id)) {
        if (id === 'j2') setText(tag, model.j2.pirs.length + ' PIR' + (model.j2.pirs.length === 1 ? '' : 's'));
        else setText(tag, model.decisions.length ? model.decisions.length + ' for a person' : 'all sections');
        tab.classList.toggle('needs', id === 'war-room' && model.decisions.length > 0);
      } else setText(tag, 'drop 2');
      tab.classList.toggle('coming', !BUILT.includes(id));
    }
  }

  function renderDecisions(previous) {
    nodes.decList.replaceChildren();
    setText(nodes.decCount, String(model.decisions.length));
    nodes.decCount.setAttribute('aria-label', model.decisions.length + ' waiting for a person');
    if (!model.decisions.length) nodes.decList.append(el('li', 'empty', 'Nothing waiting for a person right now.'));
    const now = new Set();
    for (const card of model.decisions) {
      const key = card.kind + ':' + card.product + ':' + card.hash;
      now.add(key);
      const li = el('li', 'dec' + (card.overdue ? ' overdue' : ''));
      li.dataset.product = card.product;
      const title = el('div', 'dt');
      title.append(el('span', 'sec-chip', card.code), document.createTextNode(' ' + card.title + ' v' + card.version));
      li.append(title);
      const who = el('div', 'dm', card.kind === 'decide' ? 'For the ' + card.decisionFor + '. Agents stopped here.' : 'Approved; waiting for a person to release it.');
      li.append(who);
      if (card.gates) li.append(el('div', 'dm faint', card.gates));
      if (card.deadline) li.append(el('div', 'dm' + (card.overdue ? ' late' : ''), (card.overdue ? 'Past its deadline: ' : 'Deadline: ') + dtg(Date.parse(card.deadline)) + '. It never decides by itself.'));
      if (card.options.length) {
        const list = el('ul', 'opts');
        for (const option of card.options) { const item = el('li'); item.append(el('b', '', option.label), document.createTextNode(' · Risk: ' + option.risk)); list.append(item); }
        li.append(list);
      }
      if (card.dissent.length) {
        const box = el('div', 'dissent');
        box.append(el('span', 'kicker', 'Dissent, unedited'));
        for (const line of card.dissent) box.append(el('p', '', line));
        li.append(box);
      }
      const row = el('div', 'acts');
      const decideButton = (action, label, cls) => {
        const b = button(label, cls, () => {
          vscode.postMessage({ type: 'decide', action, product: card.product, hash: card.hash });
          b.setAttribute('aria-busy', 'true');
          b.disabled = true;
          setText(b, 'Confirm in VS Code…');
          announce(label.replace('…', '') + ' ' + card.title + ': confirm who you are and sign in the VS Code dialog.');
        }, { 'data-action': action, title: 'Opens the signed person-only command in VS Code. Nothing is decided until you confirm there.' });
        return b;
      };
      if (card.kind === 'decide') row.append(decideButton('approve', 'Approve…', 'primary'), decideButton('reject', 'Reject…', ''));
      else row.append(decideButton('release', 'Release…', 'primary'));
      row.append(button('Provenance', 'ghost', (event) => openProductCard(card.product, event.currentTarget || event.target)));
      li.append(row);
      nodes.decList.append(li);
      if (!seenDecisions.has(key) && !first) {
        anim(li, [{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 450, easing: EASE.settle });
        if (motion()) { li.classList.add('arrive-gold'); setTimeout(() => li.classList.remove('arrive-gold'), 1600); }
        announce(card.title + ' v' + card.version + ' needs a person: the ' + card.decisionFor + '.', true);
      }
    }
    seenDecisions = now;
    void previous;
  }

  function renderLedger() {
    nodes.ledger.replaceChildren();
    ledgerRows.clear();
    setText(nodes.ledCount, model.ledger.length + (model.ledger.length === 1 ? ' product' : ' products'));
    if (model.ledgerProblem) nodes.ledger.append(el('li', 'problem', 'The product ledger cannot be trusted after one point: ' + model.ledgerProblem));
    if (!model.ledger.length) nodes.ledger.append(el('li', 'empty', 'No staff products yet. Products appear here as members propose them.'));
    const next = new Map();
    for (const row of model.ledger) {
      const li = el('li');
      const b = el('button', 'prod');
      b.type = 'button';
      b.setAttribute('aria-label', row.title + ' version ' + row.version + ', ' + row.display + ', ' + row.code + ', owner ' + row.owner + '. Opens its provenance.');
      const icon = el('span', 'pi', row.code.replace(/[^A-Z0-9]/gi, '').slice(0, 3));
      const name = el('span', 'pn', row.title + ' v' + row.version);
      const meta = el('span', 'pm');
      meta.append(el('span', 'st-pill ' + row.pill, row.display), el('span', '', row.owner), el('span', 'mono faint', shortTime(row.at)));
      if (row.changedSources.length) meta.append(el('span', 'st-pill changed', 'source changed'));
      b.append(icon, name, meta);
      b.addEventListener('click', () => openProductCard(row.product, b));
      li.append(b);
      nodes.ledger.append(li);
      ledgerRows.set(row.product, b);
      const stamp = row.version + ':' + row.display;
      next.set(row.product, stamp);
      if (!first && seenLedger.get(row.product) !== stamp) {
        b.classList.add('fresh');
        anim(b, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 450, easing: EASE.settle });
        announce(row.title + ' v' + row.version + ' is ' + row.display + '.');
      }
    }
    seenLedger = next;
  }

  function renderActivity(previous) {
    const before = new Set(previous ? previous.activity.map((line) => line.at + line.text) : []);
    nodes.activity.replaceChildren();
    if (model.eventLogProblem) nodes.activity.append(el('li', 'problem', model.eventLogProblem));
    if (!model.activity.length) {
      nodes.activity.append(el('li', 'empty', model.run ? 'Nothing recorded in this run yet.' : 'No staff run yet. Run a staff team with /team:<name> in the NEAR AI chat and the room fills as it works.'));
      return;
    }
    for (const line of model.activity) {
      const li = el('li', 'act k-' + line.kind);
      li.append(el('span', 'at mono', shortTime(line.at)), el('span', 'who', line.section), el('span', 'what', line.text));
      nodes.activity.append(li);
      if (previous && !before.has(line.at + line.text)) anim(li, [{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 300 });
    }
  }

  function drawMap(stagger) {
    if (!map || !model) return;
    const json = JSON.stringify(model.map) + saved.workspace;
    if (json === lastMapJson) return;
    lastMapJson = json;
    map.render(model.map, { mode: saved.workspace === 'j2' ? 'j2' : 'war-room', stagger });
  }

  // ---------- the J2 workspace ----------
  function showJ2Tab(id, byUser) {
    saved.j2tab = id;
    save();
    for (const [key, tab] of nodes.j2TabButtons) { tab.setAttribute('aria-selected', key === id ? 'true' : 'false'); tab.tabIndex = key === id ? 0 : -1; }
    for (const [key, panel] of nodes.j2Panels) panel.hidden = key !== id;
    if (byUser) map.highlight([]);
  }

  function table(head, rows, label) {
    const wrap = el('div', 'table-wrap');
    const t = el('table', 'grid-table stack-narrow');
    if (label) t.setAttribute('aria-label', label);
    const thead = el('thead');
    const hr = el('tr');
    for (const h of head) { const th = el('th', '', h); th.setAttribute('scope', 'col'); hr.append(th); }
    thead.append(hr);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      row.forEach((cell, i) => { const td = el('td'); td.dataset.label = head[i]; if (cell && typeof cell === 'object' && cell.nodeType !== undefined) td.append(cell); else if (cell && typeof cell === 'object' && cell.tagName) td.append(cell); else td.textContent = cell === undefined ? '' : String(cell); tr.append(td); });
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }
  function gradeChip(code, words) { const chip = el('span', 'grade-chip mono', code); chip.title = words; chip.setAttribute('aria-label', 'Grade ' + code + '. ' + words); return chip; }

  function renderJ2() {
    const j2 = model.j2;
    nodes.j2Problems.replaceChildren();
    for (const problem of j2.problems) nodes.j2Problems.append(el('p', 'problem', problem));
    const counts = { threat: j2.ecoas.length + j2.enemy.length, pirs: j2.pirs.length, collection: j2.collection.length, sources: j2.sources.length + j2.reports.length + (j2.live && typeof j2.live.total === 'number' ? j2.live.total : 0), watches: j2.watches.length };
    for (const [id, tab] of nodes.j2TabButtons) setText(tab.children[1], String(counts[id]));

    // Threat: the adversary COAs, in probability order, then the enemy with their grades.
    const threat = nodes.j2Panels.get('threat');
    threat.replaceChildren();
    threat.append(el('h3', 'kicker', 'Adversary courses of action'));
    if (!j2.ecoas.length) threat.append(el('p', 'faint', 'No adversary COA set yet. The threat analyst drafts the MLCOA and MDCOA in the adversary COA set; they draw onto the map as dashed red axes.'));
    for (const coa of j2.ecoas) {
      const card = el('article', 'ecoa');
      card.tabIndex = 0;
      card.setAttribute('aria-label', coa.term + ', ' + coa.title + '. ' + coa.statement);
      const head = el('div', 't');
      head.append(el('span', 'k mono', coa.term), el('span', '', coa.title));
      if (coa.state) head.append(el('span', 'st-pill ' + (coa.state === 'released' || coa.state === 'approved' ? 'released' : coa.state === 'guard-checked' ? 'checked' : 'draft'), coa.state));
      card.append(head, el('p', '', coa.statement));
      if (coa.likelihood) card.append(el('p', 'likely', titleCase(coa.likelihood.term) + ' (' + coa.likelihood.range + ').'));
      if (coa.confidence) card.append(el('p', 'conf', coa.confidence));
      if (!coa.points.length) card.append(el('p', 'faint', 'The product names no places on the map for this COA, so it is shown here only.'));
      const show = () => map.highlight([coa.id]);
      card.addEventListener('mouseenter', show); card.addEventListener('focus', show);
      card.addEventListener('mouseleave', () => map.highlight([])); card.addEventListener('blur', () => map.highlight([]));
      threat.append(card);
    }
    threat.append(el('h3', 'kicker', 'Adversary and unknown forces'));
    if (!j2.enemy.length) threat.append(el('p', 'faint', 'No adversary forces in the scenario.'));
    else threat.append(table(['Unit', 'Type', 'Grid', 'Grade', 'Reports'], j2.enemy.map((u) => [u.designation + (u.affiliation === 'Unknown' ? ' (unknown)' : ''), u.kind, u.grid, gradeChip(u.grade, u.gradeWords), u.reports]), 'Adversary and unknown forces with their grades'));
    if (j2.findings.length) {
      threat.append(el('h3', 'kicker', 'Tradecraft findings on the registers'));
      const list = el('ul', 'findings');
      for (const finding of j2.findings) { const li = el('li', 'f-' + finding.severity); li.append(el('b', '', finding.subject + ': '), document.createTextNode(finding.message)); list.append(li); }
      threat.append(list);
    }

    // PIRs, each tied to the decision point it supports.
    const pirs = nodes.j2Panels.get('pirs');
    pirs.replaceChildren();
    pirs.append(el('p', 'rule', 'Every PIR names the decision it supports and its latest time of value. Only a named person approves a PIR.'));
    if (!j2.pirs.length) pirs.append(el('p', 'faint', 'No PIRs yet. The requirements manager drafts them in the PIR register.'));
    for (const pir of j2.pirs) {
      const card = el('article', 'pir' + (pir.ltiovPassed ? ' passed' : ''));
      card.tabIndex = 0;
      const head = el('div', 't');
      head.append(el('span', 'k mono', pir.id), el('span', 'st-pill ' + (pir.status === 'approved' ? 'approved' : 'draft'), pir.status));
      card.append(head, el('p', '', pir.requirement));
      const dp = el('p', 'dp');
      dp.append(el('span', 'dia', '◆'), document.createTextNode(' Supports ' + (pir.dp ? pir.dp.id + ': ' + pir.dp.decision + ' (decision maker: ' + pir.dp.maker + ')' : pir.decisionPoint)));
      card.append(dp);
      const ltiovMs = Date.parse(pir.ltiov);
      if (Number.isFinite(ltiovMs)) card.append(el('p', 'ltiov mono' + (pir.ltiovPassed ? ' late' : ''), 'Latest time of value ' + dtg(ltiovMs) + (pir.ltiovPassed ? ' (passed)' : ' · ' + inWords(ltiovMs - model.now))));
      if (pir.nais.length) { const chips = el('p', 'chips'); for (const nai of pir.nais) chips.append(el('span', 'chip', nai)); card.append(chips); }
      if (pir.indicators.length) { const list = el('ul', 'inds'); for (const indicator of pir.indicators) list.append(el('li', '', (indicator.id ? indicator.id + ': ' : '') + indicator.text)); card.append(list); }
      if (pir.decidedBy) card.append(el('p', 'human-line', titleCase(pir.decidedBy)));
      card.setAttribute('aria-label', pir.id + ': ' + pir.requirement + '. Supports ' + (pir.dp ? pir.dp.id : pir.decisionPoint) + '.');
      const show = () => map.highlight(pir.nais);
      card.addEventListener('mouseenter', show); card.addEventListener('focus', show);
      card.addEventListener('mouseleave', () => map.highlight([])); card.addEventListener('blur', () => map.highlight([]));
      pirs.append(card);
    }

    // The collection plan: the J2 recommends, the J3 tasks.
    const collection = nodes.j2Panels.get('collection');
    collection.replaceChildren();
    collection.append(el('p', 'rule', 'The J2 recommends; the J3 approves the allocation of collection assets.'));
    if (!j2.collection.length) collection.append(el('p', 'faint', 'No collection recommendations yet. The collection manager writes them against each PIR\'s indicators.'));
    else collection.append(table(['PIR', 'Indicator', 'NAI', 'Recommended capability', 'Timing', 'Needs'], j2.collection.map((c) => [c.pir, c.indicator, c.nai, c.capability + ' (' + c.discipline + ')', shortTime(c.from) + ' to ' + shortTime(c.to), c.needs]), 'Collection plan'));

    // Sources, with reliability and credibility graded separately.
    const sources = nodes.j2Panels.get('sources');
    sources.replaceChildren();
    sources.append(el('p', 'rule', 'Reliability grades the source (A to F); credibility grades the information (1 to 6). Two reports from one origin are one piece of evidence.'));
    sources.append(el('h3', 'kicker', 'Source register'));
    if (!j2.sources.length) sources.append(el('p', 'faint', 'No sources in the register yet. The OSINT and GEOINT analysts add them through the intel workbench.'));
    else sources.append(table(['Id', 'Title', 'Discipline', 'Grade', 'Origin', 'Confirmed'], j2.sources.map((s) => [s.id, s.title, s.discipline, gradeChip(s.grade, s.gradeWords), s.origin, s.confirmed ? 'By an independent origin' : 'Not independently']), 'Source register'));
    // Live feed reports from the observation store, newest first, clamped to the person's clearance by the extension. A simulated row carries SIM.
    const live = j2.live && Array.isArray(j2.live.reports) ? j2.live : { total: 0, reports: [] };
    sources.append(el('h3', 'kicker', 'Live feed reports'));
    if (!live.reports.length) sources.append(el('p', 'faint', 'No feed reports yet. Start the exercise feed simulation, or connect a feed, and its reports arrive here.'));
    else {
      if (live.total > live.reports.length) sources.append(el('p', 'faint', 'Showing the newest ' + live.reports.length + ' of ' + live.total + ' reports.'));
      sources.append(table(['Received', 'Feed', 'Report', 'Where', 'Grade'], live.reports.map((r) => [r.known, (r.simulated ? 'SIM ' : '') + r.feed + ' / ' + r.channel, r.what, r.where, gradeChip(r.grade, r.gradeWords)]), 'Live feed reports'));
    }
    if (j2.reports.length) {
      sources.append(el('h3', 'kicker', 'Exercise reports in the scenario'));
      sources.append(table(['Id', 'Report', 'Kind', 'Received', 'Grade', 'About'], j2.reports.map((r) => [r.id, r.title, r.kind, r.received, gradeChip(r.grade, r.gradeWords), r.about]), 'Scenario reports'));
    }

    // Standing watches: an armed indicator drafts; a named person decides.
    const watches = nodes.j2Panels.get('watches');
    watches.replaceChildren();
    watches.append(el('p', 'rule', 'A watch drafts an INTREP and alerts a named person. It never releases, approves or tasks anything, and runs only while a person has the staff run open.'));
    if (!j2.watches.length) watches.append(el('p', 'faint', 'No standing watches yet. A watch binds a PIR\'s indicator to an area and its latest time of value.'));
    for (const entry of isArr(j2.watchAlerts) ? j2.watchAlerts : []) {
      if (entry.digest) watches.append(el('p', 'faint', 'Digest for ' + entry.person + ': ' + entry.digestMatches + ' match' + (entry.digestMatches === 1 ? '' : 'es') + ' in ' + entry.digest + ' held alert' + (entry.digest === 1 ? '' : 's') + ', sent with the next alert.'));
    }
    for (const watch of j2.watches) {
      const card = el('article', 'watch w-' + watch.state);
      const head = el('div', 't');
      head.append(el('span', 'k mono', watch.id), el('span', '', watch.title), el('span', 'st-pill w ' + watch.state, watch.stateText));
      card.append(head);
      if (watch.pir) card.append(el('p', 'faint', 'Serves ' + watch.pir + (watch.indicator ? ', indicator ' + watch.indicator : '') + (watch.ltiov ? '. Expires at the latest time of value, ' + dtg(Date.parse(watch.ltiov)) + '.' : '')));
      if (watch.alert) card.append(el('p', 'human-line', 'Alerts ' + watch.alert));
      if (watch.missed) card.append(el('p', 'late', watch.missed + ' match' + (watch.missed === 1 ? '' : 'es') + ' found while paused, kept for the person.'));
      if (watch.lastMatch) card.append(el('p', 'faint', 'Last match ' + shortTime(watch.lastMatch)));
      if (watch.unsigned) card.append(el('p', 'late', 'No signed arm decision proves this watch, so it runs nothing until a person arms it.'));
      if (watch.queued) card.append(el('p', 'faint', watch.queued + ' observation' + (watch.queued === 1 ? '' : 's') + ' queued for the person, delivered when it is armed again.'));
      if (isArr(watch.drafts) && watch.drafts.length) card.append(el('p', 'human-line', 'Drafts for the named person: ' + watch.drafts.join(', ') + '. Each follows its own release path.'));
      if (typeof watch.reason === 'string' && watch.reason) card.append(el('p', 'faint', watch.reason));
      watches.append(card);
    }
    showJ2Tab(J2_TABS.some(([id]) => id === saved.j2tab) ? saved.j2tab : 'threat', false);
  }

  function renderComing() {
    for (const id of ['j5', 'j3', 'j4']) {
      const pane = nodes.panes.get(id);
      const info = model.coming[id];
      if (!info) continue;
      const card = el('div', 'coming');
      const art = el('div', 'coming-art');
      art.append(glyph(GLYPH[id] || GLYPH.other, 'big'));
      const body = el('div', 'coming-body');
      body.append(el('p', 'kicker', 'Coming in drop 2'), el('h2', '', labelOf(id) + ' workspace'));
      body.append(el('p', 'muted', 'Its own view of the staff run, on the shared map, beside the same ledger, decisions and clock. It will hold:'));
      const list = el('ul', 'coming-list');
      for (const line of info.lines) list.append(el('li', '', line));
      body.append(list);
      const squad = model.squads.find((entry) => entry.section === id);
      body.append(el('p', 'faint', squad && squad.members.length ? 'Its agents are working now: watch them in the squads above and the war room.' : 'Until then the war room shows this section\'s agents, products and hand-offs.'));
      const row = el('div', 'acts');
      row.append(button('Go to the war room', 'ai', () => switchTo('war-room', true)));
      body.append(row);
      card.append(art, body);
      pane.replaceChildren(card);
    }
  }

  // ---------- cards (popovers) ----------
  function closePop() {
    if (nodes.pop.hidden) return;
    nodes.pop.hidden = true;
    nodes.pop.replaceChildren();
    if (popAnchor && typeof popAnchor.focus === 'function') popAnchor.focus();
    popAnchor = null;
  }
  function openPop(anchor, title, sub, build) {
    nodes.pop.replaceChildren();
    popAnchor = anchor;
    const heading = el('h3', '', title);
    heading.id = 'pop-title';
    nodes.pop.setAttribute('aria-labelledby', 'pop-title');
    const close = button('Close', 'ghost x', closePop, { 'aria-label': 'Close (Escape)' });
    nodes.pop.append(close, heading);
    if (sub) nodes.pop.append(el('p', 'sub', sub));
    build(nodes.pop);
    nodes.pop.hidden = false;
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      const width = Math.min(340, (document.documentElement && document.documentElement.clientWidth || 800) - 24);
      const left = Math.max(12, Math.min((r.left || 0), (document.documentElement && document.documentElement.clientWidth || 800) - width - 12));
      nodes.pop.style.left = left + 'px';
      nodes.pop.style.top = Math.max(12, (r.bottom || 0) + 6) + 'px';
      nodes.pop.style.width = width + 'px';
    }
    anim(nodes.pop, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200 });
    close.focus();
  }
  function dl(parent, rows) {
    const list = el('dl');
    for (const [key, value] of rows) { if (value === undefined || value === '') continue; list.append(el('dt', '', key), el('dd', '', value)); }
    parent.append(list);
  }

  /** A product's provenance: who drafted it, which version, its gates on that version, who approved it, what it depends on, and its history. */
  function openProductCard(product, anchor) {
    const row = model && model.ledger.find((entry) => entry.product === product);
    if (!row) return;
    openPop(anchor, row.title + ' v' + row.version, row.code + ' · ' + row.kind + ' · ' + row.display, (pop) => {
      dl(pop, [
        ['Owner', row.owner], ['State', row.display], ['Version hash', row.hash.slice(0, 16) + '…'], ['Label', row.label],
        ['Gates', row.gates.length ? row.gates.map((g) => g.gate + ' ' + g.verdict + ' on v' + g.version).join('; ') : 'None yet'],
        ['Approved by', row.approvedBy ? row.approvedBy + ', signed with this device\'s key; identity self-declared' : undefined],
        ['Decision for', row.decisionFor ? 'The ' + row.decisionFor : undefined],
        ['Depends on', row.dependsOn.join(', ')], ['File', row.path]
      ]);
      if (row.tampered) pop.append(el('p', 'problem', 'Tampered: ' + row.tampered));
      if (row.held && row.held.length) { pop.append(el('p', 'kicker', 'Held')); const list = el('ul'); for (const reason of row.held) list.append(el('li', '', reason)); pop.append(list); }
      if (row.changedSources.length) pop.append(el('p', 'late', 'Source changed: ' + row.changedSources.join('; ') + '. The owner decides whether to take it.'));
      pop.append(el('p', 'kicker', 'History, newest first'));
      const history = el('ol', 'history');
      for (const item of row.history) {
        const li = el('li', item.person ? 'person' : '');
        li.append(el('span', 'mono faint', shortTime(item.at) + ' v' + item.version + ' '), document.createTextNode(item.from + ' to ' + item.to + ', by ' + item.by));
        history.append(li);
      }
      pop.append(history);
      const acts = el('div', 'acts');
      acts.append(button('Open the file', 'ai', () => vscode.postMessage({ type: 'open-product', product: row.product })));
      pop.append(acts);
    });
  }

  function openAgentCard(squad, member, anchor) {
    openPop(anchor, member.id, squad.name + ' · ' + member.stateText, (pop) => {
      dl(pop, [['Task', member.task], ['Section', squad.name], ['Decides', 'Nothing. Drafts and recommends. Cannot approve, release or sign.'], ['Led by', squad.person || squad.lead]]);
      const acts = el('div', 'acts');
      acts.append(button('Pause, resume or stop in Team Live', 'ghost', () => vscode.postMessage({ type: 'open', target: 'team-live' })));
      pop.append(acts);
    });
  }

  function openUnitCard(unit, anchor) {
    const words = { F: 'Friendly', H: 'Hostile', N: 'Neutral', U: 'Unknown' }[unit.affiliation];
    openPop(anchor, unit.designation, words + ' · ' + unit.kind, (pop) => {
      dl(pop, [
        ['Party', unit.party], ['Echelon', unit.echelon], ['Grid', unit.grid], ['Location', unit.location],
        ['Grade', unit.grade ? unit.grade.code + '. ' + unit.grade.words : (unit.affiliation === 'F' ? 'Own-force data' : 'No graded report')],
        ['Reports', unit.reports.map((r) => r.id + ' (' + r.grade + '): ' + r.title).join('; ')],
        ['Layer', unit.layer.replace(/^cop-|-layer$/g, '')],
        ['Shown', unit.anticipated ? 'Dashed: reported or old, not confirmed' : 'Solid']
      ]);
    });
  }

  // ---------- hand-offs ----------
  function anchorFor(name) {
    const [kind, a, b] = name.split(':');
    const visible = (node) => { for (let at = node; at; at = at.parentNode || at.parent) if (at.hidden) return false; return Boolean(node); };
    let node;
    if (kind === 'section') node = pods.get(a);
    else if (kind === 'member') node = tokens.get(a + ':' + b) || pods.get(a);
    else if (kind === 'ledger') node = ledgerRows.get(a) || nodes.ledgerHead;
    else if (kind === 'decisions') node = nodes.decideHead;
    else if (kind === 'map') node = map && map.element;
    if (node && visible(node)) return node;
    if (kind === 'map') return nodes.tabButtons.get('war-room');
    return node;
  }
  function centerOf(node) { const r = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }; return [r.left + r.width / 2, r.top + r.height / 2]; }

  function handoff(cue) {
    const target = BUILT.includes(cue.workspace) ? cue.workspace : 'war-room';
    if (saved.follow && target !== saved.workspace) switchTo(target, false);
    else if (!saved.follow && cue.workspace !== saved.workspace) { const tab = nodes.tabButtons.get(cue.workspace); if (tab) tab.classList.add('live'); }
    const from = anchorFor(cue.from), to = anchorFor(cue.to);
    announce('Hand-off: ' + cue.label + '.');
    if (!from || !to) return;
    if (!motion()) { stillLink(from, to, cue.label, cue.kind); return; }
    if (liveTracers >= MAX_TRACERS) { if (tracerQueue.length < MAX_QUEUE) tracerQueue.push([from, to, cue.label, cue.kind]); return; }
    tracer(from, to, cue.label, cue.kind);
  }

  /** A dot with a label and a comet tail travels a curved path from one party to the other; the target glows on arrival (Team Live's grammar). */
  function tracer(from, to, label, kind) {
    liveTracers += 1;
    const [x1, y1] = centerOf(from), [x2, y2] = centerOf(to);
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy) || 1;
    const lift = Math.min(140, dist * 0.3);
    const cx = (x1 + x2) / 2 + (dy / dist) * lift, cy = (y1 + y2) / 2 + (-dx / dist) * lift;
    const g = sv('g', { class: 'k-' + kind }, nodes.fx);
    const d = 'M' + x1 + ',' + y1 + ' Q' + cx + ',' + cy + ' ' + x2 + ',' + y2;
    const trail = sv('path', { class: 'trailp', d }, g);
    const comet = sv('path', { class: 'comet', d }, g);
    const length = typeof trail.getTotalLength === 'function' ? trail.getTotalLength() : dist;
    const tail = 46;
    comet.style.strokeDasharray = tail + ' ' + (length + tail);
    const head = sv('g', null, g);
    sv('circle', { class: 'dotc halo', r: 10 }, head);
    sv('circle', { class: 'dotc', r: 4.5 }, head);
    const chip = sv('g', { transform: 'translate(10,-22)' }, head);
    const bg = sv('rect', { class: 'chipbg', x: 0, y: 0, height: 18, rx: 9 }, chip);
    const tx = sv('text', { class: 'chiptx', x: 8, y: 12.5 }, chip);
    tx.textContent = label;
    bg.setAttribute('width', String(Math.ceil((typeof tx.getComputedTextLength === 'function' ? tx.getComputedTextLength() : label.length * 6) + 16)));
    const frames = [];
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const px = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2, py = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
      frames.push({ transform: 'translate(' + px.toFixed(1) + 'px, ' + py.toFixed(1) + 'px)' });
    }
    const ms = Math.max(700, Math.min(1400, 520 + dist * 0.8));
    head.style.transform = frames[steps].transform;
    head.animate(frames, { duration: ms, easing: EASE.travel });
    comet.animate([{ strokeDashoffset: tail }, { strokeDashoffset: tail - length }], { duration: ms, easing: EASE.travel });
    const done = () => {
      arrive(to, kind);
      const fade = g.animate ? g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: EASE.exit }) : null;
      const finish = () => { g.remove(); liveTracers -= 1; const next = tracerQueue.shift(); if (next) { if (motion()) tracer.apply(null, next); else stillLink.apply(null, next); } };
      if (fade) fade.onfinish = finish; else finish();
    };
    setTimeout(done, ms);
  }
  function arrive(node, kind) {
    if (!motion() || !node || !node.classList) return;
    const cls = kind === 'human' ? 'arrive-gold' : kind === 'prod' ? 'arrive-ok' : 'arrive';
    node.classList.remove(cls);
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), 650);
  }
  /** Under reduced motion or Calm, nothing travels: a still dashed line with the label at the target, fading after 1.8 s. */
  function stillLink(from, to, label, kind) {
    const [x1, y1] = centerOf(from), [x2, y2] = centerOf(to);
    const g = sv('g', { class: 'k-' + kind + ' still-link' }, nodes.fx);
    sv('path', { class: 'still', d: 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2 }, g);
    const chip = sv('g', { transform: 'translate(' + (x2 + 8) + ',' + (y2 - 26) + ')' }, g);
    const bg = sv('rect', { class: 'chipbg', x: 0, y: 0, height: 18, rx: 9 }, chip);
    const tx = sv('text', { class: 'chiptx', x: 8, y: 12.5 }, chip);
    tx.textContent = label;
    bg.setAttribute('width', String(Math.ceil((typeof tx.getComputedTextLength === 'function' ? tx.getComputedTextLength() : label.length * 6) + 16)));
    setTimeout(() => g.remove(), 1800);
  }

  /** The room wakes up: the rail, the squads and the switcher come in one after another. Not under reduced motion or Calm. */
  function wakeUp() {
    if (!motion()) return;
    [...(nodes.rail.children || [])].forEach((li, i) => anim(li, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 380, delay: i * 55, fill: 'backwards' }));
    [...(nodes.squads.children || [])].forEach((pod, i) => anim(pod, [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 420, delay: 280 + i * 70, fill: 'backwards', easing: EASE.settle }));
  }

  // ---------- help and keys ----------
  const KEYS = [['1 to 5', 'War room, J2, J5, J3, J4'], ['D', 'Jump to the first decision waiting for a person'], ['F', 'Follow the action on or off'], ['M', 'Map as table'], ['C', 'Calm'], ['T', 'Theme'], ['?', 'This list'], ['Escape', 'Close a card or this list'], ['Arrow keys', 'Move along the rail, the agents, the workspaces and the J2 tabs']];
  function openHelp() {
    const dialog = nodes.helpDialog;
    dialog.replaceChildren();
    dialog.append(el('h2', '', 'Keyboard'));
    const t = el('table');
    for (const [key, what] of KEYS) { const tr = el('tr'); const td = el('td'); td.append(el('kbd', '', key)); tr.append(td, el('td', '', what)); t.append(tr); }
    dialog.append(t);
    const toggle = button(saved.keys ? 'Single-key shortcuts: on' : 'Single-key shortcuts: off', '', () => { saved.keys = !saved.keys; save(); setText(toggle, saved.keys ? 'Single-key shortcuts: on' : 'Single-key shortcuts: off'); toggle.setAttribute('aria-pressed', saved.keys ? 'true' : 'false'); }, { 'aria-pressed': saved.keys ? 'true' : 'false' });
    const close = button('Close', 'primary', closeHelp);
    const acts = el('div', 'acts');
    acts.append(toggle, close);
    dialog.append(acts);
    dialog.hidden = false;
    close.focus();
  }
  function closeHelp() { if (nodes.helpDialog.hidden) return; nodes.helpDialog.hidden = true; nodes.help.focus(); }

  function onKey(event) {
    if (event.key === 'Escape') { if (!nodes.helpDialog.hidden) { closeHelp(); return; } closePop(); return; }
    const target = event.target || {};
    const tag = String(target.tagName || '').toLowerCase();
    if (event.ctrlKey || event.metaKey || event.altKey || tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (event.key === '?') { event.preventDefault(); openHelp(); return; }
    if (!saved.keys) return;
    const key = String(event.key || '').toLowerCase();
    const index = ['1', '2', '3', '4', '5'].indexOf(key);
    if (index >= 0) { event.preventDefault(); switchTo(WORKSPACES[index], true); const tab = nodes.tabButtons.get(WORKSPACES[index]); if (tab) tab.focus(); return; }
    if (key === 'd') {
      event.preventDefault();
      // children is an HTMLCollection, which has no find: spread it first.
      const first = [...nodes.decList.children].find((li) => li.dataset && li.dataset.product);
      const actionButton = first ? findButton(first) : undefined;
      if (actionButton) actionButton.focus(); else { nodes.decideHead.tabIndex = -1; nodes.decideHead.focus(); announce('Nothing waiting for a person.'); }
      return;
    }
    if (key === 'f') { event.preventDefault(); setFollow(!saved.follow); announce(saved.follow ? 'Follow the action on.' : 'Follow the action off.'); return; }
    if (key === 'm') { event.preventDefault(); map.showTable(!map.tableShown()); announce(map.tableShown() ? 'Map as table.' : 'Map.'); return; }
    if (key === 'c') { event.preventDefault(); setCalm(!saved.calm); return; }
    if (key === 't') { event.preventDefault(); cycleTheme(); }
  }
  function findButton(node) {
    for (const child of node.children || []) {
      if (String(child.tagName || '').toLowerCase() === 'button' && child.getAttribute && child.getAttribute('data-action')) return child;
      const found = findButton(child);
      if (found) return found;
    }
    return undefined;
  }

  // One hide timer, kept: a newer notice clears the older one's, so it shows its own full 6 seconds rather than hiding when the older one's ends.
  function showNotice(text) {
    nodes.notice.textContent = text;
    nodes.notice.hidden = false;
    announce(text);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeTimer = undefined; nodes.notice.hidden = true; }, 6000);
  }

  // ---------- start ----------
  skeleton();
  applyTheme();
  switchTo(WORKSPACES.includes(saved.workspace) ? saved.workspace : 'war-room', false);
  setFollow(saved.follow);
  document.addEventListener('keydown', onKey);
  if (document.addEventListener) document.addEventListener('visibilitychange', () => { if (document.hidden && clockTimer) { clearInterval(clockTimer); clockTimer = undefined; } else if (!document.hidden && !clockTimer) clockTimer = setInterval(tick, 1000); });
  clockTimer = setInterval(tick, 1000);
  if (reducedQuery && typeof reducedQuery.addEventListener === 'function') reducedQuery.addEventListener('change', applyTheme);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!isObj(message)) return;
    if (message.type === 'layout-probe' && window.nearAiLayoutProbe) { vscode.postMessage(window.nearAiLayoutProbe()); return; }
    if (message.type === 'staff-room') {
      if (!validModel(message.model)) return;
      render(message.model, isArr(message.cues) ? message.cues : []);
      // The COP picture comes with the model when it changed (or the page asked for everything); the time comes every time.
      if (map && ('picture' in message || 'pictureProblem' in message || 'pictureNow' in message)) {
        map.setPicture(validPicture(message.picture) ? message.picture : undefined, {
          now: typeof message.pictureNow === 'number' ? message.pictureNow : undefined,
          problem: typeof message.pictureProblem === 'string' ? message.pictureProblem.slice(0, 300) : undefined
        });
      }
      return;
    }
    if (message.type === 'staff-room-empty' && typeof message.reason === 'string') {
      nodes.empty.hidden = false;
      nodes.empty.replaceChildren(el('h2', '', 'The Staff Room'), el('p', 'muted', message.reason));
      return;
    }
    if (message.type === 'notice' && typeof message.text === 'string') showNotice(message.text.slice(0, 400));
  });
  vscode.postMessage({ type: 'ready' });
})();

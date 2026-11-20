// Team Live (0.4.28): the team of a run as a tree, the lead on top, with each hand-off drawn as it happens. The host sends the whole picture (cards,
// lines, a reading order) and what changed since the last one; this page only lays it out and animates. Every state is shown by an icon and words, never
// colour alone. Movement means a hand-off and nothing else, plus a slow breathing ring on a working card; there is none at all under the system's
// reduced-motion setting or the page's Calm toggle. Animations are decoration: a card always shows the host's latest state in words.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = Object.assign({ calm: false, list: false }, vscode.getState ? vscode.getState() || {} : {});
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  // Sizes in CSS pixels; teamLive.css gives the cards the same.
  const CARD_W = 184, CARD_H = 112, GAP_X = 24, ROW_H = 152, GUEST_W = 160, GUEST_H = 96, GUEST_GAP = 16, BAND_GAP = 28, NARROW = 520;
  const SLOT = CARD_W + GAP_X;
  const MAX_PULSES = 6, MAX_QUEUE = 12, STAGGER_MS = 80, PULSE_MS = 900;

  const STATE_ICON = {
    bench: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z', queued: 'M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6M11 2c0 4-6 4-6 6s6 2 6 6', working: 'M1 8h3l2-5 4 10 2-5h3',
    'waiting-agents': 'M8 2v5M8 7l-5 6M8 7l5 6M8 7v7', 'needs-you': 'M8 2l6.5 12h-13zM8 6v4M8 11.5v.5', paused: 'M5.5 3v10M10.5 3v10',
    retrying: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 5v3.5l2.5 1.5', done: 'M3 8.5l3 3 7-7', failed: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM5.5 5.5l5 5M10.5 5.5l-5 5',
    stopped: 'M4 4h8v8H4z', interrupted: 'M2 8h4M10 8h4M7 5l2 6'
  };
  const TOOL_ICON = {
    read: 'M3 2h7l3 3v9H3zM5 7h6M5 10h6', change: 'M3 13l1-3 7-7 2 2-7 7zM10 4l2 2', run: 'M2 3h12v10H2zM4 6l2 2-2 2M8 10h3',
    web: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12', plan: 'M5 4h8M5 8h8M5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5',
    memory: 'M4 2h8v12l-4-3-4 3z', media: 'M2 3h12v10H2zM2 11l4-4 3 3 2-2 3 3', documents: 'M4 2h6l3 3v9H4zM10 2v3h3',
    connected: 'M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2', other: 'M8 6a2 2 0 1 0 0 4a2 2 0 0 0 0-4z'
  };

  let view;
  let runs = [];
  let runId;
  let clockSkew = 0;
  let restored = false;
  let wide = false;
  let focusId;
  let openId;
  let excerpt;
  const cards = new Map();
  const paths = new Map();
  let active = [];
  let queue = [];
  let nextStart = 0;
  let announced = [];
  let announceTimer;
  let clock;

  const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  /** Whether anything may move: not under reduced motion, not in Calm, not while the tab is hidden. */
  const motion = () => !saved.calm && !(reducedQuery && reducedQuery.matches) && !document.hidden;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(d, cls) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'icon ' + (cls || ''));
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  const now = () => Date.now() + clockSkew;
  function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's' : Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }
  const node = (id) => view && view.nodes.find((candidate) => candidate.id === id);
  const instanceOf = (agentId) => { for (const item of (view ? view.nodes : [])) for (const one of item.instances) if (one.agentId === agentId) return one; return undefined; };
  const TERMINAL = ['done', 'failed', 'stopped', 'interrupted'];

  // ---------- controls ----------

  function applyToggles() {
    document.body.classList.toggle('calm', !motion() || saved.calm);
    $('calm').setAttribute('aria-pressed', String(Boolean(saved.calm)));
    $('layout').setAttribute('aria-pressed', String(Boolean(saved.list)));
  }
  $('calm').addEventListener('click', () => {
    saved.calm = !saved.calm;
    if (vscode.setState) vscode.setState(saved);
    if (saved.calm) cancelAll();
    applyToggles();
    say(saved.calm ? 'Calm: nothing moves.' : 'Movement on.');
  });
  $('layout').addEventListener('click', () => { saved.list = !saved.list; if (vscode.setState) vscode.setState(saved); cancelAll(); layout(); applyToggles(); });
  $('show-chat').addEventListener('click', () => vscode.postMessage({ type: 'show-in-chat' }));
  $('run').addEventListener('change', () => vscode.postMessage({ type: 'select-run', runId: $('run').value }));
  if (reducedQuery && reducedQuery.addEventListener) reducedQuery.addEventListener('change', () => { if (!motion()) cancelAll(); applyToggles(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); applyToggles(); });
  window.addEventListener('resize', () => layout());

  // ---------- the picture ----------

  function render(message) {
    const first = !view || message.runId !== runId;
    if (message.now) clockSkew = message.now - Date.now();
    runs = message.runs || [];
    restored = Boolean(message.restored);
    if (message.runId !== runId) { cancelAll(); clearCards(); openId = undefined; excerpt = undefined; }
    runId = message.runId;
    view = message.view;
    if (message.excerpt && message.excerpt.agentId) excerpt = message.excerpt;
    renderHeader();
    $('empty').hidden = Boolean(view);
    $('stage').hidden = !view;
    $('restored').hidden = !restored;
    if (!view) { $('card').hidden = true; stopClock(); return; }
    const ids = new Set(view.nodes.map((item) => item.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.root.remove(); cards.delete(id); }
    for (const item of view.nodes) updateCard(item);
    // Reading order: the DOM follows it, so a screen reader and Tab read the team as it is drawn. Only reordered when it changed.
    const tree = $('tree');
    const wanted = view.order.map((entry) => cards.get(entry.id) && cards.get(entry.id).root).filter(Boolean);
    if (tree.children.length !== wanted.length || wanted.some((item, index) => tree.children[index] !== item)) {
      // Moving a node drops its focus; the focused card gets it back, so a keyboard user's place survives a reorder mid-run (review of PR 72).
      const focused = document.activeElement;
      tree.append(...wanted);
      if (focused && focused !== document.activeElement && tree.contains(focused) && typeof focused.focus === 'function') focused.focus();
    }
    view.order.forEach((entry) => { const card = cards.get(entry.id); if (card) { card.root.setAttribute('aria-level', String(entry.depth + 1)); card.root.style.setProperty('--depth', String(entry.depth)); } });
    if (!focusId || !cards.has(focusId)) focusId = view.order[0] && view.order[0].id;
    for (const [id, card] of cards) card.root.tabIndex = id === focusId ? 0 : -1;
    layout();
    // A task on its way to an agent that has ended since is dropped: the card already says how it ended.
    const ended = (event) => { const one = instanceOf(event.agentId); return !one || TERMINAL.includes(one.state); };
    queue = queue.filter((event) => event.kind !== 'delegate' || !ended(event));
    for (const pulse of [...active]) if (pulse.event.kind === 'delegate' && ended(pulse.event)) stopPulse(pulse);
    if (first) say(view.summary);
    for (const event of message.events || []) handle(event);
    if (openId) renderDetail();
    tick();
    clock = clock || setInterval(tick, 1000);
  }

  function renderHeader() {
    setText($('title'), view ? view.title : 'Team Live');
    setText($('run-state'), view ? view.summary : '');
    // Offered whenever there is another run to show, finished ones too: the last finished run stays reachable while another team run is live.
    const picker = $('run');
    $('run-picker').hidden = runs.length < 2;
    if (runs.length >= 2) {
      picker.replaceChildren(...runs.map((run) => { const option = el('option', '', run.title + (run.running ? '' : ' (ended)')); option.value = run.runId; option.selected = run.runId === runId; return option; }));
    }
  }

  function clearCards() {
    for (const card of cards.values()) card.root.remove();
    cards.clear();
    for (const path of paths.values()) path.remove();
    paths.clear();
  }

  function updateCard(item) {
    let card = cards.get(item.id);
    if (!card) {
      const root = el('div', 'node');
      root.setAttribute('role', 'treeitem');
      root.dataset.id = item.id;
      const ring = el('span', 'ring');
      const dock = el('span', 'dock');
      const head = el('div', 'head');
      const stateIcon = el('span', 'state-icon');
      const name = el('span', 'name');
      name.setAttribute('data-must-read', '');
      const count = el('span', 'count');
      head.append(stateIcon, name, count);
      const word = el('div', 'word');
      word.setAttribute('data-must-read', '');
      const activity = el('div', 'activity');
      const toolIcon = el('span', 'tool-icon');
      const activityText = el('span', 'activity-text');
      const answer = el('button', 'link answer', 'Answer in chat');
      answer.type = 'button';
      answer.tabIndex = -1;
      answer.addEventListener('click', (event) => { if (event && event.stopPropagation) event.stopPropagation(); vscode.postMessage({ type: 'show-in-chat' }); });
      activity.append(toolIcon, activityText, answer);
      const task = el('div', 'task');
      const meta = el('div', 'meta');
      const elapsed = el('span', 'elapsed');
      const privacy = el('span', 'privacy');
      const model = el('span', 'model');
      const reports = el('span', 'reports');
      meta.append(elapsed, privacy, model, reports);
      root.append(ring, dock, head, word, activity, task, meta);
      root.addEventListener('click', () => { focusCard(item.id); openDetail(item.id); });
      root.addEventListener('keydown', (event) => onKey(event, root.dataset.id));
      card = { root, dock, stateIcon, name, count, word, activity, toolIcon, activityText, answer, task, elapsed, privacy, model, reports, state: '', icon: '' };
      cards.set(item.id, card);
    }
    const root = card.root;
    root.className = 'node ' + item.kind + ' state-' + item.state + (item.background ? ' background' : '') + (root.classList.contains('awaiting') ? ' awaiting' : '');
    if (card.state !== item.state) { card.stateIcon.replaceChildren(icon(STATE_ICON[item.state] || STATE_ICON.bench, 'state')); card.state = item.state; }
    setText(card.name, item.name);
    setText(card.count, item.count > 1 ? '×' + item.count : '');
    card.count.title = item.tally || '';
    setText(card.word, item.word);
    const iconKey = item.state === 'working' && item.icon ? item.icon : '';
    if (card.icon !== iconKey) { card.toolIcon.replaceChildren(...(iconKey ? [icon(TOOL_ICON[iconKey] || TOOL_ICON.other, 'tool')] : [])); card.icon = iconKey; }
    setText(card.activityText, item.activity || '');
    card.activity.title = item.activity || '';
    card.answer.hidden = item.state !== 'needs-you';
    // A helper says who started it, since in the tree it sits in a band of its own.
    const from = item.kind === 'guest' && node(item.parent) ? 'From ' + node(item.parent).name + (item.task && item.name !== item.task ? ': ' + item.task : '') : '';
    setText(card.task, from || (item.task ? (item.kind === 'lead' ? item.task : 'Task: ' + item.task) : item.kind === 'member' && item.role ? item.role : ''));
    card.task.title = item.task || '';
    setText(card.privacy, item.privacy || '');
    card.privacy.hidden = !item.privacy;
    card.privacy.title = item.privacy === 'TEE' ? 'Runs inside NEAR\'s TEE' : item.privacy === 'Local' ? 'Runs on this computer' : item.privacy === 'Cloud' ? 'Forwarded by NEAR to another provider' : '';
    setText(card.model, item.model ? item.model.split('/').pop() : '');
    card.model.title = item.model || '';
    setText(card.reports, item.kind === 'lead' && (item.reportsIn || item.reportsWaiting) ? (item.reportsIn || 0) + ' report' + (item.reportsIn === 1 ? '' : 's') + ' in' + (item.reportsWaiting ? ' · ' + item.reportsWaiting + ' waiting' : '') : '');
    root.setAttribute('aria-label', item.name + ': ' + item.word + (item.count > 1 ? ', ' + (item.tally || item.count + ' tasks') : '') + (item.task ? '. Task: ' + item.task : '') + (item.activity && item.state !== 'bench' ? '. ' + item.activity : ''));
  }

  /** Places the cards: a tree when the panel is wide enough for it, otherwise (or when asked) an indented list. Cards never move during a run. */
  function layout() {
    if (!view) return;
    const stage = $('stage');
    const width = stage.clientWidth || document.documentElement.clientWidth || 0;
    wide = !saved.list && width >= NARROW && view.tree.width * SLOT <= width;
    stage.classList.toggle('wide', wide);
    stage.classList.toggle('list', !wide);
    $('lines').hidden = !wide;
    if (!wide) {
      for (const card of cards.values()) card.root.style.transform = '';
      stage.style.height = '';
      return;
    }
    const offset = Math.max(0, (width - view.tree.width * SLOT) / 2);
    const boxes = new Map();
    for (const place of view.tree.places) boxes.set(place.id, { x: offset + place.x * SLOT - CARD_W / 2, y: place.depth * ROW_H, w: CARD_W, h: CARD_H });
    const columns = Math.max(1, Math.floor((width + GUEST_GAP) / (GUEST_W + GUEST_GAP)));
    const bandTop = view.tree.rows * ROW_H - (ROW_H - CARD_H) + BAND_GAP + 24;
    view.guests.forEach((id, index) => boxes.set(id, { x: (index % columns) * (GUEST_W + GUEST_GAP), y: bandTop + Math.floor(index / columns) * (GUEST_H + GUEST_GAP + 16), w: GUEST_W, h: GUEST_H }));
    let height = 0;
    for (const [id, box] of boxes) {
      const card = cards.get(id);
      if (card) card.root.style.transform = 'translate(' + Math.round(box.x) + 'px, ' + Math.round(box.y) + 'px)';
      height = Math.max(height, box.y + box.h);
    }
    stage.style.height = Math.ceil(height + 8) + 'px';
    const svg = $('lines');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(Math.ceil(height + 8)));
    const seen = new Set();
    for (const edge of view.edges) {
      const from = boxes.get(edge.from), to = boxes.get(edge.to);
      if (!from || !to) continue;
      const key = edge.from + '>' + edge.to + ':' + edge.kind;
      seen.add(key);
      let path = paths.get(key);
      if (!path) { path = document.createElementNS(SVG, 'path'); paths.set(key, path); svg.append(path); }
      path.setAttribute('d', route(from, to, edge.kind === 'live' && view.tree.places.some((place) => place.id === edge.to)).map((point, index) => (index ? 'L' : 'M') + Math.round(point[0]) + ' ' + Math.round(point[1])).join(' '));
      const drawing = path.getAttribute('class') && path.getAttribute('class').includes('drawing') ? ' drawing' : '';
      path.setAttribute('class', 'edge ' + edge.kind + ' edge-' + edge.state + drawing);
    }
    for (const [key, path] of paths) if (!seen.has(key)) { path.remove(); paths.delete(key); }
  }

  /** The points a line (and a pulse) follows from a card's bottom to another's top: down, across, down. A bypass goes straight. */
  function route(from, to, straight) {
    const start = [from.x + from.w / 2, from.y + from.h];
    const end = [to.x + to.w / 2, to.y];
    if (straight) return [start, end];
    const mid = end[1] - Math.min(20, Math.max(8, (end[1] - start[1]) / 2));
    return [start, [start[0], mid], [end[0], mid], end];
  }

  function points(fromId, toId) {
    const from = cards.get(fromId), to = cards.get(toId);
    if (!from || !to) return undefined;
    if (wide) {
      const box = (id, card) => { const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(card.root.style.transform || ''); const guest = view.guests.includes(id); return { x: match ? Number(match[1]) : 0, y: match ? Number(match[2]) : 0, w: guest ? GUEST_W : CARD_W, h: guest ? GUEST_H : CARD_H }; };
      return route(box(fromId, from), box(toId, to), view.tree.places.some((place) => place.id === toId) && node(toId) && node(toId).parent !== fromId);
    }
    // The list: along the left rail, from below the one card to the top of the other.
    const left = (card) => (card.root.offsetLeft || 0) + 6;
    return [[left(from), (from.root.offsetTop || 0) + (from.root.offsetHeight || 0)], [left(to), (to.root.offsetTop || 0)]];
  }

  // ---------- hand-offs ----------

  function handle(event) {
    if (event.kind === 'announce') { say(event.text); return; }
    if (event.kind === 'run-ended') { cancelAll(); return; }
    if (!motion()) return;
    if (event.kind === 'delegate') { const card = cards.get(event.to); if (card) card.root.classList.add('awaiting'); }
    queue.push(event);
    // A burst bigger than the page can show: every card already says where it is, so the queued hand-offs are dropped rather than played late.
    if (queue.length > MAX_QUEUE) {
      const dropped = queue.length;
      queue = [];
      for (const card of cards.values()) card.root.classList.remove('awaiting');
      say(dropped + ' hand-offs at once; showing where everyone is now.');
      return;
    }
    pump();
  }

  function pump() {
    while (active.length < MAX_PULSES && queue.length) start(queue.shift());
  }

  function start(event) {
    const route = points(event.from, event.to);
    const target = cards.get(event.to);
    const pulse = el('div', 'pulse ' + event.kind + (event.kind === 'report' && !event.ok ? ' not-ok' : ''));
    if (!route || typeof pulse.animate !== 'function') { if (target) target.root.classList.remove('awaiting'); return; }
    const dot = el('span', 'dot');
    const chip = el('span', 'chip', event.kind === 'delegate' ? (event.task || 'New task') : event.ok ? 'Report ready' : 'Did not finish');
    pulse.append(dot, chip);
    $('pulses').append(pulse);
    // Steps timed by the length of each stretch, so the dot moves at one speed.
    const lengths = route.slice(1).map((point, index) => Math.abs(point[0] - route[index][0]) + Math.abs(point[1] - route[index][1]));
    const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
    let travelled = 0;
    const frames = route.map((point, index) => { if (index) travelled += lengths[index - 1]; return { transform: 'translate(' + Math.round(point[0]) + 'px, ' + Math.round(point[1]) + 'px)', offset: travelled / total, opacity: index === 0 || index === route.length - 1 ? 0.6 : 1 }; });
    const delay = Math.max(0, nextStart - Date.now());
    nextStart = Date.now() + delay + STAGGER_MS;
    const animation = pulse.animate(frames, { duration: PULSE_MS, delay, easing: 'ease-in-out', fill: 'forwards' });
    // The line draws on behind a task on its way down.
    const record = { event, pulse, animation, path: event.kind === 'delegate' ? paths.get(event.from + '>' + event.to + ':live') || paths.get(event.from + '>' + event.to + ':org') : undefined };
    if (record.path) record.path.setAttribute('class', (record.path.getAttribute('class') || '') + ' drawing');
    active.push(record);
    animation.onfinish = () => finish(record, true);
    animation.oncancel = () => finish(record, false);
  }

  function finish(record, arrived) {
    if (!active.includes(record)) return;
    active = active.filter((item) => item !== record);
    record.pulse.remove();
    if (record.path) record.path.setAttribute('class', (record.path.getAttribute('class') || '').replace(/ drawing/g, ''));
    const target = cards.get(record.event.to);
    if (target) {
      target.root.classList.remove('awaiting');
      // A report docks on the card it reached: a short flash of its ring, opacity only. A task arriving does not flash it (review of PR 72): the card
      // waking up says that.
      if (arrived && record.event.kind === 'report' && motion() && target.dock.animate) target.dock.animate([{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: 450 });
    }
    pump();
  }

  function stopPulse(record) { if (record.animation && record.animation.cancel) record.animation.cancel(); finish(record, false); }
  function cancelAll() {
    queue = [];
    for (const record of [...active]) stopPulse(record);
    for (const card of cards.values()) card.root.classList.remove('awaiting');
  }

  // ---------- the card that opens ----------

  function openDetail(id) {
    openId = id;
    excerpt = undefined;
    const item = node(id);
    vscode.postMessage(item && item.agentId ? { type: 'open-card', agentId: item.agentId } : { type: 'open-card' });
    renderDetail();
  }
  function closeDetail() {
    const back = openId;
    openId = undefined;
    excerpt = undefined;
    $('card').hidden = true;
    vscode.postMessage({ type: 'open-card' });
    if (back && cards.get(back)) cards.get(back).root.focus();
  }

  function renderDetail() {
    const box = $('card');
    const item = node(openId);
    if (!item) { box.hidden = true; return; }
    box.hidden = false;
    const head = el('div', 'card-head');
    head.append(el('h2', '', item.name + (item.role && item.kind !== 'lead' ? ' · ' + item.role : '')));
    const close = el('button', 'secondary', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    head.append(close);
    const parts = [head, el('p', 'card-state state-' + item.state, item.word + (item.activity && item.state !== 'bench' ? ' · ' + item.activity : ''))];
    if (item.card) {
      if (item.card.purpose) parts.push(el('p', '', item.card.purpose));
      if (item.card.capabilities && item.card.capabilities.length) parts.push(el('p', 'hint', 'Can: ' + item.card.capabilities.join(', ')));
    }
    if (item.state !== 'bench') {
      const facts = el('dl', 'facts');
      const fact = (label, value) => { if (value === undefined || value === '') return; facts.append(el('dt', '', label), el('dd', '', String(value))); };
      fact('Task', item.task);
      fact('Model', item.model ? item.model + (item.privacy ? ' (' + item.privacy + ')' : '') : undefined);
      fact('Time', item.since ? duration((item.endedAt || now()) - item.since) : undefined);
      fact('Turns', item.turns);
      fact('Tool calls', item.toolCalls);
      fact('Approvals', item.approvalsAsked ? item.approvalsAsked + ' asked' + (item.approvalsDeclined ? ', ' + item.approvalsDeclined + ' declined' : '') : undefined);
      fact('Cost so far', item.costUsd ? '$' + item.costUsd.toFixed(4) : undefined);
      fact('Tasks', item.count > 1 ? item.tally : undefined);
      parts.push(facts);
      if (item.instances.length > 1) {
        const list = el('ul', 'instances');
        for (const one of item.instances) list.append(el('li', 'state-' + one.state, (one.task || 'A task') + ': ' + one.state.replace('-', ' ')));
        parts.push(list);
      }
    } else parts.push(el('p', 'hint', 'Not asked to do anything in this run yet.'));
    const running = item.agentId && !TERMINAL.includes(item.state) && item.state !== 'bench' && !restored;
    if (running) {
      const controls = el('div', 'controls');
      const control = (label, action) => { const button = el('button', 'secondary', label); button.type = 'button'; button.addEventListener('click', () => vscode.postMessage({ type: 'agent-control', agentId: item.agentId, action })); return button; };
      if (item.kind !== 'lead') controls.append(item.state === 'paused' ? control('Resume', 'resume') : control('Pause', 'pause'));
      controls.append(control(item.kind === 'lead' ? 'Stop the run' : 'Stop', 'stop'));
      parts.push(controls);
    }
    if (item.agentId && !restored) {
      const activity = el('button', 'link', 'Show in Agent Activity');
      activity.type = 'button';
      activity.addEventListener('click', () => vscode.postMessage({ type: 'open-activity', agentId: item.agentId }));
      parts.push(activity);
    }
    if (excerpt && excerpt.agentId === item.agentId && excerpt.text) {
      parts.push(el('h3', '', 'End of its latest reply'), el('p', 'excerpt', excerpt.text));
    }
    box.replaceChildren(...parts);
  }

  // ---------- keyboard: the tree pattern ----------

  function focusCard(id) {
    if (!cards.has(id)) return;
    for (const [other, card] of cards) card.root.tabIndex = other === id ? 0 : -1;
    focusId = id;
    cards.get(id).root.focus();
  }
  function onKey(event, id) {
    if (!view) return;
    const order = view.order.map((entry) => entry.id);
    const at = order.indexOf(id);
    const item = node(id);
    let next;
    if (event.key === 'ArrowDown') next = order[at + 1];
    else if (event.key === 'ArrowUp') next = order[at - 1];
    else if (event.key === 'ArrowRight') next = (view.nodes.find((candidate) => candidate.parent === id) || {}).id;
    else if (event.key === 'ArrowLeft') next = item && item.parent;
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    else if (event.key === 'Enter' || event.key === ' ') { if (event.preventDefault) event.preventDefault(); openDetail(id); return; }
    else if (event.key === 'Escape') { if (openId) { if (event.preventDefault) event.preventDefault(); closeDetail(); } return; }
    else return;
    if (event.preventDefault) event.preventDefault();
    if (next) focusCard(next);
  }
  $('card').addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });

  // ---------- words ----------

  /** Discrete changes only, gathered for a second so a burst is one announcement. */
  function say(text) {
    if (!text) return;
    announced.push(text);
    if (announceTimer) return;
    announceTimer = setTimeout(() => { announceTimer = undefined; $('announce').textContent = announced.join(' '); announced = []; }, 400);
  }

  function stopClock() { if (clock) { clearInterval(clock); clock = undefined; } }

  function tick() {
    if (!view) { stopClock(); return; }
    const at = now();
    let running = false;
    for (const item of view.nodes) {
      const card = cards.get(item.id);
      if (!card) continue;
      const ended = TERMINAL.includes(item.state) || restored;
      if (item.since && item.state !== 'bench' && item.state !== 'queued') setText(card.elapsed, duration((item.endedAt || (ended ? item.since : at)) - item.since));
      else setText(card.elapsed, '');
      if (!ended && item.state !== 'bench') running = true;
    }
    if (!running) stopClock();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'layout-probe' && window.nearAiLayoutProbe) { vscode.postMessage(window.nearAiLayoutProbe()); return; }
    if (message.type === 'team-live') render(message);
  });
  // The page going away (closed, or unloaded while hidden) leaves no clock or pending announcement behind.
  window.addEventListener('pagehide', () => { stopClock(); if (announceTimer) { clearTimeout(announceTimer); announceTimer = undefined; } cancelAll(); });
  applyToggles();
  vscode.postMessage({ type: 'ready' });
})();

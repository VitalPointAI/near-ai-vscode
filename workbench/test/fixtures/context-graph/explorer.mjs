const byId = id => document.getElementById(id);
const canvas = byId('graph');
const context = canvas.getContext('2d', { alpha: true });
const search = byId('search');
const status = byId('status');
const details = byId('details');
const panel = details.parentElement;
const mediaMotion = matchMedia('(prefers-reduced-motion: reduce)');
const themes = [matchMedia('(prefers-color-scheme: dark)'), matchMedia('(forced-colors: active)')];
const empty = { entities: [], edges: [], counts: { entities: 0, edges: 0 } };
const relationId = ({ from, to }) => `${from}→${to}`;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = value => Math.round(value * 1000) / 1000 || 0;
const interpolate = (from, to, amount) => from + (to - from) * amount;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const camera = { x: 0, y: 0, scale: 1 };
const positions = new Map();
const animations = new Map();
let updatedItems = new Set();
const frames = [];
const announcements = [];
let graph = empty;
let generation = 1;
let revision = 0;
let pending;
let selected = null;
let initiator;
let sourceSequence = 0;
let displayedSource;
let view = 'graph';
let listSignature;
let paused = false;
let controlledTime;
let raf;
let updatedUntil = 0;
let palette;
let size = { width: 0, height: 0, ratio: 1 };
let drag;
let fitRequested = false;
let visible = { nodes: [], edges: [] };
let painted = { nodes: [], edges: [] };
const clock = () => controlledTime ?? performance.now();
const motion = () => !paused && !mediaMotion.matches;

function element(tag, text) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
}

function cameraPosition(at) {
  return [size.width / 2 + camera.x + at[0] * camera.scale, size.height / 2 + camera.y + at[1] * camera.scale];
}

function refreshColors() {
  const root = getComputedStyle(canvas);
  palette = {
    base: root.backgroundColor,
    text: root.color,
    accent: getComputedStyle(byId('updated')).color,
    edge: getComputedStyle(byId('counts')).color,
  };
}

function updateSize() {
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
  const next = { width: canvas.clientWidth, height: canvas.clientHeight, ratio: devicePixelRatio };
  if (equal(size, next)) return;
  size = next;
  canvas.width = size.width * size.ratio;
  canvas.height = size.height * size.ratio;
  if (revision) paint(clock());
}

function neighborOf(id, data) {
  return data.edges.map(({ from, to }) => from === id ? to : to === id ? from : undefined)
    .find(neighbor => positions.has(neighbor));
}

function placeNodes(data) {
  const count = new Map(data.entities.map(({ id }) => [id, 0]));
  for (const { from, to } of data.edges) {
    count.set(from, count.get(from) + 1);
    count.set(to, count.get(to) + 1);
  }
  const ordered = [...data.entities].sort((a, b) => count.get(b.id) - count.get(a.id));
  for (const [index, { id }] of ordered.entries()) {
    if (positions.has(id)) continue;
    const neighbor = positions.get(neighborOf(id, data));
    if (!positions.size) {
      positions.set(id, [0, 0]);
    } else if (ordered.length > 40) {
      positions.set(id, [(index % 14 - 6.5) * 66, (Math.floor(index / 14) - 7) * 55]);
    } else {
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      let radius = neighbor ? 128 : 178;
      let at;
      do {
        at = [(neighbor?.[0] ?? 0) + radius * Math.cos(angle), (neighbor?.[1] ?? 0) + radius * Math.sin(angle)];
        radius += 67;
      } while ([...positions.values()].some(([x, y]) => Math.hypot(x - at[0], y - at[1]) < 70));
      positions.set(id, at);
    }
  }
}

function filterGraph() {
  const term = search.value.trim().toLocaleLowerCase();
  const matching = new Set(graph.entities.filter(entity => entity.names.some(name => name.toLocaleLowerCase().includes(term)))
    .map(({ id }) => id));
  const edges = graph.edges.filter(({ from, to }) => matching.has(from) || matching.has(to));
  const linked = new Set(edges.flatMap(({ from, to }) => [from, to]));
  const nodes = graph.entities.filter(({ id }) => matching.has(id) || linked.has(id));
  visible = { nodes, edges };
  byId('counts').textContent = [
    `${nodes.length} ${nodes.length === 1 ? 'entity' : 'entities'}`,
    `${edges.length} ${edges.length === 1 ? 'relationship' : 'relationships'}`,
  ].join(' · ');
}

function selectionTitle(entity, relation) {
  if (entity) return entity.names.join(' · ');
  if (relation) {
    const nameOf = id => graph.entities.find(item => item.id === id)?.names[0];
    return `${nameOf(relation.from)} to ${nameOf(relation.to)}`;
  }
}

function addRow(fragment, id, label) {
  const line = element('li');
  const button = element('button', label);
  button.type = 'button';
  button.dataset.key = id;
  button.setAttribute('aria-pressed', String(selected === id));
  line.append(button);
  fragment.append(line);
}

function listRows(invalidate = false) {
  if (view !== 'list') {
    if (invalidate) {
      byId('entities').replaceChildren();
      byId('relationships').replaceChildren();
      listSignature = undefined;
    }
    return;
  }
  const labels = new Map(visible.nodes.map(({ id, names }) => [id, names]));
  const signature = JSON.stringify([visible.nodes, visible.edges.map(({ from, to }) => [from, to])]);
  if (listSignature === signature) return;
  listSignature = signature;
  const oldFocus = document.activeElement.closest('button[data-key]')?.dataset.key;
  const entityRows = document.createDocumentFragment();
  const edgeRows = document.createDocumentFragment();
  for (const { id, names } of visible.nodes) addRow(entityRows, id, names.join(' · '));
  for (const edge of visible.edges) {
    addRow(edgeRows, relationId(edge), `${labels.get(edge.from)[0]} to ${labels.get(edge.to)[0]}`);
  }
  if (!visible.nodes.length) entityRows.append(element('li', 'No matching entities'));
  if (!visible.edges.length) edgeRows.append(element('li', 'No connections in this view'));
  byId('entities').replaceChildren(entityRows);
  byId('relationships').replaceChildren(edgeRows);
  if (oldFocus) (rowFor(oldFocus) ?? search).focus();
}

function rowFor(key) {
  return [...byId('list-surface').querySelectorAll('button[data-key]')].find(row => row.dataset.key === key);
}

function citationsFor(id, data = graph) {
  const edge = data.edges.find(item => relationId(item) === id);
  if (edge) return edge.evidence;
  const linked = data.edges.filter(({ from, to }) => from === id || to === id);
  return linked.flatMap(item => item.evidence).filter((citation, index, all) =>
    all.findIndex(other => equal(citation, other)) === index);
}

function showSourceResult() {
  details.querySelector('[data-source-result]')?.remove();
  if (!displayedSource) return;
  const result = displayedSource.result;
  const found = result?.status === 'found';
  const message = element(found ? 'blockquote' : 'p', found ? result.text : 'Source unavailable');
  message.dataset.sourceResult = '';
  details.append(message);
}

function inspector() {
  const entity = graph.entities.find(({ id }) => id === selected);
  const relation = graph.edges.find(edge => relationId(edge) === selected);
  const actionName = action => action.getAttribute('aria-label') ?? action.textContent;
  const focused = document.activeElement;
  const focusName = details.contains(focused) && focused.matches('button') ? actionName(focused) : undefined;
  const scroll = panel.scrollTop;
  const close = byId('close-inspector');
  close.hidden = !(entity || relation);
  details.replaceChildren();
  if (!entity && !relation) {
    displayedSource = undefined;
    details.append(element('h3', 'Choose an entity'), element('p', 'Select an entity or a relationship to inspect its sources.'));
    return;
  }
  details.append(element('h3', selectionTitle(entity, relation)));
  if (entity) {
    const expand = element('button', 'Expand neighborhood');
    expand.type = 'button';
    expand.addEventListener('click', () => {
      search.value = '';
      const ids = new Set([entity.id]);
      for (const { from, to } of graph.edges) {
        if (from === entity.id) ids.add(to);
        if (to === entity.id) ids.add(from);
      }
      changeFilter();
      fit([...ids].map(id => positions.get(id)));
    });
    details.append(expand);
  }

  const sources = citationsFor(selected);
  if (displayedSource && !sources.some(citation => equal(citation, displayedSource.citation))) {
    displayedSource = undefined;
  }
  if (!sources.length) {
    details.append(element('p', 'No connections in this view'));
  } else {
    const list = element('ul');
    for (const citation of sources) {
      const row = element('li');
      row.className = 'source-row';
      const meta = `${citation.sourceId} ${citation.version} ${citation.start}–${citation.end}`;
      const opener = element('button', 'Open source');
      opener.type = 'button';
      opener.setAttribute('aria-label', `Open source ${meta}`);
      opener.addEventListener('click', async () => {
        const request = ++sourceSequence;
        const selectedAtRequest = selected;
        const reference = [citation.sourceId, citation.version, citation.start, citation.end].join(':');
        const result = await globalThis.fixtureOpenSource?.(reference).catch(() => undefined);
        if (request !== sourceSequence || selected !== selectedAtRequest ||
            !citationsFor(selected).some(current => equal(current, citation))) return;
        displayedSource = { citation, result };
        showSourceResult();
      });
      row.append(element('span', meta), opener);
      list.append(row);
    }
    details.append(list);
    showSourceResult();
  }
  if (focusName) {
    const action = [...details.querySelectorAll('button')].find(button => actionName(button) === focusName);
    (action ?? close).focus({ preventScroll: true });
  }
  panel.scrollTop = scroll;
}

function choose(key, trigger) {
  if (key === selected) return;
  const previous = rowFor(selected);
  previous?.setAttribute('aria-pressed', 'false');
  selected = key;
  initiator = trigger;
  rowFor(key)?.setAttribute('aria-pressed', 'true');
  sourceSequence += 1;
  displayedSource = undefined;
  inspector();
  paint(clock());
}

function fitCamera(points) {
  if (!points.length || !size.width) return;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  camera.scale = clamp(Math.min((size.width - 100) / (maxX - minX || 1), (size.height - 100) / (maxY - minY || 1)), 0.3, 1.5);
  camera.x = -(maxX + minX) * camera.scale / 2;
  camera.y = -(maxY + minY) * camera.scale / 2;
}

function fit(points = visible.nodes.map(({ id }) => positions.get(id))) {
  fitCamera(points);
  paint(clock());
}

function changeFilter() {
  filterGraph();
  listRows();
  paint(clock());
}

function changeView(next) {
  if (view === next) return;
  view = next;
  byId('graph-surface').hidden = next !== 'graph';
  byId('list-surface').hidden = next !== 'list';
  byId('show-graph').setAttribute('aria-pressed', String(next === 'graph'));
  byId('show-list').setAttribute('aria-pressed', String(next === 'list'));
  listRows();
  updateSize();
  paint(clock());
}

function removedEvidence(previous, next) {
  const names = new Map(next.entities.map(entity => [entity.id, entity.names]));
  const edges = new Map(next.edges.map(edge => [relationId(edge), new Set(edge.evidence.map(item => JSON.stringify(item)))]));
  return previous.entities.some(({ id, names: before }) => before.some(name => !names.get(id)?.includes(name))) ||
    previous.edges.some(edge => edge.evidence.some(item => !edges.get(relationId(edge))?.has(JSON.stringify(item))));
}

function showGraph(next, at, { reset = false, decorate = false, urgent = false } = {}) {
  const formerNodes = new Map(graph.entities.map(item => [item.id, item]));
  const formerEdges = new Map(graph.edges.map(item => [relationId(item), item]));
  const formerSources = citationsFor(selected);
  const formerTitle = selectionTitle(formerNodes.get(selected), formerEdges.get(selected));
  if (reset) {
    positions.clear();
    animations.clear();
    frames.length = 0;
    announcements.length = 0;
    status.textContent = '';
    renderSearchNotices([]);
    updatedUntil = 0;
    updatedItems.clear();
  }
  graph = next;
  placeNodes(graph);
  if (urgent) {
    sourceSequence += 1;
    if (!graph.entities.some(node => node.id === selected) && !graph.edges.some(edge => relationId(edge) === selected)) {
      const inspectorFocused = details.contains(document.activeElement) || document.activeElement === byId('close-inspector');
      selected = null;
      initiator = undefined;
      if (inspectorFocused) search.focus();
    }
  }
  const cues = new Set();
  if (decorate) {
    for (const item of graph.edges) {
      const id = relationId(item);
      const before = formerEdges.get(id);
      if (!equal(before?.evidence, item.evidence)) {
        cues.add(id);
        cues.add(item.from);
        cues.add(item.to);
      }
    }
    for (const { id, names } of graph.entities) {
      if (!equal(formerNodes.get(id)?.names, names)) cues.add(id);
    }
    if (motion() && cues.size <= 12) {
      for (const id of cues) {
        const newNode = !formerNodes.has(id) && positions.has(id);
        const neighbor = newNode && neighborOf(id, graph);
        const from = positions.get(neighbor);
        const next = positions.get(id);
        animations.set(id, { start: at, newNode, newEdge: !formerEdges.has(id) && !next,
          from: from && next && [interpolate(from[0], next[0], 0.16), interpolate(from[1], next[1], 0.16)] });
      }
    }
    if (cues.size) {
      status.textContent = 'Graph updated';
      announcements.push(status.textContent);
      if (announcements.length > 128) announcements.shift();
      updatedItems = new Set(cues);
      if (!motion() || cues.size > 12) cues.clear();
      updatedUntil = at + 700;
    }
  }
  filterGraph();
  listRows(urgent);
  const newTitle = selectionTitle(graph.entities.find(node => node.id === selected),
    graph.edges.find(edge => relationId(edge) === selected));
  if (urgent || formerTitle !== newTitle || !equal(formerSources, citationsFor(selected))) inspector();
  if (reset) {
    camera.x = 0;
    camera.y = 0;
    camera.scale = 1;
    fitCamera(visible.nodes.map(({ id }) => positions.get(id)));
  }
  paint(at, [...cues]);
}

function paint(at, cues = []) {
  for (const [key, { start }] of animations) {
    if (at - start >= 440) animations.delete(key);
  }
  function easing(progress) {
    const bounded = clamp(progress, 0, 1);
    return 1 - (1 - bounded) ** 3;
  }
  const updated = at < updatedUntil;
  if (byId('updated').hidden === updated) byId('updated').hidden = !updated;
  if (!updated) updatedItems.clear();
  const entityPaint = visible.nodes.map(({ id, names }) => {
    const [x, y] = positions.get(id);
    const animation = animations.get(id);
    const elapsed = animation ? at - animation.start : 440;
    const progress = easing(elapsed / 260);
    return {
      id, name: names[0],
      at: animation?.from ? [round(interpolate(animation.from[0], x, progress)), round(interpolate(animation.from[1], y, progress))] : [round(x), round(y)],
      opacity: animation?.newNode ? round(clamp(elapsed / 180, 0, 1)) : 1,
      halo: animation ? round(1 - clamp(elapsed / 440, 0, 1)) : 0,
    };
  });
  const edgePaint = visible.edges.map(edge => {
    const id = relationId(edge);
    const animation = animations.get(id);
    const elapsed = animation ? at - animation.start : 440;
    return { id, from: edge.from, to: edge.to,
      fraction: animation?.newEdge ? round(easing(elapsed / 280)) : 1,
      halo: animation ? round(1 - clamp(elapsed / 440, 0, 1)) : 0 };
  });
  painted = { nodes: entityPaint, edges: edgePaint };
  if (view === 'graph' && palette) draw(entityPaint, edgePaint, updated && animations.size === 0);
  frames.push({ at: round(at), cues, nodes: entityPaint.length, edges: edgePaint.length });
  if (frames.length > 128) frames.shift();
}

function draw(nodes, edges, staticUpdates) {
  const { width, height, ratio } = size;
  if (!width || !height) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const visuals = new Map(nodes.map(node => [node.id, { ...node, anchor: cameraPosition(node.at), radius: node.id === selected ? 13 : 9 }]));
  const selectedRelation = edges.find(item => item.id === selected);
  const cue = palette.accent;
  for (const edge of edges) {
    const beginning = visuals.get(edge.from);
    const ending = visuals.get(edge.to);
    const [x1, y1] = beginning.anchor;
    const [x2, y2] = ending.anchor;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const start = [x1 + Math.cos(angle) * (beginning.radius + 3), y1 + Math.sin(angle) * (beginning.radius + 3)];
    const end = [x2 - Math.cos(angle) * (ending.radius + 4), y2 - Math.sin(angle) * (ending.radius + 4)];
    const tip = [interpolate(start[0], end[0], edge.fraction), interpolate(start[1], end[1], edge.fraction)];
    if (edge.fraction === 0) continue;
    const highlighted = edge.id === selected || (staticUpdates && updatedItems.has(edge.id));
    context.strokeStyle = edge.halo || highlighted ? cue : palette.edge;
    context.globalAlpha = Math.min(1, 0.65 + edge.halo + (highlighted ? 0.3 : 0));
    context.lineWidth = highlighted ? 2.5 : 1.35 + edge.halo;
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...tip);
    if (edge.fraction >= 0.92) {
      for (const direction of [-1, 1]) {
        context.moveTo(...tip);
        context.lineTo(tip[0] - 8 * Math.cos(angle + direction * 0.45), tip[1] - 8 * Math.sin(angle + direction * 0.45));
      }
    }
    context.stroke();
  }
  context.font = '12px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const node of visuals.values()) {
    const [x, y] = node.anchor;
    const prominent = node.id === selected || node.id === selectedRelation?.from || node.id === selectedRelation?.to;
    if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue;
    if (node.halo) {
      context.globalAlpha = Math.min(node.opacity, node.halo * 0.48);
      context.strokeStyle = cue;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(x, y, node.radius + 4 + (1 - node.halo) * 14, 0, Math.PI * 2);
      context.stroke();
    }
    context.globalAlpha = node.opacity;
    context.fillStyle = prominent || (staticUpdates && updatedItems.has(node.id)) ? cue : palette.base;
    context.strokeStyle = cue;
    context.lineWidth = prominent ? 2.5 : 1.5;
    context.beginPath();
    context.arc(x, y, node.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    if (nodes.length <= 40 || prominent) {
      const label = node.name.length > 28 ? `${node.name.slice(0, 27)}…` : node.name;
      context.lineWidth = 4;
      context.strokeStyle = palette.base;
      context.strokeText(label, x, y + node.radius + 14);
      context.fillStyle = palette.text;
      context.fillText(label, x, y + node.radius + 14);
    }
  }
  context.globalAlpha = 1;
}

function step(at) {
  if (!motion()) settleMotion();
  if (pending && at >= pending.at) {
    const next = pending.graph;
    const start = pending.at;
    pending = undefined;
    showGraph(next, start, { decorate: true });
    if (at === start) return;
  }
  if (animations.size || (updatedUntil && at >= updatedUntil && !byId('updated').hidden)) paint(at);
}

function schedule() {
  if (controlledTime !== undefined || raf !== undefined) return;
  if (!pending && !animations.size && (updatedUntil <= 0 || byId('updated').hidden)) return;
  raf = requestAnimationFrame(at => {
    raf = undefined;
    step(at);
    schedule();
  });
}

function settleMotion() {
  if (motion()) return;
  if (animations.size) {
    animations.clear();
    paint(clock());
  }
}

function accept(message) {
  const { kind, graph: next, generation: inputGeneration, revision: inputRevision } = message;
  if (!['snapshot', 'delta', 'scope'].includes(kind) || !Number.isSafeInteger(inputGeneration) ||
      !Number.isSafeInteger(inputRevision) || inputRevision < 1) return false;
  const newScope = kind === 'scope';
  if (newScope ? inputGeneration <= generation : inputGeneration !== generation || inputRevision <= revision) return false;
  const reset = newScope || !revision;
  generation = inputGeneration;
  revision = inputRevision;
  const previous = pending?.graph ?? graph;
  if (reset || removedEvidence(previous, next)) {
    pending = undefined;
    showGraph(next, clock(), { reset: true, urgent: true });
  } else if (!equal(previous, next)) {
    pending = { graph: next, at: pending?.at ?? clock() + 160 };
    schedule();
  }
  return true;
}

function changeZoom(multiplier) {
  camera.scale = Math.round(clamp(camera.scale * multiplier, 0.3, 3) * 1000) / 1000;
  paint(clock());
}

function nearest(x, y) {
  const hit = painted.nodes.findLast(node => {
    const [nx, ny] = cameraPosition(node.at);
    return Math.hypot(nx - x, ny - y) <= 17;
  });
  if (hit) return hit.id;
  return painted.edges.find(edge => {
    const near = id => cameraPosition(painted.nodes.find(item => item.id === id).at);
    const [x1, y1] = near(edge.from);
    const [x2, y2] = near(edge.to);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const position = clamp(((x - x1) * dx + (y - y1) * dy) / (dx ** 2 + dy ** 2), 0, edge.fraction);
    return edge.fraction > 0 && Math.hypot(x - x1 - position * dx, y - y1 - position * dy) < 10;
  })?.id;
}

canvas.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  const area = canvas.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: area.x, offsetY: area.y, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (dx === 0 && dy === 0) return;
  drag.moved = true;
  drag.x = event.clientX;
  drag.y = event.clientY;
  camera.x += dx;
  camera.y += dy;
  paint(clock());
});
function finishDrag(event) {
  if (drag?.id !== event.pointerId) return;
  if (!drag.moved && event.type === 'pointerup') {
    const hit = nearest(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    if (hit) choose(hit, canvas);
  }
  drag = undefined;
  if (fitRequested) { fitRequested = false; fit(); }
}
canvas.addEventListener('pointerup', finishDrag);
canvas.addEventListener('pointercancel', finishDrag);
canvas.addEventListener('keydown', event => {
  const direction = { ArrowLeft: [-26, 0], ArrowRight: [26, 0], ArrowUp: [0, -26], ArrowDown: [0, 26] }[event.key];
  if (direction) {
    event.preventDefault();
    camera.x += direction[0];
    camera.y += direction[1];
    paint(clock());
  } else if (event.key === '+' || event.key === '-') {
    event.preventDefault();
    changeZoom(event.key === '+' ? 1.2 : 1 / 1.2);
  }
});
byId('show-graph').addEventListener('click', () => changeView('graph'));
byId('show-list').addEventListener('click', () => changeView('list'));
byId('fit').addEventListener('click', () => {
  if (drag) fitRequested = true;
  else fit();
});
for (const id of ['zoom-in', 'narrow-zoom-in']) byId(id).addEventListener('click', () => changeZoom(1.2));
for (const id of ['zoom-out', 'narrow-zoom-out']) byId(id).addEventListener('click', () => changeZoom(1 / 1.2));
byId('motion').addEventListener('click', event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? 'Resume motion' : 'Pause motion';
  settleMotion();
});
mediaMotion.addEventListener('change', settleMotion);
for (const theme of themes) theme.addEventListener('change', () => { refreshColors(); paint(clock()); });
search.addEventListener('input', changeFilter);
byId('list-surface').addEventListener('click', event => {
  const row = event.target.closest('button[data-key]');
  if (row) choose(row.dataset.key, row);
});
byId('close-inspector').addEventListener('click', () => {
  const currentTarget = view === 'graph' ? canvas : rowFor(selected);
  const target = [initiator, currentTarget, search].find(candidate => candidate?.checkVisibility());
  choose(null);
  target?.focus();
});

refreshColors();
updateSize();
new ResizeObserver(updateSize).observe(canvas);

function renderSearchNotices(notices) {
  const surface = byId('search-notices');
  surface.replaceChildren(...notices.map(notice => element('p', notice)));
  surface.hidden = notices.length === 0;
}

// The fixture binds this to a deterministic, reader-relative Playwright host.
// No browser request can access the corpus or install a connector.
globalThis.graphFixture = Object.freeze({
  accept,
  searchNotices(notices, inputGeneration) {
    if (!revision || inputGeneration !== generation) return false;
    renderSearchNotices(notices);
    return true;
  },
  advance(at) {
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = undefined;
    controlledTime = at;
    step(at);
  },
  inspect() {
    return { ...painted, active: [...animations.keys()], camera: { ...camera }, selected,
      frames: [...frames], announcements: [...announcements] };
  },
});

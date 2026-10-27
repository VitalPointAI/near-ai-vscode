// Agent Activity page: renders the host's snapshot and batched updates. All agent content is set
// with textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const stream = $('stream');
  const agentsBody = $('agents').querySelector('tbody');
  const filterAgent = $('filter-agent');
  const search = $('search');
  const follow = $('follow');
  const MAX_ROWS = 1500;
  const COLLAPSE_LINES = 14;
  const KIND_LABEL = { system: 'System prompt', prompt: 'Prompt', text: 'Reply', reasoning: 'Reasoning', tool: 'Tool', retry: 'Retry', notice: 'Notice', security: 'Security', 'agent-start': 'Started', 'agent-end': 'Finished' };
  const rows = new Map();
  const names = new Map();
  const pauseButton = $('pause');
  const live = $('live');
  // While paused the stream does not change: new and updated entries wait here, latest per entry.
  const held = new Map();
  let paused = false;
  let stats = [];

  const hue = (id) => { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash % 360; };
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const number = (value) => Math.round(value).toLocaleString();
  const money = (value) => value > 0 && value < 0.0001 ? '<$0.0001' : '$' + value.toFixed(value < 1 ? 4 : 2);
  const duration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

  function block(label, text) {
    const wrap = el('div', 'block');
    if (label) wrap.append(el('div', 'block-label', label));
    const pre = el('pre', 'body', text);
    wrap.append(pre);
    if (text.split('\n').length > COLLAPSE_LINES || text.length > 2400) {
      pre.classList.add('collapsed');
      const toggle = el('button', 'link', 'Show all');
      toggle.type = 'button';
      toggle.addEventListener('click', () => { const collapsed = pre.classList.toggle('collapsed'); toggle.textContent = collapsed ? 'Show all' : 'Show less'; });
      wrap.append(toggle);
    }
    return wrap;
  }

  function render(entry) {
    let row = rows.get(entry.seq);
    const fresh = !row;
    if (!row) { row = el('li', 'entry'); rows.set(entry.seq, row); }
    row.className = 'entry kind-' + entry.kind + (entry.ok === false ? ' failed' : '');
    row.dataset.kind = entry.kind === 'retry' || entry.kind === 'notice' || entry.kind === 'agent-start' || entry.kind === 'agent-end' ? 'event' : entry.kind;
    row.dataset.agent = entry.agentId;
    row.style.setProperty('--hue', String(hue(entry.agentId)));
    const meta = el('div', 'meta');
    meta.append(el('time', 'when', time(entry.at)), el('span', 'agent', entry.agent), el('span', 'kind', KIND_LABEL[entry.kind] || entry.kind));
    if (entry.title && entry.kind !== 'prompt' && entry.kind !== 'system') meta.append(el('span', 'title', entry.title));
    if (entry.kind === 'tool') meta.append(el('span', 'state', entry.ok === undefined ? 'running…' : (entry.ok ? 'done' : 'failed') + (entry.ms !== undefined ? ' · ' + duration(entry.ms) : '')));
    const parts = [meta];
    if (entry.input) parts.push(block('Input', entry.input));
    if (entry.text) parts.push(block(entry.kind === 'tool' ? 'Result' : '', entry.text));
    row.replaceChildren(...parts);
    row.dataset.search = ((entry.title || '') + '\n' + (entry.input || '') + '\n' + (entry.text || '') + '\n' + entry.agent).toLowerCase();
    applyFilter(row);
    if (fresh) {
      stream.append(row);
      while (stream.children.length > MAX_ROWS) { const first = stream.firstElementChild; rows.forEach((value, key) => { if (value === first) rows.delete(key); }); first.remove(); }
    }
  }

  function applyFilter(row) {
    const kind = row.dataset.kind;
    const box = document.querySelector('input[data-kind="' + kind + '"]');
    const query = search.value.trim().toLowerCase();
    row.hidden = (box && !box.checked) || (filterAgent.value && row.dataset.agent !== filterAgent.value) || (query && !row.dataset.search.includes(query));
  }

  function securityParts(stat) {
    return [[stat.injections, 'injection', 'injections'], [stat.hiddenRemoved, 'hidden removal', 'hidden removals'], [stat.held, 'held', 'held'], [stat.blocked, 'blocked', 'blocked']].filter(([count]) => count).map(([count, one, many]) => count + ' ' + (count === 1 ? one : many));
  }
  function securityCell(stat) {
    const parts = securityParts(stat);
    const cell = el('td', parts.length ? 'security-cell flagged' : 'security-cell', parts.length ? parts.join(' · ') : '–');
    if (stat.injections) cell.title = 'Possible prompt injections were found in outside content this agent read; they were fenced and flagged, not followed.';
    return cell;
  }

  function renderStats(usage) {
    stats = stats.sort((a, b) => a.startedAt - b.startedAt);
    $('empty-agents').hidden = stats.length > 0;
    const now = Date.now();
    agentsBody.replaceChildren(...stats.map((stat) => {
      const tr = el('tr', 'status-' + stat.status);
      tr.style.setProperty('--hue', String(hue(stat.agentId)));
      const speed = stat.modelMs > 0 ? stat.outputTokens / (stat.modelMs / 1000) : 0;
      const name = el('td', 'agent-cell');
      name.append(el('span', 'dot'), el('span', '', (stat.parentId ? '↳ ' : '') + stat.agent));
      tr.append(name, el('td', 'model', stat.model), el('td', 'status', stat.status === 'max-turns' ? 'turn limit' : stat.status),
        el('td', 'num', number(stat.turns)), el('td', 'num', number(stat.inputTokens)), el('td', 'num', stat.inputTokens ? Math.round((100 * (stat.cachedTokens || 0)) / stat.inputTokens) + '%' : '–'), el('td', 'num', number(stat.outputTokens)), el('td', 'num', speed ? speed.toFixed(1) : '–'),
        el('td', 'num', money(stat.costUsd)), el('td', 'num', number(stat.toolCalls) + (stat.toolErrors ? ' (' + stat.toolErrors + ' failed)' : '')), el('td', 'num', number(stat.retries)), securityCell(stat),
        el('td', 'num', duration((stat.endedAt || now) - stat.startedAt)));
      return tr;
    }));
    const running = stats.filter((stat) => stat.status === 'running').length;
    const sum = (key) => stats.reduce((total, stat) => total + stat[key], 0);
    const totals = [['Agents', running ? running + ' running / ' + stats.length : String(stats.length)], ['Tokens in', number(sum('inputTokens')) + (sum('inputTokens') ? ' (' + Math.round((100 * sum('cachedTokens')) / sum('inputTokens')) + '% cached)' : '')], ['Tokens out', number(sum('outputTokens'))], ['Est. cost', money(sum('costUsd'))], ['Tool calls', number(sum('toolCalls')) + (sum('toolErrors') ? ' (' + sum('toolErrors') + ' failed)' : '')], ['Retries', number(sum('retries'))], ['Security', [sum('injections') + ' injection' + (sum('injections') === 1 ? '' : 's') + ' flagged', sum('hiddenRemoved') + ' hidden removed', sum('held') + ' held', sum('blocked') + ' blocked'].join(' · ')]];
    $('totals').replaceChildren(...totals.flatMap(([label, value]) => { const wrap = el('div', 'total'); wrap.append(el('dt', '', label), el('dd', '', value)); return [wrap]; }));
    const seen = new Set();
    for (const stat of stats) { seen.add(stat.agentId); if (!names.has(stat.agentId)) { names.set(stat.agentId, stat.agent); const option = el('option', '', stat.agent + ' · ' + stat.agentId.slice(-6)); option.value = stat.agentId; filterAgent.append(option); } }
    if (usage) $('usage').textContent = 'Keeping ' + number(usage.entries) + ' entries (' + (usage.bytes / 1048576).toFixed(1) + ' of ' + Math.round(usage.limits.maxBytes / 1048576) + ' MB) from the last ' + Math.round(usage.limits.maxAgeMs / 60000) + ' minutes, in memory only. Older entries are dropped; agent totals are kept.';
  }

  function scrollIfFollowing() { if (follow.checked && !paused) window.scrollTo(0, document.body.scrollHeight); }

  function showPauseState() {
    pauseButton.textContent = paused ? 'Resume' + (held.size ? ' (' + number(held.size) + ' new)' : '') : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
    live.textContent = paused ? 'Paused' : 'Live';
    live.classList.toggle('paused', paused);
  }

  function setPaused(value) {
    paused = value;
    if (!paused) {
      [...held.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ROWS).forEach(render);
      held.clear();
      scrollIfFollowing();
    }
    showPauseState();
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'snapshot') { rows.clear(); held.clear(); stream.replaceChildren(); (message.entries || []).forEach(render); }
    if (message.type === 'cleared') { rows.clear(); held.clear(); stream.replaceChildren(); showPauseState(); }
    if (message.type === 'entries') {
      if (paused) { for (const entry of message.entries || []) held.set(entry.seq, entry); while (held.size > 5 * MAX_ROWS) held.delete(held.keys().next().value); showPauseState(); }
      else (message.entries || []).forEach(render);
    }
    if (message.stats) { stats = message.stats; renderStats(message.usage); }
    if (message.type === 'snapshot' || message.type === 'entries') scrollIfFollowing();
  });
  const refilter = () => rows.forEach(applyFilter);
  document.querySelectorAll('input[data-kind]').forEach((box) => box.addEventListener('change', refilter));
  filterAgent.addEventListener('change', refilter);
  search.addEventListener('input', refilter);
  window.addEventListener('wheel', (event) => { if (event.deltaY < 0) follow.checked = false; }, { passive: true });
  pauseButton.addEventListener('click', () => setPaused(!paused));
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
    if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'p' || event.key === 'P')) { event.preventDefault(); setPaused(!paused); }
  });
  $('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $('export-md').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'markdown' }));
  $('export-json').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'json' }));
  vscode.postMessage({ type: 'ready' });
})();

// Compare Models: the leaderboard of every model tested, the controls to run a new comparison,
// its results, and past comparisons. The host sends everything; all of it is rendered with
// textContent. Buttons only ask the host to estimate, start or cancel a comparison, open or export
// a saved one, or put a model into a role (which it can undo).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const button = (label, onClick, options) => {
    const node = el('button', options && options.secondary ? 'secondary' : options && options.link ? 'link' : '', label);
    node.type = 'button';
    if (options && options.label) node.setAttribute('aria-label', options.label);
    node.addEventListener('click', onClick);
    return node;
  };
  const badge = (text, kind, title) => { const node = el('span', 'badge' + (kind ? ' ' + kind : ''), text); if (title) node.title = title; return node; };
  const PRIVACY_LABEL = { tee: 'TEE', local: 'Local', forwarded: 'Forwarded', unknown: 'Unknown' };
  const KINDS = [['coding', 'Coding'], ['research', 'Research'], ['planning', 'Planning'], ['execution', 'Execution']];
  const OUTCOME_TEXT = { completed: 'finished', 'max-turns': 'ran out of steps', 'timed-out': 'hit the time limit', stalled: 'stopped responding', 'over-budget': 'hit the cost limit', failed: 'failed' };
  const money = (value) => value === undefined || value === null ? '—' : '$' + (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2));
  const seconds = (value) => value === undefined || value === null ? '—' : value < 120 ? Math.round(value) + ' s' : Math.round(value / 60) + ' min';
  const score = (value) => value === undefined || value === null ? '—' : (Math.round(value * 10) / 10).toFixed(1);
  const percent = (value) => Math.round(value * 100) + '%';
  const ago = (iso) => {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (days <= 0) { const hours = Math.floor((Date.now() - Date.parse(iso)) / 3600000); return hours <= 0 ? 'just now' : hours + ' h ago'; }
    return days === 1 ? 'yesterday' : days + ' days ago';
  };
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  let state;
  let report;
  let estimate;
  let running = false;
  const selection = { models: new Set(), taskSet: 'full', mode: 'reuse', runs: 1, touched: false };

  function cell(row, text, className, title) { const td = el('td', className, text); if (title) td.title = title; row.append(td); return td; }
  function headRow(table, labels) {
    const thead = el('thead'); const tr = el('tr');
    for (const [label, numeric] of labels) { const th = el('th', numeric ? 'num' : '', label); th.scope = 'col'; tr.append(th); }
    thead.append(tr); table.append(thead);
  }
  function wrap(table, label) { const box = el('div', 'table-wrap'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', label); box.tabIndex = 0; box.append(table); return box; }

  // ---- putting a model into a role ----
  function roleControl(model, privacy) {
    const box = el('div', 'role');
    const select = el('select');
    select.setAttribute('aria-label', 'Role to give ' + model);
    select.append(new Option('Use as…', ''));
    const groups = {};
    for (const role of state.roles) {
      if (!groups[role.group]) { groups[role.group] = document.createElement('optgroup'); groups[role.group].label = role.group; select.append(groups[role.group]); }
      const option = new Option(role.label + (role.current === model ? ' (already)' : ''), role.id);
      option.disabled = role.current === model;
      groups[role.group].append(option);
    }
    const apply = button('Apply', () => { if (select.value) vscode.postMessage({ type: 'apply-role', model, role: select.value }); }, { secondary: true, label: 'Put ' + model + ' into the chosen role' });
    apply.disabled = true;
    const warning = el('p', 'warning'); warning.hidden = true; warning.setAttribute('aria-live', 'polite');
    select.addEventListener('change', () => {
      apply.disabled = !select.value;
      const role = state.roles.find((candidate) => candidate.id === select.value);
      const text = role ? privacyWarning(privacy, role) : '';
      warning.textContent = text; warning.hidden = !text;
    });
    box.append(select, apply, warning);
    return box;
  }
  // Same rule as the host (modelRoles.privacyWarning): moving a role off a private model.
  function privacyWarning(privacy, role) {
    if (privacy !== 'forwarded' && privacy !== 'unknown') return '';
    if (role.currentPrivacy !== 'tee' && role.currentPrivacy !== 'local') return '';
    return 'Not private: ' + role.label + ' now uses a private model (' + role.current + '). This model ' + (privacy === 'forwarded' ? 'is forwarded outside NEAR’s TEE.' : 'has unknown privacy.');
  }

  function modelCell(row, entry, extras) {
    const td = el('td', 'model-cell');
    const head = el('div', 'model-head');
    head.append(el('code', 'name', entry.model), badge(PRIVACY_LABEL[entry.privacy] || 'Unknown', 'privacy ' + entry.privacy, entry.privacyText || (entry.forwardedTo ? 'Forwarded to ' + entry.forwardedTo : '')));
    for (const held of entry.holds || []) head.append(badge(held, 'held'));
    td.append(head);
    for (const extra of extras || []) td.append(extra);
    row.append(td);
  }

  function reliability(entry) {
    const parts = [];
    parts.push(entry.failures ? entry.failures + ' failed' : 'no failures');
    if (entry.stalls) parts.push(entry.stalls + ' stall' + (entry.stalls === 1 ? '' : 's'));
    return parts.join(', ');
  }

  // ---- leaderboard ----
  function renderBoard() {
    const root = $('board');
    root.replaceChildren();
    if (!state.leaderboard.length) { root.append(el('p', 'hint', 'No models tested yet. Run a comparison below to start the leaderboard.')); return; }
    const table = el('table');
    table.append(el('caption', 'visually-hidden', 'Leaderboard: every model tested, best first'));
    headRow(table, [['Rank', true], ['Model'], ['Overall', true], ...KINDS.map(([, label]) => [label, true]), ['Passed', true], ['Median time', true], ['Tokens/s', true], ['Cost per task', true], ['Reliability'], ['Last tested'], ['Put to work']]);
    const body = el('tbody');
    for (const entry of state.leaderboard) {
      const row = el('tr', entry.stale.length || !entry.inCatalog ? 'dim' : '');
      cell(row, entry.rank, 'num rank');
      const marks = [];
      if (!entry.inCatalog) marks.push(el('p', 'mark bad-mark', 'No longer in your key’s model list'));
      for (const reason of entry.stale) marks.push(el('p', 'mark stale', 'Out of date: ' + reason));
      if (entry.missingTasks.length) marks.push(el('p', 'mark', 'Not tested on: ' + entry.missingTasks.join(', ')));
      modelCell(row, entry, marks);
      cell(row, score(entry.score), 'num strong', entry.runs + ' runs over ' + entry.tasks.length + ' tasks');
      for (const [kind] of KINDS) {
        const part = entry.byKind[kind];
        const td = cell(row, part ? score(part.score) : '—', 'num', part ? part.tasks + ' task' + (part.tasks === 1 ? '' : 's') + ', ' + part.runs + ' run' + (part.runs === 1 ? '' : 's') : 'Not tested');
        if (part) td.append(el('span', 'runs', ' ×' + part.runs));
      }
      cell(row, percent(entry.passRate), 'num', entry.passes + ' of ' + entry.runs + ' runs got full marks');
      cell(row, seconds(entry.medianSeconds), 'num');
      cell(row, entry.tokPerSec === undefined ? '—' : entry.tokPerSec, 'num');
      cell(row, money(entry.costPerRunUsd) + (entry.costEstimated ? ' est.' : ''), 'num', entry.costUsd !== undefined ? money(entry.costUsd) + ' in all' : 'Unknown');
      cell(row, reliability(entry), entry.failures ? 'bad' : '');
      cell(row, entry.lastTested ? ago(entry.lastTested) : '—', '', entry.lastTested ? when(entry.lastTested) + ' · ' + entry.runs + ' runs' : '');
      const action = el('td'); action.append(entry.inCatalog ? roleControl(entry.model, entry.privacy) : el('span', 'hint', 'Not available')); row.append(action);
      body.append(row);
    }
    table.append(body);
    root.append(wrap(table, 'Leaderboard'));
  }

  // ---- setting up a comparison ----
  function renderSetup() {
    const root = $('setup');
    root.replaceChildren();
    if (state.problem) root.append(el('p', 'hint', state.problem));
    if (!state.catalog.length) return;
    if (!selection.touched) selection.models = new Set(state.selected);
    for (const model of [...selection.models]) if (!state.catalog.some((entry) => entry.id === model && !entry.blocked)) selection.models.delete(model);

    const models = el('fieldset', 'models');
    models.append(el('legend', '', 'Models to test (2 to 6)'));
    const filter = el('input'); filter.type = 'search'; filter.placeholder = 'Filter models'; filter.setAttribute('aria-label', 'Filter models');
    const list = el('ul', 'checks');
    for (const entry of state.catalog) {
      const item = el('li'); item.dataset.search = (entry.id + ' ' + entry.privacyText + ' ' + entry.holds.join(' ')).toLowerCase();
      const label = el('label');
      const box = el('input'); box.type = 'checkbox'; box.value = entry.id; box.checked = selection.models.has(entry.id); box.disabled = Boolean(entry.blocked) || running;
      box.addEventListener('change', () => { selection.touched = true; if (box.checked) selection.models.add(entry.id); else selection.models.delete(entry.id); requestEstimate(); });
      label.append(box, el('code', '', entry.id), badge(PRIVACY_LABEL[entry.privacy], 'privacy ' + entry.privacy, entry.privacyText));
      for (const held of entry.holds) label.append(badge(held, 'held'));
      const facts = [];
      if (entry.inputPerMillion !== undefined || entry.outputPerMillion !== undefined) facts.push(money(entry.inputPerMillion) + ' in / ' + money(entry.outputPerMillion) + ' out per 1M tokens');
      else facts.push('No published prices');
      if (entry.blocked) facts.push(entry.blocked);
      item.append(label, el('span', 'hint facts', facts.join(' · ')));
      list.append(item);
    }
    filter.addEventListener('input', () => { const query = filter.value.trim().toLowerCase(); list.querySelectorAll('li').forEach((item) => { item.hidden = Boolean(query) && !item.dataset.search.includes(query); }); });
    models.append(filter, list);

    const options = el('div', 'options');
    options.append(radios('Tasks', 'taskSet', state.taskSets.map((set) => [set.id, set.label + ' (' + set.tasks.length + ')', set.description])));
    options.append(radios('Earlier results', 'mode', [['reuse', 'Reuse saved results', 'Only models without a saved result for these task versions are run; the rest come from earlier comparisons at no cost.'], ['rerun', 'Run everything again', 'Every selected model runs every task, even with a saved result.']]));
    const runsField = el('fieldset'); runsField.append(el('legend', '', 'Runs per task'));
    const runs = el('select'); runs.setAttribute('aria-label', 'Runs per task');
    for (const count of [1, 2, 3]) runs.append(new Option(count + (count === 1 ? ' run' : ' runs'), String(count), false, selection.runs === count));
    runs.disabled = running;
    runs.addEventListener('change', () => { selection.runs = Number(runs.value); requestEstimate(); });
    runsField.append(runs, el('p', 'hint', 'More runs smooth out luck, and cost more.'));
    options.append(runsField);

    const footer = el('div', 'start');
    const summary = el('div', 'estimate'); summary.id = 'estimate'; summary.setAttribute('aria-live', 'polite');
    const start = button('Start comparison', () => vscode.postMessage(Object.assign({ type: 'start' }, selected())));
    start.id = 'start';
    footer.append(summary, start);
    root.append(models, options, footer);
    renderEstimate();
  }

  function radios(legend, key, choices) {
    const field = el('fieldset'); field.append(el('legend', '', legend));
    for (const [value, label, help] of choices) {
      const line = el('label', 'radio');
      const input = el('input'); input.type = 'radio'; input.name = key; input.value = value; input.checked = selection[key] === value; input.disabled = running;
      input.addEventListener('change', () => { if (input.checked) { selection[key] = value; requestEstimate(); } });
      line.append(input, el('span', '', label));
      field.append(line, el('p', 'hint', help));
    }
    return field;
  }

  const selected = () => ({ models: [...selection.models], taskSet: selection.taskSet, mode: selection.mode, runs: selection.runs });
  let estimateTimer;
  function requestEstimate() {
    estimate = undefined; renderEstimate();
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => vscode.postMessage(Object.assign({ type: 'plan' }, selected())), 200);
  }

  function renderEstimate() {
    const node = $('estimate'); const start = $('start');
    if (!node || !start) return;
    node.replaceChildren();
    start.disabled = true;
    if (running) { node.append(el('p', 'hint', 'A comparison is running.')); return; }
    if (!estimate) { node.append(el('p', 'hint', 'Working out the cost…')); return; }
    if (estimate.problem) { node.append(el('p', 'warning', estimate.problem)); return; }
    const value = estimate.estimate;
    start.disabled = false;
    if (!value.runs) {
      node.append(el('p', '', 'Nothing to run: every selected model has a saved result for these tasks. Starting builds the comparison from them at no cost.'));
    } else {
      const line = el('p', '');
      line.append(el('strong', '', 'About ' + money(value.usd)), document.createTextNode(' for ' + value.runs + ' task run' + (value.runs === 1 ? '' : 's') + '. A rough estimate: models that take more steps cost more.'));
      node.append(line);
      if (value.unpriced.length) node.append(el('p', 'warning', 'Not counted, no published prices: ' + value.unpriced.join(', ') + '.'));
    }
    if (estimate.reused.length) {
      const details = el('details', 'reused');
      details.append(el('summary', '', estimate.reused.length + ' result' + (estimate.reused.length === 1 ? '' : 's') + ' reused from earlier comparisons'));
      const list = el('ul');
      for (const item of estimate.reused) list.append(el('li', '', item.model + ' · ' + item.task + ' · tested ' + ago(item.at)));
      details.append(list);
      node.append(details);
    }
  }

  function renderProgress(message) {
    const root = $('progress');
    root.replaceChildren();
    root.hidden = !running;
    if (!running) return;
    const bar = el('progress'); bar.max = Math.max(1, message.total); bar.value = message.done; bar.setAttribute('aria-label', 'Comparison progress');
    const text = message.total ? message.done + ' of ' + message.total + ' task runs done' : 'Starting…';
    const current = message.current ? ' · now: ' + message.current.model + ' on ' + message.current.task + (message.current.run > 1 ? ' (run ' + message.current.run + ')' : '') : '';
    root.append(bar, el('p', '', text + current), el('p', 'hint', 'Each task runs in a temporary folder outside your project. Closing this tab does not stop it.'), button('Cancel', () => vscode.postMessage({ type: 'cancel' }), { secondary: true, label: 'Cancel the comparison' }));
  }

  // ---- one comparison's results ----
  function renderReport() {
    const section = $('results-section'); const root = $('results'); const actions = $('results-actions');
    section.hidden = !report;
    if (!report) return;
    root.replaceChildren(); actions.replaceChildren();
    const run = report.run;
    actions.append(button('Export JSON', () => vscode.postMessage({ type: 'export', id: run.id }), { secondary: true }));
    const status = run.status === 'running' ? 'Running' : run.status === 'completed' ? 'Finished' : run.status === 'cancelled' ? 'Cancelled' : 'Stopped';
    const fresh = run.rows.filter((row) => !row.reusedFrom).length;
    root.append(el('p', 'hint', status + ' · started ' + when(run.startedAt) + ' · ' + (run.taskSet === 'full' ? 'Full set' : 'Short set') + ' · ' + run.runsPerTask + ' run' + (run.runsPerTask === 1 ? '' : 's') + ' per task · ' + fresh + ' run here, ' + (run.rows.length - fresh) + ' reused' + (run.stopReason ? ' · ' + run.stopReason : '')));
    if (!report.summary.some((entry) => entry.runs)) { root.append(el('p', 'hint', 'No results yet.')); return; }
    const table = el('table');
    table.append(el('caption', 'visually-hidden', 'Ranking for this comparison'));
    headRow(table, [['Rank', true], ['Model'], ['Score', true], ['Passed', true], ['Median time', true], ['Tokens/s', true], ['Cost', true], ['Reliability'], ['Put to work']]);
    const body = el('tbody');
    for (const entry of report.summary) {
      const row = el('tr');
      cell(row, entry.runs ? entry.rank : '—', 'num rank');
      const extras = [];
      if (entry.catalogChanged) extras.push(el('p', 'mark', 'Its NEAR listing (price or privacy) has changed since'));
      if (!entry.inCatalog) extras.push(el('p', 'mark bad-mark', 'No longer in your key’s model list'));
      modelCell(row, entry, extras);
      cell(row, entry.runs ? score(entry.score) : '—', 'num strong');
      cell(row, entry.runs ? percent(entry.passRate) : '—', 'num');
      cell(row, seconds(entry.medianSeconds), 'num');
      cell(row, entry.tokPerSec === undefined ? '—' : entry.tokPerSec, 'num');
      cell(row, money(entry.costUsd) + (entry.costEstimated ? ' est.' : ''), 'num');
      cell(row, entry.runs ? reliability(entry) : '—', entry.failures ? 'bad' : '');
      const action = el('td'); action.append(entry.inCatalog ? roleControl(entry.model, entry.privacy) : el('span', 'hint', 'Not available')); row.append(action);
      body.append(row);
    }
    table.append(body);
    root.append(wrap(table, 'Ranking for this comparison'));
    for (const entry of report.summary) {
      if (!entry.tasks.length) continue;
      const details = el('details', 'model-tasks');
      details.append(el('summary', '', entry.model + ' — task by task'));
      const tasks = el('table');
      headRow(tasks, [['Task'], ['Score', true], ['Runs', true], ['Median time', true], ['Tokens/s', true], ['Cost', true], ['Problems']]);
      const tbody = el('tbody');
      for (const task of entry.tasks) {
        const row = el('tr');
        cell(row, labelOf(task.task) + (task.reused ? ' (reused, tested ' + ago(task.at) + ')' : ''));
        cell(row, score(task.score) + ' / 10', 'num');
        cell(row, task.runs, 'num');
        cell(row, seconds(task.medianSeconds), 'num');
        cell(row, task.tokPerSec === undefined ? '—' : task.tokPerSec, 'num');
        cell(row, money(task.costUsd), 'num');
        const outcomes = run.rows.filter((candidate) => candidate.model === entry.model && candidate.task === task.task && candidate.outcome !== 'completed').map((candidate) => OUTCOME_TEXT[candidate.outcome]);
        cell(row, [...new Set(outcomes)].concat(task.misses).join('; ') || '—', 'misses');
        tbody.append(row);
      }
      tasks.append(tbody);
      details.append(wrap(tasks, entry.model + ' task results'));
      root.append(details);
    }
  }

  function labelOf(taskId) {
    for (const set of state ? state.taskSets : []) { const found = set.tasks.find((task) => task.id === taskId); if (found) return found.label; }
    return taskId;
  }

  // ---- past comparisons ----
  function renderHistory() {
    const root = $('history');
    root.replaceChildren();
    if (!state.history.length) { root.append(el('p', 'hint', 'None yet. Every comparison is saved here automatically.')); return; }
    const table = el('table');
    headRow(table, [['Started'], ['Models'], ['Tasks'], ['Runs', true], ['Cost', true], ['Status'], ['']]);
    const body = el('tbody');
    for (const entry of state.history) {
      const row = el('tr');
      cell(row, when(entry.startedAt));
      cell(row, entry.models.join(', '), 'wrap');
      cell(row, (entry.taskSet === 'full' ? 'Full' : 'Short') + ', ' + (entry.mode === 'reuse' ? 'reused saved' : 'all again'));
      cell(row, entry.ran + (entry.reused ? ' + ' + entry.reused + ' reused' : ''), 'num');
      cell(row, money(entry.costUsd), 'num');
      cell(row, entry.status === 'completed' ? 'Finished' : entry.status === 'cancelled' ? 'Cancelled' : entry.status === 'running' ? 'Running' : 'Stopped', entry.status === 'completed' ? '' : 'warn', entry.stopReason || '');
      const actions = el('td', 'controls');
      actions.append(button('Open', () => vscode.postMessage({ type: 'open-run', id: entry.id }), { secondary: true, label: 'Open the comparison started ' + when(entry.startedAt) }), button('Export', () => vscode.postMessage({ type: 'export', id: entry.id }), { link: true, label: 'Export the comparison started ' + when(entry.startedAt) + ' as JSON' }));
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    root.append(wrap(table, 'Past comparisons'));
  }

  function showNotice(text, undoToken, warning) {
    const node = $('notice');
    node.replaceChildren(el('span', '', text));
    if (warning) node.append(el('p', 'warning', warning));
    if (undoToken) node.append(button('Undo', () => { vscode.postMessage({ type: 'undo-role', token: undoToken }); }, { secondary: true }));
    node.append(button('Dismiss', () => { node.hidden = true; }, { link: true }));
    node.hidden = false;
  }

  function renderAll() {
    $('problem').hidden = true;
    renderBoard();
    renderSetup();
    renderHistory();
    renderReport();
  }

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'state': {
        const first = !state;
        state = message.state;
        running = Boolean(state.running);
        renderAll();
        if (first || !estimate) requestEstimate();
        break;
      }
      case 'estimate': estimate = message; renderEstimate(); break;
      case 'progress': running = true; renderProgress(message); renderEstimate(); break;
      case 'finished': running = false; renderProgress({}); if (state) renderSetup(); requestEstimate(); showNotice(message.status === 'completed' ? 'Comparison finished. Results are below and saved.' : 'Comparison ' + (message.status === 'cancelled' ? 'cancelled' : 'stopped') + (message.stopReason ? ': ' + message.stopReason : '.') + ' What finished is saved.'); break;
      case 'report': report = message; if (state) renderReport(); break;
      case 'role-applied': showNotice(message.text, message.token, message.warning); break;
      case 'notice': showNotice(message.text); break;
      case 'error': { const node = $('problem'); node.textContent = message.text; node.hidden = false; break; }
    }
  });
  vscode.postMessage({ type: 'ready' });
})();

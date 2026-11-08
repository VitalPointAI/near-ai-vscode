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
  // Each label is [text, numeric, importance]: 'col-tertiary' columns hide at 900px and narrower,
  // 'col-secondary' ones at 600px and narrower; their values then show in the row's first cells.
  function headRow(table, labels) {
    const thead = el('thead'); const tr = el('tr');
    for (const [label, numeric, importance] of labels) { const th = el('th', [numeric ? 'num' : '', importance || ''].join(' ').trim(), label); th.scope = 'col'; tr.append(th); }
    thead.append(tr); table.append(thead);
    table.classList.add('stack-narrow');
  }
  // Gives each cell its column's name (shown before the value when narrow rows become cards) and importance.
  function labelRow(table, row) {
    const heads = table.querySelectorAll('thead th');
    [...row.children].forEach((cell, index) => {
      const head = heads[index];
      if (!head) return;
      cell.dataset.label = head.textContent;
      for (const importance of ['col-secondary', 'col-tertiary']) if (head.classList.contains(importance)) cell.classList.add(importance);
    });
  }
  // A line in a row's main cell with the values of columns hidden on a narrower panel.
  const hiddenValues = (className, parts) => el('p', 'mark ' + className, parts.filter(Boolean).join(' · '));
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
    headRow(table, [['Rank', true], ['Model'], ['Overall', true], ...KINDS.map(([, label]) => [label, true, 'col-tertiary']), ['Passed', true, 'col-secondary'], ['Median time', true, 'col-secondary'], ['Tokens/s', true, 'col-tertiary'], ['Cost per task', true, 'col-secondary'], ['Reliability', false, 'col-secondary'], ['Last tested', false, 'col-tertiary'], ['Put to work']]);
    const body = el('tbody');
    for (const entry of state.leaderboard) {
      const row = el('tr', entry.stale.length || !entry.inCatalog ? 'dim' : '');
      cell(row, entry.rank, 'num rank');
      const marks = [];
      if (!entry.inCatalog) marks.push(el('p', 'mark bad-mark', 'No longer in your key’s model list'));
      for (const reason of entry.stale) marks.push(el('p', 'mark stale', 'Out of date: ' + reason));
      if (entry.missingTasks.length) marks.push(el('p', 'mark', 'Not tested on: ' + entry.missingTasks.join(', ')));
      marks.push(hiddenValues('when-medium', [...KINDS.map(([kind, label]) => entry.byKind[kind] ? label + ' ' + score(entry.byKind[kind].score) : ''), entry.tokPerSec === undefined ? '' : entry.tokPerSec + ' tokens/s', entry.lastTested ? 'tested ' + ago(entry.lastTested) : '']));
      marks.push(hiddenValues('when-narrow', ['Passed ' + percent(entry.passRate), 'median ' + seconds(entry.medianSeconds), money(entry.costPerRunUsd) + (entry.costEstimated ? ' est.' : '') + ' per task', reliability(entry)]));
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
      labelRow(table, row);
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
    // The same two presets the command line has (npm run compare:models -- --new / --retest), so a released model does not need a terminal.
    const worth = state.retest || { models: [], newModels: [] };
    const presets = el('div', 'presets');
    if (worth.newModels.length) {
      presets.append(button('New models (' + worth.newModels.length + ')', () => selectModels([...selection.models, ...worth.newModels])),
        el('span', 'hint', 'Added to the catalog since you last tested them.'));
    }
    if (worth.models.length) {
      presets.append(button('Worth testing again (' + worth.models.length + ')', () => selectModels([...selection.models, ...worth.models.map((entry) => entry.model)])),
        el('span', 'hint', 'A saved result that is out of date or missing a task.'));
    }
    if (worth.newModels.length || worth.models.length) models.append(presets);
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
    headRow(table, [['Rank', true], ['Model'], ['Score', true], ['Passed', true, 'col-secondary'], ['Median time', true, 'col-secondary'], ['Tokens/s', true, 'col-tertiary'], ['Cost', true, 'col-secondary'], ['Reliability', false, 'col-secondary'], ['Put to work']]);
    const body = el('tbody');
    for (const entry of report.summary) {
      const row = el('tr');
      cell(row, entry.runs ? entry.rank : '—', 'num rank');
      const extras = [];
      if (entry.catalogChanged) extras.push(el('p', 'mark', 'Its NEAR listing (price or privacy) has changed since'));
      if (!entry.inCatalog) extras.push(el('p', 'mark bad-mark', 'No longer in your key’s model list'));
      if (entry.tokPerSec !== undefined) extras.push(hiddenValues('when-medium', [entry.tokPerSec + ' tokens/s']));
      if (entry.runs) extras.push(hiddenValues('when-narrow', ['Passed ' + percent(entry.passRate), 'median ' + seconds(entry.medianSeconds), money(entry.costUsd) + (entry.costEstimated ? ' est.' : ''), reliability(entry)]));
      modelCell(row, entry, extras);
      cell(row, entry.runs ? score(entry.score) : '—', 'num strong');
      cell(row, entry.runs ? percent(entry.passRate) : '—', 'num');
      cell(row, seconds(entry.medianSeconds), 'num');
      cell(row, entry.tokPerSec === undefined ? '—' : entry.tokPerSec, 'num');
      cell(row, money(entry.costUsd) + (entry.costEstimated ? ' est.' : ''), 'num');
      cell(row, entry.runs ? reliability(entry) : '—', entry.failures ? 'bad' : '');
      const action = el('td'); action.append(entry.inCatalog ? roleControl(entry.model, entry.privacy) : el('span', 'hint', 'Not available')); row.append(action);
      labelRow(table, row);
      body.append(row);
    }
    table.append(body);
    root.append(wrap(table, 'Ranking for this comparison'));
    for (const entry of report.summary) {
      if (!entry.tasks.length) continue;
      const details = el('details', 'model-tasks');
      details.append(el('summary', '', entry.model + ' — task by task'));
      const tasks = el('table');
      headRow(tasks, [['Task'], ['Score', true], ['Runs', true, 'col-secondary'], ['Median time', true, 'col-secondary'], ['Tokens/s', true, 'col-tertiary'], ['Cost', true, 'col-secondary'], ['Problems']]);
      const tbody = el('tbody');
      for (const task of entry.tasks) {
        const row = el('tr');
        const name = cell(row, labelOf(task.task) + (task.reused ? ' (reused, tested ' + ago(task.at) + ')' : ''), 'wrap');
        if (task.tokPerSec !== undefined) name.append(hiddenValues('when-medium', [task.tokPerSec + ' tokens/s']));
        name.append(hiddenValues('when-narrow', [task.runs + (task.runs === 1 ? ' run' : ' runs'), 'median ' + seconds(task.medianSeconds), money(task.costUsd)]));
        cell(row, score(task.score) + ' / 10', 'num');
        cell(row, task.runs, 'num');
        cell(row, seconds(task.medianSeconds), 'num');
        cell(row, task.tokPerSec === undefined ? '—' : task.tokPerSec, 'num');
        cell(row, money(task.costUsd), 'num');
        const outcomes = run.rows.filter((candidate) => candidate.model === entry.model && candidate.task === task.task && candidate.outcome !== 'completed').map((candidate) => OUTCOME_TEXT[candidate.outcome]);
        cell(row, [...new Set(outcomes)].concat(task.misses).join('; ') || '—', 'misses');
        labelRow(tasks, row);
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
    headRow(table, [['Started'], ['Models'], ['Tasks', false, 'col-secondary'], ['Runs', true, 'col-secondary'], ['Cost', true], ['Status'], ['']]);
    const body = el('tbody');
    for (const entry of state.history) {
      const row = el('tr');
      const started = cell(row, when(entry.startedAt), 'wrap');
      started.append(hiddenValues('when-narrow', [(entry.taskSet === 'full' ? 'Full' : 'Short') + ' set, ' + (entry.mode === 'reuse' ? 'reused saved' : 'all again'), entry.ran + ' run' + (entry.ran === 1 ? '' : 's') + (entry.reused ? ' + ' + entry.reused + ' reused' : '')]));
      cell(row, entry.models.join(', '), 'wrap');
      cell(row, (entry.taskSet === 'full' ? 'Full' : 'Short') + ', ' + (entry.mode === 'reuse' ? 'reused saved' : 'all again'));
      cell(row, entry.ran + (entry.reused ? ' + ' + entry.reused + ' reused' : ''), 'num');
      cell(row, money(entry.costUsd), 'num');
      cell(row, entry.status === 'completed' ? 'Finished' : entry.status === 'cancelled' ? 'Cancelled' : entry.status === 'running' ? 'Running' : 'Stopped', entry.status === 'completed' ? '' : 'warn', entry.stopReason || '');
      const actions = el('td', 'controls');
      actions.append(button('Open', () => vscode.postMessage({ type: 'open-run', id: entry.id }), { secondary: true, label: 'Open the comparison started ' + when(entry.startedAt) }), button('Export', () => vscode.postMessage({ type: 'export', id: entry.id }), { link: true, label: 'Export the comparison started ' + when(entry.startedAt) + ' as JSON' }));
      row.append(actions);
      labelRow(table, row);
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

  // Models worth testing again: a saved result that is stale or missing a task, and models that were added to the catalog since the last run. Shown above
  // the board so a release of a new model is not something the user has to notice by scrolling (owner, 2026-11-07).
  function renderRetest() {
    const root = $('retest');
    root.replaceChildren();
    const worth = state.retest || { models: [], newModels: [] };
    const lines = [];
    if (worth.newModels.length) lines.push(el('p', '', 'Added since you last tested: ' + worth.newModels.join(', ') + '. Select them below to see how they do.'));
    for (const entry of worth.models) lines.push(el('p', '', entry.model + ': ' + entry.why.join('; ')));
    root.hidden = !lines.length;
    if (lines.length) {
      root.append(el('strong', '', 'Worth testing again'), ...lines);
      // The banner selects, so acting on it is one click rather than hunting for models in the list below.
      const actions = el('div', 'retest-actions');
      const all = [...worth.models.map((entry) => entry.model), ...worth.newModels];
      if (all.length) actions.append(button('Select every model worth testing again', () => selectModels(all)));
      if (worth.newModels.length) actions.append(button('Select the new models', () => selectModels(worth.newModels)));
      root.append(actions);
    }
  }

  // Ticks the given models in the list below and refreshes the estimate, so the person sees the cost before starting. A model the catalog does not
  // offer (or that TEE-only mode blocks) is skipped rather than silently ticking nothing.
  function selectModels(models) {
    selection.touched = true;
    selection.models = new Set(models.filter((model) => state.catalog.some((entry) => entry.id === model && !entry.blocked)));
    renderSetup();
    requestEstimate();
  }

  // Performance over time: a line per series, score percent up the side, date along the bottom. Drawn as SVG so it keeps its shape at any width, and
  // drawn from the data rather than fetched from anywhere. A task type with no results has no line, so an untested kind cannot look like a flat zero.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (name, attrs) => { const node = document.createElementNS(SVG_NS, name); for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value)); return node; };
  function renderTrend() {
    const root = $('trend');
    root.replaceChildren();
    const trend = state.trend || { overall: [], byKind: [] };
    if (trend.overall.length < 2) {
      root.hidden = true;
      // One point is not a trend, but it is worth saying what it was, so the first comparison does not look like nothing happened.
      if (trend.overall.length === 1) { root.hidden = false; root.append(el('strong', '', 'Performance over time'), el('p', 'hint', 'One day of results so far: ' + trend.overall[0].percent + '% on ' + trend.overall[0].date + '. Run another comparison to see the line.')); }
      return;
    }
    root.hidden = false;
    root.append(el('strong', '', 'Performance over time'));
    const W = 640, H = 200, PAD = { left: 34, right: 12, top: 10, bottom: 24 };
    const dates = [...new Set(trend.overall.map((point) => point.date))].sort();
    const x = (date) => PAD.left + (dates.length === 1 ? 0 : (dates.indexOf(date) / (dates.length - 1)) * (W - PAD.left - PAD.right));
    const y = (percent) => PAD.top + (1 - percent / 100) * (H - PAD.top - PAD.bottom);
    const chart = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'img', 'aria-label': 'Score percentage over time, for every task and by task type' });
    // Grid at 0, 50 and 100 percent, with their labels.
    for (const percent of [0, 50, 100]) {
      chart.append(svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y(percent), y2: y(percent), class: 'grid' }));
      const label = svg('text', { x: 4, y: y(percent) + 4, class: 'axis' }); label.textContent = percent + '%'; chart.append(label);
    }
    for (const date of dates) {
      const label = svg('text', { x: x(date), y: H - 6, class: 'axis', 'text-anchor': 'middle' }); label.textContent = date.slice(5); chart.append(label);
    }
    const series = [{ name: 'All tasks', points: trend.overall, cls: 'all' }, ...trend.byKind.map((entry) => ({ name: entry.kind, points: entry.points, cls: entry.kind }))];
    for (const line of series) {
      const path = line.points.map((point, index) => (index ? 'L' : 'M') + x(point.date).toFixed(1) + ' ' + y(point.percent).toFixed(1)).join(' ');
      chart.append(svg('path', { d: path, class: 'trend-line ' + line.cls }));
      for (const point of line.points) chart.append(svg('circle', { cx: x(point.date), cy: y(point.percent), r: line.cls === 'all' ? 3 : 2, class: 'trend-dot ' + line.cls }));
    }
    root.append(chart);
    // A key, because a line nobody can name is decoration. The overall line is thicker and first.
    const key = el('ul', 'trend-key');
    for (const line of series) {
      const last = line.points[line.points.length - 1];
      const item = el('li');
      item.append(el('span', 'swatch ' + line.cls, ''), el('span', '', line.name + (last ? ': ' + last.percent + '%' : '')));
      key.append(item);
    }
    root.append(key);
    const first = trend.overall[0], last = trend.overall[trend.overall.length - 1];
    const change = last.percent - first.percent;
    root.append(el('p', 'hint', 'Every task went from ' + first.percent + '% on ' + first.date + ' to ' + last.percent + '% on ' + last.date + ' (' +
      (change > 0 ? '+' : '') + change + ' points over ' + trend.overall.length + ' days of testing).'));
  }

  // The setup these results point to, per tier and per role, with one button that applies every change it lists. Shown above the board because it is the
  // conclusion of the numbers below it, and because a recommendation nobody can apply in one click is just advice (owner, 2026-11-07).
  function renderRecommended() {
    const root = $('recommended');
    root.replaceChildren();
    const recommended = state.recommended || { tiers: [], roles: [] };
    // The count is what APPLY will really write. The cyber row is skipped by the host (a scan picks its own model when it starts), so counting it here made
    // the button promise one change more than it made (0.4.19 review).
    const changes = [...recommended.tiers, ...recommended.roles].filter((entry) => entry.changes && !(entry.tier === 'cyber'));
    if (!recommended.tiers.length && !recommended.roles.length) { root.hidden = true; return; }
    root.hidden = false;
    const LABELS = { deep: 'Deep tier', standard: 'Standard tier', fast: 'Fast tier', cyber: 'Cybersecurity scans' };
    const label = (entry) => ('tier' in entry ? LABELS[entry.tier] || entry.tier : entry.role);
    const list = el('ul', 'recommendation');
    for (const entry of [...recommended.tiers, ...recommended.roles]) {
      const item = el('li', entry.changes ? '' : 'same');
      const name = el('strong', '', label(entry) + ': ');
      const body = entry.model + ' — ' + entry.why + (entry.changes ? '' : ' (already set)');
      item.append(name, el('span', '', body));
      if ('abliterated' in entry && entry.abliterated) item.append(badge('abliterated', 'held'));
      if ('note' in entry && entry.note) item.append(el('p', 'hint', entry.note));
      list.append(item);
    }
    root.append(el('strong', '', 'The setup these results point to'), list);
    const actions = el('div', 'retest-actions');
    if (changes.length) actions.append(button('Apply all ' + changes.length + ' change' + (changes.length === 1 ? '' : 's'), () => vscode.postMessage({ type: 'apply-recommended' })));
    else actions.append(el('span', 'hint', 'Every tier and role already uses the recommended model.'));
    root.append(actions);
  }

  function renderAll() {
    $('problem').hidden = true;
    renderBoard();
    renderTrend();
    renderRecommended();
    renderRetest();
    renderSetup();
    renderHistory();
    renderReport();
  }

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (event) => {
    const message = event.data || {};
    // Only under the extension-host tests, which load the layout probe: report this page's layout.
    if (message.type === 'layout-probe' && window.nearAiLayoutProbe) { vscode.postMessage(window.nearAiLayoutProbe()); return; }
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

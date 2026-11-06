// The Cybersecurity panel's client. The host sends plain objects; every dynamic value is rendered
// with textContent, never innerHTML, so a target's own text (or a finding title derived from it)
// cannot inject markup. Form, script, and style are three separate assets, so no client logic lives
// inside a TypeScript template string.

(function () {
  const vscode = acquireVsCodeApi();
  // Bumped by hand when the client changes shape, so a cached webview is visible rather than silent.
  const CYBER_BUILD = 'advice+progress-1';
  window.__cyberBuild = CYBER_BUILD;
  const $ = (id) => document.getElementById(id);
  const post = (message) => vscode.postMessage(message);

  const MODE_LABEL = { defensive: 'Defensive', offensive: 'Offensive', full: 'Full' };
  const state = { preview: undefined, engagement: undefined, prompt: undefined, running: false };

  // Mirrors defaultVehicle(): long runs go to the chat so closing this panel does not lose them.
  const VEHICLE_NOTE = {
    panel: 'Closing this panel stops the run.',
    chat: 'The run continues in the chat if you close this panel, and you can steer it by typing.'
  };
  function defaultVehicleFor(depth) {
    return depth === 'deep' ? 'chat' : 'panel';
  }
  function syncVehicle() {
    const vehicle = $('vehicle');
    const note = $('vehicle-note');
    vehicle.value = defaultVehicleFor($('depth').value);
    note.textContent = VEHICLE_NOTE[vehicle.value];
  }

  // ---- small DOM helpers (textContent only) ----
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function status(text, kind) {
    const node = $('status');
    node.textContent = text || '';
    node.dataset.kind = kind || '';
  }
  // Run outcome goes where the Run button is, so nobody scrolls to the top to find out what happened.
  function runStatus(text, kind) {
    const node = $('run-status');
    if (!node) return status(text, kind);
    node.textContent = text || '';
    node.dataset.kind = kind || '';
  }
  function table(headers, rows) {
    const box = el('table', 'table');
    const thead = el('thead');
    const headerRow = el('tr');
    for (const header of headers) {
      const cell = el('th', undefined, header);
      cell.scope = 'col';
      headerRow.appendChild(cell);
    }
    thead.appendChild(headerRow);
    box.appendChild(thead);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      for (const value of row) tr.appendChild(el('td', undefined, value));
      tbody.appendChild(tr);
    }
    box.appendChild(tbody);
    return box;
  }

  // ---- target + scope preview ----
  $('target-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const kind = $('target-kind').value;
    const value = $('target-value').value.trim();
    if (!value) return;
    status('Resolving the scope…');
    post({ type: 'resolve-target', kind, value });
  });

  function renderScope(preview) {
    const box = $('scope-preview');
    clear(box);
    state.preview = preview;
    box.appendChild(el('h3', undefined, 'Resolved scope'));
    const list = el('dl', 'scope');
    const add = (label, value) => {
      list.appendChild(el('dt', undefined, label));
      list.appendChild(el('dd', undefined, value));
    };
    add('Hosts', preview.hosts.length ? preview.hosts.join(', ') : 'none (workspace target)');
    add('Ports', preview.ports.length ? preview.ports.join(', ') : 'any');
    add('Paths', preview.paths.length ? preview.paths.join(', ') : 'none');
    add('Exclusions', preview.exclusions.length ? preview.exclusions.join(', ') : 'none');
    if (preview.note) add('Note', preview.note);
    box.appendChild(list);

    const warning = $('warning');
    if (preview.warning) {
      warning.textContent = preview.warning;
      warning.hidden = false;
    } else {
      warning.textContent = '';
      warning.hidden = true;
    }

    const modes = $('mode-selector');
    clear(modes);
    for (const mode of preview.modes) {
      const button = el('button', 'mode', MODE_LABEL[mode.mode] || mode.mode);
      button.type = 'button';
      button.dataset.mode = mode.mode;
      button.setAttribute('aria-pressed', 'false');
      if (!mode.enabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        button.title = mode.reason || 'Unavailable for this scope';
        button.appendChild(el('span', 'reason', mode.reason || 'Unavailable for this scope'));
      }
      button.addEventListener('click', () => {
        if (!mode.enabled) return;
        const pressed = button.getAttribute('aria-pressed') === 'true';
        button.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        button.classList.toggle('selected', !pressed);
        $('create').disabled = !document.querySelector('.mode.selected');
      });
      modes.appendChild(button);
    }
    $('create').disabled = true;
    status('Scope resolved. Choose a mode.');
  }

  // ---- disclaimer modal ----
  function renderDisclaimer(prompt) {
    state.prompt = prompt;
    $('disclaimer-section').hidden = false;
    const box = $('disclaimer-modal');
    clear(box);
    box.appendChild(el('p', 'hint', 'Accepting records your name, this machine, and the regional statement below for this engagement. A new engagement, or a changed scope or region, asks again.'));

    if (prompt.warning) {
      const warn = el('p', 'warning', 'Warning: ' + prompt.warning);
      warn.setAttribute('role', 'alert');
      box.appendChild(warn);
    }

    const regionLabel = el('label', undefined, 'Region');
    regionLabel.setAttribute('for', 'region');
    box.appendChild(regionLabel);
    const select = el('select');
    select.id = 'region';
    select.setAttribute('aria-label', 'Region whose law applies');
    for (const region of prompt.regions) {
      const option = el('option', undefined, region.name);
      option.value = region.code;
      if (region.code === prompt.detectedRegion) option.selected = true;
      select.appendChild(option);
    }
    box.appendChild(select);

    const statement = el('div', 'statement');
    const statute = el('p', 'statute');
    const body = el('p');
    const refresh = () => {
      const chosen = prompt.regions.find((region) => region.code === select.value) || prompt.regions[0];
      statute.textContent = chosen.name + ' — ' + chosen.statute;
      body.textContent = chosen.statement;
    };
    statement.appendChild(statute);
    statement.appendChild(body);
    box.appendChild(statement);
    select.addEventListener('change', refresh);
    refresh();

    const nameLabel = el('label', undefined, 'Your legal name or organisation');
    nameLabel.setAttribute('for', 'acceptor');
    box.appendChild(nameLabel);
    const name = el('input');
    name.id = 'acceptor';
    name.type = 'text';
    name.required = true;
    name.setAttribute('aria-label', 'Your legal name or organisation');
    box.appendChild(name);

    const accept = el('button', undefined, 'Accept and create the engagement');
    accept.type = 'button';
    accept.addEventListener('click', () => {
      if (!name.value.trim()) { name.focus(); return; }
      post({ type: 'accept-disclaimer', acceptor: name.value.trim(), region: select.value });
    });
    const decline = el('button', 'secondary', 'Decline');
    decline.type = 'button';
    decline.addEventListener('click', () => {
      $('disclaimer-section').hidden = true;
      post({ type: 'decline-disclaimer' });
    });
    const actions = el('div', 'actions');
    actions.appendChild(accept);
    actions.appendChild(decline);
    box.appendChild(actions);
  }

  // ---- engagement + model ----
  function renderEngagement(payload) {
    state.engagement = payload.engagement;
    $('run-section').hidden = false;
    const label = payload.engagement.target.kind + ': ' + payload.engagement.target.value;
    status('Engagement ' + payload.engagement.id + ' created for ' + label + '.');
    if (payload.model) $('model').value = payload.model;
    // The host names the model this scan runs on and, when it applies, why (owner decision 2026-11-05: a scan runs on an
    // abliterated model, chosen for it when more than one is offered, and the panel says so when none is).
    const note = $('model-note');
    if (note) {
      note.textContent = payload.modelNote || '';
      note.hidden = !payload.modelNote;
    }
  }

  function renderModels(models, defaultModel) {
    const select = $('model');
    clear(select);
    for (const model of models) {
      const option = el('option', undefined, model);
      option.value = model;
      if (model === defaultModel) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      if (!state.engagement) return;
      post({ type: 'select-model', engagementId: state.engagement.id, model: select.value });
    });
  }

  // ---- run controls ----
  // ---- run progress: elapsed time, step count, and a bar that is unmistakably moving ----
  const progress = { startedAt: 0, timer: undefined, steps: 0, depth: 'quick' };
  function showProgress(running, label) {
    const bar = $('progress');
    const text = $('progress-text');
    if (!running) {
      clearInterval(progress.timer);
      bar.hidden = true;
      text.textContent = '';
      return;
    }
    bar.hidden = false;
    // It sits beside the Run button now, so scroll it into view rather than making the user hunt.
    if (bar.scrollIntoView) bar.scrollIntoView({ block: 'nearest' });
    bar.removeAttribute('value');
    if (!progress.startedAt) progress.startedAt = Date.now();
    clearInterval(progress.timer);
    progress.timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);
      const mm = Math.floor(elapsed / 60);
      const ss = String(elapsed % 60).padStart(2, '0');
      text.textContent = (label || 'Running') + ' — ' + progress.steps + ' step' + (progress.steps === 1 ? '' : 's') + ', ' + mm + ':' + ss + ' elapsed. The model is thinking between steps; a quiet spell is normal.';
    }, 1000);
  }

  $('depth').addEventListener('change', syncVehicle);
  $('vehicle').addEventListener('change', () => { $('vehicle-note').textContent = VEHICLE_NOTE[$('vehicle').value]; });

  $('create').addEventListener('click', () => {
    const modes = [...document.querySelectorAll('.mode.selected')].map((button) => button.dataset.mode);
    if (!modes.length || !state.preview) return;
    post({ type: 'create-engagement', draft: { kind: state.preview.kind, value: state.preview.value, modes, depth: $('depth').value } });
  });

  $('run').addEventListener('click', () => {
    if (!state.engagement) return;
    const modes = [...document.querySelectorAll('.mode.selected')].map((button) => button.dataset.mode);
    if (!modes.length) { status('Choose a mode first.'); return; }
    state.running = true;
    $('run').disabled = true;
    $('stop').disabled = false;
    clear($('timeline'));
    clear($('findings'));
    post({ type: 'run', engagementId: state.engagement.id, mode: modes[0], depth: $('depth').value, model: $('model').value || undefined, vehicle: $('vehicle').value });
  });

  $('stop').addEventListener('click', () => {
    if (!state.engagement) return;
    post({ type: 'stop', engagementId: state.engagement.id });
  });

  // ---- timeline ----
  const timelineRows = new Map();
  function stepRow(step) {
    const row = el('li', 'step');
    row.dataset.stepId = step.id;
    const head = el('div', 'step-head');
    head.appendChild(el('span', 'action', step.action));
    head.appendChild(el('code', 'tool', step.tool));
    head.appendChild(el('span', 'target', step.target));
    head.appendChild(el('span', 'duration', ''));
    head.appendChild(el('span', 'result', ''));
    row.appendChild(head);
    const reasoning = el('details', 'reasoning');
    reasoning.appendChild(el('summary', undefined, 'Model reasoning'));
    reasoning.appendChild(el('p', undefined, step.expectedResult || ''));
    row.appendChild(reasoning);
    return row;
  }

  function renderEvent(event) {
    if (event.type === 'step-started') {
      progress.steps += 1;
      const row = stepRow(event.step);
      row.dataset.startedAt = String(Date.now());
      timelineRows.set(event.step.id, row);
      $('timeline').appendChild(row);
    } else if (event.type === 'step-finished') {
      const row = timelineRows.get(event.step.id);
      if (!row) return;
      const started = Number(row.dataset.startedAt || Date.now());
      row.querySelector('.duration').textContent = (Date.now() - started) + ' ms';
      row.querySelector('.result').textContent = event.result;
      row.classList.add('done');
    } else if (event.type === 'finding') {
      renderFinding(event.finding, event.verified);
    } else if (event.type === 'notice') {
      $('timeline').appendChild(el('li', 'notice', event.text));
    } else if (event.type === 'incompatible') {
      const note = el('li', 'notice incompatible', 'The model did not follow the JSON step protocol for the ' + event.role + ' role: ' + event.reason + '. That role is missing from this run.');
      $('timeline').appendChild(note);
    } else if (event.type === 'done') {
      state.running = false;
      $('run').disabled = false;
      $('stop').disabled = true;
      status('Run finished: ' + event.outcome + '.');
    }
  }

  const findingsTable = [];
  function renderFinding(finding, verified) {
    findingsTable.push([finding.severity, finding.title, (finding.reason || ''), (finding.wstg || []).join(', '), verified ? 'verified' : 'unverified', finding.evidenceHash || '']);
    const tableEl = $('findings');
    clear(tableEl);
    if (!findingsTable.length) return;
    tableEl.appendChild(table(['Severity', 'Finding', 'Why', 'WSTG', 'Critic', 'Evidence'], findingsTable));
  }

  // ---- tools, export, replay ----
  function renderTools(payload) {
    const box = $('tools');
    clear(box);
    if (!payload.missing || !payload.missing.length) {
      box.appendChild(el('p', 'hint', 'Every catalogued host tool is installed.'));
      return;
    }
    box.appendChild(el('p', 'hint', payload.summary || 'These checks could not run. The built-in probes work without any of them.'));
    const list = el('ul', 'tools');
    for (const advice of payload.advice || []) {
      const item = el('li', 'tool');
      const head = el('div', 'tool-head');
      // The recommendation is a word as well as a class, so it never relies on colour alone.
      head.appendChild(el('span', 'tool-name', advice.tool));
      head.appendChild(el('span', 'badge rec-' + advice.recommendation, advice.recommendation));
      if (advice.sizeHint) head.appendChild(el('span', 'hint', advice.sizeHint));
      if (advice.needsElevation) head.appendChild(el('span', 'badge needs-admin', 'needs admin password'));
      item.appendChild(head);

      item.appendChild(el('p', 'tool-why', advice.why));
      item.appendChild(el('p', 'hint', 'Where it goes: ' + advice.footprint));

      // What changes on the machine: an explicit list, open by default for a recommended tool.
      const effects = el('details', 'tool-effects');
      effects.open = advice.recommendation === 'recommended';
      effects.appendChild(el('summary', undefined, 'What this changes on your machine'));
      const effectList = el('ul');
      for (const effect of advice.effects || []) effectList.appendChild(el('li', undefined, effect));
      effects.appendChild(effectList);
      if (advice.cautions && advice.cautions.length) {
        effects.appendChild(el('p', 'hint', 'Consider first:'));
        const cautionList = el('ul', 'cautions');
        for (const caution of advice.cautions) cautionList.appendChild(el('li', undefined, caution));
        effects.appendChild(cautionList);
      }
      item.appendChild(effects);

      if (advice.command) {
        item.appendChild(el('code', 'tool-command', '$ ' + advice.command));
        const button = el('button', 'secondary', 'Install ' + advice.tool);
        button.type = 'button';
        button.setAttribute('aria-label', 'Install ' + advice.tool + ' (' + advice.recommendation + ')');
        button.addEventListener('click', () => {
          button.disabled = true;
          button.textContent = 'Installing…';
          status('Installing ' + advice.tool + '. Watch the terminal it opens.');
          post({ type: 'install-tool', tool: advice.tool });
        });
        item.appendChild(button);
      } else {
        item.appendChild(el('p', 'hint', 'No one-click install for this tool on this platform; install it yourself and press Refresh.'));
      }
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  function renderExport(runId) {
    const box = $('export');
    clear(box);
    for (const format of ['markdown', 'json', 'sarif']) {
      const button = el('button', 'secondary', 'Export ' + format);
      button.type = 'button';
      button.addEventListener('click', () => post({ type: 'export', runId, format }));
      box.appendChild(button);
    }
    const replay = el('button', 'secondary', 'Replay (offline)');
    replay.type = 'button';
    replay.addEventListener('click', () => post({ type: 'replay', runId }));
    box.appendChild(replay);
  }

  function renderReplay(replay) {
    clear($('timeline'));
    timelineRows.clear();
    const banner = el('li', 'notice', 'Replayed from the stored ledger — nothing was executed. Chain ' + (replay.chainOk ? 'verified' : 'NOT verified') + '.');
    $('timeline').appendChild(banner);
    for (const step of replay.steps) {
      const row = el('li', 'step done');
      const head = el('div', 'step-head');
      head.appendChild(el('span', 'action', '#' + step.index));
      head.appendChild(el('code', 'tool', step.tool));
      head.appendChild(el('span', 'result', step.result));
      row.appendChild(head);
      $('timeline').appendChild(row);
    }
  }

  // ---- host messages ----
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'scope': renderScope(message.preview); break;
      case 'disclaimer': renderDisclaimer(message.prompt); break;
      case 'engagement': renderEngagement(message); renderExport(''); break;
      case 'declined': status('Disclaimer declined. Nothing was created and the target is untouched.'); break;
      case 'models': renderModels(message.models || [], message.defaultModel); break;
      case 'tools':
        renderTools(message);
        // Proof of what the host sent: a stale webview shows no banner and old markup.
        status('Panel build ' + (window.__cyberBuild || 'current') + '. Host sent ' + ((message.advice || []).length) + ' install suggestion(s) for ' + ((message.missing || []).length) + ' missing tool(s).');
        break;
      case 'event':
        renderEvent(message.event);
        if (message.event && message.event.type === 'done') renderExport(message.event.runId);
        break;
      case 'run-started':
        state.running = true;
        progress.startedAt = 0;
        progress.steps = 0;
        showProgress(true, 'Running in this panel; closing it stops the run');
        runStatus('Run started. Closing this panel stops it. Steps appear below as they happen.');
        break;
      case 'handed-to-chat':
        showProgress(false);
        runStatus('Run handed to the chat: it continues there if you close this panel.');
        break;
      case 'run-finished':
        state.running = false;
        showProgress(false);
        runStatus('Run finished: ' + message.outcome + '.', message.outcome === 'completed' ? '' : 'error');
        renderExport(message.runId);
        break;
      case 'stopping': showProgress(true, 'Stopping'); runStatus('Stopping…'); break;
      case 'exported': runStatus('Wrote ' + message.paths.report + ', ' + message.paths.json + ' and ' + message.paths.sarif + '.'); break;
      case 'replayed': renderReplay(message.replay); status('Replayed a finished run.'); break;
      case 'installed': status(message.ok ? 'Installed ' + message.tool + '.' : 'Install of ' + message.tool + ' failed: ' + (message.reason || 'see the terminal') ); break;
      case 'model-selected': status('Model for this engagement: ' + message.model + '.'); break;
      case 'error': status(message.text, 'error'); break;
    }
  });

  syncVehicle();
  post({ type: 'ready' });
}());

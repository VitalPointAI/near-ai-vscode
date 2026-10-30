// Agent Activity page: an overview (agents running now, a period's figures, run history) drawn
// from the host's 'overview' messages. Rows are kept and updated in place (no flicker); every
// value is set with textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const PHASE = { starting: 'Starting', thinking: 'Thinking', generating: 'Writing', tool: 'Running', 'waiting-you': 'Waiting for you', 'cooling-down': 'Cooling down', paused: 'Paused' };
  const OUTCOME = { running: 'Running', completed: 'Completed', 'max-turns': 'Turn limit', cancelled: 'Stopped', failed: 'Failed', 'setup-blocked': 'Setup needed' };
  const BOUNDARY = { tee: ['TEE', 'Runs inside NEAR AI’s attested TEE'], local: ['Local', 'Runs on this machine'], cloud: ['Forwarded', 'NEAR forwards it to another provider'] };
  const TIME = [['generateMs', 'Generating', 'seg-generate'], ['toolMs', 'Tools and sub-agents', 'seg-tool'], ['userWaitMs', 'Waiting for you', 'seg-user'], ['nearWaitMs', 'Waiting on NEAR', 'seg-near']];
  const state = { window: 'today', last: undefined, focus: undefined };

  const number = (value) => Math.round(value || 0).toLocaleString();
  const money = (value) => value === undefined ? '–' : value > 0 && value < 0.0001 ? '<$0.0001' : '$' + value.toFixed(value < 1 ? 4 : 2);
  const duration = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
  const when = (iso) => { const at = new Date(iso); const today = new Date(); return at.toDateString() === today.toDateString() ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const button = (label, onClick, className, aria) => { const b = el('button', className || 'secondary', label); b.type = 'button'; if (aria) b.setAttribute('aria-label', aria); b.addEventListener('click', onClick); return b; };

  /** Keeps one <tr> per key, in order; `fill` builds cells once, `update` refreshes them. */
  function syncRows(tbody, items, key, fill, update, tag) {
    const existing = new Map([...tbody.children].map((row) => [row.dataset.key, row]));
    let previous = null;
    for (const item of items) {
      const id = key(item);
      let row = existing.get(id);
      if (row) existing.delete(id); else { row = el(tag || 'tr'); row.dataset.key = id; fill(row, item); }
      update(row, item);
      const next = previous ? previous.nextSibling : tbody.firstChild;
      if (row !== next) tbody.insertBefore(row, next);
      previous = row;
    }
    existing.forEach((row) => row.remove());
  }
  const cells = (row, count, numeric) => { for (let i = 0; i < count; i += 1) row.append(el('td', numeric && numeric.includes(i) ? 'num' : '')); return row.children; };

  function phaseText(agent, now) {
    if (agent.phase === 'cooling-down') {
      const left = agent.coolUntil ? Math.max(0, agent.coolUntil - now) : undefined;
      return (agent.coolReason === 'rate-limited' ? 'Rate limited' : 'Cooling down') + (left !== undefined ? ' · retry in ' + duration(left) : '');
    }
    if (agent.phase === 'tool') return 'Running ' + (agent.tool || 'a tool');
    return (PHASE[agent.phase] || agent.phase) + (agent.phase === 'waiting-you' || agent.phase === 'paused' ? ' · ' + duration(now - agent.phaseSince) : '');
  }

  function renderNow(running) {
    $('now-empty').hidden = running.length > 0;
    $('now-wrap').hidden = running.length === 0;
    syncRows($('now').querySelector('tbody'), running, (agent) => agent.agentId, (row, agent) => {
      cells(row, 8, [3, 4, 5, 6]);
      row.tabIndex = -1;
      const name = row.children[0];
      name.append(el('span', 'agent-name'));
      const model = row.children[1];
      model.append(el('span', 'model-name'), el('span', 'badge'));
      const controls = row.children[7];
      controls.className = 'controls';
      if (agent.sub) {
        const pause = button('Pause', () => vscode.postMessage({ type: 'agent-control', agentId: agent.agentId, action: row.dataset.paused === 'true' ? 'resume' : 'pause' }), 'secondary', '');
        pause.dataset.role = 'pause';
        controls.append(pause);
      }
      controls.append(button('Stop', () => vscode.postMessage({ type: 'agent-control', agentId: agent.agentId, action: 'stop' }), 'secondary', 'Stop ' + agent.label + (agent.sub ? '' : ' and its run')), button('Show in chat', () => vscode.postMessage({ type: 'show-in-chat' }), 'link', 'Show ' + agent.label + ' in chat'));
    }, (row, agent) => {
      const now = Date.now();
      row.dataset.agentId = agent.agentId;
      row.dataset.runId = agent.runId;
      row.dataset.paused = String(agent.phase === 'paused');
      row.dataset.since = String(agent.startedAt);
      row.className = 'phase-' + agent.phase + (state.focus === agent.agentId ? ' focused' : '');
      setText(row.children[0].firstChild, (agent.sub ? '↳ ' : '') + agent.label);
      setText(row.children[1].firstChild, agent.model);
      const badge = row.children[1].lastChild;
      const boundary = BOUNDARY[agent.boundary];
      badge.hidden = !boundary;
      if (boundary) { setText(badge, boundary[0]); badge.title = boundary[1]; badge.className = 'badge badge-' + agent.boundary; }
      setText(row.children[2], phaseText(agent, now));
      setText(row.children[3], duration(now - agent.startedAt));
      setText(row.children[4], number(agent.turns));
      setText(row.children[5], number(agent.toolCalls));
      setText(row.children[6], money(agent.costUsd));
      const pause = row.querySelector('[data-role="pause"]');
      if (pause) { setText(pause, agent.phase === 'paused' ? 'Resume' : 'Pause'); pause.setAttribute('aria-label', (agent.phase === 'paused' ? 'Resume ' : 'Pause ') + agent.label); }
    });
  }

  function renderPairs(dl, pairs) {
    syncRows(dl, pairs, (pair) => pair[0], (wrap) => { wrap.className = 'pair'; wrap.append(el('dt'), el('dd')); }, (wrap, pair) => {
      setText(wrap.children[0], pair[0]);
      setText(wrap.children[1], pair[1]);
      wrap.title = pair[2] || '';
    }, 'div');
  }

  // Under the overview's heading: set a usage reporting token, or that NEAR's total is in use.
  function renderToken(token) {
    const line = $('token-line');
    if (!line) return;
    line.hidden = !token;
    if (!token) return;
    const link = $('reporting-token');
    setText(link, token.text);
    link.title = token.title;
    link.dataset.state = token.state;
  }

  // Spend: where the figures come from, the token's state, totals by period, burn rate, credits.
  function renderInsight(insight) {
    const section = $('spend-section');
    section.hidden = !insight;
    if (!insight) return;
    const source = $('source-label');
    setText(source, insight.source.label);
    source.dataset.kind = insight.source.kind;
    setText($('source-detail'), insight.source.detail);
    const token = insight.token;
    setText($('token-status'), token.text);
    $('token-status').dataset.state = token.state;
    $('token-problem').hidden = !token.problem;
    setText($('token-problem-text'), token.problem || '');
    $('fix-token').hidden = !token.canFix;
    $('test-token').hidden = !token.canTest;
    const top = $('top-up');
    setText(top, insight.topUp.text);
    top.title = insight.topUp.tooltip;
    syncRows($('periods'), insight.periods, (figure) => figure.period, (wrap) => { wrap.className = 'pair'; wrap.append(el('dt'), el('dd'), el('span', 'figure-source')); }, (wrap, figure) => {
      setText(wrap.children[0], figure.label);
      setText(wrap.children[1], figure.text);
      setText(wrap.children[2], figure.sourceText);
      wrap.children[2].dataset.source = figure.source;
      wrap.title = figure.tooltip;
    }, 'div');
    const credits = insight.credits;
    const rows = [
      ['Burn rate (7-day average)', insight.burn.text, insight.burn.tooltip],
      ['Remaining credits', credits.text, credits.tooltip]
    ];
    if (credits.available) rows.push(['Time to depletion', credits.depletionText || '–', credits.tooltip]);
    renderPairs($('credits'), rows);
    $('credits-note').hidden = credits.available;
  }

  function renderSummary(summary, hasProject, token) {
    const empty = summary.empty;
    $('summary').hidden = empty;
    $('summary-empty').hidden = !empty;
    if (empty) setText($('summary-empty'), !hasProject ? 'Open a project folder to keep activity history.' : summary.window === 'conversation' ? 'Nothing has run in this conversation yet.' : summary.window === 'today' ? 'Nothing has run today.' : 'Nothing has run in the last 7 days.');
    if (empty) return;
    const cost = summary.cost;
    renderPairs($('totals'), [
      ['Runs', number(summary.runs)],
      ['Agents', number(summary.agents)],
      ['Tokens in', number(summary.tokens.input), summary.tokens.source === 'ledger' ? 'From the spend ledger: every NEAR request, including safety checks and summaries' : 'From the activity history'],
      ['Tokens out', number(summary.tokens.output)],
      ['Cost', cost ? cost.text : 'Not tracked', cost ? cost.tooltip + (token ? ' ' + token.text + ' (the link above).' : '') : 'No spend ledger for this API key (local models, or no key yet).']
    ]);
    const total = TIME.reduce((sum, [key]) => sum + (summary.time[key] || 0), 0);
    const bar = $('time-bar');
    if (!bar.children.length) TIME.forEach(([, , className]) => bar.append(el('span', 'seg ' + className)));
    TIME.forEach(([key], index) => { bar.children[index].style.width = total ? (100 * (summary.time[key] || 0) / total).toFixed(2) + '%' : '0'; });
    const legend = TIME.map(([key, label]) => [label, duration(summary.time[key]) + (total ? ' (' + Math.round(100 * (summary.time[key] || 0) / total) + '%)' : '')]);
    bar.setAttribute('aria-label', legend.map((pair) => pair[0] + ' ' + pair[1]).join(', '));
    syncRows($('time-legend'), legend, (pair) => pair[0], (li, pair) => { li.append(el('span', 'swatch ' + TIME.find((entry) => entry[1] === pair[0])[2]), el('span')); }, (li, pair) => setText(li.lastChild, pair[0] + ': ' + pair[1]), 'li');
    $('tools-empty').hidden = summary.tools.length > 0;
    syncRows($('tools').querySelector('tbody'), summary.tools, (tool) => tool.name, (row) => cells(row, 3, [1, 2]), (row, tool) => {
      setText(row.children[0], tool.name); setText(row.children[1], number(tool.calls)); setText(row.children[2], tool.errors ? number(tool.errors) : '–');
      row.children[2].classList.toggle('bad', tool.errors > 0);
    });
    const a = summary.approvals;
    renderPairs($('approvals'), [
      ['Auto-allowed', number(a.autoAllowed), 'Edits, commands, and other gated actions your approval mode or rules allowed without asking'],
      ['Asked you', number(a.asked)],
      ['Declined', number(a.declined), 'By you, or refused by a rule (nearAi.agent.denyCommands)'],
      ['Expired', number(a.expired), 'Nobody answered within nearAi.agent.approvalTimeoutMinutes, so it was declined']
    ]);
    const p = summary.problems;
    const parts = [[p.rateLimited, 'rate limited (429)'], [p.retries, 'retries'], [p.errors, 'agent errors'], [p.stopped, 'stopped'], [p.toolErrors, 'failed tool calls']].filter((part) => part[0]).map((part) => number(part[0]) + ' ' + part[1]);
    setText($('problems-summary'), parts.length ? parts.join(' · ') : 'No problems.');
    syncRows($('models').querySelector('tbody'), summary.models, (model) => model.model, (row) => cells(row, 9, [1, 2, 3, 4, 5, 6, 7, 8]), (row, model) => {
      const values = [model.model, number(model.agents), number(model.turns), number(model.rateLimited), number(model.retries), number(model.errors), number(model.stopped), number(model.inputTokens), number(model.outputTokens)];
      values.forEach((value, index) => setText(row.children[index], value));
      [3, 4, 5].forEach((index) => row.children[index].classList.toggle('bad', Number(values[index].replace(/\D/g, '')) > 0));
    });
  }

  function renderHistory(history) {
    $('history-empty').hidden = history.total > 0;
    syncRows($('history').querySelector('tbody'), history.rows, (run) => run.sessionId, (row, run) => {
      cells(row, 6, [2, 3, 4]);
      const title = row.children[1];
      if (run.conversationId) {
        const open = button('', () => vscode.postMessage({ type: 'open-conversation', conversationId: run.conversationId }), 'link title-link');
        open.title = 'Open this conversation in the chat';
        title.append(open);
      } else title.append(el('span', 'title-text'));
    }, (row, run) => {
      row.dataset.runId = run.runId || '';
      row.className = 'outcome-' + run.outcome + (state.focus && state.focusRun === run.runId ? ' focused' : '');
      setText(row.children[0], when(run.startedAt));
      setText(row.children[1].firstChild, run.title);
      if (run.conversationId) row.children[1].firstChild.setAttribute('aria-label', 'Open in chat: ' + run.title);
      setText(row.children[2], number(run.agents));
      setText(row.children[3], duration(run.durationMs));
      setText(row.children[4], run.costText || '–');
      setText(row.children[5], OUTCOME[run.outcome] || run.outcome);
    });
    setText($('page'), history.total ? 'Page ' + (history.page + 1) + ' of ' + history.pages + ' · ' + number(history.total) + ' runs' : '');
    $('prev').disabled = history.page <= 0;
    $('next').disabled = history.page >= history.pages - 1;
    $('prev').dataset.page = String(history.page - 1);
    $('next').dataset.page = String(history.page + 1);
  }

  function applyFocus() {
    if (!state.focus) return;
    const row = document.querySelector('#now tr[data-agent-id="' + CSS.escape(state.focus) + '"]') || (state.focusRun ? document.querySelector('#history tr[data-run-id="' + CSS.escape(state.focusRun) + '"]') : null);
    const note = $('focus-note');
    note.hidden = Boolean(row && row.closest('#now'));
    if (!row || !row.closest('#now')) setText(note, 'That agent has finished' + (row ? '; its run is highlighted in History.' : '. Its run is in History.'));
    if (row) { row.classList.add('focused'); row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'overview') {
      state.last = message;
      renderNow(message.running || []);
      renderSummary(message.summary, message.hasProject, message.token);
      renderToken(message.token);
      renderInsight(message.insight);
      renderHistory(message.history);
    }
    if (message.type === 'token-test') {
      const line = $('token-test');
      line.hidden = false;
      line.dataset.ok = message.running ? '' : String(Boolean(message.ok));
      setText(line, String(message.text || ''));
      $('test-token').disabled = Boolean(message.running);
    }
    if (message.type === 'focus-agent' && typeof message.agentId === 'string') {
      state.focus = message.agentId;
      state.focusRun = message.runId;
      applyFocus();
    }
  });

  // Elapsed times and countdowns move every second without a message from the host.
  setInterval(() => { if (state.last && state.last.running && state.last.running.length) renderNow(state.last.running); }, 1000);

  document.querySelectorAll('[data-window]').forEach((choice) => choice.addEventListener('click', () => {
    state.window = choice.dataset.window;
    document.querySelectorAll('[data-window]').forEach((other) => other.setAttribute('aria-checked', String(other === choice)));
    vscode.postMessage({ type: 'set-window', window: state.window });
  }));
  document.querySelector('.segmented').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const choices = [...document.querySelectorAll('[data-window]')];
    const index = choices.findIndex((choice) => choice.getAttribute('aria-checked') === 'true');
    const next = choices[(index + (event.key === 'ArrowRight' ? 1 : choices.length - 1)) % choices.length];
    next.focus(); next.click(); event.preventDefault();
  });
  ['prev', 'next'].forEach((id) => $(id).addEventListener('click', () => vscode.postMessage({ type: 'history-page', page: Number($(id).dataset.page) })));
  const menu = $('export-menu');
  const details = $('export-details');
  const closeMenu = () => { menu.hidden = true; details.setAttribute('aria-expanded', 'false'); };
  details.addEventListener('click', () => { menu.hidden = !menu.hidden; details.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button').focus(); });
  menu.querySelectorAll('[data-format]').forEach((item) => item.addEventListener('click', () => { closeMenu(); vscode.postMessage({ type: 'export', format: item.dataset.format }); }));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); details.focus(); } });
  $('export-usage').addEventListener('click', () => vscode.postMessage({ type: 'export-usage' }));
  if ($('reporting-token')) $('reporting-token').addEventListener('click', () => vscode.postMessage({ type: 'reporting-token' }));
  $('test-token').addEventListener('click', () => vscode.postMessage({ type: 'test-token' }));
  $('fix-token').addEventListener('click', () => vscode.postMessage({ type: 'fix-token' }));
  $('top-up').addEventListener('click', () => vscode.postMessage({ type: 'open-console' }));
  $('open-console').addEventListener('click', () => vscode.postMessage({ type: 'open-console' }));
  vscode.postMessage({ type: 'ready' });
})();
